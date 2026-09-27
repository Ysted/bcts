// Pure logic: no DOM, no storage, no camera. Tested by logic.test.mjs.

export const FULL_LENGTH = 10;
export const NEAR_MIN_SAME = 8; // digits in the same position for a "near" hint

export function normalizeTagNumber(raw) {
  return String(raw).replace(/\D/g, "");
}

// Split pasted text into candidate tokens. Lines, commas and semicolons always
// separate. Spaces separate too, except when a chunk is one grouped number such
// as "0 657 123456" — those are rejoined so WhatsApp-style formatting survives.
export function tokenizeBulkInput(text) {
  const tokens = [];
  for (const chunk of String(text).split(/[\r\n,;]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (normalizeTagNumber(trimmed).length === FULL_LENGTH) tokens.push(trimmed);
    else tokens.push(...trimmed.split(/\s+/));
  }
  return tokens;
}

// Returns { added: [{number}], duplicates, rejected: [raw token] }.
// Tokens without any digit (words like "Tag:") are ignored, not rejected.
export function parseBulkInput(text, existingNumbers = []) {
  const seen = new Set(existingNumbers);
  const result = { added: [], duplicates: 0, rejected: [] };
  for (const token of tokenizeBulkInput(text)) {
    const digits = normalizeTagNumber(token);
    if (!digits) continue;
    if (digits.length !== FULL_LENGTH) {
      result.rejected.push(token);
    } else if (seen.has(digits)) {
      result.duplicates++;
    } else {
      seen.add(digits);
      result.added.push({ number: digits });
    }
  }
  return result;
}

export function summarizeAddResult({ added, duplicates, rejected }) {
  const parts = [];
  if (added.length) parts.push(`${added.length} ditambahkan`);
  if (duplicates) parts.push(`${duplicates} duplikat dibuang`);
  if (rejected.length) {
    parts.push(`${rejected.length} ditolak (bukan 10 angka): ${rejected.join(", ")}`);
  }
  return parts.length ? parts.join(" · ") : "Tidak ada nomor di teks itu.";
}

// --- matching ----------------------------------------------------------------
// The most critical code in the app: a wrong 'full' sends an officer to the
// wrong bag. Keep it pure and boring.

// scanned: 10 digits. watchlist: [{ number, found }].
// Returns { result: 'full'|'none', full: entry|null, near: { entry, flags }|null }.
// 'full' only when identical. 'near' is display-only (no alarm): the closest
// entry with at least NEAR_MIN_SAME digits equal in the same position; flags
// mark the positions that differ.
export function matchTag(scanned, watchlist) {
  const full = watchlist.find((e) => e.number === scanned) || null;
  if (full) return { result: "full", full, near: null };
  let near = null;
  let bestSame = NEAR_MIN_SAME - 1;
  for (const entry of watchlist) {
    if (entry.number.length !== scanned.length) continue;
    const flags = diffDigits(scanned, entry.number);
    const same = flags.filter((differs) => !differs).length;
    if (same > bestSame) {
      bestSame = same;
      near = { entry, flags };
    }
  }
  return { result: "none", full: null, near };
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
// Returns [{ value, ms }], ms = time from the first read of the streak to confirmation.
export function createReadConfirmer({ required = 2, maxGapMs = 1000 } = {}) {
  let streaks = new Map(); // value -> { count, since }
  let lastFrameAt = -Infinity;
  return function onFrame(values, now) {
    if (!values.length) return [];
    if (now - lastFrameAt > maxGapMs) streaks = new Map();
    lastFrameAt = now;
    const next = new Map();
    const confirmed = [];
    for (const value of new Set(values)) {
      const prev = streaks.get(value);
      const streak = { count: (prev?.count || 0) + 1, since: prev?.since ?? now };
      next.set(value, streak);
      if (streak.count === required) confirmed.push({ value, ms: Math.round(now - streak.since) });
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
// comparing right-aligned.
// Positions with no counterpart are flagged too.
export function diffDigits(digits, reference) {
  const offset = reference.length - digits.length;
  return [...digits].map((ch, i) => reference[i + offset] !== ch);
}

// --- log ---------------------------------------------------------------------

export const RESULT_LABEL = { full: "Match" }; // anything else is shown without a label

const pad2 = (n) => String(n).padStart(2, "0");

export function formatLogTime(time) {
  const d = new Date(time);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// entry: { number, time, result }
export function formatLogLine(entry) {
  const label = RESULT_LABEL[entry.result];
  return `${formatLogTime(entry.time)}  ${formatTagNumber(entry.number)}${label ? `  ${label}` : ""}`;
}

// Oldest first, ready to paste into WhatsApp. scannedCount: unique tags in the current count.
export function formatLogText(entries, scannedCount) {
  return ["Log scan bagasi", `Jumlah tag discan: ${scannedCount}`, ...entries.map(formatLogLine)].join("\n");
}

// "0657123456" -> "0 657 123456"; other lengths stay as-is.
export function formatTagNumber(digits) {
  if (digits.length !== FULL_LENGTH) return digits;
  return `${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4)}`;
}
