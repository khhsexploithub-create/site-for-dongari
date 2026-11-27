// 동아리 과제. 연합회가 과제를 열고, 각 동아리가 제출글을 올린다.
// 과제 자체(clubAssignments)는 연합회 임원만 등록하고,
// 제출글(submissions 하위 컬렉션)은 로그인한 계정이면 누구나 올릴 수 있다.

import {
  addDoc,
  collection,
  query,
  where,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";

import { auth, db } from "../firebase.js";
import { UNION_CLUB_NAME } from "../userRole.js";
import { MAX_FILE_COUNT, removeAttachments } from "./attachmentUpload.js";

export const CLUB_ASSIGNMENTS_COLLECTION = "clubAssignments";
export const SUBMISSIONS_COLLECTION = "submissions";
// 제출글은 계정당 하나다. 문서 번호로 계정 uid 를 그대로 쓰면
// 보안 규칙이 '이 계정이 제출했는지'를 바로 확인할 수 있다.
// 낸 내용과 첨부는 아래 하위 문서에 따로 담아 열람 권한을 나눈다.
export const SUBMISSION_DETAIL_COLLECTION = "detail";
export const SUBMISSION_DETAIL_ID = "content";

// 같은 계정은 30분에 한 번만 조회수가 올라간다. (활동 기록과 같은 기준)
export const VIEW_COOLDOWN_MS = 30 * 60 * 1000;

// 과제 상태. 제출 기간을 지금 시각과 견주어 정한다.
export const ASSIGNMENT_STATUS = {
  waiting: { value: "waiting", name: "대기" },
  open: { value: "open", name: "제출" },
  closed: { value: "closed", name: "마감" }
};

export function getAssignmentStatus(assignment, now = Date.now()) {
  const startAt = toMillis(assignment?.startAt);
  const dueAt = toMillis(assignment?.dueAt);

  if (dueAt && now > dueAt) return ASSIGNMENT_STATUS.closed.value;
  if (startAt && now < startAt) return ASSIGNMENT_STATUS.waiting.value;
  return ASSIGNMENT_STATUS.open.value;
}

export function getAssignmentStatusName(status) {
  return ASSIGNMENT_STATUS[status]?.name ?? "대기";
}

export function isSubmittable(assignment, now = Date.now()) {
  return getAssignmentStatus(assignment, now) === ASSIGNMENT_STATUS.open.value;
}

// 낸 글을 고칠 수 있는지. 제출 기간 안이거나, '마감 후 수정 허용' 과제면 마감 뒤에도 된다.
// firestore.rules 의 canEditSubmissionNow 와 같은 조건이다.
export function isSubmissionEditable(assignment, now = Date.now()) {
  const status = getAssignmentStatus(assignment, now);
  if (status === ASSIGNMENT_STATUS.waiting.value) return false;
  return status === ASSIGNMENT_STATUS.open.value || assignment?.allowLateEdit === true;
}

// 마감까지 남은 기간을 '13일', '5시간' 처럼 적어 준다.
export function describeRemaining(assignment, now = Date.now()) {
  const dueAt = toMillis(assignment?.dueAt);
  if (!dueAt) return "마감 시간이 정해지지 않았습니다.";

  const remaining = dueAt - now;
  if (remaining <= 0) return "제출이 마감되었습니다.";

  const days = Math.floor(remaining / 86400000);
  if (days >= 1) return `마감시간까지 앞으로 ${days}일 남았습니다.`;

  const hours = Math.floor(remaining / 3600000);
  if (hours >= 1) return `마감시간까지 앞으로 ${hours}시간 남았습니다.`;

  return `마감시간까지 앞으로 ${Math.max(1, Math.floor(remaining / 60000))}분 남았습니다.`;
}

// ========================================
// 과제
// ========================================

// 첨부파일은 과제 문서보다 먼저 Storage 에 올라가므로, 과제 번호를 화면에서 미리 만든다.
export function newAssignmentId() {
  return doc(collection(db, CLUB_ASSIGNMENTS_COLLECTION)).id;
}

export async function createAssignment({
  assignmentId,
  clubName,
  title,
  managerName,
  target,
  startAt,
  dueAt,
  allowLateEdit,
  allowComment,
  notice,
  attachments
}) {
  const user = auth.currentUser;
  const reference = assignmentId
    ? doc(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId)
    : doc(collection(db, CLUB_ASSIGNMENTS_COLLECTION));

  await setDoc(reference, {
    ...cleanAssignment({
      clubName, title, managerName, target, startAt, dueAt, allowLateEdit, allowComment, notice,
      attachments
    }),
    // 과제를 등록한 계정이 이 과제의 담당자다. 제출 현황을 모두 볼 수 있다.
    authorUid: user?.uid ?? "",
    authorName: String(user?.email ?? "").trim(),
    viewCount: 0,
    createdAt: serverTimestamp()
  });

  return reference.id;
}

// 과제 수정. 작성자와 관리자만 할 수 있고, 보안 규칙에서도 같은 조건으로 막는다.
// 동아리는 바꾸지 않는다. attachments 는 수정이 끝난 뒤 남길 전체 목록이다.
export async function updateAssignment(assignmentId, assignment) {
  const { clubName: _clubName, ...editable } = cleanAssignment(assignment);

  await updateDoc(doc(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId), editable);
}

export async function deleteAssignment(assignmentId) {
  // 제출글을 먼저 지우지 않으면 하위 문서가 남는다.
  const submissions = await getSubmissions(assignmentId);

  await Promise.all(submissions.map(
    (submission) => deleteSubmission(assignmentId, submission.id)
  ));

  // 첨부파일은 과제 문서가 남아 있는 동안 지워야 저장소 규칙이 작성자를 확인할 수 있다.
  const saved = await getAssignment(assignmentId).catch(() => null);
  await removeAttachments(saved?.attachments);

  await deleteDoc(doc(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId));
}

export async function getAssignment(assignmentId) {
  const snapshot = await getDoc(doc(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId));

  if (!snapshot.exists()) return null;

  return { id: snapshot.id, viewCount: 0, ...snapshot.data() };
}

// 과제 문서에 동아리가 없던 시절 기록은 연합회 공통으로 본다.
export function getAssignmentClubName(assignment) {
  return String(assignment?.clubName ?? "").trim() || UNION_CLUB_NAME;
}

// 목록은 기본적으로 최신 과제부터 돌려준다. 화면에서 고른 정렬 방식은 listSort.js 가 맡는다.
//
// clubNames 를 주면 그 동아리 과제만 읽어 온다. 보안 규칙이 소속 조건을 따지므로,
// 조건 없이 전체를 요청하면 권한 오류가 난다. 관리자만 조건 없이 읽는다.
export async function getAssignments(clubNames) {
  const reference = collection(db, CLUB_ASSIGNMENTS_COLLECTION);
  const snapshot = await getDocs(
    Array.isArray(clubNames) && clubNames.length > 0
      ? query(reference, where("clubName", "in", clubNames.slice(0, 30)))
      : reference
  );

  return snapshot.docs
    .map((assignmentDoc) => ({
      id: assignmentDoc.id,
      viewCount: 0,
      ...assignmentDoc.data()
    }))
    .sort((first, second) => toMillis(second.createdAt) - toMillis(first.createdAt));
}

export async function registerAssignmentView(assignmentId, uid) {
  return registerView([CLUB_ASSIGNMENTS_COLLECTION, assignmentId], uid);
}

// ========================================
// 제출글
// ========================================

export async function createSubmission(assignmentId, {
  title, content, authorName, studentId, attachments
}) {
  const uid = currentUid();
  const cleanedAttachments = cleanAttachments(attachments);

  // 목록 정보와 낸 내용을 한 묶음으로 저장한다.
  // 하나만 저장되고 나머지가 실패하면 '냈는데 내용이 없는' 글이 남기 때문이다.
  const batch = writeBatch(db);

  // 목록에 보이는 정보. 제출한 구성원이면 모두 읽을 수 있다.
  batch.set(submissionReference(assignmentId, uid), {
    title: String(title ?? "").trim(),
    authorUid: uid,
    authorName: String(authorName ?? "").trim(),
    studentId: String(studentId ?? "").trim(),
    attachmentCount: cleanedAttachments.length,
    viewCount: 0,
    createdAt: serverTimestamp()
  });

  // 낸 내용과 첨부. 본인과 담당자, 관리자만 읽을 수 있다.
  batch.set(submissionDetailReference(assignmentId, uid), {
    content: String(content ?? "").trim(),
    // 첨부파일은 Storage 에 올리고 여기에는 이름과 주소만 담는다.
    attachments: cleanedAttachments,
    createdAt: serverTimestamp()
  });

  await batch.commit();

  return uid;
}

// 본인 글 수정. 제목 · 내용 · 첨부만 바꾸고, 글쓴이 · 조회수 · 등록일은 그대로 둔다.
export async function updateSubmission(assignmentId, { title, content, attachments }) {
  const uid = currentUid();
  const cleanedAttachments = cleanAttachments(attachments);
  const batch = writeBatch(db);

  batch.update(submissionReference(assignmentId, uid), {
    title: String(title ?? "").trim(),
    attachmentCount: cleanedAttachments.length,
    updatedAt: serverTimestamp()
  });

  batch.update(submissionDetailReference(assignmentId, uid), {
    content: String(content ?? "").trim(),
    attachments: cleanedAttachments,
    updatedAt: serverTimestamp()
  });

  await batch.commit();
}

function submissionReference(assignmentId, userId) {
  return doc(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId, SUBMISSIONS_COLLECTION, userId);
}

function submissionDetailReference(assignmentId, userId) {
  return doc(
    db,
    CLUB_ASSIGNMENTS_COLLECTION, assignmentId,
    SUBMISSIONS_COLLECTION, userId,
    SUBMISSION_DETAIL_COLLECTION, SUBMISSION_DETAIL_ID
  );
}

function cleanAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments.slice(0, MAX_FILE_COUNT).map((attachment) => ({
    name: String(attachment?.name ?? "").slice(0, 200),
    size: Number(attachment?.size) || 0,
    type: String(attachment?.type ?? "").slice(0, 120),
    path: String(attachment?.path ?? ""),
    url: String(attachment?.url ?? "")
  }));
}

// 이 계정이 이 과제의 담당자(등록자)인지.
export function isAssignmentManager(assignment, uid) {
  return Boolean(uid) && assignment?.authorUid === uid;
}

// 목록에 쓰는 정보만 읽는다. 읽을 수 없는 계정에게는 권한 오류가 난다.
export async function getSubmissions(assignmentId) {
  const snapshot = await getDocs(
    collection(db, CLUB_ASSIGNMENTS_COLLECTION, assignmentId, SUBMISSIONS_COLLECTION)
  );

  return snapshot.docs
    .map((submissionDoc) => ({
      id: submissionDoc.id,
      viewCount: 0,
      ...submissionDoc.data()
    }))
    .sort((first, second) => toMillis(second.createdAt) - toMillis(first.createdAt));
}

export async function getSubmission(assignmentId, userId) {
  const snapshot = await getDoc(submissionReference(assignmentId, userId));

  if (!snapshot.exists()) return null;

  return { id: snapshot.id, viewCount: 0, ...snapshot.data() };
}

// 낸 내용과 첨부. 권한이 없으면 권한 오류가 나므로 부르는 쪽에서 받아 처리한다.
export async function getSubmissionDetail(assignmentId, userId) {
  const snapshot = await getDoc(submissionDetailReference(assignmentId, userId));

  return snapshot.exists() ? snapshot.data() : null;
}

// 내가 이 과제에 냈는지. 내 문서는 없을 때도 읽을 수 있다.
export async function getMySubmission(assignmentId, uid) {
  if (!uid) return null;
  return getSubmission(assignmentId, uid);
}

export async function deleteSubmission(assignmentId, userId) {
  await deleteDoc(submissionDetailReference(assignmentId, userId)).catch((error) => {
    console.error("제출 내용 삭제 오류:", error);
  });

  await deleteDoc(submissionReference(assignmentId, userId));
}

export async function registerSubmissionView(assignmentId, userId, viewerUid) {
  return registerView(
    [CLUB_ASSIGNMENTS_COLLECTION, assignmentId, SUBMISSIONS_COLLECTION, userId],
    viewerUid
  );
}

// 목록에 얹을 '내가 냈는지'와 제출 건수.
// 건수는 제출 현황을 볼 수 있는 계정(담당자 · 관리자 · 이미 낸 계정)에게만 준다.
export async function summarizeSubmissions(assignment, { uid, isAdmin }) {
  const mine = await getMySubmission(assignment.id, uid).catch(() => null);
  const canSeeList = Boolean(isAdmin) || isAssignmentManager(assignment, uid) || Boolean(mine);

  if (!canSeeList) {
    return { total: null, hasMine: false };
  }

  const submissions = await getSubmissions(assignment.id).catch(() => null);

  return {
    total: submissions ? submissions.length : null,
    hasMine: Boolean(mine)
  };
}

// ========================================
// 공통
// ========================================

// 30분 쿨다운을 확인하고, 지났을 때만 조회수를 1 올린다.
async function registerView(pathSegments, uid) {
  if (!uid) return false;

  const targetReference = doc(db, ...pathSegments);
  const viewReference = doc(db, ...pathSegments, "views", uid);
  const snapshot = await getDoc(viewReference);

  if (snapshot.exists()) {
    const data = snapshot.data();
    const lastViewedAt = Number(data.lastViewedAtMs) || toMillis(data.lastViewedAt);

    if (lastViewedAt && Date.now() - lastViewedAt < VIEW_COOLDOWN_MS) {
      return false;
    }
  }

  await setDoc(viewReference, {
    lastViewedAt: serverTimestamp(),
    lastViewedAtMs: Date.now()
  });

  await updateDoc(targetReference, { viewCount: increment(1) });

  return true;
}

function cleanAssignment({
  clubName, title, managerName, target, startAt, dueAt, allowLateEdit, allowComment, notice,
  attachments
}) {
  return {
    // 과제를 낼 동아리. 연합회 전체 과제는 '연합회 공통' 이다.
    clubName: String(clubName ?? "").trim() || UNION_CLUB_NAME,
    title: String(title ?? "").trim(),
    managerName: String(managerName ?? "").trim(),
    target: String(target ?? "").trim(),
    // 제출 기간은 <input type="datetime-local"> 값을 밀리초로 바꿔 담는다.
    startAt: toMillis(startAt),
    dueAt: toMillis(dueAt),
    allowLateEdit: allowLateEdit === true,
    allowComment: allowComment === true,
    notice: String(notice ?? "").trim(),
    // 과제 안내에 붙는 파일. 최대 10개, 파일 하나당 30MB 까지.
    attachments: cleanAttachments(attachments)
  };
}

function currentUid() {
  return auth.currentUser?.uid ?? "";
}

// Firestore 타임스탬프 · 숫자 · 날짜 문자열을 모두 밀리초로 맞춘다.
export function toMillis(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value.toMillis === "function") return value.toMillis();

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 2026-09-15 14:50 처럼 보여준다.
export function formatDateTime(value) {
  const millis = toMillis(value);
  if (!millis) return "-";

  const date = new Date(millis);
  const pad = (number) => String(number).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 09-15 14:50 처럼 짧게 보여준다. (목록의 마감일 칸)
export function formatShortDateTime(value) {
  const millis = toMillis(value);
  if (!millis) return "-";

  const date = new Date(millis);
  const pad = (number) => String(number).padStart(2, "0");

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(value) {
  const millis = toMillis(value);
  if (!millis) return "-";

  const date = new Date(millis);
  const pad = (number) => String(number).padStart(2, "0");

  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

export function getYear(value) {
  const millis = toMillis(value);
  return millis ? new Date(millis).getFullYear() : 0;
}

// <input type="datetime-local"> 에 넣을 수 있는 형태로 되돌린다.
export function toDateTimeLocal(value) {
  const millis = toMillis(value);
  if (!millis) return "";

  const date = new Date(millis);
  const pad = (number) => String(number).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatViewCount(viewCount) {
  const value = Number(viewCount);
  return Number.isFinite(value) ? value.toLocaleString("ko-KR") : "0";
}
