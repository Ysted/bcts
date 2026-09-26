import {
  parseBulkInput, summarizeAddResult, formatTagNumber, matchTag, isValidScan,
  createReadConfirmer, createCooldown, diffDigits, formatLogText, formatLogTime, RESULT_LABEL,
} from "./logic.js";
import { createDetector, openCamera, startScanLoop, cameraErrorMessage } from "./scanner.js";
import { unlockAudio, alarmFull, alarmPartial, tick, stopVibration } from "./alarm.js";

const APP_VERSION = "v2"; // keep in step with CACHE in sw.js
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

let watchlist = loadList(WATCHLIST_KEY).filter((e) => e && typeof e.number === "string"); // [{ number, kind, found }]
let scanLog = loadList(LOG_KEY); // [{ number, time, result, source, partialNumbers }]

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
}

function renderEntry(entry) {
  const li = el("li");
  li.classList.toggle("found", entry.found);

  const number = el("div", "entry-number");
  number.append(el("span", "entry-digits num", formatTagNumber(entry.number)));
  const kindText = [entry.kind === "serial" ? "Nomor seri saja" : "", entry.found ? "Sudah ketemu" : ""]
    .filter(Boolean).join(" · ");
  number.append(el("span", "entry-kind", kindText));

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
    meta.append(el("span", "log-result", RESULT_LABEL[entry.result]));
    let extra = ` · ${formatLogTime(entry.time)}`;
    if (entry.source === "manual") extra += " · diketik";
    meta.append(document.createTextNode(extra));
    li.append(meta);
    return li;
  });
  logList.replaceChildren(...rows);
  const hasRows = rows.length > 0;
  logList.hidden = !hasRows;
  $("log-footer").hidden = !hasRows;
  $("log-empty").hidden = hasRows;
}

function addLog(number, match, source) {
  scanLog.push({
    number,
    time: Date.now(),
    result: match.result,
    source,
    partialNumbers: match.partials.map((e) => e.number),
  });
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
const scanStatus = $("scan-status");
const torchButton = $("torch");
const forceZxing = new URLSearchParams(location.search).get("engine") === "zxing";

let detector = null;
let camera = null;
let stopLoop = null;
let confirmReads = createReadConfirmer();
const cooldown = createCooldown(3000);
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

function setStatus(text, number) {
  scanStatus.replaceChildren();
  if (number) scanStatus.append(el("span", "num", formatTagNumber(number)), document.createTextNode(" · "));
  scanStatus.append(document.createTextNode(text));
}

// Bumped by stopScan(); a start that finishes after a stop must not bring the camera back.
let scanSession = 0;

$("start-scan").addEventListener("click", async () => {
  if (starting || camera) return;
  starting = true;
  const session = ++scanSession;
  unlockAudio(); // must happen inside this tap or alarms stay silent
  $("scan-error").textContent = "";
  $("scan-feedback").textContent = "";
  scanner.hidden = false;
  setStatus("Membuka kamera…");
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
  setStatus(watchlist.length ? "Arahkan kamera ke barcode tag" : "Daftar kosong: semua tag akan 'tidak dicari'");
  keepScreenOn();
  resumeLoop();
});

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
  if (!resultEl.hidden || !keypadEl.hidden) return;
  // Every decoded value (valid or not) takes part in confirmation, so a misread
  // between two good reads breaks the streak. Only then filter to 10-digit tags.
  const confirmed = confirmReads(values.map((v) => String(v).trim()), now).filter(isValidScan);
  for (const number of confirmed) {
    if (!cooldown.shouldReport(number, now)) continue;
    handleNumber(number, "kamera");
    if (!resultEl.hidden) break; // one alarm at a time
  }
}

// Camera and manual entry go through exactly this path.
function handleNumber(number, source) {
  const match = matchTag(number, watchlist);
  addLog(number, match, source);
  if (match.result === "none") {
    tick();
    setStatus("tidak dicari", number);
    return;
  }
  openResult(number, match);
}

// --- result screen -------------------------------------------------------------

const resultEl = $("result");
let alarmTimer = null;
let currentResult = null;

function digitsWithMarks(digits, reference) {
  const p = el("p", "num");
  const flags = diffDigits(digits, reference);
  const formatted = formatTagNumber(digits);
  let index = 0;
  for (const ch of formatted) {
    if (ch === " ") { p.append(" "); continue; }
    if (flags[index]) p.append(el("mark", "", ch));
    else p.append(ch);
    index++;
  }
  return p;
}

function openResult(number, match) {
  pauseLoop();
  currentResult = { number, match };
  const isFull = match.result === "full";
  resultEl.classList.toggle("partial", !isFull);
  $("result-title").textContent = isFull ? "Cocok" : "Cocok sebagian — cek kode maskapai";

  const body = $("result-body");
  body.replaceChildren();
  const notes = [];
  if (isFull) {
    body.append(el("p", "result-label", "Nomor tag"), el("p", "result-number num", formatTagNumber(number)));
    if (match.full.found) notes.push("Nomor ini sudah ditandai ketemu sebelumnya.");
    if (match.partials.length) notes.push(`Ada juga ${match.partials.length} nomor lain di daftar dengan 6 digit akhir sama.`);
    $("result-found").hidden = match.full.found;
  } else {
    body.className = "result-compare";
    body.append(el("p", "result-label", "Hasil scan"), el("p", "num", formatTagNumber(number)));
    for (const entry of match.partials) {
      const row = el("div", "partial-row");
      row.append(
        el("p", "result-label", entry.kind === "serial" ? "Di daftar (nomor seri saja)" : "Di daftar — digit yang beda ditandai"),
        digitsWithMarks(entry.number, number),
      );
      if (entry.found) {
        row.append(el("p", "result-note", "Sudah ditandai ketemu."));
      } else {
        const btn = el("button", "", "Ini yang dicari — tandai ketemu");
        btn.type = "button";
        btn.addEventListener("click", () => { markFound(entry.number); closeResult(); });
        row.append(btn);
      }
      body.append(row);
    }
    notes.push("Periksa nomor di tag dengan mata sebelum mengambil bagasi.");
    $("result-found").hidden = true;
  }
  if (isFull) body.className = "";
  $("result-note").textContent = notes.join(" ");
  resultEl.hidden = false;

  const play = isFull ? alarmFull : alarmPartial;
  play();
  let repeats = 0;
  clearInterval(alarmTimer);
  alarmTimer = setInterval(() => {
    if (++repeats > ALARM_REPEATS) { clearInterval(alarmTimer); return; }
    play();
  }, ALARM_REPEAT_MS);
  $("result-continue").focus();
}

function closeResult() {
  clearInterval(alarmTimer);
  stopVibration();
  if (currentResult) cooldown.suppress(currentResult.number, performance.now(), AFTER_DISMISS_QUIET_MS);
  currentResult = null;
  resultEl.hidden = true;
  if (camera) {
    setStatus("Arahkan kamera ke barcode tag");
    resumeLoop();
  }
}

$("result-continue").addEventListener("click", closeResult);
$("result-found").addEventListener("click", () => {
  if (currentResult?.match.full) markFound(currentResult.match.full.number);
  closeResult();
});

// --- manual keypad ---------------------------------------------------------------

const keypadEl = $("keypad");
let typed = "";

function renderKeypad() {
  $("keypad-display").textContent = typed ? formatTagNumber(typed) : " ";
  $("keypad-check").disabled = !(typed.length === 6 || typed.length === 10);
  $("keypad-hint").textContent = typed.length && typed.length !== 6 && typed.length < 10
    ? `${typed.length} digit — perlu 6 atau 10`
    : "Ketik 10 digit, atau 6 digit nomor seri";
}

function openKeypad() {
  pauseLoop();
  typed = "";
  renderKeypad();
  keypadEl.hidden = false;
}

function closeKeypad() {
  keypadEl.hidden = true;
  if (camera && resultEl.hidden) resumeLoop();
}

$("manual-open").addEventListener("click", openKeypad);
$("manual-open-idle").addEventListener("click", openKeypad);

$("keys").addEventListener("click", (event) => {
  const key = event.target.closest("button[data-key]")?.dataset.key;
  if (!key) return;
  if (key === "close") return closeKeypad();
  if (key === "back") typed = typed.slice(0, -1);
  else if (key === "check") {
    if (typed.length !== 6 && typed.length !== 10) return;
    unlockAudio(); // manual entry may be used without ever starting the camera
    const number = typed;
    keypadEl.hidden = true;
    handleNumber(number, "manual");
    if (resultEl.hidden) {
      if (camera) resumeLoop();
      else $("scan-feedback").textContent = `${formatTagNumber(number)}: tidak dicari.`;
    }
    return;
  } else if (typed.length < 10) typed += key;
  renderKeypad();
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
