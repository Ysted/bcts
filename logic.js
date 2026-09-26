// Pure logic: no DOM, no storage, no camera. Tested by logic.test.mjs.

export const FULL_LENGTH = 10;
export const SERIAL_LENGTH = 6;

export function normalizeTagNumber(raw) {
  return String(raw).replace(/\D/g, "");
}

// 'full' (10 digits), 'serial' (6 digits), or null when the length is invalid.
export function tagKind(digits) {
  if (digits.length === FULL_LENGTH) return "full";
  if (digits.length === SERIAL_LENGTH) return "serial";
  return null;
}

// Split pasted text into candidate tokens. Lines, commas and semicolons always
// separate. Spaces separate too, except when a chunk is one grouped number such
// as "0 657 123456" — those are rejoined so WhatsApp-style formatting survives.
export function tokenizeBulkInput(text) {
  const tokens = [];
  for (const chunk of String(text).split(/[\r\n,;]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (tagKind(normalizeTagNumber(trimmed))) tokens.push(trimmed);
    else tokens.push(...trimmed.split(/\s+/));
  }
  return tokens;
}

// Returns { added: [{number, kind}], duplicates, rejected: [raw token] }.
// Tokens without any digit (words like "Tag:") are ignored, not rejected.
export function parseBulkInput(text, existingNumbers = []) {
  const seen = new Set(existingNumbers);
  const result = { added: [], duplicates: 0, rejected: [] };
  for (const token of tokenizeBulkInput(text)) {
    const digits = normalizeTagNumber(token);
    if (!digits) continue;
    const kind = tagKind(digits);
    if (!kind) {
      result.rejected.push(token);
    } else if (seen.has(digits)) {
      result.duplicates++;
    } else {
      seen.add(digits);
      result.added.push({ number: digits, kind });
    }
  }
  return result;
}

export function summarizeAddResult({ added, duplicates, rejected }) {
  const parts = [];
  if (added.length) parts.push(`${added.length} ditambahkan`);
  if (duplicates) parts.push(`${duplicates} duplikat dibuang`);
  if (rejected.length) {
    parts.push(`${rejected.length} ditolak (bukan 6 atau 10 digit): ${rejected.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "Tidak ada nomor di teks itu.";
}

// --- matching ----------------------------------------------------------------
// The most critical code in the app: a wrong 'full' sends an officer to the
// wrong bag. Keep it pure and boring.

const serialOf = (digits) => digits.slice(-SERIAL_LENGTH);

// scanned: 10 digits (camera) or 6/10 digits (manual entry).
// watchlist: [{ number, kind, found }].
// Returns { result: 'full'|'partial'|'none', full: entry|null, partials: [entry] }.
// 'full' only when both sides are 10 digits and identical; it always wins.
// 'partial' when the last 6 digits agree but the full number is not proven identical.
export function matchTag(scanned, watchlist) {
  const full = scanned.length === FULL_LENGTH
    ? watchlist.find((e) => e.number.length === FULL_LENGTH && e.number === scanned) || null
    : null;
  const partials = watchlist.filter(
    (e) => e !== full && serialOf(e.number) === serialOf(scanned),
  );
  const result = full ? "full" : partials.length ? "partial" : "none";
  return { result, full, partials };
}

// Accept only what a baggage tag can carry: exactly 10 digits, nothing else.
// ITF has no checksum, so anything looser widens the door for misreads.
export function isValidScan(raw) {
  return /^\d{10}$/.test(String(raw).trim());
}

// Frame-level double-read confirmation. A value is accepted only when it is
// decoded in two consecutive frames that produced any decode at all. A frame
// with a different value (or none of this value) resets its streak.
// Frames where nothing decoded are skipped, but a gap longer than maxGapMs resets.
export function createReadConfirmer({ required = 2, maxGapMs = 1000 } = {}) {
  let streaks = new Map();
  let lastFrameAt = -Infinity;
  return function onFrame(values, now) {
    if (!values.length) return [];
    if (now - lastFrameAt > maxGapMs) streaks = new Map();
    lastFrameAt = now;
    const next = new Map();
    const confirmed = [];
    for (const value of new Set(values)) {
      const count = (streaks.get(value) || 0) + 1;
      next.set(value, count);
      if (count === required) confirmed.push(value);
    }
    streaks = next;
    return confirmed;
  };
}

// Suppresses repeat reports of the same number within cooldownMs.
// suppress() extends the quiet period, e.g. after an alarm is dismissed while
// the same bag is still in front of the camera.
export function createCooldown(cooldownMs = 3000) {
  const quietUntil = new Map();
  return {
    shouldReport(number, now) {
      if (now < (quietUntil.get(number) ?? -Infinity)) return false;
      quietUntil.set(number, now + cooldownMs);
      return true;
    },
    suppress(number, now, ms) {
      quietUntil.set(number, Math.max(quietUntil.get(number) ?? 0, now + ms));
    },
  };
}

// Per-character flags for display: true where `digits` differs from `reference`,
// comparing right-aligned (so a 6-digit serial lines up with the last 6 of a tag).
// Positions with no counterpart are flagged too.
export function diffDigits(digits, reference) {
  const offset = reference.length - digits.length;
  return [...digits].map((ch, i) => reference[i + offset] !== ch);
}

// --- log ---------------------------------------------------------------------

export const RESULT_LABEL = { full: "COCOK", partial: "cocok sebagian", none: "tidak dicari" };

const pad2 = (n) => String(n).padStart(2, "0");

export function formatLogTime(time) {
  const d = new Date(time);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// entry: { number, time, result, source: 'kamera'|'manual', partialNumbers?: [] }
export function formatLogLine(entry) {
  let line = `${formatLogTime(entry.time)}  ${formatTagNumber(entry.number)}  ${RESULT_LABEL[entry.result]}`;
  if (entry.result === "partial" && entry.partialNumbers?.length) {
    line += ` (dicari: ${entry.partialNumbers.map(formatTagNumber).join(", ")})`;
  }
  if (entry.source === "manual") line += " [ketik]";
  return line;
}

// Oldest first, ready to paste into WhatsApp.
export function formatLogText(entries) {
  return ["Log scan bagasi", ...entries.map(formatLogLine)].join("\n");
}

// "0657123456" -> "0 657 123456"; 6-digit serials stay as-is.
export function formatTagNumber(digits) {
  if (digits.length !== FULL_LENGTH) return digits;
  return `${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4)}`;
}
