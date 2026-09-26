import { parseBulkInput, summarizeAddResult, formatTagNumber } from "./logic.js";

const STORAGE_KEY = "bcts.watchlist";
const CLEAR_CONFIRM_MS = 3000;

// --- storage -----------------------------------------------------------------

function loadWatchlist() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

let storageWarning = "";

function saveWatchlist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    storageWarning = "";
  } catch {
    storageWarning = "Daftar tidak bisa disimpan di HP ini dan akan hilang saat aplikasi ditutup. Matikan mode penyamaran di Chrome.";
  }
}

let watchlist = loadWatchlist(); // [{ number, kind, found }]

// --- elements ----------------------------------------------------------------

const form = document.getElementById("add-form");
const bulkInput = document.getElementById("bulk-input");
const feedback = document.getElementById("feedback");
const emptyState = document.getElementById("empty-state");
const listEl = document.getElementById("watchlist");
const listFooter = document.getElementById("list-footer");
const listCount = document.getElementById("list-count");
const clearAllButton = document.getElementById("clear-all");

// --- rendering ---------------------------------------------------------------

function renderWatchlist() {
  listEl.replaceChildren(...watchlist.map(renderEntry));
  const hasEntries = watchlist.length > 0;
  listEl.hidden = !hasEntries;
  listFooter.hidden = !hasEntries;
  emptyState.hidden = hasEntries;
  const foundCount = watchlist.filter((e) => e.found).length;
  listCount.textContent = `${watchlist.length} nomor · ${foundCount} sudah ketemu`;
}

function renderEntry(entry) {
  const li = document.createElement("li");
  li.classList.toggle("found", entry.found);

  const number = document.createElement("div");
  number.className = "entry-number";
  const digits = document.createElement("span");
  digits.className = "entry-digits num";
  digits.textContent = formatTagNumber(entry.number);
  number.append(digits);
  const kind = document.createElement("span");
  kind.className = "entry-kind";
  kind.textContent = [entry.kind === "serial" ? "Nomor seri saja" : "", entry.found ? "Sudah ketemu" : ""]
    .filter(Boolean).join(" · ");
  number.append(kind);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.action = "toggle-found";
  toggle.dataset.number = entry.number;
  toggle.textContent = entry.found ? "Batal ketemu" : "Tandai sudah ketemu";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.dataset.number = entry.number;
  remove.textContent = "Hapus";
  remove.setAttribute("aria-label", `Hapus ${formatTagNumber(entry.number)}`);

  li.append(number, toggle, remove);
  return li;
}

function showFeedback(text, isWarning) {
  feedback.textContent = [text, storageWarning].filter(Boolean).join(" ");
  feedback.classList.toggle("has-rejected", Boolean(isWarning || storageWarning));
}

// --- actions -----------------------------------------------------------------

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = parseBulkInput(bulkInput.value, watchlist.map((e) => e.number));
  watchlist.push(...result.added.map((e) => ({ ...e, found: false })));
  saveWatchlist();
  renderWatchlist();
  showFeedback(summarizeAddResult(result), result.rejected.length > 0);
  // Keep rejected tokens in the box so the officer can fix them; clear the rest.
  bulkInput.value = result.rejected.join("\n");
});

listEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, number } = button.dataset;
  if (action === "remove") {
    watchlist = watchlist.filter((e) => e.number !== number);
    showFeedback(`${formatTagNumber(number)} dihapus.`);
  } else if (action === "toggle-found") {
    const entry = watchlist.find((e) => e.number === number);
    if (entry) entry.found = !entry.found;
  }
  saveWatchlist();
  renderWatchlist();
});

// Two taps within a few seconds; no browser dialogs.
let clearTimer = null;
clearAllButton.addEventListener("click", () => {
  if (!clearTimer) {
    clearAllButton.textContent = "Tekan lagi untuk hapus semua";
    clearAllButton.classList.add("confirming");
    clearTimer = setTimeout(resetClearButton, CLEAR_CONFIRM_MS);
    return;
  }
  resetClearButton();
  const count = watchlist.length;
  watchlist = [];
  saveWatchlist();
  renderWatchlist();
  showFeedback(`${count} nomor dihapus.`);
});

function resetClearButton() {
  clearTimeout(clearTimer);
  clearTimer = null;
  clearAllButton.textContent = "Hapus semua";
  clearAllButton.classList.remove("confirming");
}

// --- navigation --------------------------------------------------------------

const navButtons = document.querySelectorAll("nav button[data-nav]");
const views = document.querySelectorAll("section[data-view]");

function showView(name) {
  views.forEach((v) => { v.hidden = v.dataset.view !== name; });
  navButtons.forEach((b) => {
    if (b.dataset.nav === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

navButtons.forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));

renderWatchlist();
