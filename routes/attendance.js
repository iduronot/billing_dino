const express = require('express');
const router  = express.Router();
let pool;
router.setPool = (p) => { pool = p; };

// Hitung jarak dua koordinat (Haversine formula) — return meter
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── GET /attendance — halaman presensi teknisi ──
router.get('/', async (req, res) => {
    try {
        const userId  = req.session.userId;
        // Gunakan WIB (UTC+7) untuk tanggal hari ini
        const wibNow  = new Date(Date.now() + 7*60*60*1000);
        const today   = wibNow.toISOString().split('T')[0];
        const month   = req.query.month || wibNow.toISOString().slice(0,7);

        // Cek sudah presensi hari ini?
        const [[todayRecord]] = await pool.query(
            'SELECT * FROM attendances WHERE user_id=? AND date=?', [userId, today]);

        // Riwayat bulan ini
        const [history] = await pool.query(
            `SELECT * FROM attendances WHERE user_id=? AND DATE_FORMAT(date,'%Y-%m')=?
             ORDER BY date DESC`, [userId, month]);

        // Stats bulan ini
        const [[stats]] = await pool.query(`
            SELECT COUNT(*) as total,
                   SUM(status='hadir') as hadir,
                   SUM(status='terlambat') as terlambat,
                   SUM(status='ditolak') as ditolak
            FROM attendances WHERE user_id=? AND DATE_FORMAT(date,'%Y-%m')=?`,
            [userId, month]);

        // Ambil setting titik pusat
        const [settings] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('map_center_lat','map_center_lng','attendance_radius','attendance_late_time')");
        const cfg = {};
        settings.forEach(s => cfg[s.setting_key] = s.setting_value);

        res.render('attendance', {
            user: req.session, todayRecord, history, stats: stats||{},
            cfg, today, month, currentPage: 'attendance'
        });
    } catch(err) { res.status(500).send("Error: "+err.message); }
});

// ── POST /attendance/api/checkin — presensi masuk ──
router.post('/api/checkin', async (req, res) => {
    try {
        const userId  = req.session.userId;
        const username= req.session.username;
        const today   = new Date().toISOString().split('T')[0];
        const { lat, lng, device_info } = req.body;

        // Cek sudah presensi?
        const [[existing]] = await pool.query(
            'SELECT id FROM attendances WHERE user_id=? AND date=?', [userId, today]);
        if (existing) return res.json({ success:false, message:'Anda sudah melakukan presensi hari ini' });

        // Ambil titik pusat & radius
        const [settings] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('map_center_lat','map_center_lng','attendance_radius','attendance_late_time')");
        const cfg = {};
        settings.forEach(s => cfg[s.setting_key] = s.setting_value);

        const centerLat = parseFloat(cfg.map_center_lat);
        const centerLng = parseFloat(cfg.map_center_lng);
        const maxRadius = parseFloat(cfg.attendance_radius) || 100;
        const lateTime  = cfg.attendance_late_time || '08:30';

        if (!centerLat || !centerLng) {
            return res.json({ success:false, message:'Titik pusat presensi belum diatur di Pengaturan → Koordinat Peta' });
        }

        // Hitung jarak
        const distance = haversine(parseFloat(lat), parseFloat(lng), centerLat, centerLng);
        const distM    = Math.round(distance);

        if (distM > maxRadius) {
            return res.json({
                success: false,
                rejected: true,
                distance: distM,
                message: `Presensi ditolak ❌ — Jarak Anda ${distM}m dari titik presensi (maks. ${maxRadius}m)`
            });
        }

        // Tentukan status: hadir/terlambat — gunakan jam WIB
        const now      = new Date(Date.now() + 7*60*60*1000);
        const nowTime  = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
        const status   = nowTime > lateTime ? 'terlambat' : 'hadir';

        await pool.query(
            'INSERT INTO attendances (user_id,username,date,check_in_time,lat,lng,distance_m,status,device_info) VALUES (?,?,?,CONVERT_TZ(NOW(),"+00:00","+07:00"),?,?,?,?,?)',
            [userId, username, today, lat, lng, distM, status, device_info||null]
        );

        const statusLabel = status === 'terlambat' ? '🟡 Terlambat' : '✅ Hadir';
        res.json({
            success: true,
            status,
            distance: distM,
            time: now.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'}),
            message: `${statusLabel} — Presensi berhasil! Jarak ${distM}m dari kantor`
        });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── GET /attendance/report — rekap admin ──
router.get('/report', async (req, res) => {
    try {
        const month = req.query.month || new Date().toISOString().slice(0,7);

        // Semua teknisi
        const [technicians] = await pool.query(
            "SELECT id, username FROM users WHERE role='technician' ORDER BY username ASC");

        // Rekap per teknisi per bulan
        const [recap] = await pool.query(`
            SELECT a.user_id, ANY_VALUE(a.username) as username,
                   COUNT(*) as total_hadir,
                   SUM(a.status='hadir') as tepat_waktu,
                   SUM(a.status='terlambat') as terlambat,
                   MIN(a.check_in_time) as earliest,
                   MAX(a.check_in_time) as latest,
                   AVG(a.distance_m) as avg_distance
            FROM attendances a
            WHERE DATE_FORMAT(a.date,'%Y-%m')=? AND a.status != 'ditolak'
            GROUP BY a.user_id ORDER BY ANY_VALUE(a.username) ASC`, [month]);

        // Detail presensi semua teknisi bulan ini
        const [details] = await pool.query(`
            SELECT a.*, u.username FROM attendances a
            JOIN users u ON u.id=a.user_id
            WHERE DATE_FORMAT(a.date,'%Y-%m')=?
            ORDER BY a.date DESC, a.username ASC`, [month]);

        // Hitung hari kerja di bulan ini (Senin-Sabtu)
        const [yr, mn] = month.split('-').map(Number);
        const daysInMonth = new Date(yr, mn, 0).getDate();
        let workDays = 0;
        for (let d = 1; d <= daysInMonth; d++) {
            const dow = new Date(yr, mn-1, d).getDay();
            if (dow !== 0) workDays++; // kecuali Minggu
        }

        // Trend harian bulan ini
        const [dailyTrend] = await pool.query(`
            SELECT date, COUNT(*) as count,
                   SUM(status='hadir') as hadir,
                   SUM(status='terlambat') as terlambat
            FROM attendances WHERE DATE_FORMAT(date,'%Y-%m')=? AND status!='ditolak'
            GROUP BY date ORDER BY date ASC`, [month]);

        // Daftar bulan tersedia
        const [months] = await pool.query(
            "SELECT DISTINCT DATE_FORMAT(date,'%Y-%m') as month FROM attendances ORDER BY month DESC");

        res.render('attendance_report', {
            user: req.session, month, months, recap, details,
            technicians, workDays, dailyTrend,
            currentPage: 'attendance'
        });
    } catch(err) { res.status(500).send("Error: "+err.message); }
});

// ── DELETE /attendance/api/:id — hapus presensi (admin) ──
router.delete('/api/:id', async (req, res) => {
    try {
        if (req.session.role !== 'admin') return res.status(403).json({ success:false, message:'Akses ditolak' });
        await pool.query('DELETE FROM attendances WHERE id=?', [req.params.id]);
        res.json({ success:true, message:'Data presensi dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
