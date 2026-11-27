import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  updateDoc
} from "firebase/firestore";

import { auth, db } from "../firebase.js";
import { resourceList } from "../resources/resourceList.js";
import {
  formatAutoApproveAt,
  getAutoApprovalItems,
  saveAutoApprovalItems,
  settleDueAutoApprovals
} from "../resources/autoApproval.js";
import {
  createInfoLine,
  createStatusBadge,
  formatDateTime
} from "./adminUi.js";

const RESERVATIONS_COLLECTION = "resourceReservations";

const listElement = document.querySelector("#reservationAdminList");
const statusFilter = document.querySelector("#reservationAdminStatusFilter");
const refreshButton = document.querySelector("#reservationAdminRefreshButton");
const totalCount = document.querySelector("#reservationTotalCount");
const pendingCount = document.querySelector("#reservationPendingCount");
const approvedCount = document.querySelector("#reservationApprovedCount");
const rejectedCount = document.querySelector("#reservationRejectedCount");
const reviewNotice = document.querySelector("#reservationReviewNotice");
const autoApprovalPanel = document.querySelector("#autoApprovalPanel");
const autoApprovalList = document.querySelector("#autoApprovalList");
const autoApprovalMessage = document.querySelector("#autoApprovalMessage");

let reservations = [];
let isInitialized = false;
// 소위원장만 승인 · 반려를 처리할 수 있다. 임원은 열람만 한다.
let canReview = false;
// 자동승인 설정은 관리자만 바꾼다. (보안 규칙에서도 settings 쓰기를 관리자로 막는다)
let canConfigure = false;
let autoApprovalItems = {};

export function initResourceAdmin({
  canReview: canReviewReservations = false,
  canConfigure: canConfigureAutoApproval = false
} = {}) {
  canReview = canReviewReservations;
  canConfigure = canConfigureAutoApproval;
  setReviewNotice();
  autoApprovalPanel.hidden = !canConfigure;

  if (canConfigure) loadAutoApproval();

  if (isInitialized) return;
  isInitialized = true;

  statusFilter.addEventListener("change", renderReservations);
  refreshButton.addEventListener("click", loadResourceAdmin);
}

function setReviewNotice() {
  if (!reviewNotice) return;

  reviewNotice.hidden = canReview;
  reviewNotice.textContent = canReview
    ? ""
    : "소위원회 임원 권한입니다. 예약 신청 현황을 열람할 수 있고, 승인 · 반려는 소위원장만 처리할 수 있습니다.";
}

// ========================================
// 신청 항목별 자동승인 (관리자 전용)
// ========================================

async function loadAutoApproval() {
  autoApprovalMessage.textContent = "";
  autoApprovalItems = await getAutoApprovalItems();
  renderAutoApproval();
}

function renderAutoApproval() {
  autoApprovalList.textContent = "";

  ["공간", "장비", "물품"].forEach((category) => {
    const resources = resourceList.filter((resource) => resource.category === category);
    if (resources.length === 0) return;

    const group = document.createElement("fieldset");
    group.className = "auto-approval-group";

    const legend = document.createElement("legend");
    legend.textContent = category;
    group.appendChild(legend);

    resources.forEach((resource) => group.appendChild(createAutoApprovalRow(resource)));
    autoApprovalList.appendChild(group);
  });
}

function createAutoApprovalRow(resource) {
  const row = document.createElement("div");
  row.className = "auto-approval-row";

  const text = document.createElement("div");
  text.className = "auto-approval-text";

  const name = document.createElement("strong");
  name.textContent = resource.name;

  const state = document.createElement("span");
  const showState = () => {
    state.textContent = autoApprovalItems[resource.name] === true
      ? "자동승인 켜짐 · 신청 즉시 승인"
      : "자동승인 꺼짐 · 관리자 승인 대기";
  };
  showState();

  text.append(name, state);

  const toggle = document.createElement("label");
  toggle.className = "user-toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = autoApprovalItems[resource.name] === true;
  input.setAttribute("aria-label", `${resource.name} 자동승인`);

  const track = document.createElement("span");
  track.className = "user-toggle-track";

  input.addEventListener("change", async () => {
    const next = input.checked;
    const previous = { ...autoApprovalItems };
    const updated = { ...autoApprovalItems };

    if (next) updated[resource.name] = true;
    else delete updated[resource.name];

    input.disabled = true;
    autoApprovalMessage.textContent = "저장 중...";

    try {
      autoApprovalItems = await saveAutoApprovalItems(updated, auth.currentUser?.uid);
      showState();
      autoApprovalMessage.textContent =
        `${resource.name} 자동승인을 ${next ? "켰습니다" : "껐습니다"}. 이후 신규 신청부터 적용됩니다.`;
    } catch (error) {
      console.error("자동승인 설정 저장 오류:", error);
      autoApprovalItems = previous;
      input.checked = previous[resource.name] === true;
      showState();
      autoApprovalMessage.textContent = "설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.";
    } finally {
      input.disabled = false;
    }
  });

  toggle.append(input, track);
  row.append(text, toggle);
  return row;
}

export async function loadResourceAdmin() {
  listElement.textContent = "예약 신청을 불러오는 중...";

  try {
    const snapshot = await getDocs(collection(db, RESERVATIONS_COLLECTION));

    reservations = snapshot.docs
      .map((reservationDoc) => ({ id: reservationDoc.id, ...reservationDoc.data() }))
      .sort(compareReservations);

    // 접수 + 5분이 지난 자동승인 대기 신청을 승인으로 바꾼다.
    if (await settleDueAutoApprovals(reservations) > 0) {
      reservations.sort(compareReservations);
    }

    renderStats();
    renderReservations();
  } catch (error) {
    console.error("예약 신청 조회 오류:", error);
    listElement.textContent = "예약 신청을 불러오지 못했습니다.";
  }
}

// 대기 중인 신청을 먼저, 그다음 날짜순으로 보여준다.
function compareReservations(first, second) {
  const firstPending = getStatus(first) === "pending" ? 0 : 1;
  const secondPending = getStatus(second) === "pending" ? 0 : 1;

  if (firstPending !== secondPending) return firstPending - secondPending;

  return `${first.date ?? ""}${first.startTime ?? ""}`
    .localeCompare(`${second.date ?? ""}${second.startTime ?? ""}`);
}

function getStatus(reservation) {
  return reservation.status ?? "pending";
}

function renderStats() {
  totalCount.textContent = reservations.length.toLocaleString("ko-KR");
  pendingCount.textContent = countByStatus("pending");
  approvedCount.textContent = countByStatus("approved");
  rejectedCount.textContent = countByStatus("rejected");
}

function countByStatus(status) {
  return reservations.filter((reservation) => getStatus(reservation) === status).length;
}

function renderReservations() {
  const selectedStatus = statusFilter.value;
  const filtered = reservations.filter((reservation) => (
    !selectedStatus || getStatus(reservation) === selectedStatus
  ));

  listElement.textContent = "";

  if (filtered.length === 0) {
    listElement.textContent = selectedStatus
      ? "해당 상태의 예약 신청이 없습니다."
      : "아직 접수된 예약 신청이 없습니다.";
    return;
  }

  filtered.forEach((reservation) => listElement.appendChild(createReservationCard(reservation)));
}

function createReservationCard(reservation) {
  const status = getStatus(reservation);

  const card = document.createElement("article");
  card.className = `admin-card reservation-admin-card status-${status}`;

  const title = document.createElement("h2");
  title.textContent = reservation.resourceName ?? "자원명 없음";

  const clubName = createInfoLine("동아리 이름", reservation.clubName ?? "동아리명 없음");
  const requesterName = createInfoLine("신청자명", reservation.requesterName || "입력된 이름 없음");
  const category = createInfoLine("카테고리", reservation.category ?? "카테고리 없음");
  const schedule = createInfoLine(
    "사용 일시",
    `${reservation.date ?? "날짜 미정"} ${reservation.startTime ?? ""}~${reservation.endTime ?? ""}`.trim()
  );

  const purpose = createInfoLine("사용 목적", reservation.purpose ?? "입력된 내용 없음");
  purpose.classList.add("admin-card-message");

  const createdAt = createInfoLine("신청 시간", formatDateTime(reservation.createdAt));
  // 자동승인 항목은 접수 + 5분에 승인된다. 그 전에 직접 승인 · 반려할 수도 있다.
  const autoApproveAt = formatAutoApproveAt(reservation);
  const badge = createStatusBadge(
    status === "approved" && reservation.autoApproved === true
      ? "자동 승인됨"
      : autoApproveAt
        ? `자동승인 예정 ${autoApproveAt}`
        : getStatusName(status),
    status
  );

  const memoLabel = document.createElement("label");
  memoLabel.className = "admin-memo-label";
  memoLabel.textContent = canReview
    ? "승인 / 반려 사유"
    : "승인 / 반려 사유 (읽기 전용)";

  const memoInput = document.createElement("textarea");
  memoInput.placeholder = canReview
    ? "승인 의견 또는 반려 사유를 입력하세요. 신청자에게만 표시됩니다."
    : "소위원장이 남긴 사유가 없습니다.";
  memoInput.value = reservation.adminMemo ?? "";
  memoInput.readOnly = !canReview;
  memoLabel.appendChild(memoInput);

  const message = document.createElement("p");
  message.className = "message admin-card-message-line";

  const actions = document.createElement("div");
  actions.className = "admin-card-actions";

  const approveButton = document.createElement("button");
  approveButton.type = "button";
  approveButton.textContent = "승인";

  const rejectButton = document.createElement("button");
  rejectButton.type = "button";
  rejectButton.className = "danger";
  rejectButton.textContent = "반려";

  approveButton.addEventListener("click", () => review("approved"));
  rejectButton.addEventListener("click", () => review("rejected"));

  async function review(nextStatus) {
    const memo = memoInput.value.trim();

    if (nextStatus === "rejected" && !memo) {
      message.textContent = "반려 사유를 입력해주세요.";
      return;
    }

    approveButton.disabled = true;
    rejectButton.disabled = true;
    message.textContent = "처리 중...";

    try {
      await updateDoc(doc(db, RESERVATIONS_COLLECTION, reservation.id), {
        status: nextStatus,
        adminMemo: memo,
        reviewedAt: serverTimestamp()
      });

      await loadResourceAdmin();
    } catch (error) {
      console.error("예약 상태 변경 오류:", error);
      message.textContent = "예약 상태를 변경하지 못했습니다. 잠시 후 다시 시도해주세요.";
      approveButton.disabled = false;
      rejectButton.disabled = false;
    }
  }

  // 소위원장만 처리 버튼을 볼 수 있다.
  if (canReview) {
    actions.append(approveButton, rejectButton);
  }

  card.append(title, clubName, requesterName, category, schedule, purpose, createdAt, badge, memoLabel);

  if (canReview) {
    card.append(actions);
  }

  card.append(message);

  if (reservation.reviewedAt) {
    card.insertBefore(createInfoLine("처리 시간", formatDateTime(reservation.reviewedAt)), badge);
  }

  return card;
}

function getStatusName(status) {
  return ({
    approved: "승인됨",
    rejected: "반려됨",
    completed: "사용 완료",
    pending: "승인 대기"
  })[status] ?? "승인 대기";
}
