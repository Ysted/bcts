import {
  parseBulkInput, summarizeAddResult, formatTagNumber, matchTag, isValidScan,
  createReadConfirmer, createCooldown, formatLogText, formatLogTime, RESULT_LABEL, meanLuma,
} from "./logic.js";
import { createDetector, openCamera, startScanLoop, cameraErrorMessage } from "./scanner.js";
import { alarmFull, readPulse, stopVibration } from "./alarm.js";

const APP_VERSION = "v16"; // keep in step with CACHE in sw.js
const WATCHLIST_KEY = "bcts.watchlist";
const LOG_KEY = "bcts.log";
const COUNTED_KEY = "bcts.counted"; // unique tags scanned since "Mulai hitungan baru"
const LOG_LIMIT = 500;
const ALARM_REPEAT_MS = 2500;
const ALARM_REPEATS = 3;
const AFTER_DISMISS_QUIET_MS = 10000;

const $ = (id) => document.getElementById(id);

// --- storage -----------------------------------------------------------------

function loadList(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

let storageFailed = false;
function saveList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
}
const STORAGE_WARNING = "Perhatian: data tidak bisa disimpan di HP ini dan akan hilang saat aplikasi ditutup. Jangan pakai mode penyamaran/pribadi.";

// v2 also accepted 6-digit serials; those can never match now, so they are dropped.
let watchlist = loadList(WATCHLIST_KEY).filter((e) => e && isValidScan(e.number)); // [{ number, found }]
let scanLog = loadList(LOG_KEY); // [{ number, time, result }]
const counted = new Set(loadList(COUNTED_KEY));

function saveWatchlist() { saveList(WATCHLIST_KEY, watchlist); }
function saveLog() { saveList(LOG_KEY, scanLog); }

// --- helpers -----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// In-page confirmation modal (no browser alert). Resolves true only on the red button.
const confirmDialog = $("confirm-dialog");
let confirmResolve = null;

function confirmAction(text, okLabel = "Hapus") {
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  confirmDialog.showModal();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(ok) {
  confirmDialog.close();
  confirmResolve?.(ok);
  confirmResolve = null;
}
$("confirm-ok").addEventListener("click", () => settleConfirm(true));
$("confirm-cancel").addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("cancel", () => settleConfirm(false)); // back button / Esc
confirmDialog.addEventListener("click", (event) => { if (event.target === confirmDialog) settleConfirm(false); });

function showFeedback(target, text, isWarning) {
  target.textContent = [text, storageFailed ? STORAGE_WARNING : ""].filter(Boolean).join(" ");
  target.classList.toggle("warning", Boolean(isWarning || storageFailed));
}

function markFound(number) {
  const entry = watchlist.find((e) => e.number === number);
  if (entry) entry.found = true;
  saveWatchlist();
  renderWatchlist();
}

// --- watchlist view ------------------------------------------------------------

const feedback = $("feedback");
const listEl = $("watchlist");

function renderWatchlist() {
  listEl.replaceChildren(...watchlist.map(renderEntry));
  const hasEntries = watchlist.length > 0;
  listEl.hidden = !hasEntries;
  $("list-head").hidden = !hasEntries;
  $("empty-state").hidden = hasEntries;
  const foundCount = watchlist.filter((e) => e.found).length;
  for (const n of selected) if (!watchlist.some((e) => e.number === n)) selected.delete(n);
  const selecting = selected.size > 0;
  listEl.classList.toggle("selecting", selecting);
  $("list-count").textContent = selecting
    ? `${selected.size} dipilih`
    : `${foundCount}/${watchlist.length} atensi ketemu`;
  $("select-cancel").hidden = !selecting;
  updateSelectButton();
  renderCount();
}

function renderCount() {
  $("scan-count").replaceChildren(el("strong", "num", String(counted.size)), " discan");
}

function countTag(number) {
  if (counted.has(number)) return;
  counted.add(number);
  saveList(COUNTED_KEY, [...counted]);
  renderCount();
}

function renderEntry(entry) {
  const li = el("li");
  li.classList.toggle("found", entry.found);
  li.classList.toggle("selected", selected.has(entry.number));
  li.dataset.number = entry.number;

  const remove = el("button", "row-delete", "Hapus");
  remove.type = "button";
  remove.dataset.number = entry.number;
  remove.setAttribute("aria-label", `Hapus ${formatTagNumber(entry.number)}`);

  const number = el("div", "entry-number");
  const text = el("div", "entry-text");
  text.append(el("span", "entry-digits num", formatTagNumber(entry.number)));
  if (entry.found) text.append(el("span", "entry-kind", "Sudah ketemu"));
  number.append(text);

  li.append(remove, number);
  return li;
}

// --- selection: hold a row to start, tap to toggle, header button acts on it ---
const LONG_PRESS_MS = 500;
const selected = new Set();
let pressTimer = null;
let swallowClick = false;
function updateSelectButton() {
  const button = $("select-action");
  button.textContent = selected.size ? `Hapus (${selected.size})` : "Pilih semua";
  button.classList.toggle("danger", selected.size > 0);
}

function toggleSelected(number) {
  if (selected.has(number)) selected.delete(number);
  else selected.add(number);
  renderWatchlist();
}

$("select-action").addEventListener("click", async () => {
  if (!selected.size) {
    closeOpenRow();
    watchlist.forEach((e) => selected.add(e.number));
    renderWatchlist();
  } else if (await confirmAction(`Hapus ${selected.size} nomor dari daftar?`)) {
    const count = selected.size;
    watchlist = watchlist.filter((e) => !selected.has(e.number));
    selected.clear();
    saveWatchlist();
    renderWatchlist();
    showFeedback(feedback, `${count} nomor dihapus.`);
  }
});

$("select-cancel").addEventListener("click", () => {
  selected.clear();
  renderWatchlist();
});

listEl.addEventListener("contextmenu", (event) => event.preventDefault()); // hold must not open a menu

// --- swipe left to reveal Hapus (one row open at a time) ---
const SWIPE_OPEN_PX = 96;
let openRow = null;
let drag = null;

function setRowOffset(row, px) {
  row.style.transform = px ? `translateX(${px}px)` : "";
}

function closeOpenRow() {
  if (openRow) setRowOffset(openRow, 0);
  openRow = null;
}

listEl.addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".entry-number");
  if (!row) return;
  const number = row.closest("li").dataset.number;
  // The hold re-renders the list, so its trailing click may never fire; a new press starts clean.
  swallowClick = false;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    drag = null;
    closeOpenRow();
    swallowClick = true; // the click that ends this hold must not toggle it back
    try { navigator.vibrate?.(30); } catch { /* iPhone */ }
    selected.add(number);
    renderWatchlist();
  }, LONG_PRESS_MS);
  if (selected.size) return; // no swiping while selecting
  if (openRow && openRow !== row) closeOpenRow();
  drag = { row, startX: event.clientX, startY: event.clientY, base: row === openRow ? -SWIPE_OPEN_PX : 0, dx: 0, active: false };
});

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

listEl.addEventListener("pointermove", (event) => {
  if (pressTimer && drag && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 8) cancelPress();
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  if (!drag.active) {
    if (Math.abs(event.clientY - drag.startY) > Math.abs(dx)) { drag = null; return; } // vertical scroll
    if (Math.abs(dx) < 8) return;
    drag.active = true;
    drag.row.classList.add("dragging");
    drag.row.setPointerCapture?.(event.pointerId);
  }
  drag.dx = dx;
  setRowOffset(drag.row, Math.min(0, Math.max(-SWIPE_OPEN_PX, drag.base + dx)));
});

function endDrag() {
  if (!drag) return;
  const { row, base, dx, active } = drag;
  drag = null;
  row.classList.remove("dragging");
  const open = active ? base + dx < -SWIPE_OPEN_PX / 2 : false;
  setRowOffset(row, open ? -SWIPE_OPEN_PX : 0);
  openRow = open ? row : null;
}
listEl.addEventListener("pointerup", () => { cancelPress(); endDrag(); });
listEl.addEventListener("pointercancel", () => { cancelPress(); endDrag(); });
listEl.addEventListener("scroll", cancelPress, { passive: true });
document.addEventListener("pointerdown", (event) => {
  if (openRow && !event.target.closest("#watchlist")) closeOpenRow();
});

const input = $("bulk-input");
const addDialog = $("add-dialog");

function openAddDialog() {
  $("add-feedback").textContent = "";
  addDialog.showModal();
  input.focus(); // ready to paste straight away
}

$("add-open").addEventListener("click", openAddDialog);
addDialog.addEventListener("click", (event) => { if (event.target === addDialog) addDialog.close(); }); // tap outside

// A one-line field would glue pasted lines into one long digit run, so line
// breaks become ", " first. Then digits only; spaces, commas, semicolons and
// dashes still separate/group numbers.
function cleanInput(text) {
  return text.replace(/[\r\n]+/g, ", ").replace(/[^\d\s,;-]/g, "").replace(/^[\s,;]+|[\s,;]+$/g, "");
}

function insertText(text) {
  const clean = cleanInput(text);
  if (!clean) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const sep = (s) => (s && !/[\s,;]$/.test(s) ? ", " : "");
  input.value = before + sep(before) + clean + (after && !/^[\s,;]/.test(after) ? ", " : "") + after;
  input.focus();
}

input.addEventListener("paste", (event) => {
  event.preventDefault();
  insertText(event.clipboardData?.getData("text") || "");
});

input.addEventListener("input", () => {
  const clean = input.value.replace(/[^\d\s,;-]/g, "");
  if (clean !== input.value) input.value = clean;
});

$("paste").addEventListener("click", async () => {
  try {
    insertText(await navigator.clipboard.readText());
  } catch {
    showFeedback($("add-feedback"), "HP tidak mengizinkan membaca clipboard. Tekan lama di kolom nomor, lalu pilih Tempel.", true);
    input.focus();
  }
});

$("add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const result = parseBulkInput(input.value, watchlist.map((e) => e.number));
  watchlist.push(...result.added.map((e) => ({ ...e, found: false })));
  saveWatchlist();
  renderWatchlist();
  // Rejected tokens stay in the open dialog so the officer can fix them; otherwise close it.
  input.value = result.rejected.join(", ");
  if (result.rejected.length || !result.added.length) {
    showFeedback($("add-feedback"), summarizeAddResult(result), true);
    input.focus();
  } else {
    addDialog.close();
    showFeedback(feedback, summarizeAddResult(result));
  }
});

listEl.addEventListener("click", (event) => {
  if (swallowClick) { swallowClick = false; return; }
  const rowNumber = event.target.closest(".entry-number") && event.target.closest("li").dataset.number;
  if (rowNumber && selected.size) { toggleSelected(rowNumber); return; }
  const number = event.target.closest(".row-delete")?.dataset.number;
  if (!number) return;
  openRow = null;
  watchlist = watchlist.filter((e) => e.number !== number);
  showFeedback(feedback, `${formatTagNumber(number)} dihapus.`);
  saveWatchlist();
  renderWatchlist();
});

$("reset-count").addEventListener("click", async () => {
  if (!await confirmAction(`Mulai hitungan baru? ${counted.size} tag yang sudah discan kembali ke 0.`, "Mulai baru")) return;
  counted.clear();
  saveList(COUNTED_KEY, []);
  renderCount();
});

// --- log view ----------------------------------------------------------------

const logList = $("log-list");

function renderLog() {
  const rows = scanLog.slice().reverse().map((entry) => {
    const li = el("li", entry.result);
    li.append(el("div", "log-number num", formatTagNumber(entry.number)));
    const meta = el("div", "log-meta");
    const label = RESULT_LABEL[entry.result];
    if (label) meta.append(el("span", "log-result", label), document.createTextNode(" · "));
    meta.append(document.createTextNode(formatLogTime(entry.time)));
    li.append(meta);
    return li;
  });
  logList.replaceChildren(...rows);
  const hasRows = rows.length > 0;
  logList.hidden = !hasRows;
  $("log-footer").hidden = !hasRows;
  $("log-empty").hidden = hasRows;
}

function addLog(number, match) {
  scanLog.push({ number, time: Date.now(), result: match.result });
  if (scanLog.length > LOG_LIMIT) scanLog = scanLog.slice(-LOG_LIMIT);
  saveLog();
  renderLog();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that refuse the async clipboard API.
    const area = el("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

$("copy-log").addEventListener("click", async () => {
  const ok = await copyText(formatLogText(scanLog, counted.size));
  showFeedback($("log-feedback"), ok
    ? `${scanLog.length} baris disalin. Tempel di WhatsApp.`
    : "Gagal menyalin. Tekan lama pada daftar lalu salin manual.", !ok);
});

$("clear-log").addEventListener("click", async () => {
  if (!await confirmAction(`Hapus semua ${scanLog.length} baris log?`)) return;
  scanLog = [];
  saveLog();
  renderLog();
  showFeedback($("log-feedback"), "Log dihapus.");
});

// --- navigation --------------------------------------------------------------

const navButtons = document.querySelectorAll("nav button[data-nav]");
const main = document.querySelector("main");

// --- pager: pages slide side by side, following the finger ---
const VIEWS = ["daftar", "scan", "log"];
const panes = VIEWS.map((v) => document.querySelector(`section[data-view="${v}"]`));
const SLIDE_MS = 260;
let pageIndex = 0;
let currentView = "daftar";
let settleTimer = null;

function placePanes(offsetPx, animate) {
  for (const [i, pane] of panes.entries()) {
    pane.style.transition = animate ? `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : "none";
    pane.style.transform = `translateX(calc(${(i - pageIndex) * 100}% + ${offsetPx}px))`;
  }
}

function revealPanes() {
  clearTimeout(settleTimer);
  panes.forEach((pane) => { pane.hidden = false; });
}

// Slide to page `next` (or back to the current one when the swipe was too short).
function goToPage(next) {
  revealPanes();
  pageIndex = next;
  currentView = VIEWS[next];
  void panes[0].offsetWidth; // start the slide from where the finger left the panes
  placePanes(0, true);
  navButtons.forEach((b) => {
    if (b.dataset.nav === currentView) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (currentView !== "scan") stopScan();
  settleTimer = setTimeout(() => {
    panes.forEach((pane, i) => { pane.hidden = i !== pageIndex; });
    if (currentView === "scan") startScan(); // camera only once the page has arrived
  }, SLIDE_MS);
}

function showView(name) {
  goToPage(VIEWS.indexOf(name));
}
navButtons.forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));
placePanes(0, false);

// Drag anywhere to change page, except where the finger lands on something that
// owns horizontal swipes itself (a list row) or on an overlay.
// Follows one finger by its identifier, so a second finger resting on the
// screen (or a stale touch point) does not block or hijack the swipe.
let pageDrag = null;
const dragTouch = (list) => [...list].find((t) => t.identifier === pageDrag?.id);

document.addEventListener("touchstart", (event) => {
  if (pageDrag) return; // already following a finger
  const touch = event.changedTouches[0];
  if (event.target.closest(".watchlist li, dialog, .result, input, nav")) return;
  pageDrag = { id: touch.identifier, x: touch.clientX, y: touch.clientY, t: performance.now(), dx: 0, axis: null };
}, { passive: true });

document.addEventListener("touchmove", (event) => {
  const touch = dragTouch(event.changedTouches);
  if (!touch || pageDrag.axis === "y") return;
  const dx = touch.clientX - pageDrag.x;
  const dy = touch.clientY - pageDrag.y;
  if (!pageDrag.axis) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { pageDrag.axis = "y"; return; }
    if (Math.abs(dx) < 10) return;
    pageDrag.axis = "x";
    revealPanes();
  }
  const hasNeighbour = VIEWS[pageIndex + (dx < 0 ? 1 : -1)] !== undefined;
  pageDrag.dx = hasNeighbour ? dx : dx * 0.3; // rubber-band at the first and last page
  placePanes(pageDrag.dx, false);
}, { passive: true });

function endPageDrag(event) {
  const touch = dragTouch(event.changedTouches);
  if (!touch) return; // some other finger lifted
  const drag = pageDrag;
  pageDrag = null;
  if (drag.axis === "y") return;
  // While the decoder is busy the browser may coalesce every touchmove away,
  // so judge the swipe from where the finger lifted, not only from the moves.
  if (event.type === "touchend") {
    const dx = touch.clientX - drag.x;
    const dy = touch.clientY - drag.y;
    if (!drag.axis && (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy))) return;
    drag.dx = VIEWS[pageIndex + (dx < 0 ? 1 : -1)] !== undefined ? dx : dx * 0.3;
  } else if (!drag.axis) {
    return;
  }
  const width = main.clientWidth;
  const speed = Math.abs(drag.dx) / Math.max(1, performance.now() - drag.t); // px per ms
  const next = pageIndex + (drag.dx < 0 ? 1 : -1);
  const far = Math.abs(drag.dx) > width * 0.25 || (speed > 0.4 && Math.abs(drag.dx) > 30);
  goToPage(far && VIEWS[next] ? next : pageIndex);
}
document.addEventListener("touchend", endPageDrag, { passive: true });
document.addEventListener("touchcancel", endPageDrag, { passive: true });

// --- scanning ------------------------------------------------------------------

const video = $("video");
const torchButton = $("torch");
const forceZxing = new URLSearchParams(location.search).get("engine") === "zxing";

let detector = null;
let camera = null;
let stopLoop = null;
let confirmReads = createReadConfirmer();
const cooldown = createCooldown(3000);
let lastReported = null; // same tag stays quiet until a different one is read
let wakeLock = null;
let starting = false;

async function keepScreenOn() {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    if (camera) wakeLock = lock;
    else lock?.release().catch(() => {}); // scan already stopped while we waited
  } catch {
    wakeLock = null; // not fatal: the screen may dim, scanning still works
  }
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function resumeLoop() {
  if (!camera || !detector || stopLoop) return;
  confirmReads = createReadConfirmer(); // never carry a half-confirmed read across a pause
  stopLoop = startScanLoop(video, document.querySelector(".scan-guide"), detector, onFrame);
  armIdle();
  lightTimer = setInterval(checkLight, 1000);
}

function pauseLoop() {
  stopLoop?.();
  stopLoop = null;
  clearTimeout(idleTimer);
  clearInterval(lightTimer);
}

// A dark picture for 2 s turns the torch on by itself, like a scanner's own lamp.
// Once the officer touches the torch button it is theirs until the camera reopens.
const DARK_LUMA = 60; // mean brightness 0-255
const lightProbe = document.createElement("canvas");
lightProbe.width = lightProbe.height = 16;
const lightCtx = lightProbe.getContext("2d", { willReadFrequently: true });
let lightTimer = null;
let torchManual = false;
let darkChecks = 0;

function checkLight() {
  if (!camera?.torchSupported || torchManual || video.readyState < 2) return;
  if (torchButton.getAttribute("aria-pressed") === "true") return;
  lightCtx.drawImage(video, 0, 0, 16, 16);
  darkChecks = meanLuma(lightCtx.getImageData(0, 0, 16, 16).data) < DARK_LUMA ? darkChecks + 1 : 0;
  if (darkChecks >= 2) setTorch(true);
}

// Half a minute with no barcode in view: camera off and the screen may dim, the two
// biggest heat and battery costs. One tap brings it back.
const IDLE_SLEEP_MS = 30_000;
let idleTimer = null;

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(sleepScan, IDLE_SLEEP_MS);
}

function sleepScan() {
  stopScan();
  setHint("Kamera dijeda: 30 detik tanpa tag terbaca.");
  showRetry("Lanjut scan");
}

function showRetry(label) {
  $("scan-retry").textContent = label;
  $("scan-retry").hidden = false;
}

const scanHint = $("scan-hint");
const scanHistory = $("scan-history");
const HISTORY_SHOWN = 3;
const calmMotion = matchMedia("(prefers-reduced-motion: reduce)");

function setHint(text) {
  scanHint.textContent = text;
}

// Reads stack under the guide box: the new one pops in on top, older ones slide
// down, shrink and fade, so each successful read is obvious without any sound.
// A near miss colours each digit: green where it equals the listed number, red where it differs.
function showRead(number, ms, near) {
  setHint("");
  const digits = el("p", "scan-number num");
  let index = 0;
  for (const ch of formatTagNumber(number)) {
    if (ch === " ") { digits.append(ch); continue; }
    digits.append(near ? el("span", near.flags[index] ? "diff" : "same", ch) : ch);
    index++;
  }
  const item = el("li");
  item.append(digits, el("p", "scan-ms num", `terbaca ${ms} ms`));

  const before = new Map([...scanHistory.children].map((li) => [li, li.getBoundingClientRect().top]));
  scanHistory.prepend(item);
  [...scanHistory.children].forEach((li, i) => {
    li.classList.toggle("old", i > 0);
    if (i >= HISTORY_SHOWN) li.remove();
  });
  if (!calmMotion.matches) {
    item.animate([
      { transform: "scale(0.6)", opacity: 0 },
      { transform: "scale(1.08)", opacity: 1, offset: 0.6 },
      { transform: "scale(1)", opacity: 1 },
    ], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    for (const [li, top] of before) { // slide the older reads from where they were
      if (!li.isConnected) continue;
      const dy = top - li.getBoundingClientRect().top;
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 240, easing: "ease-out" });
    }
  }
  const flash = $("scan-flash");
  flash.classList.remove("on");
  void flash.offsetWidth; // restart the animation on back-to-back reads
  flash.classList.add("on");
}

// Bumped by stopScan(); a start that finishes after a stop must not bring the camera back.
let scanSession = 0;

async function startScan() {
  if (starting || camera) return;
  starting = true;
  const session = ++scanSession;
  $("scan-retry").hidden = true;
  setHint("Membuka kamera…");
  let opened;
  try {
    detector ||= await createDetector({ forceZxing });
    $("engine-info").textContent = `· pembaca barcode: ${detector.name}`;
    opened = await openCamera(video);
  } catch (err) {
    starting = false;
    if (session !== scanSession) return;
    setHint(err?.kind
      ? cameraErrorMessage(err)
      : `Pembaca barcode gagal dimuat (${err?.message || err}). Buka aplikasi sekali saat ada sinyal, lalu coba lagi.`);
    showRetry("Coba lagi");
    return;
  }
  starting = false;
  if (session !== scanSession || document.hidden) { // stopped or left the app mid-start
    opened.close();
    return;
  }
  camera = opened;
  torchButton.hidden = !camera.torchSupported;
  torchButton.setAttribute("aria-pressed", "false");
  torchManual = false;
  darkChecks = 0;
  lastReported = null;
  setHint(scanHistory.children.length ? "" : watchlist.length ? "Arahkan kamera ke barcode tag" : "Daftar kosong: tidak ada yang dicari");
  keepScreenOn();
  resumeLoop();
}

$("scan-retry").addEventListener("click", startScan);

function stopScan() {
  scanSession++;
  pauseLoop();
  camera?.close();
  camera = null;
  releaseScreen();
  torchButton.hidden = true;
}

async function setTorch(on) {
  try {
    await camera?.setTorch(on);
    torchButton.setAttribute("aria-pressed", String(on));
  } catch {
    torchButton.hidden = true;
  }
}

torchButton.addEventListener("click", () => {
  torchManual = true;
  setTorch(torchButton.getAttribute("aria-pressed") !== "true");
});

function onFrame(values, now) {
  if (!resultEl.hidden) return;
  if (values.length) armIdle(); // something is in view: the officer is still scanning
  // Every decoded value (valid or not) takes part in confirmation, so a misread
  // between two good reads breaks the streak. Only then filter to 10-digit tags.
  const confirmed = confirmReads(values.map((v) => String(v).trim()), now).filter((c) => isValidScan(c.value));
  for (const { value: number, ms } of confirmed) {
    if (number === lastReported || !cooldown.shouldReport(number, now)) continue;
    lastReported = number;
    handleNumber(number, ms);
    if (!resultEl.hidden) break; // one alarm at a time
  }
}

function handleNumber(number, ms) {
  const match = matchTag(number, watchlist);
  addLog(number, match);
  countTag(number);
  readPulse();
  showRead(number, ms, match.near);
  if (match.result === "full") openResult(number, match);
}

// --- result screen -------------------------------------------------------------

const resultEl = $("result");
let alarmTimer = null;
let currentResult = null;

function openResult(number, match) {
  pauseLoop();
  currentResult = { number, match };
  $("result-title").textContent = "Ketemu!";
  $("result-body").replaceChildren(
    el("p", "result-label", "Nomor tag"),
    el("p", "result-number num", formatTagNumber(number)),
  );
  $("result-note").textContent = match.full.found ? "Nomor ini sudah ditandai ketemu sebelumnya." : "";
  $("result-found").hidden = match.full.found;
  resultEl.hidden = false;

  alarmFull();
  let repeats = 0;
  clearInterval(alarmTimer);
  alarmTimer = setInterval(() => {
    if (++repeats > ALARM_REPEATS) { clearInterval(alarmTimer); return; }
    alarmFull();
  }, ALARM_REPEAT_MS);
  $("result-continue").focus();
}

function closeResult() {
  clearInterval(alarmTimer);
  stopVibration();
  if (currentResult) cooldown.suppress(currentResult.number, performance.now(), AFTER_DISMISS_QUIET_MS);
  currentResult = null;
  resultEl.hidden = true;
  if (camera) resumeLoop();
}

$("result-continue").addEventListener("click", closeResult);
$("result-found").addEventListener("click", () => {
  if (currentResult?.match.full) markFound(currentResult.match.full.number);
  closeResult();
});

// --- lifecycle -------------------------------------------------------------------

document.addEventListener("visibilitychange", () => {
  // Camera off while the app is in the background, straight back on when it returns to Scan.
  if (document.hidden) stopScan();
  else if (currentView === "scan") startScan();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

renderWatchlist();
renderLog();
$("app-version").textContent = `BCTS ${APP_VERSION}`;
