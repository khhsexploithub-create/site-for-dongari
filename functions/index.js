// 푸시 알림 발송 (Cloud Functions, Blaze 요금제 필요)
//
//  새 공지 등록            → 알림을 켠 모든 사람
//  새 연합회 행사 등록     → 알림을 켠 모든 사람
//  예산 신청 처리 결과     → 신청한 사람
//  예산 신청 들어옴        → 예산관리 소위원회 (긴급이면 연합회장도)
//  행사 홍보 올라옴        → 행사운영 소위원회
//  자원 예약 승인 · 반려   → 예약한 사람
//
//  자원 예약 자동승인 (1분마다) — 자동승인 항목 신청을 접수 시각 + 5분에 승인으로 바꾼다.
//
// 받는 기기 목록은 users/{uid}/fcmTokens 에 있다. (src/push/pushService.js 가 저장)
// 배포: 프로젝트 폴더에서  npx firebase-tools deploy --only functions

import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

initializeApp();
const db = getFirestore();

// 학교 동아리 규모라 인스턴스를 많이 띄울 일이 없다. 요금이 튀지 않게 막아 둔다.
setGlobalOptions({ maxInstances: 5 });

// 알림을 눌렀을 때 열 주소. 커스텀 도메인을 쓰면 여기를 바꾼다. (https 여야 한다)
const SITE_URL = "https://site-for-dongari.web.app";

const BUDGET_STATUS_NAME = {
  approved: "전체 승인",
  partial: "일부 승인",
  rejected: "반려"
};

// firestore.rules 의 isAdmin() · src/userRole.js 의 관리자 목록과 같게 둔다.
const ADMIN_EMAILS = [
  "a33272708@gmail.com",
  "khhsexploithub@gmail.com",
  "111@111.com"
];

const RESERVATION_STATUS_NAME = {
  approved: "승인",
  rejected: "반려"
};

// ========================================
// 트리거
// ========================================

export const pushOnNotice = onDocumentCreated("notices/{noticeId}", async (event) => {
  const notice = event.data?.data();
  if (!notice) return;

  const prefix = notice.category === "urgent" ? "[긴급 공지]" : "[공지]";

  await sendToEveryone({
    title: `${prefix} ${notice.title ?? ""}`.trim(),
    body: shorten(notice.content),
    path: "/notices.html",
    tag: `notice-${event.params.noticeId}`
  });
});

export const pushOnUnionEvent = onDocumentCreated("unionEvents/{eventId}", async (event) => {
  const unionEvent = event.data?.data();
  if (!unionEvent) return;

  const when = [unionEvent.date, unionEvent.startTime].filter(Boolean).join(" ");
  const body = [when, unionEvent.location].filter(Boolean).join(" · ");

  await sendToEveryone({
    title: `[연합회 행사] ${unionEvent.title ?? ""}`.trim(),
    body: body || "새 연합회 행사가 등록되었습니다.",
    path: "/union-events.html",
    tag: `union-event-${event.params.eventId}`
  });
});

export const pushOnBudgetReview = onDocumentUpdated("budgetRequests/{requestId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;

  // 처리 결과가 '바뀌었을 때'만 보낸다. 품목 일부만 심사해 아직 대기 중이면 보내지 않는다.
  const statusName = BUDGET_STATUS_NAME[after.status];
  if (!statusName || before.status === after.status) return;

  const prefix = after.requestType === "urgent" ? "긴급 " : "";

  await sendToUser(after.requesterUid, {
    title: `${prefix}예산 신청 ${statusName}`,
    body: `${after.clubName ?? ""} 예산 신청이 처리되었습니다. 눌러서 확인하세요.`.trim(),
    path: "/budget.html",
    tag: `budget-${event.params.requestId}`
  });
});

// 예산 신청이 들어오면 예산관리 소위원회에 알린다.
// 긴급 신청은 회의를 기다리지 않으므로 연합회장(관리자)에게도 바로 알린다.
export const pushOnBudgetRequest = onDocumentCreated("budgetRequests/{requestId}", async (event) => {
  const request = event.data?.data();
  if (!request) return;

  const isUrgent = request.requestType === "urgent";
  const lookups = [subcommitteeMemberIds("budget")];
  if (isUrgent) lookups.push(adminIds());

  const recipients = new Set((await Promise.all(lookups)).flat());
  recipients.delete(request.requesterUid);

  const amount = Number(request.amount || 0).toLocaleString("ko-KR");
  const itemCount = Array.isArray(request.items) ? request.items.length : 0;

  await sendToUsers([...recipients], isUrgent
    ? {
      title: `[긴급 예산] ${request.clubName ?? ""} ${amount}원`.trim(),
      body: `필요한 날짜 ${formatShortDate(request.neededBy)} · ${shorten(request.urgentReason, 60)}`,
      path: "/admin.html?section=budgetManagement",
      tag: `budget-request-${event.params.requestId}`
    }
    : {
      title: `[예산 신청] ${request.clubName ?? ""} ${amount}원`.trim(),
      body: `${formatShortDate(request.meetingDate)} 회의 안건 · 품목 ${itemCount}건`,
      path: "/admin.html?section=budgetManagement",
      tag: `budget-request-${event.params.requestId}`
    });
});

// 동아리가 행사 홍보를 올리면 행사운영 소위원회에 알린다.
export const pushOnClubEvent = onDocumentCreated("clubEvents/{eventId}", async (event) => {
  const clubEvent = event.data?.data();
  if (!clubEvent) return;

  const recipients = new Set(await subcommitteeMemberIds("event"));
  recipients.delete(clubEvent.createdBy);

  const when = [clubEvent.date, clubEvent.startTime].filter(Boolean).join(" ");

  await sendToUsers([...recipients], {
    title: `[행사 홍보] ${clubEvent.title ?? ""}`.trim(),
    body: [clubEvent.clubName, when, clubEvent.location].filter(Boolean).join(" · ") || "새 행사 홍보가 올라왔습니다.",
    path: "/admin.html?section=eventManagement",
    tag: `club-event-${event.params.eventId}`
  });
});

export const pushOnReservationReview = onDocumentUpdated("resourceReservations/{reservationId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;

  const statusName = RESERVATION_STATUS_NAME[after.status];
  if (!statusName || before.status === after.status) return;

  const when = [after.date, after.startTime && `${after.startTime}~${after.endTime ?? ""}`]
    .filter(Boolean)
    .join(" ");

  await sendToUser(after.uid, {
    title: `자원 예약 ${statusName}`,
    body: [after.resourceName, when].filter(Boolean).join(" · ") || "자원 예약이 처리되었습니다.",
    path: "/resources.html",
    tag: `reservation-${event.params.reservationId}`
  });
});

// ========================================
// 자원 예약 자동승인 (접수 시각 + 5분)
// ========================================
// 예약 화면 · 관리자 화면을 연 브라우저도 같은 일을 하지만(src/resources/autoApproval.js),
// 아무도 화면을 열지 않아도 제때 승인되도록 1분마다 확인한다.
// 승인으로 바뀌면 위 pushOnReservationReview 가 신청자에게 알림을 보낸다.

const AUTO_APPROVAL_DELAY_MS = 5 * 60 * 1000;

export const autoApproveReservations = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Seoul" },
  async () => {
    const snapshot = await db.collection("resourceReservations")
      .where("autoApproveScheduled", "==", true)
      .where("status", "==", "pending")
      .get();

    const now = Date.now();
    const due = snapshot.docs.filter((reservationDoc) => {
      const createdAt = reservationDoc.get("createdAt");
      return createdAt && createdAt.toMillis() + AUTO_APPROVAL_DELAY_MS <= now;
    });

    await Promise.all(due.map((reservationDoc) => db.runTransaction(async (transaction) => {
      // 그 사이 소위원장이 처리했거나 브라우저가 먼저 승인했으면 건드리지 않는다.
      const latest = await transaction.get(reservationDoc.ref);
      if (latest.get("status") !== "pending") return;

      transaction.update(reservationDoc.ref, {
        status: "approved",
        autoApproved: true,
        reviewedAt: FieldValue.serverTimestamp()
      });
    })));

    if (due.length > 0) logger.info(`자동승인 ${due.length}건`);
  }
);

// ========================================
// 발송
// ========================================

async function sendToEveryone(message) {
  const snapshot = await db.collectionGroup("fcmTokens").get();
  await sendToTokenDocs(snapshot.docs, message);
}

// 소위원회 소속(임원 + 소위원장) 계정. 소위원장은 언제나 소속에도 들어 있다.
async function subcommitteeMemberIds(subcommitteeId) {
  const snapshot = await db.collection("users").where("subcommittees", "array-contains", subcommitteeId).get();
  return snapshot.docs.map((userDoc) => userDoc.id);
}

async function adminIds() {
  const snapshot = await db.collection("users").where("email", "in", ADMIN_EMAILS).get();
  return snapshot.docs.map((userDoc) => userDoc.id);
}

async function sendToUsers(uids, message) {
  const ids = uids.filter(Boolean);
  if (ids.length === 0) return;

  const snapshots = await Promise.all(
    ids.map((uid) => db.collection("users").doc(uid).collection("fcmTokens").get())
  );
  await sendToTokenDocs(snapshots.flatMap((snapshot) => snapshot.docs), message);
}

async function sendToUser(uid, message) {
  if (!uid) return;
  const snapshot = await db.collection("users").doc(uid).collection("fcmTokens").get();
  await sendToTokenDocs(snapshot.docs, message);
}

async function sendToTokenDocs(tokenDocs, { title, body, path, tag }) {
  // 같은 토큰이 두 번 들어가 있으면 알림이 두 번 가므로 한 번만 남긴다.
  const byToken = new Map();
  tokenDocs.forEach((tokenDoc) => {
    const token = tokenDoc.get("token");
    if (token && !byToken.has(token)) byToken.set(token, tokenDoc.ref);
  });

  const tokens = [...byToken.keys()];
  if (tokens.length === 0) return;

  const link = `${SITE_URL}${path}`;
  const staleRefs = [];

  // 한 번에 500개까지 보낼 수 있다.
  for (let start = 0; start < tokens.length; start += 500) {
    const chunk = tokens.slice(start, start + 500);

    const response = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data: { link: path, tag },
      webpush: {
        notification: { icon: "/icons/icon-192.png", tag },
        fcmOptions: { link }
      }
    });

    response.responses.forEach((result, index) => {
      const code = result.error?.code;
      if (code === "messaging/registration-token-not-registered"
        || code === "messaging/invalid-registration-token") {
        staleRefs.push(byToken.get(chunk[index]));
      } else if (code) {
        logger.warn("푸시 발송 실패", { code, message: result.error?.message });
      }
    });

    logger.info("푸시 발송", { title, sent: response.successCount, failed: response.failureCount });
  }

  // 앱을 지웠거나 알림을 끈 기기의 토큰은 정리한다.
  await Promise.all(staleRefs.map((ref) => ref.delete().catch(() => {})));
}

// "2026-10-24" → "10/24(토)"
function formatShortDate(dateKey) {
  const [year, month, day] = String(dateKey ?? "").split("-").map(Number);
  if (!year || !month || !day) return "다음";
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}/${day}(${weekday})`;
}

function shorten(text, max = 80) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
