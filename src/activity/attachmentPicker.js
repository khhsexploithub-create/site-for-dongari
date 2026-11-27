// 과제 등록 · 수정 창, 제출글 작성 · 수정 화면의 첨부 칸.
// 이미 저장된 첨부(해제할 수 있다)와 새로 고르는 파일 칸을 한 목록에 보여주고,
// 합쳐서 최대 10개, 파일 하나당 30MB 까지만 받는다.

import { MAX_FILE_BYTES, MAX_FILE_COUNT, formatFileSize } from "./attachmentUpload.js";

export function createAttachmentPicker({ list, addButton, message }) {
  let kept = [];
  let existingRows = [];
  let fileRows = [];

  function showMessage(text) {
    if (message) message.textContent = text;
  }

  function rowCount() {
    return kept.length + fileRows.length;
  }

  function refreshAddButton() {
    addButton.hidden = rowCount() >= MAX_FILE_COUNT;
  }

  function clearList() {
    list.textContent = "";
    existingRows = [];
    fileRows = [];
  }

  // 이미 저장된 첨부. 해제하면 목록에서 빠지고, 저장할 때 실제로 지워진다.
  function addExistingRow(attachment) {
    const item = document.createElement("li");
    item.className = "board-attach-row";

    const label = document.createElement("span");
    label.className = "board-attach-label";
    label.textContent = "기존";

    const box = document.createElement("div");
    box.className = "board-attach-box is-filled";
    box.style.cursor = "default";

    const name = document.createElement("span");
    name.className = "board-attach-name";
    name.textContent = attachment.name || "파일";

    const size = document.createElement("span");
    size.className = "board-attach-size";
    size.textContent = formatFileSize(attachment.size);

    box.append(name, size);

    const detach = document.createElement("button");
    detach.type = "button";
    detach.className = "board-attach-clear";
    detach.textContent = "×";
    detach.setAttribute("aria-label", `${attachment.name || "파일"} 첨부 해제`);
    detach.title = "첨부 해제";

    detach.addEventListener("click", () => {
      kept = kept.filter((entry) => entry !== attachment);
      existingRows = existingRows.filter((row) => row !== item);
      item.remove();
      showMessage("");
      refreshAddButton();
    });

    item.append(label, box, detach);
    // 기존 첨부는 새 파일 칸보다 항상 위에 둔다.
    list.insertBefore(item, fileRows[0] ?? null);
    existingRows.push(item);
  }

  function addFileRow() {
    if (rowCount() >= MAX_FILE_COUNT) {
      showMessage(`첨부는 최대 ${MAX_FILE_COUNT}개까지 올릴 수 있습니다.`);
      refreshAddButton();
      return;
    }

    const item = document.createElement("li");
    item.className = "board-attach-row";

    const label = document.createElement("span");
    label.className = "board-attach-label";
    label.textContent = "추가";

    const box = document.createElement("label");
    box.className = "board-attach-box";

    const input = document.createElement("input");
    input.type = "file";
    input.className = "board-attach-input";
    input.setAttribute("aria-label", "추가할 첨부파일");

    const choose = document.createElement("span");
    choose.className = "board-attach-choose";
    choose.textContent = "파일 선택";

    const name = document.createElement("span");
    name.className = "board-attach-name";
    name.textContent = "선택된 파일 없음";

    const size = document.createElement("span");
    size.className = "board-attach-size";

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "board-attach-clear";
    clearButton.textContent = "×";
    clearButton.setAttribute("aria-label", "이 첨부 칸 지우기");

    function showChosenFile() {
      const file = input.files?.[0];

      if (!file) {
        box.classList.remove("is-filled");
        name.textContent = "선택된 파일 없음";
        size.textContent = "";
        return;
      }

      if (file.size > MAX_FILE_BYTES) {
        showMessage(
          `'${file.name}' 은 ${formatFileSize(MAX_FILE_BYTES)} 를 넘습니다. 더 작은 파일을 올려주세요.`
        );
        input.value = "";
        showChosenFile();
        return;
      }

      showMessage("");
      box.classList.remove("is-dragging");
      box.classList.add("is-filled");
      name.textContent = file.name;
      size.textContent = formatFileSize(file.size);
    }

    input.addEventListener("change", showChosenFile);

    // 칸을 지우면 파일을 뺄 뿐 아니라 칸 자체도 없앤다. (비어 있는 칸이 자리를 차지하지 않게)
    clearButton.addEventListener("click", () => {
      fileRows = fileRows.filter((row) => row.item !== item);
      item.remove();
      showMessage("");
      refreshAddButton();
    });

    box.addEventListener("dragover", (event) => {
      event.preventDefault();
      box.classList.add("is-dragging");
    });

    box.addEventListener("dragleave", () => box.classList.remove("is-dragging"));

    box.addEventListener("drop", (event) => {
      event.preventDefault();
      box.classList.remove("is-dragging");

      const dropped = event.dataTransfer?.files?.[0];
      if (!dropped) return;

      const transfer = new DataTransfer();
      transfer.items.add(dropped);
      input.files = transfer.files;
      showChosenFile();
    });

    box.append(input, choose, name, size);
    item.append(label, box, clearButton);
    list.appendChild(item);
    fileRows.push({ item, input });

    refreshAddButton();
  }

  addButton.addEventListener("click", addFileRow);

  return {
    // 빈 파일 칸을 하나 더한다. (처음 화면에 칸을 몇 개 깔아 둘 때)
    addRow: addFileRow,

    // 창을 열 때마다 호출한다. attachments 는 이미 저장된 첨부(수정할 때만).
    reset(attachments = []) {
      clearList();
      kept = Array.isArray(attachments) ? [...attachments] : [];
      kept.forEach(addExistingRow);
      showMessage("");
      refreshAddButton();
    },

    // 남길 기존 첨부, 해제한 기존 첨부, 새로 올릴 파일.
    read(original = []) {
      return {
        kept: [...kept],
        removed: original.filter((attachment) => !kept.includes(attachment)),
        files: fileRows.map((row) => row.input.files?.[0]).filter(Boolean)
      };
    }
  };
}
