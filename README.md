# BCTS — Baggage Claim Tag Scanner

PWA pencari bagasi: tempel nomor tag yang dicari, pindai tag dengan kamera HP, alarm saat cocok.
Tanpa server; data (daftar + log) hanya tersimpan di HP.

## Pasang di HP

1. Buka alamat aplikasi sekali saat ada sinyal.
2. Android (Chrome): menu ⋮ → **Tambahkan ke layar utama** / **Instal aplikasi**.
   iPhone (Safari): tombol Bagikan → **Tambah ke Layar Utama**.
3. Buka dari ikon di layar utama. Setelah itu jalan tanpa sinyal.

iPhone: daftar di Safari dan di ikon layar utama tersimpan terpisah — isi daftar dari ikon.
iPhone tidak bisa bergetar dari web; alarm = bunyi + layar. Naikkan volume.

## Pengembangan

```
node --test            # tes logika
node tests/e2e.mjs     # tes Chrome + kamera palsu (butuh python, ffmpeg, Chrome)
node tools/make-icons.mjs
```

Setiap rilis: naikkan `CACHE` di `sw.js`, supaya HP mengambil versi baru.
`?engine=zxing` di alamat memaksa pembaca ZXing (untuk membandingkan dengan pembaca bawaan Chrome).
