import {
  parseBulkInput, summarizeAddResult, formatTagNumber, matchTag, isValidScan,
  createReadConfirmer, createCooldown, formatLogText, formatLogTime, RESULT_LABEL,
} from "./logic.js";
import { createDetector, openCamera, startScanLoop, cameraErrorMessage } from "./scanner.js";
import { unlockAudio, alarmFull, beep, stopVibration } from "./alarm.js";

const APP_VERSION = "v3"; // keep in step with CACHE in sw.js
const WATCHLIST_KEY = "bcts.watchlist";
const LOG_KEY = "bcts.log";
const LOG_LIMIT = 500;
const CONFIRM_MS = 3000;
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

function saveWatchlist() { saveList(WATCHLIST_KEY, watchlist); }
function saveLog() { saveList(LOG_KEY, scanLog); }

// --- helpers -----------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Two taps within a few seconds; the viewer shows no browser dialogs anyway.
function twoTapButton(button, confirmLabel, onConfirm) {
  const label = button.textContent;
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove("confirming");
  };
  button.addEventListener("click", () => {
    if (!timer) {
      button.textContent = confirmLabel;
      button.classList.add("confirming");
      timer = setTimeout(reset, CONFIRM_MS);
      return;
    }
    reset();
    onConfirm();
  });
}

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
  $("list-footer").hidden = !hasEntries;
  $("empty-state").hidden = hasEntries;
  const foundCount = watchlist.filter((e) => e.found).length;
  $("list-count").textContent = `${watchlist.length} nomor · ${foundCount} sudah ketemu`;
  $("scan-summary").textContent = hasEntries
    ? `${watchlist.length - foundCount} nomor masih dicari, ${foundCount} sudah ketemu.`
    : "Daftar masih kosong. Isi dulu nomor yang dicari di tab Daftar.";
  $("scan-count").textContent = hasEntries
    ? `${watchlist.length - foundCount} dicari · ${foundCount} ketemu`
    : "Daftar kosong";
}

function renderEntry(entry) {
  const li = el("li");
  li.classList.toggle("found", entry.found);

  const number = el("div", "entry-number");
  number.append(el("span", "entry-digits num", formatTagNumber(entry.number)));
  number.append(el("span", "entry-kind", entry.found ? "Sudah ketemu" : ""));

  const toggle = el("button", "", entry.found ? "Batal ketemu" : "Tandai sudah ketemu");
  toggle.type = "button";
  toggle.dataset.action = "toggle-found";
  toggle.dataset.number = entry.number;

  const remove = el("button", "", "Hapus");
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.dataset.number = entry.number;
  remove.setAttribute("aria-label", `Hapus ${formatTagNumber(entry.number)}`);

  li.append(number, toggle, remove);
  return li;
}

// Digits only; spaces, newlines, commas, semicolons and dashes still separate/group numbers.
$("bulk-input").addEventListener("input", (event) => {
  const clean = event.target.value.replace(/[^\d\s,;-]/g, "");
  if (clean !== event.target.value) event.target.value = clean;
});

$("add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("bulk-input");
  const result = parseBulkInput(input.value, watchlist.map((e) => e.number));
  watchlist.push(...result.added.map((e) => ({ ...e, found: false })));
  saveWatchlist();
  renderWatchlist();
  showFeedback(feedback, summarizeAddResult(result), result.rejected.length > 0);
  // Keep rejected tokens in the box so the officer can fix them; clear the rest.
  input.value = result.rejected.join("\n");
});

listEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, number } = button.dataset;
  if (action === "remove") {
    watchlist = watchlist.filter((e) => e.number !== number);
    showFeedback(feedback, `${formatTagNumber(number)} dihapus.`);
  } else if (action === "toggle-found") {
    const entry = watchlist.find((e) => e.number === number);
    if (entry) entry.found = !entry.found;
  }
  saveWatchlist();
  renderWatchlist();
});

twoTapButton($("clear-all"), "Tekan lagi untuk hapus semua", () => {
  const count = watchlist.length;
  watchlist = [];
  saveWatchlist();
  renderWatchlist();
  showFeedback(feedback, `${count} nomor dihapus.`);
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
  const ok = await copyText(formatLogText(scanLog));
  showFeedback($("log-feedback"), ok
    ? `${scanLog.length} baris disalin. Tempel di WhatsApp.`
    : "Gagal menyalin. Tekan lama pada daftar lalu salin manual.", !ok);
});

twoTapButton($("clear-log"), "Tekan lagi untuk hapus log", () => {
  scanLog = [];
  saveLog();
  renderLog();
  showFeedback($("log-feedback"), "Log dihapus.");
});

// --- navigation --------------------------------------------------------------

const navButtons = document.querySelectorAll("nav button[data-nav]");

function showView(name) {
  if (name === "scan") startScan(); // the tap on the tab also unlocks audio
  else stopScan();
  document.querySelectorAll("section[data-view]").forEach((v) => { v.hidden = v.dataset.view !== name; });
  navButtons.forEach((b) => {
    if (b.dataset.nav === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}
navButtons.forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));

// --- scanning ------------------------------------------------------------------

const video = $("video");
const scanner = $("scanner");
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
  stopLoop = startScanLoop(video, detector, onFrame);
}

function pauseLoop() {
  stopLoop?.();
  stopLoop = null;
}

const scanNumber = $("scan-number");
const scanMs = $("scan-ms");

function setHint(text) {
  scanNumber.className = "scan-number num hint";
  scanNumber.textContent = text;
  scanMs.textContent = "";
}

// Last read under the guide box. A near miss colours each digit: green where it
// equals the listed number, red where it differs.
function showRead(number, ms, near) {
  scanNumber.className = "scan-number num";
  scanNumber.replaceChildren();
  let index = 0;
  for (const ch of formatTagNumber(number)) {
    if (ch === " ") { scanNumber.append(ch); continue; }
    scanNumber.append(near ? el("span", near.flags[index] ? "diff" : "same", ch) : ch);
    index++;
  }
  scanMs.textContent = `terbaca ${ms} ms`;
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
  unlockAudio(); // must happen inside this tap or alarms stay silent
  $("scan-error").textContent = "";
  $("scan-feedback").textContent = "";
  scanner.hidden = false;
  setHint("Membuka kamera…");
  let opened;
  try {
    detector ||= await createDetector({ forceZxing });
    $("engine-info").textContent = `· pembaca barcode: ${detector.name}`;
    opened = await openCamera(video);
  } catch (err) {
    starting = false;
    if (session !== scanSession) return;
    scanner.hidden = true;
    $("scan-error").textContent = err?.kind
      ? cameraErrorMessage(err)
      : `Pembaca barcode gagal dimuat (${err?.message || err}). Buka aplikasi sekali saat ada sinyal, lalu coba lagi.`;
    return;
  }
  starting = false;
  if (session !== scanSession || document.hidden) { // stopped or left the app mid-start
    opened.close();
    scanner.hidden = true;
    return;
  }
  camera = opened;
  torchButton.hidden = !camera.torchSupported;
  torchButton.setAttribute("aria-pressed", "false");
  lastReported = null;
  setHint(watchlist.length ? "Arahkan kamera ke barcode tag" : "Daftar kosong: tidak ada yang dicari");
  keepScreenOn();
  resumeLoop();
}

$("start-scan").addEventListener("click", startScan);

function stopScan() {
  scanSession++;
  pauseLoop();
  camera?.close();
  camera = null;
  releaseScreen();
  scanner.hidden = true;
}

$("stop-scan").addEventListener("click", stopScan);

torchButton.addEventListener("click", async () => {
  const on = torchButton.getAttribute("aria-pressed") !== "true";
  try {
    await camera?.setTorch(on);
    torchButton.setAttribute("aria-pressed", String(on));
  } catch {
    torchButton.hidden = true;
  }
});

function onFrame(values, now) {
  if (!resultEl.hidden) return;
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
  beep();
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
  if (document.hidden && camera) {
    stopScan();
    $("scan-error").textContent = "Scan berhenti karena aplikasi ditinggal. Tekan Mulai scan lagi.";
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

renderWatchlist();
renderLog();
$("app-version").textContent = `BCTS ${APP_VERSION}`;
