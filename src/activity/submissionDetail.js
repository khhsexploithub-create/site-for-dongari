import "../styles/site.css";
import "../styles/neoul/board.css";

import { guardPage } from "../pageGuard.js";
import {
  deleteSubmission,
  formatDateTime,
  formatViewCount,
  getAssignment,
  getSubmission,
  getSubmissionDetail,
  isAssignmentManager,
  isSubmissionEditable,
  registerSubmissionView
} from "./assignmentService.js";
import { formatFileSize, removeAttachments } from "./attachmentUpload.js";

const article = document.querySelector("#submissionArticle");
const stateMessage = document.querySelector("#submissionStateMessage");
const backLink = document.querySelector("#submissionBackLink");
const listLink = document.querySelector("#submissionListLink");

const assignmentTitleText = document.querySelector("#submissionAssignmentTitle");
const postTitle = document.querySelector("#submissionPostTitle");
const postAuthor = document.querySelector("#submissionPostAuthor");
const postViews = document.querySelector("#submissionPostViews");
const postDate = document.querySelector("#submissionPostDate");
const postContent = document.querySelector("#submissionPostContent");
const attachmentSection = document.querySelector("#submissionAttachments");
const attachmentList = document.querySelector("#submissionAttachmentList");
const deleteButton = document.querySelector("#submissionDeleteButton");
const editLink = document.querySelector("#submissionEditLink");
const postUpdatedWrap = document.querySelector("#submissionPostUpdatedWrap");
const postUpdated = document.querySelector("#submissionPostUpdated");

let submission = null;
let assignment = null;
let currentUser = null;
let currentProfile = null;
let canOpenAll = false;
let isDeleting = false;

// ========================================
// 주소 읽기
// ========================================
// /activity/submission/<과제 번호>/<제출글 번호> 를 쓰고,
// 재작성 규칙이 없는 환경에서는 ?assignment=..&id=.. 로도 들어올 수 있게 한다.

function readIds() {
  const pathMatch = window.location.pathname
    .match(/^\/activity\/submission\/([^/]+)\/([^/]+)\/?$/);

  if (pathMatch) {
    return {
      assignmentId: decodeURIComponent(pathMatch[1]),
      submissionId: decodeURIComponent(pathMatch[2])
    };
  }

  const params = new URLSearchParams(window.location.search);

  return {
    assignmentId: params.get("assignment") ?? "",
    submissionId: params.get("id") ?? ""
  };
}

const { assignmentId, submissionId } = readIds();
const assignmentUrl = assignmentId
  ? `/activity/assignment/${encodeURIComponent(assignmentId)}`
  : "/activity.html";

backLink.href = assignmentUrl;
listLink.href = assignmentUrl;

guardPage({
  onReady: async ({ user, profile }) => {
    currentUser = user;
    currentProfile = profile;

    await loadSubmission();
  }
});

async function loadSubmission() {
  if (!assignmentId || !submissionId) {
    showStateMessage("잘못된 주소입니다. 과제에서 글을 다시 선택해주세요.");
    return;
  }

  try {
    assignment = await getAssignment(assignmentId).catch(() => null);
    assignmentTitleText.textContent = assignment?.title ?? "";

    canOpenAll = currentProfile?.isAdmin === true
      || isAssignmentManager(assignment, currentUser?.uid);

    submission = await getSubmission(assignmentId, submissionId).catch(() => null);

    if (!submission) {
      showStateMessage("삭제되었거나 존재하지 않는 글입니다.");
      return;
    }

    // 낸 내용과 첨부는 본인과 담당자, 관리자만 볼 수 있다.
    const canReadDetail = canOpenAll || submissionId === currentUser?.uid;
    const detail = canReadDetail
      ? await getSubmissionDetail(assignmentId, submissionId).catch(() => null)
      : null;

    if (currentUser) {
      try {
        const didCount = await registerSubmissionView(assignmentId, submissionId, currentUser.uid);
        if (didCount) submission.viewCount = Number(submission.viewCount ?? 0) + 1;
      } catch (error) {
        console.error("조회수 기록 오류:", error);
      }
    }

    renderSubmission(detail, canReadDetail);
  } catch (error) {
    console.error("제출글 조회 오류:", error);
    showStateMessage("글을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
  }
}

function renderSubmission(detail, canReadDetail) {
  const title = submission.title ?? "제목 없음";

  document.title = `${title} | 동아리 과제 제출`;
  postTitle.textContent = title;
  postAuthor.textContent = submission.authorName || "이름 없음";
  postViews.textContent = formatViewCount(submission.viewCount);
  postDate.textContent = formatDateTime(submission.createdAt);
  postUpdatedWrap.hidden = !submission.updatedAt;
  postUpdated.textContent = submission.updatedAt ? formatDateTime(submission.updatedAt) : "";

  if (canReadDetail) {
    postContent.textContent = detail?.content ?? "";
    postContent.classList.remove("board-post-locked");
    renderAttachments(detail?.attachments);
  } else {
    postContent.textContent = "낸 내용은 글쓴이 본인과 담당자만 볼 수 있습니다.";
    postContent.classList.add("board-post-locked");
    renderAttachments([]);
  }

  // 본인이 낸 글과 담당자, 관리자만 지울 수 있다.
  deleteButton.hidden = !(canOpenAll || submissionId === currentUser?.uid);

  // 본인 글은 제출 기간 안(또는 '마감 후 수정 허용' 과제)에서 고칠 수 있다.
  const canEdit = submissionId === currentUser?.uid && isSubmissionEditable(assignment);
  editLink.hidden = !canEdit;
  if (canEdit) {
    editLink.href = `/activity/submit/${encodeURIComponent(assignmentId)}?edit=1`;
  }

  article.hidden = false;
  stateMessage.hidden = true;
}

function renderAttachments(attachments) {
  const files = Array.isArray(attachments) ? attachments : [];

  attachmentList.textContent = "";
  attachmentSection.hidden = files.length === 0;

  files.forEach((attachment) => {
    const item = document.createElement("li");
    item.className = "board-attachment";

    const link = document.createElement("a");
    link.href = attachment.url ?? "#";
    link.textContent = attachment.name ?? "파일";
    link.rel = "noopener";
    // 링크를 눌러 바로 내려받게 한다.
    link.download = attachment.name ?? "";

    const size = document.createElement("span");
    size.className = "board-attachment-size";
    size.textContent = formatFileSize(attachment.size);

    item.append(link, size);
    attachmentList.appendChild(item);
  });
}

deleteButton.addEventListener("click", async () => {
  if (isDeleting) return;
  if (!window.confirm("제출한 글을 삭제할까요?")) return;

  isDeleting = true;
  deleteButton.disabled = true;
  deleteButton.textContent = "삭제 중...";

  try {
    // 글을 지우기 전에 붙여 둔 파일부터 정리한다.
    const detail = await getSubmissionDetail(assignmentId, submissionId).catch(() => null);
    await removeAttachments(detail?.attachments);
    await deleteSubmission(assignmentId, submissionId);
    window.location.replace(assignmentUrl);
  } catch (error) {
    console.error("제출글 삭제 오류:", error);
    isDeleting = false;
    deleteButton.disabled = false;
    deleteButton.textContent = "삭제";
    showStateMessage("글을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.", true);
  }
});

function showStateMessage(message, keepArticle = false) {
  stateMessage.textContent = message;
  stateMessage.hidden = false;

  if (!keepArticle) article.hidden = true;
}
