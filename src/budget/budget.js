import "../styles/site.css";
import "../styles/neoul/budget.css";

import { guardPage } from "../pageGuard.js";
import { EXECUTIVE_ROLE, getClubLeaderOf } from "../userRole.js";
import { markSectionRead } from "../notifications/readState.js";
import { mountPageBell } from "../notifications/bell.js";
import { createClubTag, fillClubSelect } from "../clubList.js";
import { setupPasswordToggle } from "../passwordToggle.js";
import {
  createBudgetRequest,
  getRequestPasswordHash,
  hashRequestPassword,
  isItemProcessed,
  isPartiallyProcessed,
  readItems,
  sumApprovedAmount,
  subscribeToAllBudgetRequests,
  subscribeToMyBudgetRequests
} from "./budgetService.js";
import {
  clearDraft,
  formatAmount,
  readDraft,
  writeDraft
} from "./requestDraft.js";
import {
  ITEM_KINDS,
  createRequestSheet,
  formatMoney,
  sumByKind,
  sumItems
} from "./requestSheet.js";
import { downloadTemplate, readWorkbook } from "./requestExcel.js";
import {
  URGENT_POLICY,
  formatShortDate,
  getMeetingDate,
  getRequestType,
  hasUsedUrgentThisMonth,
  toDateKey,
  validateUrgentRequest
} from "./budgetPolicy.js";


const form = document.querySelector("#budgetRequestForm");
const submitButton = document.querySelector("#budgetSubmitButton");
const resultMessage = document.querySelector("#budgetResultMessage");
const clubNameSelect = document.querySelector("#clubName");
const requesterNameInput = document.querySelector("#requesterName");
const requestPasswordInput = document.querySelector("#requestPassword");
const requestPasswordToggle = document.querySelector("#requestPasswordToggle");

const sheetBody = document.querySelector("#budgetSheetBody");
const itemsTotal = document.querySelector("#budgetItemsTotal");
const itemsCount = document.querySelector("#budgetItemsCount");
const kindTotals = document.querySelector("#budgetKindTotals");
const sheetError = document.querySelector("#budgetSheetError");
const templateButton = document.querySelector("#budgetTemplateButton");
const uploadButton = document.querySelector("#budgetUploadButton");
const uploadInput = document.querySelector("#budgetUploadInput");
const addRowButton = document.querySelector("#budgetAddRowButton");

const authMessage = document.querySelector("#budgetAuthMessage");
const myRequestsList = document.querySelector("#myBudgetRequestsList");
const budgetRecordList = document.querySelector("#budgetRecordList");
const budgetRecordCard = document.querySelector("#budgetRecordCard");

// 신청 종류 (일반 · 긴급)
const typeRadios = [...document.querySelectorAll('input[name="requestType"]')];
const urgentRadio = document.querySelector("#budgetUrgentRadio");
const urgentQuota = document.querySelector("#budgetUrgentQuota");
const normalNote = document.querySelector("#budgetNormalNote");
const urgentBox = document.querySelector("#budgetUrgentBox");
const urgentNeededBy = document.querySelector("#urgentNeededBy");
const urgentReason = document.querySelector("#urgentReason");
const urgentReasonCount = document.querySelector("#urgentReasonCount");

let isSubmitting = false;
let draft = { clubName: "", requesterName: "", items: [] };
let unsubscribeFromMyBudgetRequests = null;
let unsubscribeFromAllBudgetRequests = null;
let canSeeAllRecords = false;
let requestType = "normal";
let urgentUsedThisMonth = false;

fillClubSelect(clubNameSelect);
setupPasswordToggle(requestPasswordInput, requestPasswordToggle);

// 품목 표. 값이 바뀔 때마다 소계와 합계를 다시 그리고 임시 저장한다.
const sheet = createRequestSheet({
  tableBody: sheetBody,
  onChange: (items) => {
    draft.items = items;
    renderTotals(items);
    saveDraft();
  }
});

templateButton.addEventListener("click", async () => {
  templateButton.disabled = true;

  try {
    await downloadTemplate();
  } catch (error) {
    console.error("신청 양식 내려받기 오류:", error);
    resultMessage.textContent = "양식을 내려받지 못했습니다. 잠시 후 다시 시도해주세요.";
  } finally {
    templateButton.disabled = false;
  }
});

uploadButton.addEventListener("click", () => uploadInput.click());

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;

  resultMessage.textContent = "엑셀 파일을 읽는 중...";

  try {
    sheet.setItems(await readWorkbook(file));
    resultMessage.textContent = `${file.name} 의 내용을 표에 채웠습니다. 확인 후 신청해주세요.`;
  } catch (error) {
    console.error("엑셀 파일 읽기 오류:", error);
    resultMessage.textContent = "엑셀 파일을 읽지 못했습니다. 신청 양식과 같은 열 순서인지 확인해주세요.";
  } finally {
    uploadInput.value = "";
  }
});

addRowButton.addEventListener("click", () => sheet.addRow());

// ========================================
// 신청 종류 (일반 · 긴급)
// ========================================

setupRequestType();

function setupRequestType() {
  const meeting = getMeetingDate();
  document.querySelectorAll("[data-meeting-label]").forEach((element) => {
    element.textContent = formatShortDate(meeting);
  });

  // 긴급은 오늘부터 다음 회의 전날까지만 고를 수 있다.
  const lastDay = new Date(meeting);
  lastDay.setDate(lastDay.getDate() - 1);
  urgentNeededBy.min = toDateKey(new Date());
  urgentNeededBy.max = toDateKey(lastDay);

  typeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setRequestType(radio.value);
    });
  });

  urgentReason.addEventListener("input", renderReasonCount);
  renderReasonCount();
}

function setRequestType(nextType) {
  requestType = nextType === "urgent" && !urgentUsedThisMonth ? "urgent" : "normal";

  typeRadios.forEach((radio) => {
    radio.checked = radio.value === requestType;
  });

  const isUrgent = requestType === "urgent";
  urgentBox.hidden = !isUrgent;
  normalNote.hidden = isUrgent;
  form.classList.toggle("is-urgent", isUrgent);
  submitButton.textContent = isUrgent ? "긴급 신청 보내기" : "예산 신청";
  renderTotals(sheet.getItems());
}

function renderReasonCount() {
  const length = urgentReason.value.trim().length;
  urgentReasonCount.textContent = `${length} / ${URGENT_POLICY.minReasonLength}자 이상`;
  urgentReasonCount.classList.toggle("is-ok", length >= URGENT_POLICY.minReasonLength);
}

// 이 동아리가 이번 달 긴급 신청을 썼는지 확인해서 선택지를 막는다.
async function refreshUrgentQuota() {
  const clubName = clubNameSelect.value;

  if (!clubName) {
    urgentUsedThisMonth = false;
    urgentQuota.textContent = "한 달에 1번";
    return;
  }

  try {
    urgentUsedThisMonth = await hasUsedUrgentThisMonth(clubName);
  } catch (error) {
    console.error("긴급 신청 횟수 확인 오류:", error);
    urgentUsedThisMonth = false;

    // 서버 규칙이 옛 버전이면 신청이 저장되지 않는다. 미리 알려 준다.
    if (error?.message === "rules-not-deployed") {
      resultMessage.textContent = "지금은 신청이 저장되지 않아요. 서버 보안 규칙(firestore.rules)이 아직 배포되지 않았어요. 관리자에게 알려주세요.";
    }
  }

  urgentRadio.disabled = urgentUsedThisMonth;
  urgentRadio.closest(".budget-type-option").classList.toggle("is-used", urgentUsedThisMonth);
  urgentQuota.textContent = urgentUsedThisMonth ? "이번 달 사용함" : "이번 달 1번 가능";

  if (urgentUsedThisMonth && requestType === "urgent") setRequestType("normal");
}

guardPage({
  onReady: ({ user, role, profile }) => {
    unsubscribeFromMyBudgetRequests?.();
    unsubscribeFromAllBudgetRequests?.();

    // 최근 기록은 연합회 임원에게만 보여준다.
    // (전체 동아리 예산 현황은 관리자 화면 '01 예산 관리'로 옮겼다.)
    canSeeAllRecords = role === EXECUTIVE_ROLE;
    budgetRecordCard.hidden = !canSeeAllRecords;

    // 예산 신청은 동아리 부장(과 관리자)만 할 수 있다. 규칙에서도 같은 조건으로 막는다.
    const leaderClub = getClubLeaderOf(profile);
    const canRequest = profile?.isAdmin === true || Boolean(leaderClub);

    submitButton.disabled = !canRequest;
    authMessage.textContent = canRequest
      ? `로그인 계정: ${user.email ?? "이메일 정보 없음"}`
      : "동아리 부장만 예산을 신청할 수 있습니다. 부장 지정은 연합회에 문의해주세요.";

    // 부장은 자기 동아리로 고정된다. 관리자만 고를 수 있다.
    if (leaderClub && profile?.isAdmin !== true) {
      clubNameSelect.value = leaderClub;
      clubNameSelect.disabled = true;
      draft.clubName = leaderClub;
    }

    form.classList.toggle("is-locked", !canRequest);

    mountPageBell(user);
    restoreDraft();
    refreshUrgentQuota();

    // 계정에 저장된 이름을 신청자명에 미리 넣어 준다. 고쳐 쓸 수 있다.
    if (!requesterNameInput.value) {
      requesterNameInput.value = String(profile?.name ?? "").trim();
      saveDraft();
    }
    subscribeToBudgetRequests(user.uid);

    // 이 화면을 열었으므로 '내 예산 신청' 알림을 읽은 것으로 표시한다.
    markSectionRead("budget");
  }
});

// ========================================
// 작성 중인 신청서 (항목 추가 페이지를 다녀와도 유지된다)
// ========================================

function restoreDraft() {
  draft = readDraft();

  if (draft.clubName) clubNameSelect.value = draft.clubName;
  requesterNameInput.value = draft.requesterName;

  if (draft.items.length > 0) sheet.setItems(draft.items);
}

function saveDraft() {
  draft.clubName = clubNameSelect.value;
  draft.requesterName = requesterNameInput.value;
  writeDraft(draft);
}

clubNameSelect.addEventListener("change", () => {
  saveDraft();
  refreshUrgentQuota();
});
requesterNameInput.addEventListener("input", saveDraft);

function renderTotals(items) {
  const total = sumItems(items);
  const byKind = sumByKind(items);

  itemsTotal.textContent = `₩${formatMoney(total)}`;
  itemsCount.textContent = `${items.length}개 품목 · 합계`;

  // 긴급 신청은 상한을 넘으면 합계를 빨갛게 표시한다.
  const overUrgentCap = requestType === "urgent" && total > URGENT_POLICY.maxAmount;
  itemsTotal.classList.toggle("is-over", overUrgentCap);
  itemsCount.textContent = overUrgentCap
    ? `긴급 상한 ₩${formatMoney(URGENT_POLICY.maxAmount)} 초과 · 합계`
    : `${items.length}개 품목 · 합계`;

  kindTotals.textContent = "";

  ITEM_KINDS.forEach((kind) => {
    if (byKind[kind] <= 0) return;

    const chip = document.createElement("span");
    chip.className = `budget-kind-chip is-${ITEM_KINDS.indexOf(kind) + 1}`;
    chip.textContent = `${kind} ${formatMoney(byKind[kind])}`;
    kindTotals.appendChild(chip);
  });
}


// ========================================
// 신청
// ========================================

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isSubmitting) return;

  saveDraft();

  if (!draft.clubName) {
    resultMessage.textContent = "동아리명을 선택해주세요.";
    return;
  }

  if (!draft.requesterName.trim()) {
    resultMessage.textContent = "신청자명을 입력해주세요.";
    return;
  }

  // 칸 단위로 검사해서 첫 번째 문제를 그 자리에 표시한다.
  const sheetProblem = sheet.validate();
  sheetError.textContent = sheetProblem ? `⚠ ${sheetProblem}` : "";

  if (sheetProblem) {
    resultMessage.textContent = "표에서 빨갛게 표시된 칸을 고쳐주세요.";
    return;
  }

  const isUrgent = requestType === "urgent";

  if (isUrgent) {
    if (urgentUsedThisMonth) {
      resultMessage.textContent = "이번 달 긴급 신청을 이미 썼어요. 일반 신청으로 내주세요.";
      return;
    }

    const urgentProblem = validateUrgentRequest({
      amount: sumItems(sheet.getItems()),
      reason: urgentReason.value,
      neededBy: urgentNeededBy.value
    });

    if (urgentProblem) {
      resultMessage.textContent = urgentProblem;
      return;
    }
  }

  const password = requestPasswordInput.value;

  if (!password.trim()) {
    resultMessage.textContent = "신청 비밀번호를 입력해주세요.";
    return;
  }

  isSubmitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "신청 중...";
  resultMessage.textContent = "";

  try {
    const savedHash = await getRequestPasswordHash();
    const inputHash = await hashRequestPassword(password);

    if (!savedHash) {
      resultMessage.textContent = "아직 신청 비밀번호가 설정되지 않았습니다. 관리자에게 문의해주세요.";
      return;
    }

    if (savedHash !== inputHash) {
      resultMessage.textContent = "신청 비밀번호가 일치하지 않습니다.";
      requestPasswordInput.select();
      return;
    }

    await createBudgetRequest({
      clubName: draft.clubName,
      requesterName: draft.requesterName,
      items: sheet.getItems(),
      requestPasswordHash: inputHash,
      requestType,
      urgentReason: urgentReason.value,
      neededBy: urgentNeededBy.value
    });

    clearDraft();
    requestPasswordInput.value = "";
    draft = { clubName: clubNameSelect.value, requesterName: requesterNameInput.value, items: [] };
    sheet.setItems([]);

    resultMessage.textContent = isUrgent
      ? "긴급 신청을 보냈어요. 연합회장이나 예산 소위원장이 확인하면 알림이 와요."
      : `예산 신청이 완료되었습니다. ${formatShortDate(getMeetingDate())} 회의에서 심의해요.`;

    if (isUrgent) {
      urgentReason.value = "";
      urgentNeededBy.value = "";
      renderReasonCount();
      await refreshUrgentQuota();
    }
  } catch (error) {
    console.error(error);
    // 긴급 신청이 규칙에 걸리면 대부분 이번 달 횟수를 이미 쓴 경우다.
    resultMessage.textContent = isUrgent && error?.code === "permission-denied"
      ? "긴급 신청 조건에 맞지 않아요. 이번 달에 이미 썼거나 금액 · 사유를 다시 확인해주세요."
      : "예산 신청 중 오류가 발생했습니다.";
    if (isUrgent) refreshUrgentQuota();
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = requestType === "urgent" ? "긴급 신청 보내기" : "예산 신청";
  }
});

// ========================================
// 기록 불러오기
// ========================================

function subscribeToBudgetRequests(uid) {
  myRequestsList.textContent = "내 예산 신청을 불러오는 중...";

  if (canSeeAllRecords) {
    budgetRecordList.textContent = "예산 기록을 불러오는 중...";
  }

  unsubscribeFromMyBudgetRequests = subscribeToMyBudgetRequests(
    uid,
    renderMyBudgetRequests,
    (error) => {
      console.error("내 예산 신청 조회 오류:", error);
      myRequestsList.textContent = "내 예산 신청을 불러오지 못했습니다.";
    }
  );

  // 일반 계정은 전체 기록을 읽을 수 없다. 구독 자체를 걸지 않는다.
  if (!canSeeAllRecords) return;

  unsubscribeFromAllBudgetRequests = subscribeToAllBudgetRequests(
    renderBudgetDashboard,
    (error) => {
      console.error("전체 예산 기록 조회 오류:", error);
      resetBudgetDashboard("예산 기록을 불러오지 못했습니다.");
    }
  );
}

function renderBudgetDashboard(budgetRequests) {
  renderRecentBudgetRecords(
    budgetRequests
      .filter(({ status }) => ["approved", "confirmed", "completed", "assembly"].includes(status))
      .sort((first, second) => getTimestamp(second.reviewedAt ?? second.createdAt) - getTimestamp(first.reviewedAt ?? first.createdAt))
      .slice(0, 8)
  );
}

function renderRecentBudgetRecords(budgetRequests) {
  budgetRecordList.textContent = "";

  if (budgetRequests.length === 0) {
    budgetRecordList.textContent = "승인 · 연합회장 확인 · 처리 완료 · 본 회의 안건 상정 기록이 없습니다.";
    return;
  }

  budgetRequests.forEach((budgetRequest) => {
    const items = readItems(budgetRequest);
    const item = document.createElement("li");
    item.className = `budget-record-item status-${budgetRequest.status ?? "approved"}`;

    const details = document.createElement("div");
    details.className = "budget-record-details";

    // 제목과 상태 배지를 같은 줄에 둔다.
    const head = document.createElement("div");
    head.className = "budget-record-head";

    const heading = document.createElement("strong");
    heading.className = "budget-record-title";
    heading.textContent = summarizeItems(items);
    heading.title = heading.textContent;

    const statusBadge = document.createElement("span");
    statusBadge.className = `budget-record-badge status-${budgetRequest.status ?? "approved"}`;
    statusBadge.textContent = getRequestStatusName(budgetRequest);

    head.append(heading, statusBadge);

    if (getRequestType(budgetRequest) === "urgent") {
      head.insertBefore(createTypeChip("urgent"), statusBadge);
    }

    // 동아리마다 색을 달리해 어느 동아리 신청인지 바로 보이게 한다.
    const metadata = document.createElement("div");
    metadata.className = "budget-record-meta";
    metadata.append(
      createClubTag(budgetRequest.clubName),
      document.createTextNode(
        `${budgetRequest.requesterName ?? "신청자 미상"} · ${formatDate(budgetRequest.reviewedAt ?? budgetRequest.createdAt)}`
      )
    );

    const amount = document.createElement("b");
    amount.textContent = formatAmount(budgetRequest.amount);

    details.append(head, metadata);
    item.append(details, amount);
    budgetRecordList.appendChild(item);
  });
}

function summarizeItems(items) {
  if (items.length === 0) return "신청 물품 없음";
  const first = items[0].itemName || "물품 이름 없음";
  return items.length > 1 ? `${first} 외 ${items.length - 1}건` : first;
}

function resetBudgetDashboard(message = "예산 기록을 불러오지 못했습니다.") {
  budgetRecordList.textContent = message;
}

function renderMyBudgetRequests(budgetRequests) {
  myRequestsList.textContent = "";

  if (budgetRequests.length === 0) {
    myRequestsList.textContent = "아직 제출한 예산 신청이 없습니다.";
    return;
  }

  budgetRequests.forEach((budgetRequest) => {
    const items = readItems(budgetRequest);
    const item = document.createElement("li");
    item.className = `my-budget-request status-${budgetRequest.status ?? "pending"}`;

    const heading = document.createElement("div");
    heading.append(createClubTag(budgetRequest.clubName));

    const type = getRequestType(budgetRequest);
    heading.appendChild(createTypeChip(type));

    const summary = document.createElement("span");
    summary.textContent = summarizeItems(items);
    heading.appendChild(summary);

    const status = budgetRequest.status ?? "pending";
    const statusChip = document.createElement("span");
    statusChip.className = `nu-chip is-${status}`;
    statusChip.textContent = getRequestStatusName(budgetRequest);
    heading.appendChild(statusChip);

    const itemBoxes = document.createElement("ul");
    itemBoxes.className = "budget-item-list is-readonly";

    // 품목마다 따로 심사되므로 결과와 반려 사유를 품목 옆에 보여준다.
    items.forEach((entry) => {
      const itemStatus = String(entry.status ?? "pending");
      const box = document.createElement("li");
      box.className = `budget-item-card is-${itemStatus}`;

      const name = document.createElement("strong");
      name.textContent = entry.itemName || "물품 이름 없음";

      const badge = document.createElement("span");
      badge.className = `review-status is-${itemStatus}`;
      badge.textContent = itemStatus === "approved" && isItemProcessed(entry)
        ? "처리 완료"
        : ({ approved: "승인", rejected: "반려" })[itemStatus] ?? "대기";

      const amount = document.createElement("span");
      amount.className = "budget-item-amount";
      amount.textContent = formatAmount(entry.amount);

      box.append(name, badge, amount);

      if (itemStatus === "rejected" && String(entry.reviewMemo ?? "").trim()) {
        const memo = document.createElement("p");
        memo.className = "budget-item-memo";
        memo.textContent = `반려 사유: ${entry.reviewMemo}`;
        box.appendChild(memo);
      }

      itemBoxes.appendChild(box);
    });

    const details = document.createElement("div");
    details.className = "my-budget-request-details";
    details.append(
      createDetail("총 신청 금액", formatAmount(budgetRequest.amount)),
      createDetail("승인 금액", formatAmount(sumApprovedAmount(budgetRequest))),
      createDetail("신청일", formatDate(budgetRequest.createdAt)),
      ...(type === "urgent"
        ? [
          createDetail("필요한 날짜", formatShortDate(budgetRequest.neededBy)),
          createDetail("긴급 사유", budgetRequest.urgentReason || "-")
        ]
        : budgetRequest.meetingDate
          ? [createDetail("심의 회의", `${formatShortDate(budgetRequest.meetingDate)} 예산 소위원회`)]
          : []),
      createDetail("처리 상태", getRequestStatusName(budgetRequest)),
      createDetail("관리자 의견", budgetRequest.adminMemo?.trim() || "등록된 의견이 없습니다.")
    );

    item.append(heading, itemBoxes, details);
    myRequestsList.appendChild(item);
  });
}

function createTypeChip(type) {
  const chip = document.createElement("span");
  chip.className = `budget-type-chip is-${type}`;
  chip.textContent = type === "urgent" ? "긴급" : "일반";
  return chip;
}

function createDetail(label, value) {
  const paragraph = document.createElement("p");
  const labelElement = document.createElement("b");
  labelElement.textContent = `${label}: `;
  paragraph.append(labelElement, document.createTextNode(value));
  return paragraph;
}

// 연합회장 확인 뒤 일부 품목만 처리됐으면 '부분 처리 완료'로 보여 준다.
function getRequestStatusName(budgetRequest) {
  return isPartiallyProcessed(budgetRequest)
    ? "부분 처리 완료"
    : getStatusName(budgetRequest?.status);
}

function getStatusName(status) {
  return ({
    approved: "승인됨",
    partial: "부분 승인",
    confirmed: "연합회장 확인 완료",
    completed: "처리 완료",
    rejected: "반려됨",
    assembly: "본 회의 안건 상정",
    pending: "승인 대기"
  })[status] ?? "승인 대기";
}

function formatDate(timestamp) {
  if (!timestamp) return "신청일 정보 없음";
  const date = typeof timestamp.toDate === "function" ? timestamp.toDate() : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "신청일 정보 없음" : date.toLocaleString("ko-KR");
}

function getTimestamp(timestamp) {
  if (timestamp && typeof timestamp.toMillis === "function") {
    return timestamp.toMillis();
  }

  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? 0 : value;
}
