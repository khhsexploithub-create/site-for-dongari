import "../styles/site.css";
import "../styles/neoul/resources.css";

import { guardPage } from "../pageGuard.js";
import { markSectionRead } from "../notifications/readState.js";
import { mountPageBell } from "../notifications/bell.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp
} from "firebase/firestore";

import { db } from "../firebase.js";
import {
  formatAutoApproveAt,
  getAutoApprovalItems,
  isAutoApprovalOn,
  msUntilNextAutoApproval,
  settleDueAutoApprovals
} from "./autoApproval.js";
import {
  PRINTER_RESOURCE_NAME,
  PRINTER_TRAINING_MESSAGE,
  SPACE_RESERVATION_NOTICE,
  resourceList
} from "./resourceList.js";

const reservationForm = document.querySelector("#reservationForm");
const clubNameInput = document.querySelector("#reservationClubName");
const requesterNameInput = document.querySelector("#reservationRequesterName");
const resourceSelect = document.querySelector("#reservationResource");
const dateInput = document.querySelector("#reservationDate");
const startTimeInput = document.querySelector("#reservationStartTime");
const endTimeInput = document.querySelector("#reservationEndTime");
const purposeInput = document.querySelector("#reservationPurpose");
const submitButton = document.querySelector("#reservationSubmitButton");
const authMessage = document.querySelector("#reservationAuthMessage");
const formMessage = document.querySelector("#reservationFormMessage");
const resourceTabs = document.querySelectorAll(".resource-tab");
const resourceListElement = document.querySelector("#resourceList");
const spaceMap = document.querySelector("#spaceMap");
const floorPlan = document.querySelector("#floorPlan");
const floorPlanTitle = document.querySelector("#floorPlanTitle");
const floorPlanSelection = document.querySelector("#floorPlanSelection");
const floorPlanEyebrow = document.querySelector("#floorPlanEyebrow");
const floorPlanNote = document.querySelector("#floorPlanNote");
const floorTabs = document.querySelectorAll(".floor-tab");
const categoryFilter = document.querySelector("#reservationCategoryFilter");
const searchInput = document.querySelector("#reservationSearchInput");
const reservationList = document.querySelector("#reservationList");
const myReservationList = document.querySelector("#myReservationList");
const trainingNotice = document.querySelector("#reservationTrainingNotice");
const spaceReservationNotice = document.querySelector("#spaceReservationNotice");

const RESERVATIONS_COLLECTION = "resourceReservations";

// 층별 평면도.
// - resourceName 이 있는 칸만 예약 신청서로 연결되는 버튼이 된다.
// - type: "unavailable" 은 교실은 있지만 예약을 받지 않는 칸이다.
// - type: "facility" 는 교무실·계단처럼 예약 대상이 아닌 시설이다.
// - type: "empty" 는 이름 없는 빈 공간(없는 공간)이다.
// columns 는 한 층의 전체 칸 수이고, 각 칸의 span 을 더하면 columns 와 같아야
// 위아래 줄의 교실이 세로로 정확히 맞춰진다.
const FLOOR_PLANS = {
  "5층": {
    mode: "plan",
    columns: 11,
    rows: [
      { cells: [
        { label: "계단", type: "facility", span: 2 },
        { label: "1-4", type: "unavailable", span: 2 },
        { label: "1-5", type: "unavailable", span: 2 },
        { label: "1-6", type: "unavailable", span: 2 },
        { label: "컴퓨터실", resourceName: "5층 · 컴퓨터실", span: 3 }
      ] },
      { corridor: "5층 복도" },
      { cells: [
        { label: "학생부", type: "facility", span: 2 },
        { label: "1학년 교무실", type: "facility", span: 2 },
        { label: "1-8", type: "unavailable", span: 2 },
        { label: "1-7", type: "unavailable", span: 2 },
        { label: "제3청운재", type: "unavailable", span: 3 }
      ] }
    ]
  },

  "4층": {
    mode: "plan",
    columns: 8,
    rows: [
      { cells: [
        { label: "2-4", type: "unavailable", span: 2 },
        { label: "2-3", resourceName: "4층 · 2-3 교실", span: 2 },
        { label: "2-2", resourceName: "4층 · 2-2 교실", span: 2 },
        { label: "2-1", resourceName: "4층 · 2-1 교실", span: 2 }
      ] },
      { corridor: "4층 복도" },
      { cells: [
        // 2학년 교무실과 계단을 1:1 로 나눠 한 칸(2-4 와 같은 크기)에 넣는다.
        { span: 2, group: [
          { label: "2학년 교무실", type: "facility" },
          { label: "계단", type: "facility" }
        ] },
        { label: "1-1", resourceName: "4층 · 1-1 교실", span: 2 },
        { label: "1-2", resourceName: "4층 · 1-2 교실", span: 2 },
        { label: "1-3", resourceName: "4층 · 1-3 교실", span: 2 }
      ] }
    ]
  },

  "3층": {
    mode: "plan",
    columns: 14,
    rows: [
      { cells: [
        { label: "제1청운재", type: "unavailable", span: 6 },
        { type: "empty", span: 2 },
        { label: "3-7", type: "unavailable", span: 2 },
        { label: "3-8", type: "unavailable", span: 2 },
        { label: "2-5", resourceName: "3층 · 2-5 교실", span: 2 }
      ] },
      { corridor: "3층 복도" },
      { cells: [
        { label: "대외협력부", type: "facility", span: 2 },
        { label: "세미나실", resourceName: "3층 · 세미나실", span: 2 },
        { label: "교장실", type: "facility", span: 2 },
        { label: "계단", type: "facility", span: 2 },
        { label: "2-8", resourceName: "3층 · 2-8 교실", span: 2 },
        { label: "2-7", resourceName: "3층 · 2-7 교실", span: 2 },
        { label: "2-6", resourceName: "3층 · 2-6 교실", span: 2 }
      ] }
    ]
  },

  "2층": {
    mode: "plan",
    columns: 16,
    rows: [
      { cells: [
        { label: "중앙현관", type: "facility", span: 2 },
        { label: "행정실", type: "facility", span: 2 },
        { label: "전산실", type: "facility", span: 2 },
        { label: "방송실", type: "unavailable", span: 2 },
        { label: "3학년 교무실", type: "facility", span: 2 },
        { label: "3-1", type: "unavailable", span: 2 },
        { label: "3-2", type: "unavailable", span: 2 },
        { label: "3-3", type: "unavailable", span: 2 }
      ] },
      { corridor: "2층 복도" },
      { cells: [
        { label: "중앙계단", type: "facility", span: 2 },
        { label: "제1교무실", type: "facility", span: 3 },
        { label: "교감실", type: "facility", span: 2 },
        // 남는 공간은 계단을 넓혀서 채운다.
        { label: "계단", type: "facility", span: 3 },
        { label: "3-6", type: "unavailable", span: 2 },
        { label: "3-5", type: "unavailable", span: 2 },
        { label: "3-4", type: "unavailable", span: 2 }
      ] }
    ]
  },

  "1층": {
    mode: "list",
    title: "1층 선택 가능 공간",
    note: "음악실 스마트교실은 관할 구역이 아님",
    spaces: ["1층 · 다산실", "1층 · 화학실"]
  }
};

let activeCategory = "공간";
let activeFloor = "5층";
let currentUser = null;
let reservations = [];
let isSubmitting = false;
let hasPrinterAccess = false;

spaceReservationNotice.textContent = SPACE_RESERVATION_NOTICE;

renderResources();
populateResourceSelect();

resourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeCategory = tab.dataset.category;
    resourceTabs.forEach((button) => {
      const isActive = button === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
    renderResources();
  });
});

floorTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeFloor = tab.dataset.floor;
    updateFloorTabs();
    renderFloorPlan();
  });
});

categoryFilter.addEventListener("change", renderReservations);
searchInput.addEventListener("input", renderReservations);

guardPage({
  onReady: async ({ user, profile }) => {
    currentUser = user;
    hasPrinterAccess = profile.printerAccess === true;
    submitButton.disabled = false;
    authMessage.textContent = `로그인 계정: ${user.email ?? "이메일 정보 없음"}`;

    mountPageBell(user);

    // 계정에 저장된 이름을 신청자명에 미리 넣어 준다. 고쳐 쓸 수 있다.
    if (!requesterNameInput.value) {
      requesterNameInput.value = String(profile?.name ?? "").trim();
    }

    updateTrainingNotice();
    await loadReservations();

    // 이 화면을 열었으므로 '내 예약' 알림을 읽은 것으로 표시한다.
    markSectionRead("resources");
  }
});

resourceSelect.addEventListener("change", () => {
  updateTrainingNotice();
  renderResources();
});

// 교육 이수가 필요한 자원을 고르면 안내 문구를 띄우고 신청을 막는다.
function updateTrainingNotice() {
  const selectedResource = resourceList.find(({ name }) => name === resourceSelect.value);
  const needsTraining = Boolean(selectedResource?.requiresTraining) && !hasPrinterAccess;

  trainingNotice.hidden = !needsTraining;
  trainingNotice.textContent = needsTraining ? PRINTER_TRAINING_MESSAGE : "";
  submitButton.disabled = needsTraining || !currentUser;

  if (needsTraining) {
    formMessage.textContent = "";
  }
}

reservationForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser || isSubmitting) return;

  const selectedResource = resourceList.find(({ name }) => name === resourceSelect.value);
  const reservation = {
    clubName: clubNameInput.value.trim(),
    requesterName: requesterNameInput.value.trim(),
    category: selectedResource?.category ?? "",
    resourceName: resourceSelect.value,
    date: dateInput.value,
    startTime: startTimeInput.value,
    endTime: endTimeInput.value,
    purpose: purposeInput.value.trim()
  };

  if (!selectedResource) {
    formMessage.textContent = "예약할 수 있는 자원을 선택해주세요.";
    return;
  }

  if (reservation.resourceName === PRINTER_RESOURCE_NAME && !hasPrinterAccess) {
    trainingNotice.hidden = false;
    trainingNotice.textContent = PRINTER_TRAINING_MESSAGE;
    return;
  }

  if (!isValidReservation(reservation)) {
    formMessage.textContent = "모든 항목을 입력하고 종료 시간을 시작 시간보다 늦게 선택해주세요.";
    return;
  }

  isSubmitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "신청 중...";
  formMessage.textContent = "";

  try {
    const latestReservations = await getReservations();
    const hasConflict = latestReservations
      .filter((savedReservation) => savedReservation.status !== "rejected")
      .some((savedReservation) => isTimeOverlapping(reservation, savedReservation));

    if (hasConflict) {
      formMessage.textContent = "선택한 자원은 해당 시간에 이미 예약되어 있습니다. 다른 시간을 선택해주세요.";
      return;
    }

    // 모든 항목은 관리자 승인 대기로 시작한다. 관리자가 그 항목의 자동승인을 켜 둔 경우에는
    // 신청(접수) 시각 + 5분에 자동으로 승인된다. 설정은 신청할 때마다 새로 읽고,
    // 보안 규칙도 같은 설정과 5분을 다시 확인한다.
    const autoItems = await getAutoApprovalItems();
    let autoApproved = isAutoApprovalOn(autoItems, reservation.resourceName);

    try {
      await saveReservation(reservation, autoApproved);
    } catch (error) {
      // 읽은 뒤에 관리자가 자동승인을 끈 경우 규칙이 거절한다. 일반 대기로 다시 신청한다.
      if (!autoApproved || error?.code !== "permission-denied") throw error;

      autoApproved = false;
      await saveReservation(reservation, false);
    }

    reservationForm.reset();
    populateResourceSelect();
    updateTrainingNotice();
    formMessage.textContent = autoApproved
      ? "예약 신청이 접수되었습니다. 5분 뒤 자동으로 승인됩니다."
      : "예약 신청이 완료되었습니다. 관리자 승인 후 사용할 수 있습니다.";
    await loadReservations();
  } catch (error) {
    console.error("자원 예약 처리 오류:", error);
    formMessage.textContent = "예약 신청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = "예약 신청";
  }
});

// 신청은 언제나 대기(pending)로 저장한다.
// 자동승인 항목이면 autoApproveScheduled 를 켜 두고, 접수 시각 + 5분에 승인으로 바뀐다.
async function saveReservation(reservation, scheduleAutoApproval) {
  await addDoc(collection(db, RESERVATIONS_COLLECTION), {
    ...reservation,
    status: "pending",
    autoApproved: false,
    autoApproveScheduled: scheduleAutoApproval === true,
    adminMemo: "",
    reviewedAt: null,
    uid: currentUser.uid,
    createdAt: serverTimestamp()
  });
}

function renderResources() {
  const isSpaceCategory = activeCategory === "공간";
  spaceMap.hidden = !isSpaceCategory;
  resourceListElement.hidden = isSpaceCategory;
  spaceReservationNotice.hidden = !isSpaceCategory;

  if (isSpaceCategory) {
    renderFloorPlan();
    return;
  }

  renderResourceCards();
}

function renderFloorPlan() {
  const plan = FLOOR_PLANS[activeFloor];
  const selectedResource = resourceList.find(({ name }) => name === resourceSelect.value);

  floorPlan.textContent = "";
  floorPlanNote.hidden = true;
  floorPlanNote.textContent = "";

  if (!plan) {
    floorPlanTitle.textContent = `${activeFloor} 평면도`;
    return;
  }

  if (plan.mode === "list") {
    floorPlanEyebrow.hidden = true;
    floorPlanTitle.textContent = plan.title ?? `${activeFloor} 선택 가능 공간`;
    floorPlan.setAttribute("aria-label", `${activeFloor} 공간 선택`);
    renderFloorSpacePicker(plan);
  } else {
    floorPlanEyebrow.hidden = false;
    floorPlanTitle.textContent = `${activeFloor} 평면도`;
    floorPlan.setAttribute("aria-label", `${activeFloor} 공간 선택`);
    renderFloorPlanRows(plan);
  }

  floorPlanSelection.textContent = selectedResource?.category === "공간"
    ? `선택된 공간: ${selectedResource.name}`
    : "";
}

// 평면도가 없는 층은 선택 가능한 공간만 카드로 보여준다.
function renderFloorSpacePicker(plan) {
  const picker = document.createElement("div");
  picker.className = "floor-space-picker";

  plan.spaces.forEach((resourceName) => {
    const resource = resourceList.find(({ name }) => name === resourceName);
    if (!resource) return;

    const isSelected = resource.name === resourceSelect.value;
    const option = document.createElement("button");
    option.type = "button";
    option.className = "floor-space-option";
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-pressed", String(isSelected));

    const name = document.createElement("strong");
    name.textContent = resource.name.split(" · ").at(-1);

    const description = document.createElement("span");
    description.textContent = resource.description;

    option.append(name, description);
    option.addEventListener("click", () => selectResourceForReservation(resource));
    picker.appendChild(option);
  });

  floorPlan.appendChild(picker);

  if (plan.note) {
    floorPlanNote.hidden = false;
    floorPlanNote.textContent = plan.note;
  }
}

function renderFloorPlanRows(plan) {
  plan.rows.forEach((row) => {
    if (row.corridor) {
      const corridor = document.createElement("div");
      corridor.className = "floor-plan-corridor";
      corridor.textContent = row.corridor;
      floorPlan.appendChild(corridor);
      return;
    }

    const planRow = document.createElement("div");
    planRow.className = "floor-plan-row";
    planRow.style.setProperty("--plan-columns", String(plan.columns));

    row.cells.forEach((cell) => {
      planRow.appendChild(createFloorPlanCell(cell));
    });

    floorPlan.appendChild(planRow);
  });
}

function createFloorPlanCell(cell) {
  // 한 칸을 1:1 로 나눠 쓰는 묶음 칸
  if (Array.isArray(cell.group)) {
    const group = document.createElement("div");
    group.className = "floor-room-group";
    group.style.setProperty("--cell-span", String(cell.span ?? 1));

    cell.group.forEach((part) => {
      const partElement = document.createElement("div");
      partElement.className = `floor-room floor-room-part ${getCellClassName(part.type)}`;
      partElement.textContent = part.label ?? "";
      group.appendChild(partElement);
    });

    return group;
  }

  const resource = cell.resourceName
    ? resourceList.find(({ name }) => name === cell.resourceName)
    : null;

  // 예약할 수 있는 공간만 버튼이 된다.
  if (resource) {
    const isSelected = resource.name === resourceSelect.value;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floor-room";
    button.style.setProperty("--cell-span", String(cell.span ?? 1));
    button.textContent = cell.label;
    button.classList.toggle("is-selected", isSelected);
    button.title = `${resource.name} 예약 선택`;
    button.setAttribute("aria-pressed", String(isSelected));
    button.addEventListener("click", () => selectResourceForReservation(resource));
    return button;
  }

  const cellElement = document.createElement("div");
  cellElement.className = `floor-room ${getCellClassName(cell.type)}`;
  cellElement.style.setProperty("--cell-span", String(cell.span ?? 1));

  if (cell.type === "empty") {
    cellElement.setAttribute("aria-hidden", "true");
    return cellElement;
  }

  cellElement.textContent = cell.label ?? "";
  cellElement.setAttribute(
    "aria-label",
    cell.type === "unavailable"
      ? `${cell.label} · 예약 불가`
      : `${cell.label} · 예약 대상 아님`
  );

  return cellElement;
}

function getCellClassName(type) {
  return ({
    unavailable: "is-unavailable",
    empty: "is-empty",
    facility: "is-facility"
  })[type] ?? "is-facility";
}

function updateFloorTabs() {
  floorTabs.forEach((tab) => {
    const isActive = tab.dataset.floor === activeFloor;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

function renderResourceCards() {
  resourceListElement.textContent = "";

  resourceList
    .filter(({ category }) => category === activeCategory)
    .forEach((resource) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const description = document.createElement("span");
      const meta = document.createElement("div");
      const isSelected = resource.name === resourceSelect.value;

      item.className = "resource-item";
      item.dataset.selectable = "true";
      item.classList.toggle("is-selected", isSelected);
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-pressed", String(isSelected));
      item.setAttribute("aria-label", `${resource.name} 예약 선택`);

      name.textContent = resource.name;
      description.textContent = resource.description;
      meta.className = "resource-meta";

      const availabilityBadge = document.createElement("span");
      availabilityBadge.className = "resource-availability-badge";
      availabilityBadge.textContent = "예약 가능";
      meta.appendChild(availabilityBadge);

      if (resource.requiresTraining) {
        const badge = document.createElement("span");
        badge.className = "resource-training-badge";
        badge.textContent = "사전 교육 필요";
        meta.appendChild(badge);
      }

      item.append(name, description, meta);
      item.addEventListener("click", () => selectResourceForReservation(resource));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectResourceForReservation(resource);
        }
      });
      resourceListElement.appendChild(item);
    });
}

function selectResourceForReservation(resource) {
  resourceSelect.value = resource.name;

  if (resource.category === "공간" && resource.floor) {
    activeFloor = resource.floor;
    updateFloorTabs();
  }

  updateTrainingNotice();
  renderResources();
  reservationForm.scrollIntoView({ behavior: "smooth", block: "start" });
  resourceSelect.focus({ preventScroll: true });
}

function populateResourceSelect() {
  const currentValue = resourceSelect.value;
  resourceSelect.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "예약할 자원을 선택하세요";
  placeholder.disabled = true;
  placeholder.selected = !currentValue;
  resourceSelect.appendChild(placeholder);

  const appendGroup = (label, resources) => {
    const group = document.createElement("optgroup");
    group.label = label;

    resources.forEach((resource) => {
      const option = document.createElement("option");
      option.value = resource.name;
      option.textContent = resource.name;
      option.selected = resource.name === currentValue;
      group.appendChild(option);
    });

    resourceSelect.appendChild(group);
  };

  const floors = [...new Set(
    resourceList
      .filter(({ category }) => category === "공간")
      .map(({ floor }) => floor)
      .filter(Boolean)
  )];

  floors.forEach((floor) => {
    appendGroup(
      `공간 · ${floor}`,
      resourceList.filter((resource) => (
        resource.category === "공간"
        && resource.floor === floor
      ))
    );
  });

  ["장비", "물품"].forEach((category) => {
    appendGroup(
      category,
      resourceList.filter((resource) => resource.category === category)
    );
  });
}

async function loadReservations() {
  reservationList.textContent = "예약 내역을 불러오는 중...";
  myReservationList.textContent = "내 예약을 불러오는 중...";

  try {
    reservations = await getReservations();
    // 접수 + 5분이 지난 자동승인 대기 신청을 승인으로 바꾼다.
    await settleDueAutoApprovals(reservations);
    renderReservations();
    renderMyReservations();
    scheduleAutoApprovalRefresh();
  } catch (error) {
    console.error("예약 내역 조회 오류:", error);
    reservationList.textContent = "예약 내역을 불러오지 못했습니다.";
    myReservationList.textContent = "내 예약을 불러오지 못했습니다.";
  }
}

// 화면을 열어 둔 사이에 5분이 지나면 목록을 다시 읽어 승인 상태로 보여 준다.
let autoApprovalTimer = 0;

function scheduleAutoApprovalRefresh() {
  window.clearTimeout(autoApprovalTimer);
  const waitMs = msUntilNextAutoApproval(reservations);
  if (waitMs < 0) return;

  // 기기 시계와 서버 시계가 조금 어긋날 수 있어 몇 초 여유를 둔다.
  autoApprovalTimer = window.setTimeout(loadReservations, waitMs + 3000);
}

async function getReservations() {
  const snapshot = await getDocs(collection(db, RESERVATIONS_COLLECTION));
  return snapshot.docs
    .map((reservationDoc) => ({ id: reservationDoc.id, ...reservationDoc.data() }))
    .sort((first, second) => `${first.date ?? ""}${first.startTime ?? ""}`.localeCompare(`${second.date ?? ""}${second.startTime ?? ""}`));
}

function renderReservations() {
  const searchTerm = searchInput.value.trim().toLocaleLowerCase("ko-KR");

  // 관리자가 승인한 예약만 공개 내역에 기재한다.
  const filteredReservations = reservations.filter((reservation) => (
    ["approved", "completed"].includes(reservation.status)
    && (!categoryFilter.value || reservation.category === categoryFilter.value)
    && (!searchTerm || (reservation.resourceName ?? "").toLocaleLowerCase("ko-KR").includes(searchTerm))
  ));

  renderReservationItems(reservationList, filteredReservations, "승인된 예약 내역이 없습니다.");
}

function renderMyReservations() {
  const myReservations = reservations.filter((reservation) => reservation.uid === currentUser?.uid);
  renderReservationItems(myReservationList, myReservations, "아직 신청한 예약이 없습니다.", true, true);
}

function renderReservationItems(listElement, items, emptyMessage, showCancelButton = false, showAdminMemo = false) {
  listElement.textContent = "";
  if (items.length === 0) {
    listElement.textContent = emptyMessage;
    return;
  }

  items.forEach((reservation) => {
    const item = document.createElement("li");
    item.className = "reservation-item";
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    const status = document.createElement("span");
    title.textContent = reservation.resourceName ?? "자원명 없음";
    status.className = `reservation-status status-${reservation.status ?? "pending"}`;
    status.textContent = getStatusName(reservation.status);
    if (reservation.autoApproved === true && reservation.status === "approved") {
      status.textContent = "자동 승인됨";
    }
    const autoApproveAt = formatAutoApproveAt(reservation);
    if (autoApproveAt) {
      status.textContent = `자동승인 예정 ${autoApproveAt}`;
    }
    heading.append(title, status);

    const details = document.createElement("p");
    const requester = reservation.requesterName ? ` · 신청자 ${reservation.requesterName}` : "";
    details.textContent = `${reservation.clubName ?? "동아리명 없음"}${requester} · ${reservation.category ?? "카테고리 없음"} · ${reservation.date ?? "날짜 미정"} ${reservation.startTime ?? ""}~${reservation.endTime ?? ""}`;
    const purpose = document.createElement("p");
    purpose.className = "reservation-purpose";
    purpose.textContent = `사용 목적: ${reservation.purpose ?? "입력된 내용 없음"}`;
    item.append(heading, details, purpose);

    // 승인 / 반려 사유는 신청자 본인에게만 보여준다.
    if (showAdminMemo && reservation.adminMemo) {
      const adminMemo = document.createElement("p");
      adminMemo.className = "reservation-admin-memo";
      adminMemo.textContent = `관리자 의견: ${reservation.adminMemo}`;
      item.appendChild(adminMemo);
    }

    if (showCancelButton && canCancelReservation(reservation)) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "secondary reservation-cancel-button";
      cancelButton.textContent = "예약 취소";
      cancelButton.addEventListener("click", () => cancelReservation(reservation, cancelButton));
      item.appendChild(cancelButton);
    }

    listElement.appendChild(item);
  });
}

// 승인 대기 중인 예약과, 자동승인으로 바로 확정된 예약은 본인이 취소할 수 있다.
function canCancelReservation(reservation) {
  return reservation.status === "pending"
    || (reservation.status === "approved" && reservation.autoApproved === true);
}

async function cancelReservation(reservation, cancelButton) {
  if (!currentUser || reservation.uid !== currentUser.uid || !canCancelReservation(reservation)) return;
  if (!window.confirm(`'${reservation.resourceName}' 예약을 취소할까요?`)) return;

  cancelButton.disabled = true;
  cancelButton.textContent = "취소 중...";
  try {
    await deleteDoc(doc(db, RESERVATIONS_COLLECTION, reservation.id));
    await loadReservations();
  } catch (error) {
    console.error("예약 취소 오류:", error);
    cancelButton.disabled = false;
    cancelButton.textContent = "예약 취소";
    formMessage.textContent = "예약을 취소하지 못했습니다. 잠시 후 다시 시도해주세요.";
  }
}

function isValidReservation({ clubName, requesterName, category, resourceName, date, startTime, endTime, purpose }) {
  return Boolean(
    clubName && requesterName && category && resourceName
    && date && startTime && endTime && purpose && startTime < endTime
  );
}

function isTimeOverlapping(candidate, savedReservation) {
  return savedReservation.resourceName === candidate.resourceName
    && savedReservation.date === candidate.date
    && candidate.startTime < savedReservation.endTime
    && candidate.endTime > savedReservation.startTime;
}

function getStatusName(status) {
  return ({ approved: "승인됨", rejected: "반려됨", completed: "사용 완료", pending: "승인 대기" })[status] ?? "승인 대기";
}
