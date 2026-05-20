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
        res.render('settings', { user: req.session, settings, currentPage: 'settings' });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.get('/whatsapp-status', async (req, res) => {
    const { getStatus } = require('../helpers/whatsapp');
    res.json(getStatus());
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
