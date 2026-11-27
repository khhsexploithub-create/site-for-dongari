import "../styles/site.css";
import "../styles/neoul/board.css";

import { guardPage } from "../pageGuard.js";
import { getDisplayName, getReadableClubNames } from "../userRole.js";
import {
  createSubmission,
  describeRemaining,
  formatDateTime,
  getAssignment,
  getAssignmentStatus,
  getAssignmentClubName,
  getAssignmentStatusName,
  getMySubmission,
  getSubmissionDetail,
  isSubmissionEditable,
  isSubmittable,
  updateSubmission
} from "./assignmentService.js";
import {
  createUploadId,
  removeAttachments,
  uploadAttachments,
  validateAttachmentFiles
} from "./attachmentUpload.js";
import { createAttachmentPicker } from "./attachmentPicker.js";

const form = document.querySelector("#submitForm");
const stateMessage = document.querySelector("#submitStateMessage");
const backLink = document.querySelector("#submitBackLink");
const cancelLink = document.querySelector("#submitCancelLink");

const headingKind = document.querySelector("#submitHeadingKind");
const assignmentTitleTag = document.querySelector("#submitAssignmentTitle");
const statusBadge = document.querySelector("#submitStatusBadge");
const periodText = document.querySelector("#submitPeriodText");
const remainingText = document.querySelector("#submitRemainingText");

const authorNameInput = document.querySelector("#submitAuthorName");
const studentIdInput = document.querySelector("#submitStudentId");
const titleInput = document.querySelector("#submitTitle");
const contentInput = document.querySelector("#submitContent");
const contentCount = document.querySelector("#submitContentCount");

const saveButton = document.querySelector("#submitSaveButton");
const message = document.querySelector("#submitMessage");

// 기존 첨부(수정할 때)와 새 파일 칸을 한 목록에서 다룬다. 합쳐서 10개, 파일당 30MB.
const attachmentPicker = createAttachmentPicker({
  list: document.querySelector("#submitAttachmentList"),
  addButton: document.querySelector("#submitAddAttachmentButton"),
  message
});

const INITIAL_ATTACHMENT_ROWS = 5;

let assignment = null;
let currentUser = null;
let currentProfile = null;
let isSaving = false;

// 수정할 때만 채워진다. 저장되어 있던 첨부 목록.
let originalAttachments = [];

// ========================================
// 주소 읽기
// ========================================
// /activity/submit/<과제 번호> 를 쓰고,
// 재작성 규칙이 없는 환경에서는 ?id=<과제 번호> 로도 들어올 수 있게 한다.
// 낸 글을 고칠 때는 주소 뒤에 ?edit=1 을 붙인다.

function readAssignmentId() {
  const pathMatch = window.location.pathname.match(/^\/activity\/submit\/([^/]+)\/?$/);

  if (pathMatch) {
    return decodeURIComponent(pathMatch[1]);
  }

  return new URLSearchParams(window.location.search).get("id") ?? "";
}

const assignmentId = readAssignmentId();
const isEditMode = new URLSearchParams(window.location.search).get("edit") === "1";
const assignmentUrl = assignmentId
  ? `/activity/assignment/${encodeURIComponent(assignmentId)}`
  : "/activity.html";

backLink.href = assignmentUrl;
cancelLink.href = assignmentUrl;

guardPage({
  onReady: async ({ user, profile }) => {
    currentUser = user;
    currentProfile = profile;

    await loadAssignment();
  }
});

function submissionUrl() {
  return `/activity/submission/${encodeURIComponent(assignmentId)}/${encodeURIComponent(currentUser.uid)}`;
}

async function loadAssignment() {
  if (!assignmentId) {
    showStateMessage("잘못된 주소입니다. 과제 목록에서 다시 들어와주세요.");
    return;
  }

  try {
    assignment = await getAssignment(assignmentId);

    if (!assignment) {
      showStateMessage("삭제되었거나 존재하지 않는 과제입니다.");
      return;
    }

    // 소속 동아리 과제에만 낼 수 있다. 규칙에서도 같은 조건으로 막는다.
    const assignmentClub = getAssignmentClubName(assignment);

    if (currentProfile?.isAdmin !== true
      && !getReadableClubNames(currentProfile).includes(assignmentClub)) {
      showStateMessage(`${assignmentClub} 소속만 낼 수 있는 과제예요.`);
      return;
    }

    // 계정당 한 번만 낼 수 있다. 이미 냈으면 그 글을 고친다.
    const mine = await getMySubmission(assignmentId, currentUser.uid).catch(() => null);

    if (isEditMode) {
      if (!mine) {
        showStateMessage("고칠 제출글이 없습니다. 과제 화면에서 먼저 제출해주세요.");
        return;
      }

      if (!isSubmissionEditable(assignment)) {
        showStateMessage("제출 기간이 끝나 글을 고칠 수 없습니다. (이 과제는 마감 후 수정을 허용하지 않습니다)");
        return;
      }

      const detail = await getSubmissionDetail(assignmentId, currentUser.uid).catch(() => null);
      renderForm({ submission: mine, detail });
      return;
    }

    if (mine) {
      if (isSubmissionEditable(assignment)) {
        // 이미 냈으면 새로 쓰는 대신 낸 글을 고치는 화면으로 보낸다.
        const editUrl = new URL(window.location.href);
        editUrl.searchParams.set("edit", "1");
        window.location.replace(editUrl.toString());
        return;
      }

      showStateMessage("이미 제출한 과제입니다. 제출 기간이 끝나 글을 고칠 수 없습니다.");
      return;
    }

    if (!isSubmittable(assignment)) {
      showStateMessage("제출 기간이 아닙니다. 과제 화면에서 기간을 확인해주세요.");
      return;
    }

    renderForm();
  } catch (error) {
    console.error("동아리 과제 조회 오류:", error);
    showStateMessage("과제를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
  }
}

function renderForm({ submission = null, detail = null } = {}) {
  const status = getAssignmentStatus(assignment);
  const title = assignment.title ?? "제목 없음";
  const kind = isEditMode ? "제출글 수정" : "과제제출";

  document.title = `${title} ${kind} | 동아리 통합 인프라`;
  if (headingKind) headingKind.textContent = kind;
  assignmentTitleTag.textContent = title;

  statusBadge.className = `board-badge is-${status}`;
  statusBadge.textContent = getAssignmentStatusName(status);

  periodText.textContent =
    `제출기간 : ${formatDateTime(assignment.startAt)} ~ ${formatDateTime(assignment.dueAt)}`;
  remainingText.textContent = isEditMode && !isSubmittable(assignment)
    ? "마감 후 수정이 허용된 과제입니다."
    : describeRemaining(assignment);

  if (isEditMode) {
    authorNameInput.value = submission?.authorName || getDisplayName(currentProfile, currentUser);
    studentIdInput.value = submission?.studentId || currentProfile?.studentId || "학번 미등록";
    titleInput.value = submission?.title ?? "";
    contentInput.value = detail?.content ?? "";
    contentCount.textContent = String(contentInput.value.length);

    originalAttachments = Array.isArray(detail?.attachments) ? detail.attachments : [];
    attachmentPicker.reset(originalAttachments);

    saveButton.textContent = "수정 저장";
    cancelLink.href = submissionUrl();
    backLink.href = submissionUrl();
    backLink.textContent = "← 제출글로 돌아가기";
  } else {
    authorNameInput.value = getDisplayName(currentProfile, currentUser);
    studentIdInput.value = currentProfile?.studentId || "학번 미등록";

    attachmentPicker.reset([]);
    for (let index = 0; index < INITIAL_ATTACHMENT_ROWS; index += 1) {
      attachmentPicker.addRow();
    }
  }

  form.hidden = false;
  stateMessage.hidden = true;
}

// ========================================
// 글자 수
// ========================================

contentInput.addEventListener("input", () => {
  contentCount.textContent = String(contentInput.value.length);
});

// ========================================
// 저장
// ========================================

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isSaving || !assignment) return;

  if (!titleInput.value.trim() || !contentInput.value.trim()) {
    message.textContent = "제목과 내용을 모두 입력해주세요.";
    return;
  }

  // 화면을 열어둔 사이에 마감됐을 수 있어 저장 직전에 한 번 더 본다.
  if (isEditMode ? !isSubmissionEditable(assignment) : !isSubmittable(assignment)) {
    message.textContent = isEditMode
      ? "제출 기간이 끝나 글을 고칠 수 없습니다."
      : "제출 기간이 지났습니다.";
    return;
  }

  const { kept, removed, files } = attachmentPicker.read(originalAttachments);
  const fileProblem = validateAttachmentFiles(files, kept.length);

  if (fileProblem) {
    message.textContent = fileProblem;
    return;
  }

  isSaving = true;
  saveButton.disabled = true;
  saveButton.textContent = "저장 중...";
  message.textContent = files.length > 0 ? "첨부파일을 올리는 중..." : "";

  let uploaded = [];

  try {
    uploaded = files.length > 0
      ? await uploadAttachments({
        assignmentId,
        uid: currentUser.uid,
        uploadId: createUploadId(),
        files,
        onProgress: (index, total, name) => {
          message.textContent = `첨부파일을 올리는 중... (${index + 1}/${total}) ${name}`;
        }
      })
      : [];

    if (isEditMode) {
      message.textContent = "고친 내용을 저장하는 중...";

      await updateSubmission(assignmentId, {
        title: titleInput.value,
        content: contentInput.value,
        attachments: [...kept, ...uploaded]
      });

      // 저장이 끝난 뒤에야 해제한 파일을 저장소에서 지운다. (저장이 실패하면 그대로 남는다)
      await removeAttachments(removed);

      window.location.replace(submissionUrl());
      return;
    }

    message.textContent = "제출하는 중...";

    await createSubmission(assignmentId, {
      title: titleInput.value,
      content: contentInput.value,
      authorName: getDisplayName(currentProfile, currentUser),
      studentId: currentProfile?.studentId ?? "",
      attachments: uploaded
    });

    window.location.replace(assignmentUrl);
  } catch (error) {
    console.error(isEditMode ? "제출글 수정 오류:" : "과제 제출 오류:", error);

    // 저장에 실패했으면 이번에 올린 첨부파일은 지워서 찌꺼기를 남기지 않는다.
    await removeAttachments(uploaded);

    message.textContent = describeSubmitError(error);
    isSaving = false;
    saveButton.disabled = false;
    saveButton.textContent = isEditMode ? "수정 저장" : "저장";
  }
});

// 왜 실패했는지 화면에서 바로 알 수 있게 풀어 쓴다.
function describeSubmitError(error) {
  const code = String(error?.code ?? "");
  const action = isEditMode ? "수정" : "제출";

  if (code === "permission-denied") {
    return `${action} 권한이 없습니다. 제출 기간과 로그인 상태를 확인해주세요.`
      + " (보안 규칙이 아직 반영되지 않았을 수도 있습니다)";
  }

  if (code === "storage/unauthorized") {
    return "첨부파일을 올릴 권한이 없습니다. Storage 규칙이 배포되었는지 확인해주세요.";
  }

  if (code === "storage/unknown" || code === "storage/retry-limit-exceeded") {
    return "첨부파일을 올리지 못했습니다. Firebase Storage 가 켜져 있는지 확인해주세요.";
  }

  if (code.startsWith("storage/")) {
    return `첨부파일을 올리지 못했습니다. (${code})`;
  }

  return code
    ? `${action}하지 못했습니다. (${code})`
    : `${action}하지 못했습니다. 잠시 후 다시 시도해주세요.`;
}

function showStateMessage(text) {
  form.hidden = true;
  stateMessage.hidden = false;
  stateMessage.textContent = text;
}
