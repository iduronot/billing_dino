# 🦖 Dino-Bill — ISP Management System

Sistem manajemen billing dan operasional ISP (Internet Service Provider) berbasis **Node.js + Express + MySQL**. Dirancang untuk berjalan **autopilot penuh** — dari pembuatan invoice, isolir otomatis, hingga notifikasi WhatsApp — semua berjalan tanpa campur tangan manual.

---

## 📋 Daftar Isi

- [Fitur Lengkap](#-fitur-lengkap)
- [Persyaratan Sistem](#-persyaratan-sistem)
- [Instalasi Cepat](#-instalasi-cepat)
- [Instalasi Manual](#-instalasi-manual)
- [Konfigurasi Awal](#-konfigurasi-awal)
- [Alur Pembayaran Xendit QRIS](#-alur-pembayaran-xendit-qris)
- [Cron Job Otomatis](#-cron-job-otomatis)
- [Teknologi](#-teknologi)
- [Support](#-support)

---

## ✨ Fitur Lengkap

### 1. 👥 Manajemen Pelanggan
- Data lengkap pelanggan: nama, telepon, alamat, email, koordinat GPS
- Integrasi PPPoE MikroTik: tambah, hapus, aktif, nonaktif langsung dari dashboard
- Pilih paket layanan & router yang digunakan
- Tanggal isolir per pelanggan dapat dikustomisasi
- Filter pelanggan: aktif, terisolir, menunggak
- Import pelanggan massal via CSV
- Export data pelanggan ke CSV
- Tampilan peta sebaran pelanggan (Leaflet.js)
- Assign teknisi per pelanggan untuk instalasi baru
- Status instalasi: pending / selesai

### 2. 🗓 Billing & Invoice
- Generate invoice otomatis setiap bulan (berjalan tengah malam tanggal 1)
- Generate invoice manual untuk satu atau banyak pelanggan sekaligus
- Filter invoice: status (unpaid/paid/overdue), rentang tanggal, nama pelanggan
- Catat pembayaran manual (cash/transfer)
- Tunda (defer) invoice tanpa menghapus tagihan
- Cetak invoice (template siap print)
- Export invoice ke CSV
- Statistik pendapatan bulanan
- Riwayat pembayaran per pelanggan

### 3. ⚡ Payment Gateway

#### Xendit QRIS (Utama)
- Buat QR Code dinamis per invoice langsung dari portal pelanggan
- QR Code tampil sebagai gambar (scan via aplikasi bank/e-wallet manapun)
- Polling status pembayaran otomatis setiap 5 detik
- Webhook callback: setelah bayar → invoice lunas → PPPoE aktif → notif WA dikirim
- Verifikasi `x-callback-token` dari Xendit untuk keamanan

#### Transfer Manual / Cash
- Data rekening bank ditampilkan otomatis di portal pelanggan
- Admin catat pembayaran secara manual dari dashboard

#### Tripay (Opsional)
- Integrasi Tripay untuk QRIS, Virtual Account, dan E-Wallet
- Pilih channel pembayaran aktif dari dashboard
- Callback webhook dengan verifikasi HMAC-SHA256
- Mode sandbox & production

### 4. 🔌 Integrasi MikroTik (RouterOS API)
- Kelola beberapa router MikroTik sekaligus
- Tambah, edit, hapus konfigurasi router
- Test koneksi ke router langsung dari dashboard
- Lihat daftar PPPoE active sessions secara real-time
- Sync PPPoE secrets dari MikroTik ke database
- Fetch daftar PPP Profile dari MikroTik untuk assign ke paket
- Auto disable/enable PPPoE saat isolir/reaktivasi
- Monitoring traffic per router
- Tampilkan active PPPoE yang belum terhubung ke data pelanggan

### 5. 📡 Manajemen OLT (Optical Line Terminal)
- Multi-brand OLT via SNMP: **HIOSO C, HIOSO B, HIOSO GPON, HIOSO HA73, ZTE, HSGQ, HSGQ GPON, Huawei**
- Auto-detect tipe/brand OLT saat pertama kali sync
- Sync daftar ONU otomatis setiap 5 menit (round-robin per OLT)
- Data ONU: status online/offline, RX power, TX power, MAC address, ONU index
- VLAN management per ONU
- Reboot ONU dari dashboard
- SNMP walk discovery untuk temukan OLT baru di jaringan
- Tambah, edit, hapus konfigurasi OLT
- Test koneksi SNMP ke OLT

### 6. 🌐 Integrasi GenieACS (ONT/CPE Management via TR-069)
- Sync perangkat dari GenieACS server otomatis setiap 5 menit
- Tampilkan status online/offline berdasarkan waktu `last_inform`
- Lihat IP WAN, serial number, manufacturer, PPPoE username tiap perangkat
- Fetch SSID & Password WiFi real-time dari GenieACS
- Ubah SSID & Password WiFi langsung dari portal pelanggan atau portal teknisi
- Reboot ONT dari dashboard admin
- Factory reset ONT dari dashboard admin
- Hapus device dari tracking ACS
- Konfigurasi path virtual parameters (PPPoE, IP WAN, dll) dari Settings
- Dukungan autentikasi HTTP Basic ke GenieACS

### 7. 🗺 Peta Infrastruktur
- Peta interaktif (Leaflet.js + OpenStreetMap)
- Tampilkan objek infrastruktur: Server, ODP, dan titik kustom lainnya
- Gambar jalur kabel pada peta dengan warna yang dapat dipilih
- Tambah, edit, hapus objek dan kabel dari peta
- Koordinat pusat peta & zoom default dapat dikustomisasi dari Settings
- Ambil koordinat GPS perangkat sebagai pusat peta

### 8. 🔶 Manajemen Infrastruktur Fiber Optik (FO)
- Kelola node FO: ODP, ODC, OLT, Splitter, Tiang, Pondasi, Closure
- Kelola kabel FO antar node dengan koordinat jalur
- Manajemen tube dalam kabel (nomor tube, warna, jumlah core)
- Manajemen core dalam tube (nomor core, warna, status: tersedia/terpakai/rusak)
- Assignment core ke node (many-to-many)
- Manajemen splice point per kabel
- Inventaris aset FO: kabel, splitter, ODP box, closure, konektor, dll
- Peta visual infrastruktur FO

### 9. 🎫 Tiket Gangguan (Trouble Ticket)
- Buat tiket dari admin, portal pelanggan, atau portal teknisi
- Priority: low, normal, high, urgent
- Status: open, in_progress, closed
- Kategori tiket (gangguan, instalasi, request, dll)
- Assign tiket ke satu atau banyak teknisi (many-to-many)
- Riwayat komentar & update per tiket
- Komentar internal (tidak terlihat pelanggan)
- Lokasi gangguan dengan koordinat GPS
- Close & reopen tiket
- Laporan tiket: jumlah per status, resolve rate, rata-rata waktu penyelesaian

### 10. 🛠 Portal Teknisi
- Dashboard tiket terbuka yang ditugaskan ke teknisi yang login
- Antrian instalasi baru (pelanggan berstatus instalasi pending)
- Ambil info WiFi real-time (SSID/Password) dari GenieACS langsung di lapangan
- Cek sinyal ONU real-time (RX/TX power) dari OLT
- Mark instalasi selesai dari portal
- Tampilan peta lokasi pelanggan
- Check-in presensi berbasis GPS

### 11. 📊 Portal Sales
- Dashboard khusus tim sales
- Kelola prospek / lead pelanggan baru
- Tracking komisi dan balance

### 12. 🌐 Portal Pelanggan (Self-Service)
- Login menggunakan username PPPoE atau nomor telepon
- Password default `1234`, bisa diganti sendiri kapan saja
- Lihat semua tagihan dan riwayat pembayaran (10 invoice terakhir)
- Bayar tagihan via Xendit QRIS langsung dari portal
- Lihat jumlah dan total tagihan belum lunas
- Buat laporan gangguan / trouble ticket sendiri
- Lihat riwayat tiket yang pernah dibuat
- Lihat dan ubah nama WiFi (SSID) & password WiFi (via GenieACS)
- Update nomor telepon & email profil
- Ganti password portal

### 13. 💬 Notifikasi WhatsApp
- **Provider lokal**: whatsapp-web.js (scan QR, gratis, butuh Google Chrome)
- **Provider eksternal**: Fonnte, MPWA, Wablas (API berbayar, lebih stabil untuk skala besar)
- Notifikasi otomatis yang dikirim:
  - Invoice baru diterbitkan (beserta nominal dan jatuh tempo)
  - Pengingat jatuh tempo (H-3 atau sesuai konfigurasi)
  - Peringatan layanan diisolir
  - Konfirmasi pembayaran diterima
  - Notifikasi teknisi: ada penugasan pelanggan baru
- Laporan harian otomatis ke admin (jumlah pelanggan, pendapatan bulan ini, tiket aktif)
- Rate limiting & delay antar pesan (untuk bulk send, hindari ban)
- Manager percakapan WhatsApp: lihat & balas chat dari dashboard
- Riwayat pesan tersimpan di database
- Test kirim pesan dari Settings
- Restart koneksi WhatsApp dari Settings tanpa restart server
- Status koneksi WhatsApp real-time: QR Code, Connecting, Ready
- Template semua pesan dapat dikustomisasi dari Settings

### 14. ✈️ Notifikasi Telegram
- Integrasi Telegram Bot
- Laporan harian otomatis dikirim ke group/channel Telegram admin
- Test kirim pesan dari Settings

### 15. 🎮 Hotspot & Voucher WiFi
- Manajemen hotspot user di MikroTik
- Tambah dan hapus hotspot profile
- Generate voucher WiFi otomatis (kode acak, harga, profile)
- Cetak voucher dalam batch (template siap print)
- Hapus voucher yang sudah terpakai sekaligus (bulk cleanup)
- Lihat status voucher: unused / used

### 16. 📦 Manajemen Inventaris
- Stok perangkat dan material (ONT, kabel, splitter, router, dll)
- Kategori dan satuan unit (pcs, meter, roll, dll)
- Tambah, edit, hapus item stok

### 17. 💰 Pencatatan Pengeluaran
- Catat pengeluaran operasional ISP harian
- Kategori pengeluaran dengan warna & ikon kustom (Operasional, Internet Upstream, Equipment, dll)
- Tambah, edit, hapus kategori pengeluaran
- Filter pengeluaran per kategori dan rentang tanggal
- Ringkasan pengeluaran per kategori

### 18. 📍 Presensi Teknisi
- Form check-in berbasis GPS dari portal teknisi
- Validasi radius: presensi ditolak jika jarak melebihi batas dari titik kantor
- Batas jam tepat waktu dapat dikonfigurasi (contoh: 08:30, setelahnya = terlambat)
- Laporan presensi per user per periode (tepat waktu / terlambat)
- Admin dapat hapus data presensi

### 19. 🔧 Pengaturan Sistem
- **Profil Perusahaan**: nama ISP, telepon, alamat, email, website, timezone, mata uang
- **Billing**: prefix nomor invoice, tanggal generate otomatis, hari jatuh tempo default, toleransi keterlambatan
- **Otomasi**: toggle auto-billing, toggle auto-isolir, hari kirim reminder sebelum jatuh tempo
- **WhatsApp**: pilih provider, API URL, API key, nomor pengirim, delay antar pesan, limit batch, nomor admin
- **Template Pesan WA**: kustomisasi teks untuk invoice baru, payment received, isolir, reminder (variabel: `{name}`, `{amount}`, `{due_date}`, `{company}`)
- **Telegram**: bot token, admin chat ID
- **Payment Gateway**: pilih gateway default, konfigurasi Xendit (API key, webhook token, callback URL), konfigurasi Tripay (API key, private key, merchant code, mode, channel), data rekening bank manual
- **GenieACS**: URL ACS, username, password, path virtual parameters (PPPoE, IP WAN, custom params)
- **Peta**: koordinat pusat, zoom default, mini preview map interaktif, ambil lokasi GPS
- **Presensi**: radius maksimal check-in (meter), jam batas tepat waktu
- **Manajemen User**: tambah/edit/hapus user admin, teknisi, sales; set role, nomor HP, Telegram ID
- **Import/Export**: export pelanggan & invoice ke CSV, import pelanggan massal dari CSV
- **Git Repository**: konfigurasi URL repo & branch untuk update sistem
- **Update Sistem**: update dari GitHub langsung via tombol di dashboard (git pull)
- **Multi-bahasa**: Indonesia & English (dapat diganti dari topbar)

### 20. 🔐 Keamanan & Akses
- Role-based access control: **Admin** (akses penuh), **Teknisi** (portal teknisi), **Sales** (portal sales)
- Password hashing dengan bcrypt (salt round 10)
- Session management dengan express-session
- Middleware autentikasi per route group
- Verifikasi webhook Xendit via `x-callback-token` header
- Verifikasi webhook Tripay via HMAC-SHA256 signature
- Web Installer mode: jika `.env` belum ada, semua route dialihkan ke halaman setup

---

## 🔧 Persyaratan Sistem

| Komponen | Minimum | Rekomendasi |
|---|---|---|
| OS | Ubuntu 20.04 / Debian 11 | Ubuntu 22.04 LTS |
| CPU | 1 core | 2 core |
| RAM | 1 GB | 2 GB (jika pakai WA lokal) |
| Storage | 5 GB | 10 GB |
| Node.js | v18+ | v20 LTS |
| Database | MySQL 8.0 / MariaDB 10.6 | MySQL 8.0 |
| Port | 3999 | 3999 |

---

## 🚀 Instalasi Cepat (Ubuntu/Debian)

Jalankan satu perintah ini di terminal server sebagai root:

```bash
curl -sSL https://raw.githubusercontent.com/ittosolution-png/Dino-Bill/main/install.sh | sudo bash
```

Setelah selesai, buka browser dan akses:
```
http://IP-SERVER:3999
```

Web Installer akan memandu mengisi koneksi database dan membuat akun admin pertama.

---

## 🛠 Instalasi Manual

```bash
# 1. Clone repository
git clone https://github.com/ittosolution-png/Dino-Bill.git /opt/dino-bill
cd /opt/dino-bill

# 2. Install dependensi (skip download Chromium bawaan Puppeteer)
PUPPETEER_SKIP_DOWNLOAD=true npm install

# 3. Jalankan — Web Installer aktif otomatis jika .env belum ada
node server.js

# 4. Atau jalankan dengan PM2 untuk production
pm2 start server.js --name dino-bill
pm2 save && pm2 startup
```

---

## ⚙️ Konfigurasi Awal

### 1. Login Admin
- URL: `http://IP-SERVER:3999`
- Username: `admin` | Password: `admin`
- **Ganti password segera setelah login pertama**

### 2. Profil Perusahaan
**Pengaturan → Perusahaan** → isi nama ISP, telepon, alamat, timezone.

### 3. Xendit QRIS (Payment Gateway)
**Pengaturan → Payment → Xendit QRIS:**
1. Isi **API Key** — ambil dari Xendit Dashboard → Settings → API Keys (gunakan Secret Key)
2. Isi **Webhook Token** — ambil dari Xendit Dashboard → Settings → Webhooks → Callback Token
3. Salin **Callback URL** yang tampil → daftarkan ke Xendit Dashboard → Webhooks → QR Code
4. Klik **Test Koneksi Xendit** untuk verifikasi
5. Set **Default Gateway** ke `Xendit QRIS` → Simpan

### 4. WhatsApp
**Pengaturan → WhatsApp** → pilih provider:
- **Local** — klik Restart, scan QR Code yang muncul dengan HP, gratis
- **Fonnte / MPWA / Wablas** — isi API URL + API Key dari dashboard provider

### 5. MikroTik
**Router** → Tambah Router → isi nama, IP address, username, password API (port default 8728).

### 6. OLT
**OLT** → Tambah OLT → isi nama, host/IP, port SNMP (default 161), community string, pilih brand.

### 7. GenieACS
**Pengaturan → GenieACS** → isi URL ACS (`http://IP:7557`), username, password, path virtual parameter.

---

## ⚡ Alur Pembayaran Xendit QRIS

```
Pelanggan buka Portal → klik "Bayar dengan QRIS"
            ↓
POST /portal/pay/:invoiceId
            ↓
Dino-Bill request ke Xendit API → buat QR Code dinamis (24 jam)
            ↓
QR Code tampil di modal (gambar + countdown waktu kedaluwarsa)
            ↓
Polling otomatis setiap 5 detik ke /portal/qr-status/:referenceId
            ↓
Pelanggan scan QR via aplikasi bank / e-wallet manapun
            ↓
Xendit kirim webhook → POST /api/xendit/callback
            ↓
Server verifikasi x-callback-token → proses pembayaran
            ↓
Invoice ditandai "paid" → PPPoE di-enable di MikroTik
            ↓
Notifikasi WhatsApp "Pembayaran Diterima" dikirim ke pelanggan
            ↓
Portal pelanggan otomatis tampilkan layar sukses ✅
```

---

## ⏰ Cron Job Otomatis

| Jadwal | Fungsi |
|---|---|
| Setiap hari pukul 00:00 | **Auto-Isolir**: cari invoice overdue → set status isolated → disable PPPoE MikroTik → kirim notif WA |
| Setiap hari pukul 08:00 | **Reminder Tagihan**: kirim WA ke pelanggan yang jatuh tempo H-3 (atau sesuai setting) |
| Setiap hari pukul 08:30 | **Laporan Harian**: ringkasan statistik ISP dikirim ke admin via WA & Telegram |
| Tanggal 1 setiap bulan pukul 06:00 | **Generate Invoice**: buat invoice bulanan untuk semua pelanggan aktif + kirim notif WA |
| Setiap 5 menit | **Sync OLT**: update status & sinyal ONU dari semua OLT via SNMP (round-robin) |
| Setiap 5 menit | **Sync GenieACS**: update status online/offline device dari ACS server |

> Auto-isolir dan auto-billing dapat dimatikan dari **Pengaturan → Billing**.

---

## 🏗 Teknologi

| Komponen | Teknologi |
|---|---|
| Backend | Node.js + Express.js |
| Database | MySQL 8 via mysql2/promise (connection pool) |
| Template Engine | EJS |
| Session | express-session |
| Scheduler | node-cron |
| MikroTik API | routeros-api |
| OLT SNMP | net-snmp |
| WhatsApp | whatsapp-web.js + Puppeteer / Google Chrome |
| Payment | Xendit QRIS API + Tripay API |
| Notifikasi | WhatsApp (lokal/API) + Telegram Bot API |
| Peta | Leaflet.js + OpenStreetMap |
| QR Code | qrcode |
| Password | bcryptjs |
| Git Update | simple-git |
| HTTP Client | axios |
| Environment | dotenv |

---

## 💬 Support & Komunitas

- **Grup Telegram**: [t.me/dinosupports](https://t.me/dinosupports)
- **Bug Report / Feature Request**: buka Issue di repository GitHub

---

## 📄 Lisensi

MIT License — Bebas digunakan, dimodifikasi, dan dikembangkan untuk kebutuhan ISP lokal.
