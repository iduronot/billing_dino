const express = require('express');
const router = express.Router();
const { sendWhatsApp, sendTelegram } = require('../helpers/notification');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

let pool;
router.setPool = (dbPool) => { pool = dbPool; };

// ── Multer storage config ──
const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Nama file tetap (company_logo / company_icon) agar selalu overwrite yang lama
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, req.params.type + ext);
    }
});
const uploadFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan JPG, PNG, SVG, atau ICO'), false);
};
const upload = multer({ storage: uploadStorage, fileFilter: uploadFilter, limits: { fileSize: 2 * 1024 * 1024 } });

// POST /settings/api/upload/:type  (type = company_logo | company_icon)
router.post('/api/upload/:type', upload.single('file'), async (req, res) => {
    try {
        const type = req.params.type;
        if (!['company_logo', 'company_icon', 'qris_image'].includes(type))
            return res.status(400).json({ success: false, message: 'Tipe tidak valid' });
        if (!req.file)
            return res.status(400).json({ success: false, message: 'File tidak ditemukan' });

        const filePath = '/uploads/' + req.file.filename;
        await pool.query(
            'INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
            [type, filePath, filePath]
        );
        if (global.invalidateSettingsCache) global.invalidateSettingsCache();
        res.json({ success: true, path: filePath });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE /settings/api/upload/:type
router.delete('/api/upload/:type', async (req, res) => {
    try {
        const type = req.params.type;
        if (!['company_logo', 'company_icon', 'qris_image'].includes(type))
            return res.status(400).json({ success: false, message: 'Tipe tidak valid' });

        const [[row]] = await pool.query('SELECT setting_value FROM settings WHERE setting_key=?', [type]);
        if (row && row.setting_value) {
            const filePath = path.join(__dirname, '..', 'public', row.setting_value);
            fs.unlink(filePath, () => {});
        }
        await pool.query('DELETE FROM settings WHERE setting_key=?', [type]);
        if (global.invalidateSettingsCache) global.invalidateSettingsCache();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM settings');
        const settings = {};
        rows.forEach(s => settings[s.setting_key] = s.setting_value);
        const { getStatus } = require('../helpers/whatsapp');
        const waStatusInit = getStatus();
        res.render('settings', { user: req.session, settings, currentPage: 'settings', waStatusInit });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.get('/whatsapp-status', async (req, res) => {
    const { getStatus } = require('../helpers/whatsapp');
    const s = getStatus();
    console.log('[WA-STATUS] status:', s.status, '| qr:', s.qr ? s.qr.substring(0,30)+'...('+s.qr.length+' chars)' : 'NULL');
    res.json(s);
});

router.post('/whatsapp-restart', async (req, res) => {
    const { restartWhatsApp } = require('../helpers/whatsapp');
    restartWhatsApp(pool).catch(e => console.error('[WA-RESTART] Error:', e.message));
    res.json({ success: true, message: 'Proses inisialisasi ulang WhatsApp dimulai...' });
});

router.post('/api/save', async (req, res) => {
    try {
        const entries = req.body;
        for (const [key, value] of Object.entries(entries)) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        // Invalidate settings cache agar halaman berikutnya baca data terbaru
        if (global.invalidateSettingsCache) global.invalidateSettingsCache();
        res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-wa', async (req, res) => {
    const { phone, message } = req.body;
    try {
        const result = await sendWhatsApp(pool, phone, message || 'Test dari Dino-Bill ✅');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-telegram', async (req, res) => {
    const { message } = req.body;
    try {
        const result = await sendTelegram(pool, message || '✅ Test Telegram dari Dino-Bill');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test-acs', async (req, res) => {
    const { url } = req.body;
    try {
        const axios = require('axios');
        const response = await axios.get(`${url}/devices`, { timeout: 4000 });
        res.json({ success: true, message: `Berhasil! Terhubung ke GenieACS. HTTP ${response.status}` });
    } catch (e) {
        res.json({ success: false, message: `Gagal terhubung ke ACS: ${e.message}` });
    }
});



router.post('/api/test-tripay', async (req, res) => {
    try {
        const tripay = require('../helpers/tripay');
        const channels = await tripay.getPaymentChannels(pool);
        if (channels.success) {
            const names = channels.data.slice(0, 5).map(c => c.name).join(', ');
            res.json({ success: true, message: `Berhasil! ${channels.data.length} channel tersedia: ${names}...`, channels: channels.data });
        } else {
            res.json({ success: false, message: channels.message });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/api/test-xendit', async (req, res) => {
    try {
        const xendit = require('../helpers/xendit');
        const result = await xendit.testConnection(pool);
        res.json(result);
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/api/test-olt-alert', async (req, res) => {
    try {
        // Ambil konfigurasi telegram
        const [cfgRows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('telegram_bot_token','monitor_telegram_chat','telegram_chat_id','olt_offline_threshold','olt_offline_threshold_global')"
        );
        const s = {};
        cfgRows.forEach(r => { s[r.setting_key] = r.setting_value; });

        const token   = s.telegram_bot_token;
        const chat_id = s.monitor_telegram_chat || s.telegram_chat_id;
        const threshold       = parseInt(s.olt_offline_threshold || '100', 10);
        const thresholdGlobal = parseInt(s.olt_offline_threshold_global || '0', 10);

        if (!token || !chat_id) {
            return res.json({ success: false, message: 'Token bot atau Chat ID belum dikonfigurasi di pengaturan Telegram.' });
        }

        // Ambil statistik OLT terkini
        const [oltRows] = await pool.query(`
            SELECT o.name AS olt_name,
                   COUNT(*) AS total,
                   COALESCE(SUM(u.status = 'Up'), 0) AS online,
                   COALESCE(SUM(u.status = 'Down'), 0) AS offline
            FROM hioso_onus u
            JOIN hioso_olts o ON u.olt_id = o.id
            GROUP BY o.id, o.name
            ORDER BY o.name ASC
        `);

        const totalDown   = oltRows.reduce((a, r) => a + parseInt(r.offline, 10), 0);
        const totalOnline = oltRows.reduce((a, r) => a + parseInt(r.online, 10), 0);
        const totalAll    = oltRows.reduce((a, r) => a + parseInt(r.total, 10), 0);

        let lines = ['🔔 <b>[TEST] Notifikasi OLT Alert</b>', ''];
        lines.push(`📊 Rekap saat ini:`);
        oltRows.forEach(r => {
            const down = parseInt(r.offline, 10);
            const icon = down >= threshold ? '🔴' : '🟢';
            lines.push(`${icon} <b>${r.olt_name}</b>: ${r.online} online, ${down} offline / ${r.total} total`);
        });
        lines.push('');
        lines.push(`🌐 Total Global: ${totalOnline} online, ${totalDown} offline / ${totalAll} total`);
        lines.push('');
        lines.push(`⚙️ Threshold per-OLT: <b>${threshold}</b> offline`);
        lines.push(`⚙️ Threshold global: <b>${thresholdGlobal > 0 ? thresholdGlobal : 'Nonaktif'}</b>`);
        lines.push('');
        lines.push('✅ Ini adalah pesan uji coba — notifikasi real dikirim otomatis saat threshold terlampaui.');

        const axios = require('axios');
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id,
            text: lines.join('\n'),
            parse_mode: 'HTML'
        });

        res.json({ success: true, message: `Pesan test berhasil dikirim ke chat ID ${chat_id}` });
    } catch (e) {
        const errMsg = e.response?.data?.description || e.message;
        res.json({ success: false, message: `Gagal kirim: ${errMsg}` });
    }
});

// POST - Test OLT Alert via WhatsApp ke semua admin & teknisi
router.post('/api/test-olt-alert-wa', async (req, res) => {
    try {
        const { sendLocalWhatsApp } = require('../helpers/whatsapp');
        const { getStatus } = require('../helpers/whatsapp');

        // Cek status WA
        const waStatus = getStatus();
        if (waStatus.status !== 'READY') {
            return res.json({ success: false, message: 'WhatsApp belum terhubung. Scan QR di tab WA Gateway terlebih dahulu.' });
        }

        // Ambil semua admin & teknisi dengan nomor HP
        const [users] = await pool.query(
            "SELECT name, phone, role FROM users WHERE role IN ('admin','technician') AND phone IS NOT NULL AND phone != '' AND phone != '-' ORDER BY role, name"
        );

        if (!users || users.length === 0) {
            return res.json({ success: false, message: 'Tidak ada admin/teknisi dengan nomor HP terdaftar di Manajemen User.' });
        }

        // Ambil statistik OLT terkini
        const [oltRows] = await pool.query(`
            SELECT o.name AS olt_name,
                   COALESCE(SUM(u.status = 'Up'), 0) AS online,
                   COALESCE(SUM(u.status = 'Down'), 0) AS offline,
                   COUNT(*) AS total
            FROM hioso_onus u
            JOIN hioso_olts o ON u.olt_id = o.id
            GROUP BY o.id, o.name ORDER BY o.name ASC
        `);

        const totalDown   = oltRows.reduce((a, r) => a + parseInt(r.offline, 10), 0);
        const totalOnline = oltRows.reduce((a, r) => a + parseInt(r.online, 10), 0);
        const totalAll    = oltRows.reduce((a, r) => a + parseInt(r.total, 10), 0);
        const now         = new Date().toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });

        let msg = `🔔 *[TEST] Notifikasi OLT Alert via WA*\n\n`;
        msg += `📊 Rekap OLT saat ini:\n`;
        oltRows.forEach(r => {
            const down = parseInt(r.offline, 10);
            const icon = down > 0 ? '🔴' : '🟢';
            msg += `${icon} *${r.olt_name}*: ${r.online} online, ${down} offline / ${r.total}\n`;
        });
        msg += `\n🌐 Global: ${totalOnline} online, ${totalDown} offline / ${totalAll}\n`;
        msg += `🕐 ${now}\n\n`;
        msg += `✅ Ini pesan uji coba — notifikasi real dikirim otomatis saat threshold terlampaui.`;

        let sent = 0, failed = 0, failedNames = [];
        for (const user of users) {
            const result = await sendLocalWhatsApp(user.phone, msg);
            if (result.success) {
                sent++;
            } else {
                failed++;
                failedNames.push(user.name);
            }
            if (sent + failed < users.length) await new Promise(r => setTimeout(r, 800));
        }

        const info = `Terkirim: ${sent}/${users.length} user${failed > 0 ? `. Gagal: ${failedNames.join(', ')}` : ''}`;
        res.json({ success: sent > 0, message: info });
    } catch (e) {
        res.json({ success: false, message: 'Error: ' + e.message });
    }
});

// GET - List users
router.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, role, telegram_id, phone, created_at FROM users ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST - Add user
router.post('/api/users', async (req, res) => {
    const { username, password, role, telegram_id, phone } = req.body;
    try {
        const bcrypt = require('bcryptjs');
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, role, telegram_id, phone) VALUES (?,?,?,?,?)',
            [username, hashed, role||'admin', telegram_id||null, phone||null]);
        res.json({ success: true, message: 'User berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE - Remove user
router.delete('/api/users/:id', async (req, res) => {
    try {
        if (req.params.id == req.session.userId) {
            return res.status(400).json({ success: false, message: 'Tidak bisa menghapus diri sendiri' });
        }
        await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'User berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT - Edit user
router.put('/api/users/:id', async (req, res) => {
    try {
        const { username, role, telegram_id, phone, password } = req.body;
        if (password && password.trim()) {
            const bcrypt = require('bcryptjs');
            const hashed = await bcrypt.hash(password, 10);
            await pool.query('UPDATE users SET username=?, role=?, telegram_id=?, phone=?, password=? WHERE id=?',
                [username, role, telegram_id||null, phone||null, hashed, req.params.id]);
        } else {
            await pool.query('UPDATE users SET username=?, role=?, telegram_id=?, phone=? WHERE id=?',
                [username, role, telegram_id||null, phone||null, req.params.id]);
        }
        res.json({ success: true, message: 'User berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
