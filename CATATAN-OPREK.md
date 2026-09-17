# 🦖 CATATAN OPREK — Dino-Bill ISP Management System

> Dokumen ini disusun setelah membaca seluruh kode inti (server.js 2.559 baris, 22 routes, 10 helpers, views).
> Gunakan sebagai pegangan sebelum mengubah apa pun.

---

## 1. Denyut Utama Aplikasi

```
server.js (entry point, port 3999)
 ├── Mode Install: jika .env tidak ada → semua route dialihkan ke /install
 ├── Mode Normal: buat DB pool (mysql2/promise, charset utf8mb4, timezone +07:00)
 │    ├── Auto-migrasi: CREATE TABLE IF NOT EXISTS + ALTER (checkAndAddColumn) di setiap startup
 │    ├── Settings cache 5 menit (getSettings) → invalidate via global.invalidateSettingsCache()
 │    ├── Mount semua routes (router.setPool(pool) → app.use('/path', middleware, router))
 │    ├── Cron jobs (node-cron)
 │    └── app.listen() → initWhatsApp(pool) + startTelegramBot(pool)
```

**Pola wajib route baru:**
```js
const xRouter = require('./routes/x');
xRouter.setPool(pool);          // setPool WAJIB dipanggil sebelum app.use
app.use('/x', adminOnly, xRouter);
```
Di dalam route: `let pool; router.setPool = (dbPool) => { pool = dbPool; };`

---

## 2. Peta Routes & Middleware Auth

| Route | Middleware | File |
|---|---|---|
| `/` (dashboard) | adminOnly | server.js |
| `/customers` | adminOnly | routes/customers.js |
| `/billing` | adminOnly | routes/billing.js |
| `/portal` | portal auth sendiri (session.customerId) | routes/portal.js |
| `/tickets` | requireAuth (admin + teknisi) | routes/tickets.js |
| `/technician` | requireRole('technician') | server.js |
| `/sales` | requireRole('sales') | server.js |
| `/fo` | admin + teknisi (custom inline) | routes/fo.js |
| `/olt`, `/acs`, `/mikrotik`, `/wa`, `/settings`, `/inventory`, `/monitoring`, `/sla`, `/ip-monitor`, `/hotspot`, `/packages`, `/expenses`, `/map` | adminOnly | masing-masing |
| `/attendance` | requireAuth | routes/attendance.js |
| Webhook publik (tanpa auth): `/api/xendit/callback`, `/api/tripay/callback`, `/wa-status` | — | server.js |

**Session keys:** `req.session.userId / role / username` (admin/teknisi/sales), `req.session.customerId / customerName` (portal pelanggan).
**Role:** `admin` (akses penuh), `technician` (redirect /tickets), `sales` (redirect /sales).

---

## 3. Skema Database (34 tabel, dinodb.sql + auto-migrasi server.js)

**Inti bisnis:** `customers`, `packages`, `invoices`, `routers`, `users`, `settings`
**Jaringan:** `hioso_olts`, `hioso_onus`, `acs_devices`, `onu_status_history`, `ip_monitors`
**Tiket:** `trouble_tickets`, `ticket_comments`, `ticket_technicians` (many-to-many)
**FO:** `fo_nodes`, `fo_node_types`, `fo_cables`, `fo_tubes`, `fo_cores`, `fo_core_assignments`, `fo_ports`, `fo_assets`
**WA:** `wa_messages`, `wa_contacts`, `wa_templates`, `wa_auto_replies`
**Lainnya:** `vouchers`, `inventory`, `inventory_mutations`, `attendances`, `map_objects`, `map_cables`, `expenses`, `expense_categories`, `technician_users`, `sales_users`

⚠️ **Auto-migrasi jalan di SETIAP startup** (server.js:171-897). Menambah tabel/kolom baru cukup tambahkan `checkAndAddColumn(...)` atau `pool.query(CREATE TABLE IF NOT EXISTS ...)` di sana — jangan edit dinodb.sql untuk migrasi incremental.

---

## 4. Cron Jobs (semua di server.js)

| Jadwal | Fungsi |
|---|---|
| `0 0 * * *` | Auto-isolir: invoice overdue → status isolated → disable PPPoE → WA |
| `0 8 * * *` | Reminder H-3 jatuh tempo via WA |
| `30 8 * * *` | Laporan harian ke admin (WA + Telegram) |
| `0 6 1 * *` | Generate invoice bulanan semua pelanggan aktif/isolated (billing_method='fixed') + WA |
| `*/5 * * * *` | Sync OLT (paralel, SNMP) + OLT alert cek |
| `*/5 * * * *` | Sync GenieACS → acs_devices + hapus orphan |
| `* * * * *` | IP Monitor (`ipMonitorRouter.runChecks()`) |

**Pola pengiriman WA massal:** batas `wa_limit` (default 50) + jeda `wa_delay` detik antar pesan. Hanya WA yang dibatasi — isolir & pembuatan invoice tetap jalan tanpa batas.

---

## 5. Alur Pembayaran (3 jalur, logika rolling billing terduplikasi!)

1. **Xendit QRIS** (portal pelanggan): `POST /portal/pay/:id` → QR dinamis → polling `/portal/qr-status/:ref` → webhook `POST /api/xendit/callback` (verifikasi `x-callback-token`)
2. **Tripay**: webhook `POST /api/tripay/callback` (verifikasi HMAC-SHA256)
3. **Manual/cash**: `POST /billing/api/:id/pay` atau `POST /customers/:id/pay`

**Setelah lunas (semua jalur):** invoice→paid → unisolate → enable PPPoE MikroTik → WA konfirmasi → **rolling billing** (jika bayar tgl ≥ 25 → auto-switch `billing_method='rolling'` + buat invoice jatuh tempo +30 hari)

⚠️ **Logika rolling billing terduplikasi di 3 tempat** — server.js (Tripay callback), routes/customers.js:345, routes/billing.js:188. Kalau ubah satu, ubah ketiganya (kandidat refactor jadi helper).
⚠️ `invoices.invoice_number` dipakai untuk menyimpan referenceId Xendit (`INV-{id}-{timestamp}`), bukan nomor invoice tercetak.

---

## 6. Integrasi Eksternal

**MikroTik** (`helpers/mikrotik.js`): routeros-api, timeout 5 dtk. Fungsi: add/remove/enable/disable PPPoE secret, getActiveConnections, hotspot, ping/traceroute via exec OS (IS_WIN → `ping -n 4` / `tracert`).

**OLT SNMP** (`helpers/olt.js`): class `HiosoOLT`, net-snmp v2c. 8 profil OID: HIOSO_C/B/GPON/HA73, ZTE, HSGQ, HSGQ_GPON, Huawei. Auto-probe profil via getNext. Divider sinyal per-brand (ZTE: `(val-15000)/500`, HSGQ: RX ÷100 negatif / TX ÷1000 positif). Status 'Up'/'Down'.

**GenieACS** (`helpers` inline di server.js + routes/acs.js): REST API `/devices`, cross-ref PPPoE → customers, threshold online default 15 menit (`acs_online_threshold`). Ubah WiFi via `POST /devices/:id/tasks` (setParameterValues).

**WhatsApp** (`helpers/whatsapp.js`): whatsapp-web.js + LocalAuth di `.wwebjs_auth/` (⚠️ tidak ikut backup — butuh scan QR ulang di copy ini). Flow pesan masuk: saveMessage → perintah teknisi `#cek/#status/...` → auto-reply keyword → AI Agent (Groq). `sendLocalWhatsApp` normalisasi 08→62, coba `@c.us` lalu `@lid`.

**Telegram**: 2 mekanisme — (a) bot polling perintah teknisi (`helpers/telegram-bot.js`, verifikasi telegram_id terdaftar), (b) kirim notif via Bot API (`helpers/notification.js`).

**AI Agent** (`helpers/ai-agent.js`): Groq API, model default `llama-3.1-8b-instant`. System prompt dibangun dari DB (paket, company, area, data pelanggan). History 8 pasang / 30 menit per nomor. System context cache 10 menit.

**Payment**: Xendit QRIS (`helpers/xendit.js`), Tripay (`helpers/tripay.js`).

---

## 7. Konvensi Penting

- **Status pelanggan:** `active` | `isolated` | `inactive` (berhenti berlangganan, `inactive_at` + `inactive_reason`)
- **Status invoice:** `unpaid` | `paid` | (`overdue` = unpaid + due_date < today, dihitung on-the-fly)
- **Billing method:** `fixed` (tagihan tanggal 1, jatuh tempo `isolation_date`) | `rolling` (jatuh tempo +30 hari dari bayar)
- **Pencocokan telepon:** normalisasi strip `+`/`-`/spasi, cocokkan 9 digit terakhir (`slice(-9)`)
- **Settings:** key-value di tabel `settings`; cache 5 mnt; setelah simpan panggil `global.invalidateSettingsCache()` + `invalidateSystemCache()` (AI)
- **Uploads:** multer → `public/uploads/` (logo 2MB, gambar saja) & `public/uploads/proofs/` (5MB, jpg/png/webp/pdf)
- **Locale:** `res.locals.t` (id/en), ganti via `/set-lang/:lang`
- **Frontend:** EJS + vanilla JS, dark theme default, CSS var di `views/partials/head.ejs`, Font Awesome CDN, Leaflet+OSM untuk peta. **Tanpa build step.**
- **Response API:** konsisten `{ success: bool, message, ...data }`

---

## 8. ⚠️ Gotcha & Temuan (hati-hati saat oprek)

1. **`hioso_onus` di-full-replace tiap sync 5 menit** (DELETE + INSERT bulk, server.js:2009). Kolom `customer_id` (mapping manual ONU→pelanggan) **tidak ikut di-insert → hilang tiap sync**. Ada kemungkinan ini bug; cek dulu sebelum mengandalkan mapping tersebut.
2. **`billing.js api/generate-bulk` punya `break` saat `sentCount >= waLimit` di ATAS loop** → invoice berhenti dibuat setelah 50 WA terkirim. Versi cron di server.js tidak begini (invoice selalu dibuat, hanya WA dibatasi). **Inkonsisten — kemungkinan bug.**
3. **Logika isolir terduplikasi 4 tempat**: cron tengah malam (server.js), `/billing/api/run-isolir`, `/billing/api/:id/isolate`, `/customers/:id/isolate`. Logika rolling billing terduplikasi 3 tempat (lihat §5).
4. **Dua getSettings**: server.js punya versi cache-5-mnt (untuk `res.locals.settings`), `helpers/notification.js` punya versi query langsung. Jangan tertukar.
5. **File duplikat/backup** yang masih ada dan membingungkan: `routes/olt_default.js`, `routes/settings_default.js`, `routes/settings_edit1.js`, `views/billing_default.ejs`, `views/olt_default.ejs`, `views/technician_portal_deffault.ejs`, `views/technician_portal_edit1.ejs`, `views/fo_splice_default.ejs`, `views/ticket_detail_default.ejs`. **Tidak dipakai** — jangan diedit salah file!
6. **Session secret fallback** `'fallback_secret'` hardcode (server.js:40) — aman selama .env ada.
7. **Timezone hardcode `+07:00`** di pool MySQL dan WIB di beberapa cron/report.
8. **WhatsApp lokal butuh Google Chrome** terinstall (dicari di Program Files/system path) + folder `.wwebjs_auth` untuk sesi.
9. **OLT alert state anti-spam di memori** (`oltOfflineAlertState`) — reset saat restart server, bisa kirim notif ulang setelah restart.
10. **`wa-status` endpoint publik tanpa auth** (sengaja — QR hanya valid ±20 detik).
11. Script akar `check_cust.js`, `debug_db.js`, `migrate_olt.js`, `create_slr.js`/`create_slr_id.js` (~57KB masing-masing!) adalah script utilitas/one-off, bukan bagian runtime.
12. `install.sh` curl|bash dari GitHub — jangan dijalankan di mesin ini tanpa membaca.

---

## 10. 🛠 Log Perbaikan (audit 2026-09-17) — SUDAH DIPASANG

**Bug fungsional (A):**
1. ✅ **Mapping `customer_id` ONU dipertahankan saat sync** (server.js doOltSync) — sebelumnya hilang tiap 5 menit. Ditambah auto-map by PPPoE name (aktif jika ISP menamai ONU = username PPPoE).
2. ✅ **Generate-bulk invoice** (`routes/billing.js`) — wa_limit hanya membatasi WA, invoice tetap dibuat untuk semua pelanggan.
3. ✅ **Logika rolling billing & isolir dipusatkan** di `helpers/billing.js` (`markInvoicePaid`, `activateAfterPayment`, `applyRollingBilling`, `isolateCustomer`) — 3 jalur bayar + 4 jalur isolir kini memakai 1 sumber.
4. ✅ **Route webhook Xendit QRIS dibuat** (`POST /api/xendit/callback`) — sebelumnya tidak ada; verifikasi token, cek nominal, idempoten. Plus polling QR sekarang ikut menandai lunas sebagai fallback.
5. ✅ **Toggle pengaturan yang mati dihidupkan**: `auto_isolate_enabled`, `auto_billing_enabled`, `reminder_days_before` (reminder H-N sesuai setting), `late_tolerance_days` (toleransi sebelum isolir).

**Keamanan (B):**
6. ✅ `SESSION_SECRET` acak 32-byte dibuat & disimpan ke .env jika belum ada.
7. ✅ Portal: password default `1234` wajib diganti saat pertama login (`/portal/first-login`, min 6 karakter).
8. ✅ 9 file backup lama (`*_default.js/ejs`, `settings_edit1.js`) dipindah ke `archive/`.
9. ✅ `npm audit fix` + hapus dependensi `sequelize` (tidak pernah dipakai): 19 → 8 vulnerabilities. Sisa 8 butuh breaking change (node-cron 4, whatsapp-web.js) — ditunda sengaja.

**Stabilitas (C):**
10. ✅ Bot Telegram bisa dimatikan via `TG_BOT=0` di .env (dev copy sudah diset) — hapus konflik getUpdates antar instance.
11. ✅ Option mysql2 tidak valid (`acquireTimeout`, `idleTimeoutMillis`) dihapus dari pool config.
12. ✅ **Cron lock berbasis tabel `cron_locks`** — 7 cron tidak dobel saat 2 instance jalan (TTL kedaluwarsa otomatis).
13. ✅ **State anti-spam OLT alert pindah ke tabel `olt_alert_state`** — tahan restart, konsisten antar-instance.
14. ✅ Kolom `invoices.payment_ref` untuk referenceId payment gateway — `invoice_number` tidak lagi ditimpa.

**Tabel/kolom baru di DB:** `cron_locks`, `olt_alert_state`, `invoices.payment_ref`.

**Cara pakai perbaikan:** restart server (`taskkill //PID <pid> //F` lalu `node server.js`). Semua perubahan ada di copy workspace; copy kembali ke `D:\wamp64\www\billing_dino` untuk produksi.

---

## 9. Cara Menjalankan Copy Ini

```bash
cd billing_dino
npm install                # node_modules tidak ikut backup
node server.js             # http://localhost:3999
```
`.env` sudah ikut tersalin (DB yang sama dengan aplikasi asli) — ⚠️ **hati-hati: copy ini menyentuh database produksi yang sama**. Untuk oprek aman, pertimbangkan DB terpisah (duplikat dinodb.sql ke database baru + ubah DB_NAME di .env).
Login admin default: `admin` / `admin` (jika belum diganti di DB asli).
