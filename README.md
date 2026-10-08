# api-cafe-queue

API antrian cafe: Cloudflare Worker (Hono) + D1.

| Method | Path | Akses | Fungsi |
|---|---|---|---|
| GET | `/api/menu` | publik | Daftar menu |
| POST | `/api/menu` | staff | Tambah menu |
| PATCH | `/api/menu/:id` | staff | Ubah harga/nama, tandai habis |
| GET | `/api/queue` | publik | Antrian aktif hari ini (untuk layar TV) |
| POST | `/api/orders` | staff | Buat pesanan, nomor antrian otomatis |
| GET | `/api/orders` | staff | Pesanan aktif + item (untuk dapur) |
| PATCH | `/api/orders/:id/status` | staff | waiting, preparing, ready, done, cancelled |
| GET | `/api/stats` | staff | Ringkasan hari ini: jumlah pesanan & omzet per status |
| POST | `/api/login` | staff | Cek PIN |

Akses staff = header `x-staff-pin: <STAFF_PIN>`. Nomor antrian reset tiap hari (zona WIB).

## Jalankan lokal
```bash
npm install
cp .dev.vars.example .dev.vars   # PIN untuk dev
npm run db:init:local
npm run dev                      # http://127.0.0.1:8787
```

Panduan deploy lengkap ada di `PANDUAN.md` (folder induk).

## Batas penting
- D1 membatasi 100 bound parameter per query; endpoint di sini sengaja memakai subquery, bukan `IN (id1, id2, ...)`.
- `/api/queue` dibatasi 60 pesanan per status (jumlah sebenarnya ada di `counts`); `/api/orders` dibatasi `?limit=` (default 300, maks 500).
