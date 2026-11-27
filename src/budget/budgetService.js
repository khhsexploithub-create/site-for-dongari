import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";

import { auth, db } from "../firebase.js";
import { getMeetingDate, getUrgentMonthKey, getUrgentUsageId, toDateKey } from "./budgetPolicy.js";

const SETTINGS_DOC = ["settings", "budgetRequest"];

// 신청 비밀번호는 그대로 저장하지 않고 해시만 남긴다.
// salt 는 코드에 고정해 두어, 비밀번호를 모르면 같은 해시를 만들 수 없게 한다.
const PASSWORD_SALT = "neoul-budget-request";

export async function hashRequestPassword(password) {
  const encoded = new TextEncoder().encode(`${PASSWORD_SALT}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// 관리자가 설정해 둔 신청 비밀번호가 있는지 확인한다.
export async function getRequestPasswordHash() {
  const snapshot = await getDoc(doc(db, ...SETTINGS_DOC));
  return snapshot.exists() ? (snapshot.data().passwordHash ?? "") : "";
}

// 관리자 전용. 신청 비밀번호를 새로 정한다.
export async function saveRequestPassword(password) {
  await setDoc(doc(db, ...SETTINGS_DOC), {
    passwordHash: await hashRequestPassword(password),
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.uid ?? ""
  });
}

// requestType: "normal" (토요일 회의 심의) | "urgent" (긴급 — 바로 승인 가능, 규칙 적용)
export async function createBudgetRequest({
  clubName,
  requesterName,
  items,
  requestPasswordHash,
  requestType = "normal",
  urgentReason = "",
  neededBy = ""
}) {
  const user = auth.currentUser;
  // 현황표와 같은 모양으로 담는다. 금액은 수량 × 단가로 계산해 함께 저장한다.
  const cleanedItems = items.map((item) => {
    const quantity = Math.max(1, Number(item.quantity) || 0);
    const unitPrice = Math.max(0, Number(item.unitPrice) || 0);

    return {
      kind: String(item.kind ?? "재료").trim() || "재료",
      itemName: String(item.itemName ?? "").trim(),
      quantity,
      unitPrice,
      amount: quantity * unitPrice,
      purchaseLink: String(item.purchaseLink ?? "").trim(),
      description: String(item.description ?? "").trim(),
      isShipping: item.isShipping === true,
      // 품목마다 따로 승인 · 반려할 수 있다.
      status: "pending",
      reviewMemo: ""
    };
  });

  const isUrgent = requestType === "urgent";
  const trimmedClubName = clubName.trim();
  const now = new Date();
  const requestRef = doc(collection(db, "budgetRequests"));
  const batch = writeBatch(db);

  batch.set(requestRef, {
    requesterUid: user?.uid ?? "",
    clubName: trimmedClubName,
    requesterName: requesterName.trim(),
    items: cleanedItems,
    // 합계는 목록과 통계에서 그대로 쓰이므로 함께 저장한다.
    amount: cleanedItems.reduce((total, item) => total + item.amount, 0),
    requestPasswordHash,
    requestType: isUrgent ? "urgent" : "normal",
    // 일반 신청은 심의할 회의, 긴급 신청은 사후 보고할 회의
    meetingDate: toDateKey(getMeetingDate(now)),
    urgentReason: isUrgent ? String(urgentReason).trim() : "",
    neededBy: isUrgent ? String(neededBy) : "",
    status: "pending",
    adminMemo: "",
    createdAt: serverTimestamp(),
    reviewedAt: null
  });

  // 긴급 신청은 동아리마다 한 달에 한 번. 이 달의 사용 기록을 같이 만든다.
  // 이미 있으면 규칙에서 둘 다 거절된다.
  if (isUrgent) {
    batch.set(doc(db, "budgetUrgentUsage", getUrgentUsageId(trimmedClubName, now)), {
      clubName: trimmedClubName,
      monthKey: getUrgentMonthKey(now),
      requestId: requestRef.id,
      requesterUid: user?.uid ?? "",
      createdAt: serverTimestamp()
    });
  }

  await batch.commit();
  return requestRef.id;
}

// 모든 구성원이 올린 예산 기록을 함께 본다.
export function subscribeToAllBudgetRequests(onUpdate, onError) {
  return onSnapshot(
    collection(db, "budgetRequests"),
    (snapshot) => onUpdate(toSortedBudgetRequests(snapshot)),
    onError
  );
}

export function subscribeToMyBudgetRequests(uid, onUpdate, onError) {
  const budgetRequestsQuery = query(
    collection(db, "budgetRequests"),
    where("requesterUid", "==", uid)
  );

  return onSnapshot(
    budgetRequestsQuery,
    (snapshot) => onUpdate(toSortedBudgetRequests(snapshot)),
    onError
  );
}

// 품목별 상태에서 신청서 전체 상태를 뽑아낸다.
//   모두 승인 → approved · 모두 반려 → rejected · 섞여 있으면 partial
export function deriveRequestStatus(items) {
  const list = (items ?? []).filter((item) => item);

  if (list.length === 0) return "pending";
  if (list.some((item) => (item.status ?? "pending") === "pending")) return "pending";

  const approved = list.filter((item) => item.status === "approved").length;

  if (approved === list.length) return "approved";
  if (approved === 0) return "rejected";
  return "partial";
}

// 승인된 품목의 금액만 더한다. 예산 현황은 이 값을 쓴다.
export function sumApprovedAmount(budgetRequest) {
  const items = readItems(budgetRequest);
  const approved = items.filter((item) => item.status === "approved");

  if (approved.length === 0) {
    // 품목별 상태가 없던 시절 기록은 신청서 상태를 그대로 따른다.
    return items.some((item) => item.status) ? 0 : (Number(budgetRequest?.amount) || 0);
  }

  return approved.reduce((total, item) => total + (Number(item.amount) || 0), 0);
}

// ========================================
// 승인 이후의 흐름
//   신청(pending) → 승인(approved · partial) → 연합회장 확인(confirmed) → 처리 → 처리 완료(completed)
//   '처리'는 선생님이 실제로 구매하는 단계라 따로 저장하지 않는다. (연합회장 확인 뒤 처리 완료 전)
//   [부분 처리 완료] 일부 품목만 먼저 산 경우 그 품목에 processed: true 를 남긴다.
//   신청서 상태는 confirmed 그대로이고, 남은 품목까지 끝나면 completed 가 된다.
// ========================================

// 처리(구매)할 품목. 품목별 상태가 없던 옛 기록은 신청서가 승인됐으므로 모두 산다.
export function getProcessTargets(budgetRequest) {
  const items = readItems(budgetRequest);
  const hasItemStatus = items.some((item) => item?.status);

  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !hasItemStatus || item?.status === "approved");
}

export function isItemProcessed(item) {
  return item?.processed === true;
}

// 처리 진행 정도. 처리 완료(completed)면 모두 끝난 것으로 본다.
export function getProcessProgress(budgetRequest) {
  const targets = getProcessTargets(budgetRequest);
  const isCompleted = budgetRequest?.status === "completed";
  const processed = targets.filter(({ item }) => isCompleted || isItemProcessed(item));

  return {
    total: targets.length,
    done: processed.length,
    doneAmount: processed.reduce((sum, { item }) => sum + (Number(item.amount) || 0), 0),
    remaining: targets.filter(({ item }) => !isCompleted && !isItemProcessed(item))
  };
}

// 연합회장 확인 뒤 일부 품목만 처리된 상태
export function isPartiallyProcessed(budgetRequest) {
  if (budgetRequest?.status !== "confirmed") return false;
  const { done, total } = getProcessProgress(budgetRequest);
  return done > 0 && done < total;
}

// 승인 예산에 들어가는 신청서 상태. 반려 · 대기 · 본 회의 안건은 빠진다.
export const APPROVED_FLOW_STATUSES = ["approved", "partial", "confirmed", "completed"];

// 연합회장 확인을 받을 수 있는 상태 (승인된 품목이 하나 이상)
export const CONFIRMABLE_STATUSES = ["approved", "partial"];

// 승인된 품목이 어느 것인지 나타내는 열쇠. 확인 뒤 승인 품목이 바뀌었는지 비교한다.
export function getApprovedItemsKey(items) {
  return (items ?? [])
    .map((item, index) => (item?.status === "approved" ? index : -1))
    .filter((index) => index >= 0)
    .join(",");
}

// 품목 심사를 저장할 때 신청서 상태를 정한다.
// 연합회장 확인 · 처리 완료 뒤에 반려 사유만 고치는 등 '승인 품목이 그대로'면 그 상태를 지킨다.
// 승인 품목이 바뀌면(예: 승인했던 품목을 반려) 확인을 다시 받아야 하므로 품목 기준 상태로 돌아간다.
export function resolveReviewedStatus(previousStatus, previousApprovedKey, items) {
  const derived = deriveRequestStatus(items);

  if (
    ["confirmed", "completed"].includes(previousStatus)
    && ["approved", "partial"].includes(derived)
    && getApprovedItemsKey(items) === previousApprovedKey
  ) {
    return previousStatus;
  }

  return derived;
}

// 예산 현황 집계. 품목 단위 승인 금액으로 계산하므로
// 승인했다가 반려한 품목 · 신청서는 상태가 바뀌는 즉시 합계에서 빠진다.
export function summarizeBudget(budgetRequests) {
  const summary = {
    approvedTotal: 0,      // 승인 예산 (승인 · 부분 승인 · 연합회장 확인 · 처리 완료)
    approvedCount: 0,
    awaitingConfirm: 0,    // 연합회장 확인 대기 금액
    awaitingConfirmCount: 0,
    confirmed: 0,          // 연합회장 확인 완료 · 처리 대기 금액
    confirmedCount: 0,
    completedTotal: 0,     // 처리 완료 예산 (부분 처리 완료된 품목 금액 포함)
    completedCount: 0,
    partialCount: 0,       // 부분 처리 완료 신청서
    rejectedCount: 0       // 반려된 신청서 (집계 제외)
  };

  (budgetRequests ?? []).forEach((budgetRequest) => {
    const status = budgetRequest?.status ?? "pending";

    if (status === "rejected") summary.rejectedCount += 1;
    if (!APPROVED_FLOW_STATUSES.includes(status)) return;

    const amount = sumApprovedAmount(budgetRequest);

    summary.approvedTotal += amount;
    summary.approvedCount += 1;

    if (status === "completed") {
      summary.completedTotal += amount;
      summary.completedCount += 1;
    } else if (status === "confirmed") {
      // 부분 처리 완료된 품목 금액은 처리 완료 예산으로, 나머지는 처리 대기로 센다.
      const processedAmount = Math.min(getProcessProgress(budgetRequest).doneAmount, amount);
      summary.completedTotal += processedAmount;
      summary.confirmed += amount - processedAmount;
      summary.confirmedCount += 1;
      if (processedAmount > 0) summary.partialCount += 1;
    } else {
      summary.awaitingConfirm += amount;
      summary.awaitingConfirmCount += 1;
    }
  });

  return summary;
}

// 연합회장(관리자) 확인. 규칙(firestore.rules)에서도 관리자 · 승인된 건만 허용한다.
// reviewedAt 을 함께 고쳐 신청자에게 '상태가 바뀌었다'는 알림이 간다.
export async function confirmBudgetByPresident(requestId, confirmerName = "") {
  await updateDoc(doc(db, "budgetRequests", requestId), {
    status: "confirmed",
    reviewedAt: serverTimestamp(),
    presidentConfirmedAt: serverTimestamp(),
    presidentConfirmedBy: auth.currentUser?.uid ?? "",
    presidentConfirmedByName: String(confirmerName ?? "").slice(0, 40)
  });
}

// [부분 처리 완료] 고른 품목에 처리 표시를 남긴다. 신청서 상태는 연합회장 확인(confirmed) 그대로다.
// 규칙(firestore.rules)은 심사를 시작한 예산 소위원장 · 관리자만 허용한다.
export async function markItemsProcessed(requestId, items, indexes, adminMemo = "", reviewerName = "") {
  const selected = new Set(indexes);
  const processedAt = Date.now();
  const nextItems = (items ?? []).map((item, index) => (
    selected.has(index) && !isItemProcessed(item)
      ? { ...item, processed: true, processedAt }
      : item
  ));

  await updateDoc(doc(db, "budgetRequests", requestId), {
    items: nextItems,
    status: "confirmed",
    adminMemo: String(adminMemo ?? "").trim(),
    reviewedAt: serverTimestamp(),
    reviewedBy: auth.currentUser?.uid ?? "",
    reviewedByName: String(reviewerName ?? "").slice(0, 40)
  });

  return nextItems;
}

// 관리자 화면에서 품목 상태를 바꾼다. 누가 처리했는지 함께 남긴다.
// status 를 주지 않으면 품목 상태에서 뽑아낸다.
export async function reviewBudgetItems(requestId, items, adminMemo = "", reviewerName = "", status = deriveRequestStatus(items)) {
  await updateDoc(doc(db, "budgetRequests", requestId), {
    items,
    status,
    adminMemo: String(adminMemo ?? ""),
    reviewedAt: serverTimestamp(),
    reviewedBy: auth.currentUser?.uid ?? "",
    reviewedByName: String(reviewerName ?? "").slice(0, 40)
  });
}

// 예전에는 물품 하나만 담았다. 그 기록도 목록에서 똑같이 보이도록 항목 하나짜리로 바꿔준다.
export function readItems(budgetRequest) {
  if (Array.isArray(budgetRequest?.items) && budgetRequest.items.length > 0) {
    return budgetRequest.items;
  }

  if (budgetRequest?.itemName || budgetRequest?.purpose) {
    return [{
      kind: "재료",
      itemName: budgetRequest.itemName ?? "",
      quantity: 1,
      unitPrice: Number(budgetRequest.amount) || 0,
      amount: Number(budgetRequest.amount) || 0,
      purchaseLink: "",
      description: budgetRequest.description ?? budgetRequest.purpose ?? "",
      isShipping: false
    }];
  }

  return [];
}

function toSortedBudgetRequests(snapshot) {
  return snapshot.docs
    .map((budgetRequestDoc) => ({
      id: budgetRequestDoc.id,
      ...budgetRequestDoc.data()
    }))
    .sort((first, second) => getTimestamp(second.createdAt) - getTimestamp(first.createdAt));
}

function getTimestamp(timestamp) {
  if (timestamp && typeof timestamp.toMillis === "function") {
    return timestamp.toMillis();
  }

  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? 0 : value;
}
