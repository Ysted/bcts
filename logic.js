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

// "0657123456" -> "0 657 123456"; 6-digit serials stay as-is.
export function formatTagNumber(digits) {
  if (digits.length !== FULL_LENGTH) return digits;
  return `${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4)}`;
}
