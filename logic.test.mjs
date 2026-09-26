// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBulkInput, formatTagNumber, summarizeAddResult } from "./logic.js";

test("tahap 1: tempel 20 nomor campuran", () => {
  const pasted = [
    "Mohon dicari bagasi berikut:",
    "0126123456",          // full
    "0-990-654321",        // full, pakai tanda hubung
    "0 657 111222",        // full, dikelompokkan spasi
    "0141000001, 0994000002; 0126000003", // 3 full, pemisah campuran
    "",                    // baris kosong
    "   ",
    "123456",              // serial (duplikat seri dari entri pertama, tapi beda nomor → sah)
    "654999",              // serial
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
  assert.equal(r.added.length, 14);
  assert.equal(r.added.filter((e) => e.kind === "full").length, 12);
  assert.equal(r.added.filter((e) => e.kind === "serial").length, 2);
  assert.equal(r.duplicates, 3);
  assert.deepEqual(r.rejected, ["12345", "01261234567"]);
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
  assert.equal(formatTagNumber("123456"), "123456");
  assert.equal(
    summarizeAddResult({ added: [{}, {}], duplicates: 1, rejected: ["12345"] }),
    "2 ditambahkan · 1 duplikat dibuang · 1 ditolak (bukan 6 atau 10 digit): 12345",
  );
  assert.equal(summarizeAddResult({ added: [], duplicates: 0, rejected: [] }), "Tidak ada nomor di teks itu.");
});
