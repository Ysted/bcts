// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBulkInput, formatTagNumber, summarizeAddResult, matchTag, isValidScan,
  createReadConfirmer, createCooldown, diffDigits, formatLogText,
} from "./logic.js";

const list = (...numbers) => numbers.map((number) => ({ number, found: false }));

test("match: penuh 10 digit identik", () => {
  const r = matchTag("0126123456", list("0126123456", "0990000001"));
  assert.equal(r.result, "full");
  assert.equal(r.full.number, "0126123456");
  assert.equal(r.near, null);
});

test("match: leading zero tidak hilang", () => {
  assert.equal(matchTag("0000000001", list("0000000001")).result, "full");
});

test("match: satu digit beda → bukan penuh, tapi mirip", () => {
  const r = matchTag("0126123457", list("0126123456"));
  assert.equal(r.result, "none");
  assert.equal(r.near.entry.number, "0126123456");
  assert.deepEqual(r.near.flags, [false, false, false, false, false, false, false, false, false, true]);
});

test("mirip: 8 dari 10 sama → diwarnai, 7 dari 10 → tidak", () => {
  assert.ok(matchTag("1234567809", list("1234567890")).near); // 8 sama, "09" beda
  assert.ok(matchTag("1234567801", list("1234567890")).near); // 8 sama
  assert.equal(matchTag("1234567011", list("1234567890")).near, null); // 7 sama
});

test("mirip: pilih entri paling dekat", () => {
  const r = matchTag("1234567899", list("1234567800", "1234567890"));
  assert.equal(r.near.entry.number, "1234567890");
});

test("match: entri lama 6 digit tidak pernah cocok", () => {
  const r = matchTag("0126123456", list("123456"));
  assert.equal(r.result, "none");
  assert.equal(r.near, null);
});

test("match: daftar kosong", () => {
  const r = matchTag("0126123456", []);
  assert.equal(r.result, "none");
  assert.equal(r.near, null);
});

test("scan valid hanya tepat 10 digit", () => {
  assert.ok(isValidScan("0126123456"));
  for (const bad of ["012612345", "01261234567", "A126123456", "0126 123456", "", "123456"]) {
    assert.ok(!isValidScan(bad), bad);
  }
});

test("konfirmasi: satu kali baca tidak cukup", () => {
  const confirm = createReadConfirmer();
  assert.deepEqual(confirm(["0126123456"], 0), []);
});

test("konfirmasi: dua frame berturut identik → diterima sekali", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456"], 0);
  assert.deepEqual(confirm(["0126123456"], 50), [{ value: "0126123456", ms: 50 }]);
  assert.deepEqual(confirm(["0126123456"], 100), []); // tidak diulang selama streak
});

test("konfirmasi: salah baca di tengah memutus streak", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456"], 0);
  confirm(["0126123457"], 50);
  assert.deepEqual(confirm(["0126123456"], 100), []);
  assert.deepEqual(confirm(["0126123456"], 150), [{ value: "0126123456", ms: 50 }]);
});

test("konfirmasi: frame kosong dilewati, jeda panjang me-reset", () => {
  const confirm = createReadConfirmer({ maxGapMs: 1000 });
  confirm(["0126123456"], 0);
  assert.deepEqual(confirm([], 30), []);
  assert.deepEqual(confirm(["0126123456"], 60), [{ value: "0126123456", ms: 60 }]);
  const c2 = createReadConfirmer({ maxGapMs: 1000 });
  c2(["0126123456"], 0);
  assert.deepEqual(c2(["0126123456"], 2000), []);
});

test("konfirmasi: dua barcode berbeda dalam satu frame tidak saling merusak", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456", "0657000001"], 0);
  assert.deepEqual(confirm(["0126123456", "0657000001"], 50).map((c) => c.value).sort(), ["0126123456", "0657000001"]);
});

test("cooldown 3 detik dan suppress", () => {
  const cd = createCooldown(3000);
  assert.ok(cd.shouldReport("A", 0));
  assert.ok(!cd.shouldReport("A", 2999));
  assert.ok(cd.shouldReport("A", 3000));
  cd.suppress("A", 3000, 10000);
  assert.ok(!cd.shouldReport("A", 12999));
  assert.ok(cd.shouldReport("A", 13000));
  assert.ok(cd.shouldReport("B", 13000));
});

test("teks log siap kirim: hanya Match yang berlabel", () => {
  const t = new Date(2026, 8, 27, 7, 5, 9).getTime();
  const text = formatLogText([
    { number: "0126123456", time: t, result: "full" },
    { number: "0994000001", time: t, result: "none" },
    { number: "0657123456", time: t, result: "partial", source: "manual" }, // entri lama v2
  ]);
  assert.equal(text, [
    "Log scan bagasi",
    "27/09 07:05:09  0 126 123456  Match",
    "27/09 07:05:09  0 994 000001",
    "27/09 07:05:09  0 657 123456",
  ].join("\n"));
});

test("diffDigits rata kanan", () => {
  assert.deepEqual(diffDigits("0657123456", "0126123456"), [false, true, true, true, false, false, false, false, false, false]);
});

test("tempel 20 nomor campuran: hanya 10 angka diterima", () => {
  const pasted = [
    "Mohon dicari bagasi berikut:",
    "0126123456",          // full
    "0-990-654321",        // full, pakai tanda hubung
    "0 657 111222",        // full, dikelompokkan spasi
    "0141000001, 0994000002; 0126000003", // 3 full, pemisah campuran
    "",                    // baris kosong
    "   ",
    "123456",              // ditolak: 6 digit
    "GA 654999",           // ditolak: huruf dibuang, sisa 6 digit
    "0126123456",          // duplikat
    "0-990-654321",        // duplikat (setelah normalisasi)
    "12345",               // ditolak: 5 digit
    "01261234567",         // ditolak: 11 digit
    "0657222333 0657444555", // 2 full dipisah spasi
    "0990777888\t0141888999", // 2 full dipisah tab
    "0126000003",          // duplikat
    "0994123123",          // full
    "Tag: 0657999000",     // full, ada kata
  ].join("\n");

  const r = parseBulkInput(pasted);
  assert.equal(r.added.length, 12);
  assert.equal(r.duplicates, 3);
  assert.deepEqual(r.rejected, ["123456", "654999", "12345", "01261234567"]);
  assert.ok(r.added.some((e) => e.number === "0990654321"));
  assert.ok(r.added.some((e) => e.number === "0657111222"));
});

test("duplikat terhadap daftar yang sudah ada", () => {
  const r = parseBulkInput("0126123456\n0126999999", ["0126123456"]);
  assert.equal(r.added.length, 1);
  assert.equal(r.duplicates, 1);
});

test("leading zero tetap utuh", () => {
  assert.equal(parseBulkInput("0000000001").added[0].number, "0000000001");
});

test("format dan ringkasan", () => {
  assert.equal(formatTagNumber("0657123456"), "0 657 123456");
  assert.equal(
    summarizeAddResult({ added: [{}, {}], duplicates: 1, rejected: ["12345"] }),
    "2 ditambahkan · 1 duplikat dibuang · 1 ditolak (bukan 10 angka): 12345",
  );
  assert.equal(summarizeAddResult({ added: [], duplicates: 0, rejected: [] }), "Tidak ada nomor di teks itu.");
});
