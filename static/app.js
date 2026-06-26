"use strict";

// 画像振り分けツール - ブラウザ完結版（File System Access API）
// 指定フォルダ（再帰）の画像を一覧し、「保存」「削除（_trash へ移動）」を素早く振り分ける。
// すべてブラウザ内で完結し、ファイルは外部に送信されない。

const TRASH_DIRNAME = "_trash";
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const state = {
  rootHandle: null,   // FileSystemDirectoryHandle（選択したルート）
  rootName: "",
  scope: "all",       // "all"（再帰）/ "__root__"（root直下）/ サブフォルダ相対パス
  filter: "all",      // "all" | "unsorted" | "keep" | "trash"
  allItems: [],       // 全画像（rel昇順）
  items: [],          // 現在 scope で表示中の画像
  status: {},         // rel -> "keep" | "trash"
  folders: [],        // {rel, name, depth, count}
  focusIndex: -1,
  lastTrash: null,    // 直前の削除した item（Zで取消）
  modalOpen: false,
  modalIndex: -1,
};

const $ = (id) => document.getElementById(id);
const grid = $("grid");

// ---- 共通ユーティリティ --------------------------------------------------
function ext(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}
function isImage(name) {
  return ALLOWED_EXT.has(ext(name));
}
function posixBasename(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 2400);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- File System Access ヘルパ ------------------------------------------
async function entryExists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) {
    if (e && e.name !== "NotFoundError") {
      try { await dir.getDirectoryHandle(name); return true; } catch (_) { /* noop */ }
    }
    return false;
  }
}

// dir 内で name と衝突しない名前を返す（既存なら _1, _2 ... を付与）
async function uniqueName(dir, name) {
  if (!(await entryExists(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const e = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cand = `${base}_${i}${e}`;
    if (!(await entryExists(dir, cand))) return cand;
    i++;
  }
}

// posix 相対パス（サブフォルダ）に対応する _trash 配下のディレクトリを取得/作成
async function ensureTrashDir(subdir) {
  let dir = await state.rootHandle.getDirectoryHandle(TRASH_DIRNAME, { create: true });
  if (subdir) {
    for (const seg of subdir.split("/")) {
      if (!seg) continue;
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
  }
  return dir;
}

// ファイルを destDir/destName へ移動。move() があれば使い、無ければ copy + remove。
async function moveFile(item, destDir, destName) {
  if (typeof item.fileHandle.move === "function") {
    try {
      await item.fileHandle.move(destDir, destName);
      item.parentDir = destDir;
      item.curName = destName;
      return;
    } catch (_) { /* フォールバックへ */ }
  }
  const file = await item.fileHandle.getFile();
  const newHandle = await destDir.getFileHandle(destName, { create: true });
  const writable = await newHandle.createWritable();
  await writable.write(file);
  await writable.close();
  await item.parentDir.removeEntry(item.curName);
  item.fileHandle = newHandle;
  item.parentDir = destDir;
  item.curName = destName;
}

// ---- フォルダ選択・走査 --------------------------------------------------
async function pickRoot() {
  if (!window.showDirectoryPicker) { showUnsupported(); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e && e.name === "AbortError") return; // ユーザーがキャンセル
    toast("フォルダ選択に失敗: " + (e.message || e));
    return;
  }
  // 書き込み許可を確実に取得
  try {
    if (handle.requestPermission) {
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") { toast("書き込み許可が必要です"); return; }
    }
  } catch (_) { /* 一部実装では不要 */ }

  state.rootHandle = handle;
  state.rootName = handle.name || "root";
  $("rootLabel").textContent = state.rootName;
  $("rootLabel").title = state.rootName;
  await scanAll();
  state.scope = "all";
  renderSidebar();
  loadList();
}

// ルート配下を再帰走査して allItems / folders / status を構築
async function scanAll() {
  const items = [];
  const folders = [];
  const status = {};

  async function walk(dirHandle, relPrefix) {
    let count = 0;
    const subdirs = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "directory") {
        if (entry.name === TRASH_DIRNAME) continue; // _trash は走査しない
        subdirs.push(entry);
      } else if (entry.kind === "file" && isImage(entry.name)) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        items.push({
          rel,
          name: entry.name,
          subdir: relPrefix,
          fileHandle: entry,
          parentDir: dirHandle,
          curName: entry.name,
          origParent: dirHandle,
          origName: entry.name,
          blobUrl: null,
        });
        count++;
      }
    }
    folders.push({
      rel: relPrefix,
      name: relPrefix ? posixBasename(relPrefix) : state.rootName,
      depth: relPrefix ? relPrefix.split("/").length : 0,
      count,
    });
    subdirs.sort((a, b) => a.name.localeCompare(b.name));
    for (const sd of subdirs) {
      const childRel = relPrefix ? `${relPrefix}/${sd.name}` : sd.name;
      await walk(sd, childRel);
    }
  }

  await walk(state.rootHandle, "");
  items.sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
  folders.sort((a, b) => a.rel.localeCompare(b.rel));

  state.allItems = items;
  state.folders = folders;
  state.status = status;
  state.lastTrash = null;
}

// ---- サイドバー ----------------------------------------------------------
function renderSidebar() {
  const ul = $("folderList");
  ul.innerHTML = "";
  const total = state.allItems.length;

  const allLi = document.createElement("li");
  allLi.dataset.scope = "all";
  allLi.innerHTML = `<span class="fname">📂 すべて（再帰）</span><span class="fcount">${total}</span>`;
  ul.appendChild(allLi);

  for (const f of state.folders) {
    const li = document.createElement("li");
    li.dataset.scope = f.rel === "" ? "__root__" : f.rel;
    const indent = "　".repeat(f.depth);
    const label = f.rel === "" ? (f.name + "（直下）") : f.name;
    li.innerHTML =
      `<span class="fname" title="${escapeHtml(f.rel || f.name)}">${indent}${escapeHtml(label)}</span>` +
      `<span class="fcount">${f.count}</span>`;
    ul.appendChild(li);
  }
  highlightSidebar();
}

function highlightSidebar() {
  document.querySelectorAll("#folderList li").forEach((li) => {
    li.classList.toggle("active", li.dataset.scope === state.scope);
  });
}

// ---- 一覧（scope によるクライアント側フィルタ）---------------------------
function loadList() {
  let items;
  if (state.scope === "all") {
    items = state.allItems.slice();
  } else {
    const sub = state.scope === "__root__" ? "" : state.scope;
    items = state.allItems
      .filter((it) => it.subdir === sub)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  state.items = items;
  state.focusIndex = items.length ? 0 : -1;
  renderGrid();
  highlightSidebar();
}

// ---- 遅延読み込み（IntersectionObserver）--------------------------------
const lazyObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    lazyObserver.unobserve(img);
    const idx = Number(img.dataset.lazyIdx);
    const item = state.items[idx];
    if (!item) continue;
    loadBlobUrl(item).then((url) => { if (url) img.src = url; });
  }
}, { rootMargin: "300px" });

async function loadBlobUrl(item) {
  if (item.blobUrl) return item.blobUrl;
  try {
    const file = await item.fileHandle.getFile();
    item.blobUrl = URL.createObjectURL(file);
    return item.blobUrl;
  } catch (e) {
    return null;
  }
}

// ---- グリッド描画 --------------------------------------------------------
function renderGrid() {
  grid.innerHTML = "";
  $("emptyMsg").classList.toggle("hidden", state.items.length > 0);

  state.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "card";
    card.tabIndex = 0;
    card.dataset.idx = idx;
    applyStatusClass(card, item.rel);

    const sub = item.subdir ? `<span class="subdir">${escapeHtml(item.subdir)}/</span>` : "";
    card.innerHTML = `
      <span class="badge keep-badge">保存</span>
      <span class="badge trash-badge">削除</span>
      <div class="thumb-wrap">
        <img data-lazy-idx="${idx}" alt="${escapeHtml(item.name)}">
      </div>
      <div class="quick">
        <button class="keep" data-act="keep">S</button>
        <button class="trash" data-act="trash">D</button>
      </div>
      <div class="meta" title="${escapeHtml(item.rel)}">${sub}${escapeHtml(item.name)}</div>
    `;

    const img = card.querySelector("img");
    if (item.blobUrl) img.src = item.blobUrl;
    else lazyObserver.observe(img);

    card.querySelector(".thumb-wrap").addEventListener("click", () => openModal(idx));
    card.querySelector('[data-act="keep"]').addEventListener("click", (e) => {
      e.stopPropagation(); markKeep(idx);
    });
    card.querySelector('[data-act="trash"]').addEventListener("click", (e) => {
      e.stopPropagation(); markTrash(idx);
    });
    card.addEventListener("focus", () => { state.focusIndex = idx; });
    grid.appendChild(card);
  });

  applyFilter();
  updateStats();
  focusCard(state.focusIndex);
}

// ---- フィルタ ------------------------------------------------------------
function matchesFilter(rel) {
  const s = state.status[rel];
  switch (state.filter) {
    case "keep": return s === "keep";
    case "trash": return s === "trash";
    case "unsorted": return !s;
    default: return true;
  }
}
function applyFilter() {
  state.items.forEach((item, idx) => {
    const card = cardAt(idx);
    if (card) card.classList.toggle("filtered-out", !matchesFilter(item.rel));
  });
  if (state.focusIndex < 0 || !matchesFilter(state.items[state.focusIndex]?.rel)) {
    const firstVisible = state.items.findIndex((it) => matchesFilter(it.rel));
    focusCard(firstVisible);
  }
}
function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll("#filterBar .filter-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === filter);
  });
  applyFilter();
}

function applyStatusClass(card, rel) {
  card.classList.remove("keep", "trash");
  const s = state.status[rel];
  if (s === "keep") card.classList.add("keep");
  else if (s === "trash") card.classList.add("trash");
}
function cardAt(idx) { return grid.querySelector(`.card[data-idx="${idx}"]`); }

function focusCard(idx) {
  grid.querySelectorAll(".card.focused").forEach((c) => c.classList.remove("focused"));
  if (idx < 0 || idx >= state.items.length) return;
  const card = cardAt(idx);
  if (card) {
    card.classList.add("focused");
    state.focusIndex = idx;
    card.scrollIntoView({ block: "nearest" });
  }
}

function updateStats() {
  let keep = 0, trash = 0;
  for (const item of state.items) {
    if (state.status[item.rel] === "keep") keep++;
    else if (state.status[item.rel] === "trash") trash++;
  }
  const total = state.items.length;
  $("statTotal").textContent = `画像: ${total}`;
  $("statKeep").textContent = `保存: ${keep}`;
  $("statTrash").textContent = `削除: ${trash}`;
  $("fcAll").textContent = total;
  $("fcUnsorted").textContent = total - keep - trash;
  $("fcKeep").textContent = keep;
  $("fcTrash").textContent = trash;
}

// ---- 振り分け ------------------------------------------------------------
function markKeep(idx) {
  const item = state.items[idx];
  if (!item) return;
  state.status[item.rel] = "keep";
  const card = cardAt(idx);
  if (card) applyStatusClass(card, item.rel);
  updateStats();
  if (!state.modalOpen) moveFocus(1);
  if (state.filter !== "all") applyFilter();
}

async function markTrash(idx) {
  const item = state.items[idx];
  if (!item) return;
  if (state.status[item.rel] === "trash") return;
  try {
    const destDir = await ensureTrashDir(item.subdir);
    const destName = await uniqueName(destDir, item.origName);
    await moveFile(item, destDir, destName);
    state.status[item.rel] = "trash";
    state.lastTrash = item;
    const card = cardAt(idx);
    if (card) applyStatusClass(card, item.rel);
    updateStats();
    toast(`削除（ゴミ箱へ移動）: ${item.name}  —  Z で取消`);
    if (state.modalOpen) {
      $("modalCaption").textContent = item.rel + "（削除済み）";
    } else {
      moveFocus(1);
    }
    if (state.filter !== "all") applyFilter();
  } catch (e) {
    toast("削除失敗: " + (e.message || e));
  }
}

async function undoTrash() {
  const item = state.lastTrash;
  if (!item) { toast("取り消す削除がありません"); return; }
  try {
    const destName = await uniqueName(item.origParent, item.origName);
    await moveFile(item, item.origParent, destName);
    delete state.status[item.rel];
    state.lastTrash = null;
    const idx = state.items.findIndex((it) => it.rel === item.rel);
    if (idx >= 0) {
      const card = cardAt(idx);
      if (card) applyStatusClass(card, item.rel);
    }
    updateStats();
    if (state.filter !== "all") applyFilter();
    toast("削除を取り消しました: " + item.rel);
  } catch (e) {
    toast("取消失敗: " + (e.message || e));
  }
}

function moveFocus(delta) {
  if (!state.items.length) return;
  const step = delta === 0 ? 0 : (delta > 0 ? 1 : -1);
  let idx = state.focusIndex;
  let remaining = Math.abs(delta);
  while (remaining > 0) {
    const next = idx + step;
    if (next < 0 || next >= state.items.length) break;
    idx = next;
    if (matchesFilter(state.items[idx].rel)) remaining--;
  }
  if (!matchesFilter(state.items[idx]?.rel)) {
    let j = idx;
    while (j >= 0 && j < state.items.length && !matchesFilter(state.items[j].rel)) j += step || -1;
    if (j >= 0 && j < state.items.length) idx = j;
  }
  focusCard(idx);
}

// ---- モーダル ------------------------------------------------------------
async function openModal(idx) {
  if (idx < 0 || idx >= state.items.length) return;
  state.modalIndex = idx;
  state.modalOpen = true;
  await renderModal();
  $("modal").classList.remove("hidden");
}
function closeModal() {
  state.modalOpen = false;
  $("modal").classList.add("hidden");
  focusCard(state.modalIndex);
}
async function renderModal() {
  const item = state.items[state.modalIndex];
  if (!item) return;
  const url = await loadBlobUrl(item);
  if (url) $("modalImg").src = url;
  const s = state.status[item.rel];
  const tag = s === "keep" ? "（保存）" : s === "trash" ? "（削除済み）" : "";
  $("modalCaption").textContent = `${state.modalIndex + 1}/${state.items.length}  ${item.rel}${tag}`;
}
function modalNav(delta) {
  const step = delta >= 0 ? 1 : -1;
  let idx = state.modalIndex;
  let next = idx + step;
  while (next >= 0 && next < state.items.length) {
    if (matchesFilter(state.items[next].rel)) { idx = next; break; }
    next += step;
  }
  state.modalIndex = idx;
  state.focusIndex = idx;
  renderModal();
}

// ---- ゴミ箱を空に --------------------------------------------------------
async function emptyTrash() {
  if (!state.rootHandle) { toast("先にフォルダを選択してください"); return; }
  if (!confirm("_trash フォルダ内の画像を完全に削除します。元に戻せません。よろしいですか？")) return;
  try {
    let removed = 0;
    let trashDir;
    try {
      trashDir = await state.rootHandle.getDirectoryHandle(TRASH_DIRNAME);
    } catch (e) {
      if (e && e.name === "NotFoundError") { toast("ゴミ箱は空です"); return; }
      throw e;
    }
    // 件数カウント（再帰）
    async function count(dir) {
      for await (const entry of dir.values()) {
        if (entry.kind === "file") removed++;
        else if (entry.kind === "directory") await count(entry);
      }
    }
    await count(trashDir);
    await state.rootHandle.removeEntry(TRASH_DIRNAME, { recursive: true });
    state.lastTrash = null;
    toast(`ゴミ箱を空にしました（${removed} 件）`);
  } catch (e) {
    toast("失敗: " + (e.message || e));
  }
}

// ---- キーボード ----------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const key = e.key.toLowerCase();

  if (state.modalOpen) {
    if (e.key === "Escape") { closeModal(); }
    else if (e.key === "ArrowLeft") { modalNav(-1); }
    else if (e.key === "ArrowRight") { modalNav(1); }
    else if (key === "d") { markTrash(state.modalIndex); }
    else if (key === "s") { markKeep(state.modalIndex); renderModal(); }
    else if (key === "z") { undoTrash(); }
    else return;
    e.preventDefault();
    return;
  }

  if (!state.items.length) return;
  if (e.key === "ArrowLeft") { moveFocus(-1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { moveFocus(1); e.preventDefault(); }
  else if (e.key === "ArrowUp") { moveFocus(-columnsPerRow()); e.preventDefault(); }
  else if (e.key === "ArrowDown") { moveFocus(columnsPerRow()); e.preventDefault(); }
  else if (key === "d") { markTrash(state.focusIndex); e.preventDefault(); }
  else if (key === "s") { markKeep(state.focusIndex); e.preventDefault(); }
  else if (key === "z") { undoTrash(); e.preventDefault(); }
  else if (e.key === "Enter") { openModal(state.focusIndex); e.preventDefault(); }
});

function columnsPerRow() {
  const first = cardAt(0);
  if (!first) return 1;
  const gridWidth = grid.clientWidth;
  const cardWidth = first.offsetWidth + 12;
  return Math.max(1, Math.floor(gridWidth / cardWidth));
}

// ---- 非対応ブラウザ ------------------------------------------------------
function showUnsupported() {
  $("unsupported").classList.remove("hidden");
}

// ---- イベント結線 --------------------------------------------------------
$("pickBtn").addEventListener("click", pickRoot);
$("emptyTrashBtn").addEventListener("click", emptyTrash);
$("filterBar").addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (btn) setFilter(btn.dataset.filter);
});
$("folderList").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  state.scope = li.dataset.scope;
  loadList();
});
$("modalClose").addEventListener("click", closeModal);
$("modalPrev").addEventListener("click", () => modalNav(-1));
$("modalNext").addEventListener("click", () => modalNav(1));
$("modalKeep").addEventListener("click", () => { markKeep(state.modalIndex); renderModal(); });
$("modalTrash").addEventListener("click", () => markTrash(state.modalIndex));
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

// 起動時に対応チェック
if (!window.showDirectoryPicker) showUnsupported();
