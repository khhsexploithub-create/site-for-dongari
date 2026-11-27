import "./styles/site.css";
import "./styles/neoul/admin.css";
import "./styles/neoul/budget-flow.css";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "firebase/auth";

import {
  doc,
  updateDoc,
  serverTimestamp
} from "firebase/firestore";

import {
  auth,
  db
} from "./firebase.js";

import { signOutUser } from "./auth/authService.js";

import { setupPasswordToggle } from "./passwordToggle.js";

import { mountProfileWidget } from "./auth/profileWidget.js";
import { mountShell } from "./ui/shell.js";

import { createClubTag } from "./clubList.js";

import {
  CONFIRMABLE_STATUSES,
  confirmBudgetByPresident,
  getProcessProgress,
  getRequestPasswordHash,
  isPartiallyProcessed,
  markItemsProcessed,
  readItems,
  saveRequestPassword,
  subscribeToAllBudgetRequests,
  sumApprovedAmount
} from "./budget/budgetService.js";
import { createBudgetItemReview } from "./admin/budgetReview.js";
import {
  createBudgetOverview,
  createFlowButton,
  createFlowStepper,
  openActionDialog,
  openPartialCompleteDialog,
  openProcessDialog,
  runButtonTask,
  wait
} from "./admin/budgetFlow.js";

import {
  endReviewSession,
  readReviewSession,
  saveReviewPassword,
  startReviewSession
} from "./budget/budgetReviewLock.js";

import {
  URGENT_POLICY,
  formatShortDate,
  getMeetingDate,
  getRequestType,
  toDateKey
} from "./budget/budgetPolicy.js";

import {
  getClubLeaderOf,
  getDisplayName,
  getSubcommitteeSections,
  isAdminEmail,
  isSubcommitteeChair,
  resolveUserProfile,
  SUBCOMMITTEES
} from "./userRole.js";

import {
  initActivityAdmin,
  loadActivityAdmin
} from "./admin/activityAdmin.js";

import {
  initResourceAdmin,
  loadResourceAdmin
} from "./admin/resourceAdmin.js";

import {
  initScheduleAdmin,
  loadScheduleAdmin
} from "./admin/scheduleAdmin.js";

import {
  initEventAdmin,
  loadEventAdmin
} from "./admin/eventAdmin.js";

import {
  initUserAdmin,
  loadUserAdmin
} from "./admin/userAdmin.js";


// ========================================
// 관리자 계정
// ========================================

// 관리자 이메일 목록은 userRole.js 에서 관리한다.


// ========================================
// DOM
// ========================================

const loginSection =
  document.querySelector("#loginSection");

const adminSection =
  document.querySelector("#adminSection");

const loginForm =
  document.querySelector("#loginForm");

const loginMessage =
  document.querySelector("#loginMessage");

const passwordInput =
  document.querySelector("#password");

const passwordToggle =
  document.querySelector("#passwordToggle");

const budgetRequestList =
  document.querySelector("#budgetRequestList");

const budgetTotalCount =
  document.querySelector("#budgetTotalCount");

const budgetPendingCount =
  document.querySelector("#budgetPendingCount");

const budgetApprovedCount =
  document.querySelector("#budgetApprovedCount");

const budgetRejectedCount =
  document.querySelector("#budgetRejectedCount");

const budgetAssemblyCount =
  document.querySelector("#budgetAssemblyCount");

const budgetConfirmedCount =
  document.querySelector("#budgetConfirmedCount");

const budgetCompletedCount =
  document.querySelector("#budgetCompletedCount");

// [승인 예산] · [처리 완료 예산] 현황 (Firestore 실시간)
const budgetOverview =
  createBudgetOverview(document.querySelector("#budgetOverview"));

const adminAccessLabel =
  document.querySelector("#adminAccessLabel");

const refreshButton =
  document.querySelector("#refreshButton");

const logoutButton =
  document.querySelector("#logoutButton");

const budgetReviewNotice =
  document.querySelector("#budgetReviewNotice");

const budgetPasswordBox =
  document.querySelector("#budgetPasswordBox");

const budgetPasswordState =
  document.querySelector("#budgetPasswordState");

const budgetPasswordInput =
  document.querySelector("#budgetPasswordInput");

const budgetPasswordToggle =
  document.querySelector("#budgetPasswordToggle");

const budgetPasswordSaveButton =
  document.querySelector("#budgetPasswordSaveButton");

const budgetPasswordMessage =
  document.querySelector("#budgetPasswordMessage");


// ========================================
// 현재 로그인 계정의 처리 권한
// ========================================

// 소위원장만 승인 · 반려 등을 처리할 수 있다.
// 소위원회 임원은 관리 현황을 열람만 한다.
let canReviewBudget = false;

// 지금 로그인한 처리자. 긴급 신청의 '자기 동아리 처리 금지'와 처리 기록에 쓴다.
// isAdmin: 연합회장(관리자) 계정인지. [연합회장 확인] 단추는 관리자에게만 보인다. (규칙에서도 막는다)
let reviewer = { uid: "", name: "", leaderClub: "", isAdmin: false };

// 심사 비밀번호를 넣고 심사를 시작했으면 끝나는 시각. 아니면 null.
let reviewUnlockedUntil = null;

function isReviewUnlocked() {
  return Boolean(reviewUnlockedUntil) && reviewUnlockedUntil > new Date();
}

// 예산 목록 거르기: all · meeting(다음 회의 안건) · urgent · normal
let budgetFilter = "all";
let loadedBudgetRequests = [];

// 예산 신청 실시간 구독 해제 함수
let unsubscribeFromBudgetRequests = null;

// 실시간으로 바뀌어도 쓰던 의견이 날아가지 않도록 카드별로 적어 둔다.
const memoDrafts = new Map();

// 단추를 누른 뒤 진행 · 완료 모습을 보여 주는 동안, 그리고 입력 중에는 목록을 다시 그리지 않는다.
let budgetRenderHolds = 0;
let budgetListRenderPending = false;


// ========================================
// 비밀번호 표시 / 숨기기
// ========================================

setupPasswordToggle(passwordInput, passwordToggle);

mountProfileWidget();
mountShell();


// ========================================
// 관리자 로그인
// ========================================

loginForm.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    const email =
      document
        .querySelector("#email")
        .value
        .trim()
        .toLowerCase();

    const password =
      passwordInput.value;


    loginMessage.textContent =
      "로그인 중...";


    try {

      const result =
        await signInWithEmailAndPassword(
          auth,
          email,
          password
        );


      // 관리자와 소위원회 계정만 통과시킨다.
      const profile =
        await resolveUserProfile(result.user);

      if (
        getAccessibleSections(
          result.user,
          profile
        ).length === 0
      ) {

        await signOut(auth);

        loginMessage.textContent =
          "관리자 또는 소위원회 계정이 아닙니다.";

        return;
      }


      loginMessage.textContent = "";

    } catch (error) {

      console.error(
        "관리자 로그인 오류:",
        error
      );

      loginMessage.textContent =
        "이메일 또는 비밀번호를 확인해주세요.";

    }

  }
);


// ========================================
// 로그인 상태 확인
// ========================================

onAuthStateChanged(
  auth,
  async (user) => {

    if (!user) {
      unsubscribeFromBudgetRequests?.();
      unsubscribeFromBudgetRequests = null;
      showLoginSection();
      return;
    }


    const profile =
      await resolveUserProfile(user);

    const accessibleSections =
      getAccessibleSections(user, profile);


    if (accessibleSections.length === 0) {
      showLoginSection();
      return;
    }


    canReviewBudget =
      isSubcommitteeChair(profile, "budget");

    reviewer = {
      uid: user.uid,
      name: getDisplayName(profile, user),
      leaderClub: getClubLeaderOf(profile) ?? "",
      isAdmin: isAdminEmail(user.email)
    };

    setBudgetReviewNotice();

    setupBudgetPasswordBox(
      isAdminEmail(user.email)
    );

    await setupReviewLock();


    loginSection.classList.add("hidden");
    adminSection.classList.remove("hidden");

    applySectionAccess(
      accessibleSections,
      isAdminEmail(user.email)
    );


    const tasks = [];

    if (accessibleSections.includes("budgetManagement")) {
      tasks.push(loadBudgetRequests());
    }

    if (accessibleSections.includes("activityManagement")) {
      initActivityAdmin();
      tasks.push(loadActivityAdmin());
    }

    if (accessibleSections.includes("resourceManagement")) {
      initResourceAdmin({
        canReview: isSubcommitteeChair(profile, "resource"),
        canConfigure: isAdminEmail(user.email)
      });
      tasks.push(loadResourceAdmin());
    }

    if (accessibleSections.includes("scheduleManagement")) {
      initScheduleAdmin({
        canManage: isSubcommitteeChair(profile, "event")
      });
      tasks.push(loadScheduleAdmin());
    }

    if (accessibleSections.includes("eventManagement")) {
      initEventAdmin({
        canManage: isSubcommitteeChair(profile, "event")
      });
      tasks.push(loadEventAdmin());
    }

    if (accessibleSections.includes("userManagement")) {
      initUserAdmin();
      tasks.push(loadUserAdmin());
    }

    await Promise.all(tasks);

  }
);


function showLoginSection() {
  loginSection.classList.remove("hidden");
  adminSection.classList.add("hidden");
}


setupPasswordToggle(budgetPasswordInput, budgetPasswordToggle);

budgetPasswordSaveButton.addEventListener(
  "click",
  async () => {

    const password =
      budgetPasswordInput.value;


    if (password.trim().length < 4) {

      budgetPasswordMessage.textContent =
        "비밀번호는 4자 이상으로 입력해주세요.";

      return;
    }


    budgetPasswordSaveButton.disabled = true;

    budgetPasswordMessage.textContent =
      "저장 중...";


    try {

      await saveRequestPassword(password);

      budgetPasswordInput.value = "";

      budgetPasswordMessage.textContent =
        "신청 비밀번호를 저장했습니다. 각 동아리 부장에게 전달해주세요.";

      budgetPasswordState.textContent =
        "설정됨";

      budgetPasswordState.classList.add("is-on");

    } catch (error) {

      console.error(
        "신청 비밀번호 저장 오류:",
        error
      );

      budgetPasswordMessage.textContent =
        "비밀번호를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.";

    } finally {

      budgetPasswordSaveButton.disabled = false;

    }

  }
);


// 관리자에게만 신청 비밀번호 설정 상자를 보여준다.
async function setupBudgetPasswordBox(isFullAdmin) {

  budgetPasswordBox.hidden = !isFullAdmin;

  if (!isFullAdmin) return;


  try {

    const savedHash =
      await getRequestPasswordHash();

    budgetPasswordState.textContent =
      savedHash ? "설정됨" : "아직 설정되지 않음";

    budgetPasswordState.classList.toggle(
      "is-on",
      Boolean(savedHash)
    );

  } catch (error) {

    console.error(
      "신청 비밀번호 확인 오류:",
      error
    );

    budgetPasswordState.textContent =
      "확인하지 못했습니다.";

  }

}


// ========================================
// 심사 절차 · 심사 비밀번호
// ========================================

const reviewLockBox = document.querySelector("#budgetReviewLock");
const reviewUnlockForm = document.querySelector("#budgetReviewUnlockForm");
const reviewPasswordField = document.querySelector("#budgetReviewPassword");
const reviewUnlockButton = document.querySelector("#budgetReviewUnlockButton");
const reviewLockMessage = document.querySelector("#budgetReviewLockMessage");
const reviewUnlockedBox = document.querySelector("#budgetReviewUnlocked");
const reviewUntilText = document.querySelector("#budgetReviewUntil");
const reviewLockButton = document.querySelector("#budgetReviewLockButton");

setupPasswordToggle(reviewPasswordField, document.querySelector("#budgetReviewPasswordToggle"));

async function setupReviewLock() {
  reviewLockBox.hidden = !canReviewBudget;
  reviewUnlockedUntil = canReviewBudget ? await readReviewSession() : null;
  renderReviewLock();
}

function renderReviewLock() {
  const unlocked = isReviewUnlocked();
  reviewUnlockForm.hidden = unlocked;
  reviewUnlockedBox.hidden = !unlocked;
  reviewLockBox.classList.toggle("is-unlocked", unlocked);

  if (unlocked) {
    reviewUntilText.textContent = reviewUnlockedUntil.toLocaleString("ko-KR", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }
}

// 심사 시간이 끝났거나 비밀번호가 바뀌어 거절되면 다시 잠근다.
function relockReview(message) {
  reviewUnlockedUntil = null;
  renderReviewLock();
  reviewLockMessage.textContent = message;
  renderBudgetRequests(filterBudgetRequests(loadedBudgetRequests));
  reviewLockBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

reviewUnlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const password = reviewPasswordField.value;
  if (!password.trim()) {
    reviewLockMessage.textContent = "심사 비밀번호를 입력해주세요.";
    return;
  }

  reviewUnlockButton.disabled = true;
  reviewLockMessage.textContent = "확인 중...";

  try {
    const until = await startReviewSession(password);

    if (!until) {
      reviewLockMessage.textContent = "심사 비밀번호가 맞지 않아요.";
      reviewPasswordField.select();
      return;
    }

    reviewUnlockedUntil = until;
    reviewPasswordField.value = "";
    reviewLockMessage.textContent = "";
    renderReviewLock();
    renderBudgetRequests(filterBudgetRequests(loadedBudgetRequests));
  } catch (error) {
    console.error("심사 시작 오류:", error);
    reviewLockMessage.textContent = error?.message === "rules-not-deployed"
      ? "서버 보안 규칙(firestore.rules)이 아직 옛날 버전이라 확인할 수 없어요. 규칙을 배포한 뒤 다시 해주세요."
      : "심사를 시작하지 못했어요. 잠시 후 다시 시도해주세요.";
  } finally {
    reviewUnlockButton.disabled = false;
  }
});

reviewLockButton.addEventListener("click", async () => {
  await endReviewSession();
  reviewUnlockedUntil = null;
  reviewLockMessage.textContent = "심사를 마쳤어요.";
  renderReviewLock();
  renderBudgetRequests(filterBudgetRequests(loadedBudgetRequests));
});

// 관리자 전용: 심사 비밀번호 바꾸기
const reviewPasswordInput = document.querySelector("#reviewPasswordInput");
const reviewPasswordSaveButton = document.querySelector("#reviewPasswordSaveButton");
const reviewPasswordMessage = document.querySelector("#reviewPasswordMessage");

setupPasswordToggle(reviewPasswordInput, document.querySelector("#reviewPasswordToggle"));

reviewPasswordSaveButton.addEventListener("click", async () => {
  const password = reviewPasswordInput.value;

  if (password.trim().length < 6) {
    reviewPasswordMessage.textContent = "심사 비밀번호는 6자 이상으로 입력해주세요.";
    return;
  }

  if (!window.confirm("심사 비밀번호를 바꿀까요? 지금 심사 중인 사람도 모두 다시 넣어야 합니다.")) return;

  reviewPasswordSaveButton.disabled = true;
  reviewPasswordMessage.textContent = "저장 중...";

  try {
    await saveReviewPassword(password);
    reviewPasswordInput.value = "";
    reviewPasswordMessage.textContent = "심사 비밀번호를 바꿨어요. 예산관리소위원회에 전달해주세요.";
    relockReview("심사 비밀번호가 바뀌어서 다시 넣어야 해요.");
  } catch (error) {
    console.error("심사 비밀번호 저장 오류:", error);
    reviewPasswordMessage.textContent = "저장하지 못했어요. 잠시 후 다시 시도해주세요.";
  } finally {
    reviewPasswordSaveButton.disabled = false;
  }
});


// 소위원회 임원에게는 열람 전용이라는 것을 화면 위에 알려준다.
function setBudgetReviewNotice() {

  budgetReviewNotice.hidden = canReviewBudget;

  budgetReviewNotice.textContent = canReviewBudget
    ? ""
    : "소위원회 임원 권한입니다. 예산 신청 현황을 열람할 수 있고, 승인 · 반려 · 처리 완료는 소위원장만, 연합회장 확인은 관리자만 처리할 수 있습니다.";
}


// 관리자는 모든 항목, 소위원회 계정은 담당 항목만 열 수 있다.
function getAccessibleSections(user, profile) {

  if (isAdminEmail(user.email)) {
    return [
      "budgetManagement",
      "activityManagement",
      "resourceManagement",
      "scheduleManagement",
      "eventManagement",
      "userManagement"
    ];
  }


  const memberships =
    Array.isArray(profile.subcommittees)
      ? profile.subcommittees
      : [];


  // 한 소위원회가 여러 항목을 맡을 수 있으므로 모두 펼쳐서 모은다.
  return [...new Set(
    SUBCOMMITTEES
      .filter((subcommittee) => memberships.includes(subcommittee.id))
      .flatMap((subcommittee) => getSubcommitteeSections(subcommittee))
  )];
}


// ========================================
// 예산 신청 불러오기 (Firestore 실시간)
// ========================================
// 상태가 바뀌면 예산 현황 · 통계 · 목록이 바로 다시 그려진다.
// 첫 자료가 도착하면 끝나는 Promise 를 돌려준다.

function loadBudgetRequests() {

  unsubscribeFromBudgetRequests?.();

  if (loadedBudgetRequests.length === 0) {
    budgetRequestList.textContent =
      "예산 신청을 불러오는 중...";
  }

  return new Promise((resolve) => {

    let isFirst = true;

    const settle = () => {
      if (!isFirst) return;
      isFirst = false;
      resolve();
    };

    unsubscribeFromBudgetRequests =
      subscribeToAllBudgetRequests(
        (budgetRequests) => {

          loadedBudgetRequests = budgetRequests;

          budgetOverview.update(budgetRequests);

          renderBudgetStats(budgetRequests);

          renderBudgetFilter(budgetRequests);

          scheduleBudgetListRender();

          settle();

        },
        (error) => {

          console.error(
            "예산 신청 조회 오류:",
            error
          );

          budgetOverview.setError("불러오지 못함");

          budgetRequestList.textContent =
            "예산 신청을 불러오지 못했습니다.";

          settle();

        }
      );

  });

}


// 목록 다시 그리기를 잠깐 미룬다. 놓아주는 함수를 돌려준다.
function holdBudgetListRender() {

  budgetRenderHolds += 1;

  let released = false;

  return () => {
    if (released) return;
    released = true;
    budgetRenderHolds -= 1;
    flushBudgetListRender();
  };

}

function isEditingBudgetList() {

  const active = document.activeElement;

  return Boolean(active)
    && budgetRequestList.contains(active)
    && active.matches("textarea, input");

}

function scheduleBudgetListRender() {

  budgetListRenderPending = true;

  flushBudgetListRender();

}

function flushBudgetListRender() {

  if (
    !budgetListRenderPending
    || budgetRenderHolds > 0
    || isEditingBudgetList()
  ) {
    return;
  }

  budgetListRenderPending = false;

  renderBudgetRequests(filterBudgetRequests(loadedBudgetRequests));

}

// 입력칸에서 빠져나오면 미뤄 둔 새 자료를 그린다.
budgetRequestList.addEventListener("focusout", () => {
  setTimeout(flushBudgetListRender, 0);
});


// ========================================
// 예산 통계
// ========================================

function renderBudgetStats(
  budgetRequests
) {

  budgetTotalCount.textContent =
    budgetRequests.length;


  budgetPendingCount.textContent =
    countByStatus(
      budgetRequests,
      "pending"
    );


  budgetApprovedCount.textContent =
    countByStatus(
      budgetRequests,
      "approved"
    );


  budgetRejectedCount.textContent =
    countByStatus(
      budgetRequests,
      "rejected"
    );


  budgetAssemblyCount.textContent =
    countByStatus(
      budgetRequests,
      "assembly"
    );


  budgetConfirmedCount.textContent =
    countByStatus(
      budgetRequests,
      "confirmed"
    );


  budgetCompletedCount.textContent =
    countByStatus(
      budgetRequests,
      "completed"
    );

}


// ========================================
// 예산 목록 거르기 (전체 · 다음 회의 안건 · 긴급 · 일반)
// ========================================

const budgetFilterBar =
  document.querySelector("#budgetFilterBar");

budgetFilterBar?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-budget-filter]");
  if (!button) return;

  budgetFilter = button.dataset.budgetFilter;
  renderBudgetFilter(loadedBudgetRequests);
  renderBudgetRequests(filterBudgetRequests(loadedBudgetRequests));
});

// 다음 회의에 올라갈 것:
//  - 아직 심의하지 않은 일반 신청 (지난 회의에서 밀린 것 포함)
//  - 이번 회의에 사후 보고할 긴급 승인 건
function isMeetingAgenda(budgetRequest, meetingKey) {
  const type = getRequestType(budgetRequest);
  const meetingDate = budgetRequest.meetingDate ?? "";

  if (type === "urgent") {
    return meetingDate === meetingKey
      && ["approved", "partial", "confirmed", "completed"].includes(budgetRequest.status);
  }

  return (budgetRequest.status ?? "pending") === "pending"
    && (!meetingDate || meetingDate <= meetingKey);
}

function filterBudgetRequests(budgetRequests) {
  const meetingKey = toDateKey(getMeetingDate());

  return budgetRequests.filter((budgetRequest) => {
    if (budgetFilter === "urgent") return getRequestType(budgetRequest) === "urgent";
    if (budgetFilter === "normal") return getRequestType(budgetRequest) === "normal";
    if (budgetFilter === "meeting") return isMeetingAgenda(budgetRequest, meetingKey);
    return true;
  });
}

function renderBudgetFilter(budgetRequests) {
  if (!budgetFilterBar) return;

  const meeting = getMeetingDate();
  const meetingKey = toDateKey(meeting);
  const counts = {
    all: budgetRequests.length,
    meeting: budgetRequests.filter((request) => isMeetingAgenda(request, meetingKey)).length,
    urgent: budgetRequests.filter((request) => getRequestType(request) === "urgent").length,
    normal: budgetRequests.filter((request) => getRequestType(request) === "normal").length
  };
  const labels = {
    all: "전체",
    meeting: `${formatShortDate(meeting)} 회의 안건`,
    urgent: "긴급",
    normal: "일반"
  };

  budgetFilterBar.textContent = "";

  Object.keys(labels).forEach((key) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `budget-filter-chip is-${key}`;
    button.dataset.budgetFilter = key;
    button.setAttribute("aria-pressed", String(budgetFilter === key));
    button.classList.toggle("is-active", budgetFilter === key);
    button.append(document.createTextNode(labels[key]));

    const count = document.createElement("b");
    count.textContent = counts[key];
    button.appendChild(count);

    budgetFilterBar.appendChild(button);
  });
}


// ========================================
// 예산 신청 목록
// ========================================

function renderBudgetRequests(
  budgetRequests
) {

  budgetRequestList.textContent = "";

  // 직접 다시 그렸으므로 미뤄 둔 것은 없앤다.
  budgetListRenderPending = false;


  if (budgetRequests.length === 0) {

    budgetRequestList.textContent =
      budgetFilter === "all"
        ? "아직 예산 신청이 없습니다."
        : "여기에 해당하는 신청이 없습니다.";

    return;

  }


  budgetRequests.forEach(
    (budgetRequest) => {

      const card =
        createBudgetRequestCard(
          budgetRequest
        );

      budgetRequestList.appendChild(
        card
      );

    }
  );

}


// ========================================
// 예산 신청 카드
// ========================================
//
// 흐름: 신청 → 승인 → 연합회장 확인 → 처리 → 처리 완료
//  - 승인 · 반려는 품목 심사 표(전체 승인 · 전체 반려 · 품목별)에서 한다.
//  - [연합회장 확인] 은 관리자만, 승인된 건에서 누를 수 있다. (firestore.rules 에서도 막는다)
//  - [처리] · [처리 완료] 는 연합회장 확인이 끝난 건에서만 나타난다.

function createBudgetRequestCard(data) {

  const card =
    document.createElement("article");

  const requestType = getRequestType(data);
  const isUrgent = requestType === "urgent";
  const status = data.status ?? "pending";

  function setCardStatus(nextStatus) {
    card.className =
      `admin-card budget-request-card status-${nextStatus}`;
    card.classList.toggle("is-urgent", isUrgent);
  }

  setCardStatus(status);


  const title =
    document.createElement("h2");

  title.className = "admin-card-club-title";

  // 긴급 신청은 신청한 본인 · 그 동아리 부장이 처리할 수 없다. (규칙에서도 막는다)
  const hasConflict = isUrgent && (
    data.requesterUid === reviewer.uid
    || (reviewer.leaderClub && data.clubName === reviewer.leaderClub)
  );
  // 심사 비밀번호로 심사를 시작해야 처리 단추가 생긴다.
  const canReviewThis = canReviewBudget && isReviewUnlocked() && !hasConflict;
  const canRejectOnly = canReviewBudget && isReviewUnlocked() && hasConflict;

  const typeChip = document.createElement("span");
  typeChip.className = `budget-type-chip is-${requestType}`;
  typeChip.textContent = isUrgent ? "긴급 신청" : "일반 신청";

  title.append(
    typeChip,
    createClubTag(data.clubName)
  );


  const requester =
    createInfoLine(
      "신청자",
      data.requesterName ?? "이름 없음"
    );


  const items = readItems(data);


  const itemCount =
    createInfoLine(
      "신청 물품",
      items.length > 0
        ? `${items.length}건`
        : "입력된 물품 없음"
    );


  const amount =
    createInfoLine(
      "총 신청 금액",
      `${formatAmount(data.amount)} (승인 ${formatAmount(sumApprovedAmount(data))})`
    );


  // 일반: 어느 토요일 회의에서 심의하는지 / 긴급: 필요한 날짜 · 사유 · 사후 보고할 회의
  const typeLines = isUrgent
    ? [
      createInfoLine("필요한 날짜", formatShortDate(data.neededBy)),
      createInfoLine("긴급 사유", data.urgentReason || "-"),
      createInfoLine("사후 보고", data.meetingDate ? `${formatShortDate(data.meetingDate)} 회의` : "다음 회의")
    ]
    : data.meetingDate
      ? [createInfoLine("심의 회의", `${formatShortDate(data.meetingDate)} 예산 소위원회`)]
      : [];

  if (data.reviewedByName) {
    typeLines.push(createInfoLine("처리한 사람", data.reviewedByName));
  }

  if (["confirmed", "completed"].includes(status) && data.presidentConfirmedAt) {
    typeLines.push(createInfoLine(
      "연합회장 확인",
      `${data.presidentConfirmedByName || "연합회장"} · ${formatCreatedAt(data.presidentConfirmedAt)}`
    ));
  }


  // --- 진행 단계 (신청 → 승인 → 연합회장 확인 → 처리 → 처리 완료) ---
  // 일부 품목만 처리 완료되면 '처리' 단계가 '부분 처리 완료'로 보인다.
  const stepper = createFlowStepper(status, { partial: isPartiallyProcessed(data) });


  // --- [연합회장 확인] (전체 승인 · 전체 반려 옆) ---
  const headActions = [];
  let confirmButton = null;

  if (["confirmed", "completed"].includes(status)) {

    const confirmedBadge = document.createElement("span");
    confirmedBadge.className = "flow-confirmed-badge";
    confirmedBadge.textContent = "연합회장 확인 완료";
    headActions.push(confirmedBadge);

  } else if (reviewer.isAdmin && canReviewThis) {

    confirmButton = createFlowButton({
      label: "연합회장 확인",
      variant: "president",
      size: "sm"
    });

    syncConfirmButton(status);

    confirmButton.addEventListener("click", () => confirmByPresident());
    headActions.push(confirmButton);

  }

  function syncConfirmButton(currentStatus) {
    if (!confirmButton) return;
    const isConfirmable = CONFIRMABLE_STATUSES.includes(currentStatus);
    confirmButton.disabled = !isConfirmable;
    confirmButton.title = isConfirmable
      ? "승인된 예산을 연합회장으로서 확인합니다."
      : "승인된 품목이 있어야 연합회장 확인을 할 수 있어요.";
  }


  // 품목마다 따로 승인 · 반려할 수 있는 심사 표
  const itemTable =
    createBudgetItemReview({
      budgetRequest: data,
      items,
      canReview: canReviewThis,
      reviewerName: reviewer.name,
      headActions,
      holdRender: holdBudgetListRender,
      getAdminMemo: () => adminMemo.value,
      beforeChange: () => getUrgentMemoProblem(),
      onDenied: () => relockReview("심사 시간이 끝났거나 비밀번호가 바뀌었어요. 심사 비밀번호를 다시 넣어주세요."),
      onSaved: (nextItems, nextStatus) => {
        data.items = nextItems;
        data.status = nextStatus;
        memoDrafts.delete(data.id);
        stepper.setStatus(nextStatus, { animate: true });
        setCardStatus(nextStatus);
        syncConfirmButton(nextStatus);
      }
    });


  const createdAt =
    createInfoLine(
      "신청 시간",
      formatCreatedAt(data.createdAt)
    );


  const adminMemoLabel = document.createElement("label");
  adminMemoLabel.className = "admin-memo-label";
  adminMemoLabel.textContent = canRejectOnly
    ? "반려 사유"
    : !canReviewThis
    ? "관리자 의견 (읽기 전용)"
    : isUrgent
      ? `긴급 승인 사유 (필수 · ${URGENT_POLICY.minApprovalMemo}자 이상)`
      : "관리자 의견";
  const adminMemo = document.createElement("textarea");
  adminMemo.placeholder = canRejectOnly
    ? "반려하는 이유를 적어주세요."
    : !canReviewThis
    ? "소위원장이 남긴 의견이 없습니다."
    : isUrgent
      ? "왜 회의 전에 바로 승인하는지 적어주세요. 다음 회의에 그대로 보고됩니다."
      : "승인 의견 또는 반려 사유를 입력하세요.";
  adminMemo.value = memoDrafts.get(data.id) ?? data.adminMemo ?? "";
  adminMemo.readOnly = !(canReviewThis || canRejectOnly);
  adminMemo.addEventListener("input", () => {
    memoDrafts.set(data.id, adminMemo.value);
  });
  adminMemoLabel.appendChild(adminMemo);

  // 긴급 신청은 사유를 먼저 적어야 처리할 수 있다.
  function getUrgentMemoProblem() {
    if (!isUrgent) return "";
    return adminMemo.value.trim().length < URGENT_POLICY.minApprovalMemo
      ? `긴급 신청은 승인 사유를 ${URGENT_POLICY.minApprovalMemo}자 이상 먼저 적어주세요.`
      : "";
  }

  // 확인 창에 보여 줄 요약
  function summaryRows() {
    const approvedCount = readItems(data).filter((item) => item.status === "approved").length;
    return [
      ["동아리", `${data.clubName ?? "동아리"} · ${isUrgent ? "긴급" : "일반"} 신청`],
      ["승인 품목", `${approvedCount}건`],
      ["승인 금액", formatAmount(sumApprovedAmount(data))]
    ];
  }

  // 자기 동아리 긴급 신청이면 처리 대신 안내만 보여 준다.
  const conflictNotice = document.createElement("p");
  conflictNotice.className = "admin-conflict-notice";
  conflictNotice.textContent = "본인 · 자기 동아리의 긴급 신청이라 승인할 수 없어요. 반려만 할 수 있고, 승인은 다른 승인권자(연합회장 · 예산 소위원장)가 해요.";
  conflictNotice.hidden = !(canReviewBudget && hasConflict);


  // --- [연합회장 확인] 누르기 ---
  async function confirmByPresident() {

    const confirmed = await openActionDialog({
      tone: "president",
      title: "연합회장 확인",
      description: "확인하면 '연합회장 확인 완료'로 바뀌고, 선생님이 처리할 수 있도록 [처리] · [처리 완료] 단추가 열려요.",
      rows: summaryRows(),
      confirmText: "확인 완료로 바꾸기"
    });

    if (!confirmed) return;

    const release = holdBudgetListRender();

    try {

      await runButtonTask(
        confirmButton,
        () => confirmBudgetByPresident(data.id, reviewer.name),
        { busyText: "확인 중", doneText: "확인 완료" }
      );

      data.status = "confirmed";
      stepper.setStatus("confirmed", { animate: true });
      setCardStatus("confirmed");
      await wait(1100);

    } catch (error) {

      await handleBudgetWriteError(error, "연합회장 확인 중 오류가 발생했습니다.");

    } finally {

      release();

    }

  }


  // --- [처리] · [처리 완료] (연합회장 확인이 끝난 건에서만) ---
  const processPanel = document.createElement("section");
  processPanel.className = "flow-process";
  processPanel.hidden = status !== "confirmed";
  processPanel.setAttribute("aria-label", "선생님 처리");

  if (status === "confirmed") {

    const processNote = document.createElement("div");
    processNote.className = "flow-process-note";

    const noteTitle = document.createElement("strong");
    noteTitle.textContent = "선생님이 처리 후 눌러주세요";

    const noteText = document.createElement("span");
    noteText.textContent = "[처리]에서 품목별 구매 링크를 열고, 구매를 마치면 [처리 완료]를 눌러요."
      + " 일부 품목만 샀다면 [부분 처리 완료]로 그 품목만 표시할 수 있어요.";

    // 부분 처리 완료 진행 정도
    const progressText = document.createElement("p");
    progressText.className = "flow-process-progress";

    function renderProgress() {
      const progress = getProcessProgress(data);
      progressText.hidden = progress.done === 0;
      progressText.textContent =
        `부분 처리 완료 ${progress.done} / ${progress.total}건 · ${formatAmount(progress.doneAmount)}`;
      return progress;
    }

    renderProgress();
    processNote.append(noteTitle, noteText, progressText);

    const processActions = document.createElement("div");
    processActions.className = "flow-process-actions";

    const processButton = createFlowButton({
      label: "처리",
      variant: "process"
    });

    processButton.setAttribute("aria-haspopup", "dialog");
    processButton.addEventListener("click", () => openProcessDialog(data));
    processActions.appendChild(processButton);

    if (canReviewThis) {

      const completeButton = createFlowButton({
        label: "처리 완료",
        variant: "complete"
      });

      completeButton.addEventListener("click", async () => {

        const confirmed = await openActionDialog({
          tone: "complete",
          title: "처리 완료",
          description: "처리 완료로 바꾸면 승인 금액이 [처리 완료 예산]에 더해져요.",
          rows: summaryRows(),
          note: adminMemo.value.trim() ? `의견: ${adminMemo.value.trim()}` : "",
          confirmText: "처리 완료"
        });

        if (!confirmed) return;

        const release = holdBudgetListRender();

        try {

          await runButtonTask(
            completeButton,
            () => changeBudgetRequestStatus(data.id, "completed", adminMemo.value),
            { busyText: "반영 중", doneText: "처리 완료!" }
          );

          data.status = "completed";
          memoDrafts.delete(data.id);
          stepper.setStatus("completed", { animate: true });
          setCardStatus("completed");
          await wait(1100);

        } catch (error) {

          await handleBudgetWriteError(error, "예산 신청 상태 변경 중 오류가 발생했습니다.");

        } finally {

          release();

        }

      });

      processActions.appendChild(completeButton);

      // --- [부분 처리 완료] 일부 품목만 처리했을 때 (남은 품목이 2건 이상일 때만 의미가 있다) ---
      const partialButton = createFlowButton({
        label: "부분 처리 완료",
        variant: "partial",
        iconName: "complete"
      });

      const syncPartialButton = () => {
        partialButton.hidden = renderProgress().remaining.length < 2;
      };
      syncPartialButton();

      partialButton.addEventListener("click", async () => {

        const picked = await openPartialCompleteDialog(data, {
          note: adminMemo.value.trim() ? `의견: ${adminMemo.value.trim()}` : ""
        });

        if (!picked) return;

        // 남은 품목을 모두 골랐으면 그냥 [처리 완료]와 같다.
        if (picked.length >= getProcessProgress(data).remaining.length) {
          completeButton.click();
          return;
        }

        const release = holdBudgetListRender();

        try {

          const nextItems = await runButtonTask(
            partialButton,
            () => markItemsProcessed(data.id, readItems(data), picked, adminMemo.value, reviewer.name),
            { busyText: "반영 중", doneText: "부분 처리 완료!" }
          );

          data.items = nextItems;
          memoDrafts.delete(data.id);
          stepper.setStatus("confirmed", { animate: true, partial: true });
          syncPartialButton();
          await wait(1100);

        } catch (error) {

          await handleBudgetWriteError(error, "부분 처리 완료 중 오류가 발생했습니다.");

        } finally {

          release();

        }

      });

      processActions.appendChild(partialButton);

    } else {

      const lockedHint = document.createElement("p");
      lockedHint.className = "flow-process-hint";
      lockedHint.textContent = canReviewBudget
        ? "심사를 시작하면 [처리 완료]를 누를 수 있어요."
        : "[처리 완료]는 예산 소위원장 · 관리자가 눌러요.";
      processActions.appendChild(lockedHint);

    }

    processPanel.append(processNote, processActions);

  }


  card.append(
    title,
    requester,
    itemCount,
    amount,
    ...typeLines,
    itemTable,
    createdAt,
    stepper,
    conflictNotice,
    adminMemoLabel,
    processPanel
  );


  // 자기 동아리 긴급 신청: 신청서 전체 반려만 할 수 있다.
  if (canRejectOnly) {

    const rejectActions = document.createElement("div");
    rejectActions.className = "flow-reject-only";

    const rejectButton = createFlowButton({
      label: "반려",
      variant: "reject"
    });

    rejectButton.addEventListener("click", async () => {

      const confirmed = await openActionDialog({
        tone: "reject",
        title: "전체 반려",
        description: "이 신청서를 반려해요. 반려된 금액은 예산 집계에서 빠져요.",
        rows: summaryRows(),
        note: adminMemo.value.trim() ? `반려 사유: ${adminMemo.value.trim()}` : "반려 사유: (없음)",
        confirmText: "반려하기"
      });

      if (!confirmed) return;

      const release = holdBudgetListRender();

      try {

        await runButtonTask(
          rejectButton,
          () => changeBudgetRequestStatus(data.id, "rejected", adminMemo.value),
          { busyText: "반려 중", doneText: "반려됨" }
        );

        memoDrafts.delete(data.id);
        stepper.setStatus("rejected", { animate: true });
        setCardStatus("rejected");
        await wait(900);

      } catch (error) {

        await handleBudgetWriteError(error, "예산 신청 상태 변경 중 오류가 발생했습니다.");

      } finally {

        release();

      }

    });

    rejectActions.appendChild(rejectButton);
    card.append(rejectActions);

  }


  return card;
}


// ========================================
// 정보 한 줄 생성
// ========================================

function createInfoLine(
  label,
  value
) {

  const paragraph =
    document.createElement("p");

  paragraph.className =
    "admin-info-line";


  const labelElement =
    document.createElement("strong");

  labelElement.textContent =
    `${label}: `;


  const valueElement =
    document.createElement("span");

  valueElement.textContent =
    value;


  paragraph.append(
    labelElement,
    valueElement
  );


  return paragraph;
}


// ========================================
// 신청서 상태 바꾸기 (처리 완료 · 반려)
// ========================================
// 실패하면 오류를 그대로 던진다. 화면 처리는 부른 쪽(handleBudgetWriteError)이 한다.
// 바뀐 내용은 실시간 구독으로 목록 · 예산 현황에 바로 반영된다.

async function changeBudgetRequestStatus(
  id,
  newStatus,
  adminMemo
) {

  await updateDoc(
    doc(
      db,
      "budgetRequests",
      id
    ),
    {
      status: newStatus,
      adminMemo: adminMemo.trim(),
      reviewedAt: serverTimestamp(),
      reviewedBy: reviewer.uid,
      reviewedByName: reviewer.name.slice(0, 40)
    }
  );

}


// 저장이 거절됐을 때. 심사 시간이 끝났으면 다시 잠그고,
// 심사 중인데도 거절되면 서버 규칙이 옛 버전일 가능성이 크다.
async function handleBudgetWriteError(error, fallbackMessage) {

  console.error(
    "예산 상태 변경 오류:",
    error
  );

  if (error?.code === "permission-denied") {

    const session = await readReviewSession();

    if (!session) {
      relockReview("심사 시간이 끝났거나 비밀번호가 바뀌었어요. 심사 비밀번호를 다시 넣어주세요.");
      return;
    }

    alert(
      "처리하지 못했어요. 권한이 없거나, 서버 보안 규칙(firestore.rules)이 아직 새 버전으로 배포되지 않았을 수 있어요."
    );
    return;

  }

  alert(fallbackMessage);

}


// ========================================
// 상태 개수
// ========================================

function countByStatus(
  budgetRequests,
  status
) {

  return budgetRequests.filter(
    (budgetRequest) =>
      budgetRequest.status === status
  ).length;

}


// ========================================
// 금액 표시
// ========================================

function formatAmount(amount) {

  const numberAmount =
    Number(amount);


  if (!Number.isFinite(numberAmount)) {
    return "금액 정보 없음";
  }


  return `${numberAmount.toLocaleString("ko-KR")}원`;
}


// ========================================
// 시간 표시
// ========================================

function formatCreatedAt(createdAt) {

  if (!createdAt) {
    return "시간 정보 없음";
  }


  if (
    typeof createdAt.toDate === "function"
  ) {

    return createdAt
      .toDate()
      .toLocaleString("ko-KR");

  }


  const date =
    new Date(createdAt);


  if (Number.isNaN(date.getTime())) {
    return "시간 정보 없음";
  }


  return date.toLocaleString("ko-KR");
}


// ========================================
// 새로고침
// ========================================

// 실시간으로 반영되지만, 연결이 끊겼을 때를 위해 구독을 다시 건다.
refreshButton.addEventListener(
  "click",
  () => loadBudgetRequests()
);


// ========================================
// 로그아웃
// ========================================

logoutButton.addEventListener(
  "click",
  () => signOutUser()
);


// ========================================
// 관리 메뉴 전환
// ========================================

const adminMenuButtons =
  document.querySelectorAll("[data-admin-target]");

const adminSections =
  document.querySelectorAll(".admin-management-section");


adminMenuButtons.forEach(
  (menuButton) => {

    menuButton.addEventListener(
      "click",
      () =>
        selectAdminSection(
          menuButton.dataset.adminTarget
        )
    );

  }
);


function selectAdminSection(targetId) {

  adminMenuButtons.forEach(
    (button) =>
      button.classList.toggle(
        "active",
        button.dataset.adminTarget === targetId
      )
  );


  adminSections.forEach(
    (section) =>
      section.classList.toggle(
        "hidden",
        section.id !== targetId
      )
  );

}


// 접근 권한이 있는 항목만 남긴다.
function applySectionAccess(
  accessibleSections,
  isFullAdmin
) {

  adminMenuButtons.forEach(
    (button) => {

      button.hidden =
        !accessibleSections.includes(
          button.dataset.adminTarget
        );

    }
  );


  adminSections.forEach(
    (section) => {

      if (
        !accessibleSections.includes(section.id)
      ) {
        section.classList.add("hidden");
      }

    }
  );


  adminAccessLabel.textContent =
    isFullAdmin
      ? "관리자 계정"
      : "소위원회 계정";


  const requestedSection =
    new URLSearchParams(
      window.location.search
    ).get("section");


  const initialSection =
    accessibleSections.includes(requestedSection)
      ? requestedSection
      : accessibleSections[0];


  selectAdminSection(initialSection);
}

