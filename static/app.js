"use strict";

const state = {
  root: "",
  scope: "all",
  filter: "all",      // "all" | "unsorted" | "keep" | "trash"
  items: [],          // 現在表示中の画像 {rel, name, subdir, size, mtime}
  status: {},         // rel -> "keep" | "trash"
  focusIndex: -1,     // グリッド内のフォーカス位置
  lastTrash: null,    // 直前の削除 {rel, trash_rel} （Zで取消）
  modalOpen: false,
  modalIndex: -1,
};

const $ = (id) => document.getElementById(id);
const grid = $("grid");

// ---- API ヘルパ ----------------------------------------------------------
async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "エラー");
  return data;
}
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "エラー");
  return data;
}

function imgUrl(rel) {
  return `/img?root=${encodeURIComponent(state.root)}&rel=${encodeURIComponent(rel)}`;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---- 読み込み ------------------------------------------------------------
async function loadRoot() {
  const root = $("rootInput").value.trim();
  if (!root) { toast("フォルダパスを入力してください"); return; }
  state.root = root;
  localStorage.setItem("imgtriage.root", root);
  try {
    const tree = await apiGet(`/api/tree?root=${encodeURIComponent(root)}`);
    renderSidebar(tree);
    state.scope = "all";
    await loadList();
  } catch (e) {
    toast("読み込み失敗: " + e.message);
  }
}

function renderSidebar(tree) {
  const ul = $("folderList");
  ul.innerHTML = "";

  const allLi = document.createElement("li");
  allLi.dataset.scope = "all";
  allLi.innerHTML = `<span class="fname">📂 すべて（再帰）</span><span class="fcount">${tree.total}</span>`;
  ul.appendChild(allLi);

  for (const f of tree.folders) {
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

async function loadList() {
  // scope は "all"（再帰）/ "__root__"（root直下）/ サブフォルダ相対パス
  let scopeParam = state.scope;
  if (scopeParam === "__root__") scopeParam = ""; // root 直下は空文字
  try {
    const data = await apiGet(
      `/api/list?root=${encodeURIComponent(state.root)}&scope=${encodeURIComponent(scopeParam)}`);
    state.items = data.items;
    state.focusIndex = state.items.length ? 0 : -1;
    renderGrid();
    highlightSidebar();
  } catch (e) {
    toast("一覧取得失敗: " + e.message);
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
        <img loading="lazy" src="${imgUrl(item.rel)}" alt="${escapeHtml(item.name)}">
      </div>
      <div class="quick">
        <button class="keep" data-act="keep">S</button>
        <button class="trash" data-act="trash">D</button>
      </div>
      <div class="meta" title="${escapeHtml(item.rel)}">${sub}${escapeHtml(item.name)}</div>
    `;

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

// ---- フィルタ（保存／削除などで絞り込み）--------------------------------
function matchesFilter(rel) {
  const s = state.status[rel];
  switch (state.filter) {
    case "keep": return s === "keep";
    case "trash": return s === "trash";
    case "unsorted": return !s;
    default: return true; // "all"
  }
}

function applyFilter() {
  state.items.forEach((item, idx) => {
    const card = cardAt(idx);
    if (card) card.classList.toggle("filtered-out", !matchesFilter(item.rel));
  });
  // 現在のフォーカスが非表示なら、表示中の先頭へ寄せる
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

function cardAt(idx) {
  return grid.querySelector(`.card[data-idx="${idx}"]`);
}

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
  // フィルタバーの件数
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
  try {
    const res = await apiPost("/api/trash", { root: state.root, rel: item.rel });
    state.status[item.rel] = "trash";
    state.lastTrash = { rel: res.rel, trash_rel: res.trash_rel };
    const card = cardAt(idx);
    if (card) applyStatusClass(card, item.rel);
    updateStats();
    toast(`削除（ゴミ箱へ移動）: ${item.name}  —  Z で取消`);
    if (state.modalOpen) {
      // モーダル中はキャプション更新
      $("modalCaption").textContent = item.rel + "（削除済み）";
    } else {
      moveFocus(1);
    }
    if (state.filter !== "all") applyFilter();
  } catch (e) {
    toast("削除失敗: " + e.message);
  }
}

async function undoTrash() {
  if (!state.lastTrash) { toast("取り消す削除がありません"); return; }
  const { rel, trash_rel } = state.lastTrash;
  try {
    await apiPost("/api/restore", { root: state.root, rel, trash_rel });
    delete state.status[rel];
    state.lastTrash = null;
    const idx = state.items.findIndex((it) => it.rel === rel);
    if (idx >= 0) {
      const card = cardAt(idx);
      if (card) applyStatusClass(card, rel);
    }
    updateStats();
    if (state.filter !== "all") applyFilter();
    toast("削除を取り消しました: " + rel);
  } catch (e) {
    toast("取消失敗: " + e.message);
  }
}

function moveFocus(delta) {
  if (!state.items.length) return;
  const step = delta === 0 ? 0 : (delta > 0 ? 1 : -1);
  let idx = state.focusIndex;
  let remaining = Math.abs(delta);
  // フィルタで非表示のカードは飛ばして、表示中のカードへフォーカスを移す
  while (remaining > 0) {
    let next = idx + step;
    if (next < 0 || next >= state.items.length) break;
    idx = next;
    if (matchesFilter(state.items[idx].rel)) remaining--;
  }
  // 端で止まった場合に非表示カードへ乗らないよう、表示中の最寄りへ補正
  if (!matchesFilter(state.items[idx]?.rel)) {
    let j = idx;
    while (j >= 0 && j < state.items.length && !matchesFilter(state.items[j].rel)) j += step || -1;
    if (j >= 0 && j < state.items.length) idx = j;
  }
  focusCard(idx);
}

// ---- モーダル ------------------------------------------------------------
function openModal(idx) {
  state.modalIndex = idx;
  state.modalOpen = true;
  renderModal();
  $("modal").classList.remove("hidden");
}
function closeModal() {
  state.modalOpen = false;
  $("modal").classList.add("hidden");
  focusCard(state.modalIndex);
}
function renderModal() {
  const item = state.items[state.modalIndex];
  if (!item) return;
  $("modalImg").src = imgUrl(item.rel);
  const s = state.status[item.rel];
  const tag = s === "keep" ? "（保存）" : s === "trash" ? "（削除済み）" : "";
  $("modalCaption").textContent = `${state.modalIndex + 1}/${state.items.length}  ${item.rel}${tag}`;
}
function modalNav(delta) {
  let idx = state.modalIndex + delta;
  idx = Math.max(0, Math.min(state.items.length - 1, idx));
  state.modalIndex = idx;
  state.focusIndex = idx;
  renderModal();
}

// ---- ゴミ箱を空に --------------------------------------------------------
async function emptyTrash() {
  if (!state.root) { toast("先にフォルダを読み込んでください"); return; }
  if (!confirm("_trash フォルダ内の画像を完全に削除します。元に戻せません。よろしいですか？")) return;
  try {
    const res = await apiPost("/api/empty_trash", { root: state.root });
    state.lastTrash = null;
    toast(`ゴミ箱を空にしました（${res.removed} 件）`);
  } catch (e) {
    toast("失敗: " + e.message);
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
  const cardWidth = first.offsetWidth + 12; // gap
  return Math.max(1, Math.floor(gridWidth / cardWidth));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- イベント結線 --------------------------------------------------------
$("loadBtn").addEventListener("click", loadRoot);
$("rootInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadRoot(); });
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

// 前回のパスを復元
const savedRoot = localStorage.getItem("imgtriage.root");
if (savedRoot) $("rootInput").value = savedRoot;
