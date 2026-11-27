// 신청 항목별 자동승인 설정.
//
// settings/reservationAutoApproval 문서 하나에 { items: { "<항목 이름>": true } } 로 담는다.
//  - 문서가 없거나 항목이 없거나 false 이면 자동승인이 꺼진 것이다. (기본값은 항상 '승인 대기')
//  - 켜고 끄는 것은 관리자만 할 수 있다. 읽기는 로그인한 구성원이 모두 할 수 있다.
//  - 이미 접수된 신청은 바꾸지 않는다. 설정을 바꾼 뒤의 신규 신청부터 적용된다.
//  - 클라이언트가 승인 상태를 마음대로 정하지 못하도록, 같은 설정을 firestore.rules 가 다시 확인한다.
//
// 자동승인 시점: 신청(접수) 시각 + 5분.
//  - 자동승인 항목의 신청은 '승인 대기' + autoApproveScheduled: true 로 저장된다.
//  - 5분이 지나면 승인(approved, autoApproved: true)으로 바뀐다.
//    예약 화면 · 관리자 화면을 연 사람의 브라우저나 Cloud Functions 예약 작업이 바꾸고,
//    firestore.rules 가 '접수 시각 + 5분이 지났는지'를 서버 시각으로 확인한다.
//  - 그 5분 사이에 소위원장이 직접 승인 · 반려하면 그 결과가 그대로 남는다.

import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

import { db } from "../firebase.js";

export const AUTO_APPROVAL_COLLECTION = "settings";
export const AUTO_APPROVAL_DOC_ID = "reservationAutoApproval";
export const RESERVATIONS_COLLECTION = "resourceReservations";

// 접수 뒤 자동승인까지 기다리는 시간. firestore.rules · functions/index.js 의 5분과 같게 둔다.
export const AUTO_APPROVAL_DELAY_MS = 5 * 60 * 1000;

function settingReference() {
  return doc(db, AUTO_APPROVAL_COLLECTION, AUTO_APPROVAL_DOC_ID);
}

// 켜진 항목 이름만 담은 객체를 돌려준다. 읽지 못하면 모두 꺼진 것으로 본다.
export async function getAutoApprovalItems() {
  try {
    const snapshot = await getDoc(settingReference());
    const items = snapshot.exists() ? snapshot.data()?.items : null;

    if (!items || typeof items !== "object") return {};

    return Object.fromEntries(
      Object.entries(items).filter(([, enabled]) => enabled === true)
    );
  } catch (error) {
    console.error("자동승인 설정 조회 오류:", error);
    return {};
  }
}

export function isAutoApprovalOn(items, resourceName) {
  return items?.[resourceName] === true;
}

// 관리자 전용. items 는 { 항목 이름: true } 이고, 꺼진 항목은 담지 않는다.
export async function saveAutoApprovalItems(items, uid) {
  const enabled = Object.fromEntries(
    Object.entries(items).filter(([, value]) => value === true)
  );

  await setDoc(settingReference(), {
    items: enabled,
    updatedAt: serverTimestamp(),
    updatedBy: uid ?? ""
  });

  return enabled;
}

// ========================================
// 접수 시각 + 5분 자동승인
// ========================================

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 자동승인을 기다리는 신청이면 승인될 시각(밀리초), 아니면 0.
export function getAutoApproveAt(reservation) {
  if ((reservation?.status ?? "pending") !== "pending") return 0;
  if (reservation?.autoApproveScheduled !== true) return 0;

  const createdAt = toMillis(reservation.createdAt);
  return createdAt ? createdAt + AUTO_APPROVAL_DELAY_MS : 0;
}

export function isAutoApprovalDue(reservation, now = Date.now()) {
  const approveAt = getAutoApproveAt(reservation);
  return approveAt > 0 && now >= approveAt;
}

// 14:05 처럼 승인될 시각을 보여 준다.
export function formatAutoApproveAt(reservation) {
  const approveAt = getAutoApproveAt(reservation);
  if (!approveAt) return "";

  const date = new Date(approveAt);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 5분이 지난 자동승인 대기 신청을 승인으로 바꾸고, 목록의 값도 바로 고친다.
// 기기 시계가 조금 빠르면 규칙이 거절할 수 있는데, 그때는 다음에 다시 시도한다.
export async function settleDueAutoApprovals(reservations, now = Date.now()) {
  const due = (reservations ?? []).filter((reservation) => isAutoApprovalDue(reservation, now));

  await Promise.all(due.map(async (reservation) => {
    try {
      await updateDoc(doc(db, RESERVATIONS_COLLECTION, reservation.id), {
        status: "approved",
        autoApproved: true,
        reviewedAt: serverTimestamp()
      });

      reservation.status = "approved";
      reservation.autoApproved = true;
      reservation.reviewedAt = new Date();
    } catch (error) {
      console.warn("자동승인 처리 보류:", reservation.id, error?.code ?? error);
    }
  }));

  return due.length;
}

// 가장 먼저 자동승인될 신청까지 남은 시간(밀리초). 없으면 -1.
export function msUntilNextAutoApproval(reservations, now = Date.now()) {
  const times = (reservations ?? [])
    .map(getAutoApproveAt)
    .filter((approveAt) => approveAt > 0);

  if (times.length === 0) return -1;
  return Math.max(0, Math.min(...times) - now);
}
