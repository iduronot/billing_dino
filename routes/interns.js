const express = require('express');
const router  = express.Router();
let pool;
router.setPool = (p) => { pool = p; };

// Guard: hanya admin (route ini di-mount juga di /intern untuk siswa)
const adminGuard = (req, res, next) => {
    if (req.session.role !== 'admin') return res.status(403).json({ success:false, message:'Akses ditolak' });
    next();
};
// Guard: hanya siswa magang
const internGuard = (req, res, next) => {
    if (req.session.role !== 'intern' && req.session.role !== 'admin') {
        return res.status(403).json({ success:false, message:'Akses ditolak' });
    }
    next();
};

// ═════════════ ADMIN: KELOLA SISWA MAGANG ═════════════

// POST /interns/api — tambah siswa magang (buat akun user role=intern + profil)
router.post('/api', adminGuard, async (req, res) => {
    try {
        const { username, password, full_name, school, major, start_date, end_date, mentor } = req.body;
        if (!username || !password || !full_name) {
            return res.json({ success: false, message: 'Username, password, dan nama lengkap wajib diisi' });
        }
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(password, 10);

        // Buat akun user
        const [uResult] = await pool.query(
            'INSERT INTO users (username, password, role) VALUES (?,?,?)',
            [username, hashed, 'intern']);

        // Buat profil magang
        await pool.query(
            `INSERT INTO interns (user_id, full_name, school, major, start_date, end_date, mentor, status)
             VALUES (?,?,?,?,?,?,?, 'active')`,
            [uResult.insertId, full_name, school || null, major || null,
             start_date || null, end_date || null, mentor || null]);

        res.json({ success: true, message: 'Siswa magang berhasil ditambahkan' });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.json({ success: false, message: 'Username sudah dipakai' });
        }
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /interns/api/:id — edit profil magang
router.put('/api/:id', adminGuard, async (req, res) => {
    try {
        const { full_name, school, major, start_date, end_date, mentor, status, password } = req.body;
        await pool.query(
            `UPDATE interns SET full_name=?, school=?, major=?, start_date=?, end_date=?, mentor=?, status=?
             WHERE id=?`,
            [full_name, school || null, major || null, start_date || null,
             end_date || null, mentor || null, status || 'active', req.params.id]);

        // Reset password jika diisi
        if (password && password.trim()) {
            const bcrypt = require('bcryptjs');
            const hashed = await bcrypt.hash(password, 10);
            await pool.query(
                'UPDATE users u JOIN interns i ON i.user_id = u.id SET u.password=? WHERE i.id=?',
                [hashed, req.params.id]);
        }
        res.json({ success: true, message: 'Data magang diperbarui' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /interns/api/:id — hapus siswa magang + akunnya + datanya
router.delete('/api/:id', adminGuard, async (req, res) => {
    try {
        const [[intern]] = await pool.query('SELECT user_id FROM interns WHERE id=?', [req.params.id]);
        if (!intern) return res.json({ success: false, message: 'Data tidak ditemukan' });
        await pool.query('DELETE FROM logbooks WHERE user_id=?', [intern.user_id]);
        await pool.query('DELETE FROM attendances WHERE user_id=?', [intern.user_id]);
        await pool.query('DELETE FROM interns WHERE id=?', [req.params.id]);
        await pool.query('DELETE FROM users WHERE id=?', [intern.user_id]);
        res.json({ success: true, message: 'Siswa magang dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═════════════ ADMIN: REKAP LOGBOOK ═════════════

// GET /interns/logbook — rekap logbook semua/per siswa
router.get('/logbook', adminGuard, async (req, res) => {
    try {
        const userId = req.query.user_id || '';
        const month  = req.query.month || new Date(Date.now() + 7*3600e3).toISOString().slice(0,7);

        const [interns] = await pool.query(
            `SELECT i.id, i.user_id, i.full_name, i.school FROM interns i ORDER BY i.full_name ASC`);

        let logs = [];
        if (userId) {
            [logs] = await pool.query(
                `SELECT l.*, i.full_name, i.school
                 FROM logbooks l
                 JOIN interns i ON i.user_id = l.user_id
                 WHERE l.user_id = ? AND DATE_FORMAT(l.log_date,'%Y-%m') = ?
                 ORDER BY l.log_date DESC`, [userId, month]);
        } else {
            [logs] = await pool.query(
                `SELECT l.*, i.full_name, i.school
                 FROM logbooks l
                 JOIN interns i ON i.user_id = l.user_id
                 WHERE DATE_FORMAT(l.log_date,'%Y-%m') = ?
                 ORDER BY l.log_date DESC, i.full_name ASC`, [month]);
        }
        res.render('interns_logbook', {
            user: req.session, interns, logs, userId, month, currentPage: 'interns'
        });
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ═════════════ ADMIN: REKAP PRESENSI MAGANG ═════════════

// GET /interns/attendance — rekap presensi siswa magang
router.get('/attendance', adminGuard, async (req, res) => {
    try {
        const month = req.query.month || new Date(Date.now() + 7*3600e3).toISOString().slice(0,7);
        const [recap] = await pool.query(
            `SELECT i.full_name, i.school, ANY_VALUE(a.username) as username,
                    COUNT(*) as total_hadir,
                    SUM(a.status='hadir') as tepat_waktu,
                    SUM(a.status='terlambat') as terlambat
             FROM attendances a
             JOIN interns i ON i.user_id = a.user_id
             WHERE DATE_FORMAT(a.date,'%Y-%m')=? AND a.status != 'ditolak'
             GROUP BY i.user_id, i.full_name, i.school
             ORDER BY i.full_name ASC`, [month]);

        const [details] = await pool.query(
            `SELECT a.*, i.full_name FROM attendances a
             JOIN interns i ON i.user_id = a.user_id
             WHERE DATE_FORMAT(a.date,'%Y-%m')=?
             ORDER BY a.date DESC, i.full_name ASC`, [month]);

        const [months] = await pool.query(
            "SELECT DISTINCT DATE_FORMAT(date,'%Y-%m') as m FROM attendances a JOIN interns i ON i.user_id=a.user_id ORDER BY m DESC");

        res.render('interns_attendance', {
            user: req.session, month, months, recap, details, currentPage: 'interns'
        });
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ═════════════ ADMIN: SERTIFIKAT ═════════════

// GET /interns/certificate/:id — sertifikat siap cetak
router.get('/certificate/:id', adminGuard, async (req, res) => {
    try {
        const [[intern]] = await pool.query(
            `SELECT i.*, u.username FROM interns i JOIN users u ON u.id=i.user_id WHERE i.id=?`,
            [req.params.id]);
        if (!intern) return res.redirect('/interns?err=Siswa magang tidak ditemukan');

        // Statistik kehadiran selama periode
        const [[att]] = await pool.query(
            `SELECT COUNT(*) as total,
                    SUM(status='hadir') as hadir,
                    SUM(status='terlambat') as terlambat
             FROM attendances WHERE user_id=? AND status!='ditolak'`, [intern.user_id]);
        const [[{log_count}]] = await pool.query(
            'SELECT COUNT(*) as log_count FROM logbooks WHERE user_id=?', [intern.user_id]);

        const [settingsRows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name','company_logo','company_address','company_phone')");
        const settings = {};
        settingsRows.forEach(s => settings[s.setting_key] = s.setting_value);

        res.render('intern_certificate', {
            user: req.session, intern,
            att: att || {}, log_count: log_count || 0, settings,
            currentPage: 'interns'
        });
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ═════════════ SISWA: DASHBOARD MAGANG ═════════════

// GET / — root handler dipakai dua mount point:
//   /interns  (admin)   → daftar kelola siswa magang
//   /intern   (siswa)   → dashboard presensi + logbook
router.get('/', async (req, res) => {
    if (req.session.role === 'admin') return adminList(req, res);
    return internDashboard(req, res);
});

async function adminList(req, res) {
    try {
        const [interns] = await pool.query(`
            SELECT i.*, u.username, u.role
            FROM interns i
            JOIN users u ON u.id = i.user_id
            ORDER BY i.created_at DESC`);
        res.render('interns_manage', {
            user: req.session, interns, currentPage: 'interns',
            msg: req.query.msg || '', err: req.query.err || ''
        });
    } catch (e) { res.status(500).send('Error: ' + e.message); }
}

async function internDashboard(req, res) {
    try {
        const userId = req.session.userId;

        const [[intern]] = await pool.query(
            'SELECT * FROM interns WHERE user_id=?', [userId]);

        // Cek presensi hari ini
        const wibNow = new Date(Date.now() + 7*3600e3);
        const today  = wibNow.toISOString().split('T')[0];
        const [[todayAttendance]] = await pool.query(
            'SELECT * FROM attendances WHERE user_id=? AND date=?', [userId, today]);

        // Logbook bulan ini
        const month = wibNow.toISOString().slice(0,7);
        const [logs] = await pool.query(
            `SELECT * FROM logbooks WHERE user_id=? AND DATE_FORMAT(log_date,'%Y-%m')=?
             ORDER BY log_date DESC`, [userId, month]);

        // Sudah isi logbook hari ini?
        const [[todayLog]] = await pool.query(
            'SELECT * FROM logbooks WHERE user_id=? AND log_date=?', [userId, today]);

        // Statistik
        const [[attStats]] = await pool.query(
            `SELECT COUNT(*) as total, SUM(status='hadir') as hadir, SUM(status='terlambat') as terlambat
             FROM attendances WHERE user_id=? AND status!='ditolak'`, [userId]);
        const [[{logTotal}]] = await pool.query(
            'SELECT COUNT(*) as logTotal FROM logbooks WHERE user_id=?', [userId]);

        // Setting presensi
        const [cfgRows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('map_center_lat','map_center_lng','attendance_radius','attendance_late_time')");
        const cfg = {};
        cfgRows.forEach(s => cfg[s.setting_key] = s.setting_value);

        res.render('intern_dashboard', {
            user: req.session, intern: intern || {},
            today, month, todayAttendance, todayLog, logs,
            attStats: attStats || {}, logTotal: logTotal || 0,
            cfg, currentPage: 'intern'
        });
    } catch (e) { res.status(500).send('Error: ' + e.message); }
}

// POST /intern/api/logbook — simpan logbook hari ini (1x per hari, upsert)
router.post('/api/logbook', internGuard, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { activities, problems, log_date } = req.body;
        if (!activities || !activities.trim()) {
            return res.json({ success: false, message: 'Kegiatan wajib diisi' });
        }
        const date = log_date || new Date(Date.now() + 7*3600e3).toISOString().split('T')[0];

        await pool.query(
            `INSERT INTO logbooks (user_id, log_date, activities, problems)
             VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE activities=VALUES(activities), problems=VALUES(problems)`,
            [userId, date, activities.trim(), (problems || '').trim() || null]);

        res.json({ success: true, message: 'Logbook tersimpan' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /intern/api/logbook/:id — siswa hapus entry-nya sendiri
router.delete('/api/logbook/:id', internGuard, async (req, res) => {
    try {
        await pool.query('DELETE FROM logbooks WHERE id=? AND user_id=?',
            [req.params.id, req.session.userId]);
        res.json({ success: true, message: 'Logbook dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
