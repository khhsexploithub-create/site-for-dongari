// 01 예산 관리 — 승인 이후의 흐름을 보여 주는 화면 부품.
//
//   신청 → 승인 → 연합회장 확인 → 처리 → 처리 완료
//   (승인 후 반려되면 집계에서 빠진다)
//
//  - createBudgetOverview : [승인 예산] · [처리 완료 예산] 현황 (Firestore 실시간)
//  - createFlowStepper    : 카드마다 지금 어느 단계인지 보여 주는 진행 표시
//  - openActionDialog     : 처리 전에 한 번 더 확인하는 창
//  - openProcessDialog    : [처리] — 승인된 품목의 구매 링크 목록
//  - openPartialCompleteDialog : [부분 처리 완료] — 처리를 마친 품목 고르기
//  - createFlowButton · runButtonTask : 누르는 느낌이 있는 단추와 진행 상태 표시

import { formatMoney } from "../budget/requestSheet.js";
import {
  getProcessTargets,
  isItemProcessed,
  summarizeBudget
} from "../budget/budgetService.js";
import { withProtocol } from "./budgetReview.js";

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// ========================================
// 예산 현황 — [승인 예산] · [처리 완료 예산]
// ========================================

export function createBudgetOverview(root) {
  root.classList.add("budget-overview");
  root.innerHTML = `
    <div class="bo-head">
      <div>
        <p class="bo-eyebrow">전체 동아리 예산 현황</p>
        <h3 class="bo-title">승인부터 처리 완료까지 한눈에</h3>
      </div>
      <span class="bo-live" data-ref="live"><i aria-hidden="true"></i><span data-ref="liveText">불러오는 중</span></span>
    </div>

    <div class="bo-grid">
      <section class="bo-panel is-approved" aria-label="승인 예산">
        <div class="bo-panel-top">
          <span class="bo-tag"><i aria-hidden="true"></i>승인 예산</span>
          <span class="bo-count" data-ref="approvedCount">0건</span>
        </div>
        <p class="bo-amount"><span data-ref="approvedTotal">0</span><small>원</small></p>
        <div class="bo-bar" data-ref="bar" role="img">
          <span class="is-wait" data-ref="barWait"></span>
          <span class="is-confirmed" data-ref="barConfirmed"></span>
          <span class="is-done" data-ref="barDone"></span>
        </div>
        <ul class="bo-legend">
          <li class="is-wait"><i aria-hidden="true"></i><span>연합회장 확인 대기</span><b data-ref="wait">0원</b></li>
          <li class="is-confirmed"><i aria-hidden="true"></i><span>확인 완료 · 처리 대기</span><b data-ref="confirmed">0원</b></li>
          <li class="is-done"><i aria-hidden="true"></i><span>처리 완료</span><b data-ref="done">0원</b></li>
        </ul>
      </section>

      <section class="bo-panel is-completed" aria-label="처리 완료 예산">
        <div class="bo-panel-top">
          <span class="bo-tag"><i aria-hidden="true"></i>처리 완료 예산</span>
          <span class="bo-count" data-ref="completedCount">0건</span>
        </div>
        <p class="bo-amount"><span data-ref="completedTotal">0</span><small>원</small></p>
        <div class="bo-meter">
          <div class="bo-meter-track"><span data-ref="meter"></span></div>
          <b data-ref="percent">0%</b>
        </div>
        <p class="bo-remain">아직 처리하지 않은 승인 예산 <b data-ref="remain">0원</b></p>
      </section>
    </div>

    <p class="bo-foot" data-ref="foot">승인했다가 반려한 품목 · 신청은 상태가 바뀌는 즉시 합계에서 빠져요.</p>
  `;

  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const numbers = new Map();

  function setNumber(name, value, suffix = "") {
    const element = ref(name);
    const previous = numbers.get(name);
    numbers.set(name, value);

    if (previous === undefined || previous === value || prefersReducedMotion()) {
      element.textContent = `${formatMoney(value)}${suffix}`;
      if (previous !== undefined && previous !== value) bump(element);
      return;
    }

    countUp(element, previous, value, suffix);
    bump(element);
  }

  function bump(element) {
    const target = element.closest(".bo-amount, li, .bo-remain") ?? element;
    target.classList.remove("is-bump");
    void target.offsetWidth;
    target.classList.add("is-bump");
  }

  function update(budgetRequests) {
    const summary = summarizeBudget(budgetRequests);
    const total = summary.approvedTotal;
    const share = (value) => (total > 0 ? (value / total) * 100 : 0);
    const percent = total > 0 ? Math.round((summary.completedTotal / total) * 100) : 0;

    setNumber("approvedTotal", total);
    setNumber("completedTotal", summary.completedTotal);
    setNumber("wait", summary.awaitingConfirm, "원");
    setNumber("confirmed", summary.confirmed, "원");
    setNumber("done", summary.completedTotal, "원");
    setNumber("remain", Math.max(total - summary.completedTotal, 0), "원");

    ref("approvedCount").textContent = `${summary.approvedCount}건`;
    ref("completedCount").textContent = `${summary.completedCount}건`;
    ref("percent").textContent = `${percent}%`;

    ref("barWait").style.width = `${share(summary.awaitingConfirm)}%`;
    ref("barConfirmed").style.width = `${share(summary.confirmed)}%`;
    ref("barDone").style.width = `${share(summary.completedTotal)}%`;
    ref("bar").setAttribute(
      "aria-label",
      `확인 대기 ${formatMoney(summary.awaitingConfirm)}원, 처리 대기 ${formatMoney(summary.confirmed)}원, 처리 완료 ${formatMoney(summary.completedTotal)}원`
    );
    ref("meter").style.width = `${percent}%`;

    ref("foot").textContent = summary.rejectedCount > 0
      ? `반려된 신청 ${summary.rejectedCount}건과 반려 품목은 합계에서 뺐어요. 상태가 바뀌면 바로 다시 계산해요.`
      : "승인했다가 반려한 품목 · 신청은 상태가 바뀌는 즉시 합계에서 빠져요.";

    root.classList.remove("is-error");
    ref("liveText").textContent = "실시간 반영 중";
    root.classList.add("is-live");
  }

  function setError(message) {
    root.classList.remove("is-live");
    root.classList.add("is-error");
    ref("liveText").textContent = message;
  }

  return { update, setError };
}

function countUp(element, from, to, suffix) {
  const duration = 700;
  const start = performance.now();
  const token = Symbol("count");
  element._countToken = token;

  function frame(now) {
    if (element._countToken !== token) return;
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = `${formatMoney(Math.round(from + (to - from) * eased))}${suffix}`;
    if (progress < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

// ========================================
// 진행 단계 표시
// ========================================

const FLOW_STEPS = ["신청", "승인", "연합회장 확인", "처리", "처리 완료"];

// done: 끝난 단계 수 · current: 지금 진행 중인 단계 (-1 이면 모두 끝)
function getFlowPosition(status) {
  switch (status) {
    case "approved":
    case "partial":
      return { done: 2, current: 2, tone: "normal" };
    case "confirmed":
      return { done: 3, current: 3, tone: "normal" };
    case "completed":
      return { done: 5, current: -1, tone: "normal" };
    case "rejected":
      return { done: 1, current: 1, tone: "rejected" };
    case "assembly":
      return { done: 1, current: 1, tone: "assembly" };
    default:
      return { done: 1, current: 1, tone: "normal" };
  }
}

function getStepLabel(index, status, partial = false) {
  if (index === 1) {
    if (status === "partial") return "부분 승인";
    if (status === "rejected") return "반려";
    if (status === "assembly") return "본 회의 안건";
  }
  if (index === 3 && status === "confirmed") return partial ? "부분 처리 완료" : "처리 중";
  return FLOW_STEPS[index];
}

// partial: 연합회장 확인 뒤 일부 품목만 처리 완료된 상태
export function createFlowStepper(status, { partial: initialPartial = false } = {}) {
  const list = el("ol", "flow-stepper");
  list.setAttribute("aria-label", "처리 단계");

  FLOW_STEPS.forEach(() => {
    const step = el("li", "flow-step");
    const dot = el("span", "flow-dot");
    dot.setAttribute("aria-hidden", "true");
    step.append(dot, el("span", "flow-label"));
    list.appendChild(step);
  });

  let partial = initialPartial;

  function setStatus(nextStatus, { animate = false, partial: nextPartial = partial } = {}) {
    partial = nextPartial === true;
    const { done, current, tone } = getFlowPosition(nextStatus);
    list.dataset.tone = tone;
    list.classList.toggle("is-partial", nextStatus === "confirmed" && partial);

    [...list.children].forEach((step, index) => {
      const wasDone = step.classList.contains("is-done");
      const isDone = index < done;
      const isCurrent = index === current;

      step.classList.toggle("is-done", isDone);
      step.classList.toggle("is-current", isCurrent);
      step.classList.toggle("is-just-done", animate && isDone && !wasDone);
      step.querySelector(".flow-label").textContent = getStepLabel(index, nextStatus, partial);
      step.querySelector(".flow-dot").textContent = isDone ? "✓" : String(index + 1);

      if (isCurrent) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  }

  setStatus(status);
  list.setStatus = setStatus;
  return list;
}

// ========================================
// 단추 — 눌림 · 물결 · 진행 중 · 완료
// ========================================

const ICONS = {
  president: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
  process: '<path d="M4 7h16M4 12h10M4 17h7"/><path d="M17 14l3 3-3 3"/>',
  complete: '<path d="M20 6L9 17l-5-5"/>',
  reject: '<path d="M18 6L6 18M6 6l12 12"/>',
  link: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
};

function icon(name) {
  const span = el("span", "flow-btn-icon");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
  return span;
}

export function createFlowButton({ label, variant, iconName = variant, size = "" }) {
  const button = el("button", `flow-btn is-${variant}${size ? ` is-${size}` : ""}`);
  button.type = "button";
  button.append(icon(iconName), el("span", "flow-btn-label", label));
  button.dataset.label = label;
  attachPress(button);
  return button;
}

// 누른 자리에서 물결이 퍼진다.
export function attachPress(button) {
  button.addEventListener("pointerdown", (event) => {
    if (button.disabled || prefersReducedMotion()) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = el("span", "flow-ripple");
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    button.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  });
}

function setButtonLabel(button, text) {
  const label = button.querySelector(".flow-btn-label");
  if (label) label.textContent = text;
}

// 단추를 누른 뒤의 진행 과정: 진행 중(빙글) → 완료(체크 · 반짝) / 실패(흔들림)
export async function runButtonTask(button, task, { busyText = "처리 중", doneText = "완료" } = {}) {
  button.disabled = true;
  button.classList.remove("is-error", "is-success");
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  setButtonLabel(button, busyText);

  try {
    const result = await task();
    button.classList.remove("is-busy");
    button.classList.add("is-success");
    setButtonLabel(button, doneText);
    button.querySelector(".flow-btn-icon")?.replaceWith(icon("complete"));
    burst(button);
    return result;
  } catch (error) {
    button.classList.remove("is-busy");
    button.classList.add("is-error");
    setButtonLabel(button, button.dataset.label ?? "");
    button.disabled = false;
    throw error;
  } finally {
    button.removeAttribute("aria-busy");
  }
}

// 완료 때 단추 둘레로 작은 조각이 튄다.
function burst(button) {
  if (prefersReducedMotion()) return;
  const layer = el("span", "flow-burst");
  layer.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 10; index += 1) {
    const piece = el("i");
    piece.style.setProperty("--angle", `${index * 36}deg`);
    layer.appendChild(piece);
  }
  button.appendChild(layer);
  setTimeout(() => layer.remove(), 900);
}

// ========================================
// 확인 창
// ========================================

// rows: [이름, 값] 목록. 돌려주는 값: 확인을 누르면 true.
export function openActionDialog({
  tone = "president",
  title,
  description = "",
  rows = [],
  note = "",
  confirmText = "확인",
  cancelText = "취소"
}) {
  const dialog = el("dialog", `flow-dialog is-${tone}`);

  if (typeof dialog.showModal !== "function") {
    const lines = [title, description, ...rows.map(([label, value]) => `${label}: ${value}`), "", "이대로 처리할까요?"];
    return Promise.resolve(window.confirm(lines.filter((line) => line !== undefined).join("\n")));
  }

  const form = el("form", "flow-dialog-body");
  form.method = "dialog";

  const badge = el("span", "flow-dialog-icon");
  badge.appendChild(icon(tone));

  const heading = el("h3", "flow-dialog-title", title);
  const text = el("p", "flow-dialog-desc", description);

  const table = el("dl", "flow-dialog-rows");
  rows.forEach(([label, value]) => {
    const row = el("div");
    row.append(el("dt", "", label), el("dd", "", String(value ?? "-")));
    table.appendChild(row);
  });

  const actions = el("div", "flow-dialog-actions");
  const cancel = createFlowButton({ label: cancelText, variant: "ghost", iconName: "reject" });
  cancel.value = "cancel";
  cancel.type = "submit";
  const confirm = createFlowButton({ label: confirmText, variant: tone });
  confirm.value = "confirm";
  confirm.type = "submit";
  actions.append(cancel, confirm);

  form.append(badge, heading, text);
  if (rows.length > 0) form.appendChild(table);
  if (note) form.appendChild(el("p", "flow-dialog-note", note));
  form.appendChild(actions);
  dialog.appendChild(form);
  document.body.appendChild(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.classList.add("is-closing");
      setTimeout(() => dialog.remove(), 200);
    }, { once: true });

    // 바깥(배경)을 누르면 닫는다.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close("cancel");
    });

    dialog.showModal();
    confirm.focus();
  });
}

// ========================================
// [처리] — 승인된 품목별 구매 링크
// ========================================

export function openProcessDialog(budgetRequest) {
  // 품목별 상태가 없던 옛 기록은 신청서가 승인됐으므로 모두 산다.
  const targets = getProcessTargets(budgetRequest);

  const dialog = el("dialog", "flow-dialog flow-process-dialog is-process");
  const body = el("div", "flow-dialog-body");

  const badge = el("span", "flow-dialog-icon");
  badge.appendChild(icon("process"));

  const heading = el("h3", "flow-dialog-title", "처리 — 품목별 구매 링크");
  const desc = el(
    "p",
    "flow-dialog-desc",
    `${budgetRequest.clubName ?? "동아리"} · 승인된 품목 ${targets.length}건. 품목을 누르면 구매 페이지가 새 창으로 열려요.`
  );

  const list = el("ol", "flow-link-list");
  let opened = 0;
  const progress = el("p", "flow-link-progress");
  const renderProgress = () => {
    const withLinks = targets.filter(({ item }) => item.purchaseLink).length;
    progress.textContent = withLinks > 0
      ? `열어 본 링크 ${opened} / ${withLinks}`
      : "등록된 구매 링크가 없어요. 신청자에게 링크를 받아 처리해주세요.";
  };

  if (targets.length === 0) {
    list.appendChild(el("li", "flow-link-empty", "승인된 품목이 없어요."));
  }

  let order = 0;

  targets.forEach(({ item }) => {
    const row = el("li", "flow-link-row");
    const name = item.itemName || "물품 이름 없음";
    if (!item.isShipping) order += 1;
    const meta = `${formatMoney(item.quantity)}개 × ${formatMoney(item.unitPrice)}원 = ${formatMoney(item.amount)}원`;

    const number = el("span", "flow-link-no", item.isShipping ? "↳" : String(order));
    const text = el("span", "flow-link-text");
    const label = item.isShipping && !name.includes("배송") ? `배송비 · ${name}` : name;
    text.append(el("strong", "", label), el("small", "", meta));
    if (isItemProcessed(item)) {
      text.appendChild(el("em", "flow-link-done", "처리 완료"));
    }

    if (item.purchaseLink) {
      const link = el("a", "flow-link");
      link.href = withProtocol(item.purchaseLink);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = link.href;
      link.append(number, text, icon("link"));
      attachPress(link);
      link.addEventListener("click", () => {
        if (!link.classList.contains("is-opened")) {
          link.classList.add("is-opened");
          opened += 1;
          renderProgress();
        }
      });
      row.appendChild(link);
    } else {
      const plain = el("div", "flow-link is-missing");
      plain.append(number, text, el("span", "flow-link-missing", "링크 없음"));
      row.appendChild(plain);
    }

    list.appendChild(row);
  });

  renderProgress();

  const notice = el("p", "flow-teacher-note");
  notice.append(el("b", "", "선생님이 처리 후 눌러주세요"), document.createTextNode(" — 구매를 마치면 카드의 [처리 완료]를 눌러요."));

  const actions = el("div", "flow-dialog-actions");
  const close = createFlowButton({ label: "닫기", variant: "ghost", iconName: "reject" });
  close.addEventListener("click", () => dialog.close());
  actions.appendChild(close);

  body.append(badge, heading, desc, list, progress, notice, actions);
  dialog.appendChild(body);
  document.body.appendChild(dialog);

  dialog.addEventListener("close", () => {
    dialog.classList.add("is-closing");
    setTimeout(() => dialog.remove(), 200);
  }, { once: true });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

// ========================================
// [부분 처리 완료] — 처리를 마친 품목 고르기
// ========================================
// 고른 품목 번호(readItems 기준) 목록을 돌려준다. 취소하면 null.

export function openPartialCompleteDialog(budgetRequest, { note = "" } = {}) {
  const remaining = getProcessTargets(budgetRequest)
    .filter(({ item }) => !isItemProcessed(item));
  const doneCount = getProcessTargets(budgetRequest).length - remaining.length;

  const dialog = el("dialog", "flow-dialog flow-partial-dialog is-complete");

  if (typeof dialog.showModal !== "function") {
    return Promise.resolve(null);
  }

  const form = el("form", "flow-dialog-body");
  form.method = "dialog";

  const badge = el("span", "flow-dialog-icon");
  badge.appendChild(icon("complete"));

  const heading = el("h3", "flow-dialog-title", "부분 처리 완료");
  const desc = el(
    "p",
    "flow-dialog-desc",
    `구매를 마친 품목만 골라주세요. 고른 품목 금액이 [처리 완료 예산]에 더해지고, 남은 품목은 계속 처리 대기로 남아요.`
      + (doneCount > 0 ? ` (이미 처리 완료 ${doneCount}건)` : "")
  );

  const list = el("ol", "flow-link-list flow-partial-list");
  const checkboxes = [];
  let order = 0;

  remaining.forEach(({ item, index }) => {
    const row = el("li", "flow-link-row");
    const label = el("label", "flow-link flow-partial-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(index);
    checkbox.className = "flow-partial-check";

    const name = item.itemName || "물품 이름 없음";
    if (!item.isShipping) order += 1;
    const text = el("span", "flow-link-text");
    text.append(
      el("strong", "", item.isShipping && !name.includes("배송") ? `배송비 · ${name}` : name),
      el("small", "", `${formatMoney(item.quantity)}개 × ${formatMoney(item.unitPrice)}원 = ${formatMoney(item.amount)}원`)
    );

    label.append(el("span", "flow-link-no", item.isShipping ? "↳" : String(order)), text, checkbox);
    row.appendChild(label);
    list.appendChild(row);
    checkboxes.push({ checkbox, item });
  });

  const total = el("p", "flow-link-progress");
  const actions = el("div", "flow-dialog-actions");
  const cancel = createFlowButton({ label: "취소", variant: "ghost", iconName: "reject" });
  cancel.value = "cancel";
  cancel.type = "submit";
  const confirm = createFlowButton({ label: "선택 품목 처리 완료", variant: "complete" });
  confirm.value = "confirm";
  confirm.type = "submit";
  actions.append(cancel, confirm);

  function renderTotal() {
    const chosen = checkboxes.filter(({ checkbox }) => checkbox.checked);
    const amount = chosen.reduce((sum, { item }) => sum + (Number(item.amount) || 0), 0);
    total.textContent = chosen.length > 0
      ? `선택 ${chosen.length} / ${checkboxes.length}건 · ${formatMoney(amount)}원`
        + (chosen.length === checkboxes.length ? " — 모두 고르면 [처리 완료]로 바뀌어요." : "")
      : "처리를 마친 품목을 하나 이상 골라주세요.";
    confirm.disabled = chosen.length === 0;
    checkboxes.forEach(({ checkbox }) => {
      checkbox.closest(".flow-link").classList.toggle("is-opened", checkbox.checked);
    });
  }

  checkboxes.forEach(({ checkbox }) => checkbox.addEventListener("change", renderTotal));
  renderTotal();

  form.append(badge, heading, desc, list, total);
  if (note) form.appendChild(el("p", "flow-dialog-note", note));
  form.appendChild(actions);
  dialog.appendChild(form);
  document.body.appendChild(dialog);

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const picked = checkboxes
        .filter(({ checkbox }) => checkbox.checked)
        .map(({ checkbox }) => Number(checkbox.value));
      resolve(dialog.returnValue === "confirm" && picked.length > 0 ? picked : null);
      dialog.classList.add("is-closing");
      setTimeout(() => dialog.remove(), 200);
    }, { once: true });

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close("cancel");
    });

    dialog.showModal();
  });
}
