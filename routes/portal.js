const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const xendit = require('../helpers/xendit');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Multer for payment proof uploads
const proofStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'public', 'uploads', 'proofs');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `proof_${req.session.customerId}_${Date.now()}${ext}`);
    }
});
const proofUpload = multer({
    storage: proofStorage,
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Format tidak didukung. Gunakan JPG, PNG, atau PDF'), false);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

// Middleware for Portal Auth
// FIX (audit 2026-09): pelanggan yang masih memakai password default '1234'
// (portal_password belum pernah diganti) WAJIB ganti password lebih dulu.
const ALLOWED_WHEN_MUST_CHANGE = ['/first-login', '/logout', '/login'];
const requirePortalAuth = (req, res, next) => {
    if (!req.session.customerId) {
        return res.redirect('/portal/login');
    }
    if (req.session.mustChangePw && !ALLOWED_WHEN_MUST_CHANGE.includes(req.path)) {
        return res.redirect('/portal/first-login');
    }
    next();
};

// GET /portal/login
router.get('/login', async (req, res) => {
    if (req.session.customerId) return res.redirect('/portal');
    try {
        const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name','company_logo','company_icon')");
        const settings = {};
        rows.forEach(r => settings[r.setting_key] = r.setting_value);
        // Gunakan company_logo jika ada, fallback ke company_icon
        settings.logo = settings.company_logo || settings.company_icon || '';
        const inactiveMsg = req.query.reason === 'inactive'
            ? 'Akun Anda sudah tidak aktif. Silakan hubungi admin untuk informasi lebih lanjut.'
            : null;
        res.render('portal_login', { error: inactiveMsg, settings });
    } catch (_) {
        res.render('portal_login', { error: null, settings: {} });
    }
});

// POST /portal/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Normalize phone: strip spaces/dashes, handle 08xxx <-> 628xxx variants
        const raw = username.trim().replace(/[\s\-]/g, '');
        const phoneVariants = [raw];
        if (/^08/.test(raw))        phoneVariants.push('62' + raw.slice(1));   // 08x → 628x
        if (/^628/.test(raw))       phoneVariants.push('0'  + raw.slice(2));   // 628x → 08x
        if (/^\+628/.test(raw))     phoneVariants.push('0'  + raw.slice(3));   // +628x → 08x
        if (/^\+62/.test(raw))      phoneVariants.push('0'  + raw.slice(3));   // +62x → 0x

        const placeholders = phoneVariants.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT * FROM customers WHERE pppoe_username = ? OR phone IN (${placeholders})`,
            [raw, ...phoneVariants]
        );

        if (rows.length > 0) {
            const customer = rows[0];
            // Default password is '1234' if portal_password is not set
            const validPass = customer.portal_password ?
                await bcrypt.compare(password, customer.portal_password) :
                (password === '1234');

            if (validPass) {
                if (customer.status === 'inactive') {
                    return res.render('portal_login', { error: 'Akun Anda sudah tidak aktif. Silakan hubungi admin untuk informasi lebih lanjut.', settings });
                }
                req.session.customerId = customer.id;
                req.session.customerName = customer.name;
                // Password masih default ('1234', belum pernah diganti) → wajib ganti dulu
                req.session.mustChangePw = !customer.portal_password;
                return res.redirect(req.session.mustChangePw ? '/portal/first-login' : '/portal');
            }
        }
        res.render('portal_login', { error: 'Username atau Password salah' });
    } catch (err) {
        res.render('portal_login', { error: 'Terjadi kesalahan sistem' });
    }
});

// GET /portal/first-login — halaman wajib ganti password default (B6)
router.get('/first-login', (req, res) => {
    if (!req.session.customerId) return res.redirect('/portal/login');
    if (!req.session.mustChangePw) return res.redirect('/portal');
    res.render('portal_first_login', { user: req.session, error: null });
});

// POST /portal/first-login — simpan password baru
router.post('/first-login', async (req, res) => {
    const { new_password, confirm_password } = req.body;
    if (!req.session.customerId) return res.redirect('/portal/login');
    try {
        if (!new_password || new_password.length < 6) {
            return res.render('portal_first_login', { user: req.session, error: 'Password minimal 6 karakter.' });
        }
        if (new_password !== confirm_password) {
            return res.render('portal_first_login', { user: req.session, error: 'Konfirmasi password tidak sama.' });
        }
        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE customers SET portal_password = ? WHERE id = ?', [hashed, req.session.customerId]);
        req.session.mustChangePw = false;
        res.redirect('/portal');
    } catch (e) {
        res.render('portal_first_login', { user: req.session, error: 'Terjadi kesalahan: ' + e.message });
    }
});

// GET /portal (Dashboard)
router.get('/', requirePortalAuth, async (req, res) => {
    try {
        const [[customer]] = await pool.query(`
            SELECT c.*, p.name as package_name, p.price as package_price 
            FROM customers c 
            LEFT JOIN packages p ON c.package_id = p.id 
            WHERE c.id = ?`, [req.session.customerId]);
        
        if (!customer) {
            req.session.customerId = null;
            return res.redirect('/portal/login');
        }
        // Block inactive customer — auto-logout
        if (customer.status === 'inactive') {
            req.session.customerId = null;
            req.session.customerName = null;
            return res.redirect('/portal/login?reason=inactive');
        }
        
        const [invoiceRows] = await pool.query('SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', [req.session.customerId]);
        const invoices = invoiceRows;

        const [countRows] = await pool.query('SELECT COUNT(*) as unpaidCount FROM invoices WHERE customer_id = ? AND status = "unpaid"', [req.session.customerId]);
        const unpaidCount = countRows[0] ? countRows[0].unpaidCount : 0;

        const [totalRows] = await pool.query('SELECT COALESCE(SUM(amount),0) as unpaidTotal FROM invoices WHERE customer_id = ? AND status = "unpaid"', [req.session.customerId]);
        const unpaidTotal = totalRows[0] ? totalRows[0].unpaidTotal : 0;

        // Get payment gateway setting
        const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings");
        const settings = {};
        settingsRows.forEach(r => settings[r.setting_key] = r.setting_value);
        
        // Xendit aktif jika API key sudah diisi, override setting 'manual'
        const hasXendit = !!(settings.xendit_api_key && settings.xendit_api_key.trim());
        const paymentGateway = hasXendit ? 'xendit' : (settings.payment_gateway || 'manual');
        const company = {
            company_name: settings.company_name || 'Dino-Net',
            company_phone: settings.company_phone || '',
            company_address: settings.company_address || '',
            bank_name: settings.bank_name || 'BANK BCA',
            bank_account: settings.bank_account || '1234567890',
            bank_holder: settings.bank_holder || settings.company_name || 'Dino-Net',
            qris_image: settings.qris_image || '',
            company_logo: settings.company_logo || settings.company_icon || ''
        };

        res.render('portal_dashboard', { 
            user: req.session, customer, invoices, unpaidCount, unpaidTotal,
            paymentGateway, company
        });
    } catch (err) {
        console.error("PORTAL ERROR:", err);
        res.status(500).send("Gagal memuat portal");
    }
});

// POST /portal/pay/:invoiceId — Create Xendit QRIS payment
router.post('/pay/:invoiceId', requirePortalAuth, async (req, res) => {
    try {
        const [[inv]] = await pool.query('SELECT * FROM invoices WHERE id = ? AND customer_id = ?', [req.params.invoiceId, req.session.customerId]);
        if (!inv) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
        if (inv.status === 'paid') return res.json({ success: false, message: 'Invoice sudah lunas' });

        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.session.customerId]);

        const result = await xendit.createQRCode(pool, {
            invoiceId: inv.id,
            amount: parseInt(inv.amount),
            customerName: customer.name
        });

        if (result.success) {
            // Simpan referenceId ke kolom payment_ref (FIX audit 2026-09:
            // dulu menimpa invoice_number sehingga nomor invoice tercetak rusak)
            await pool.query(
                "UPDATE invoices SET payment_ref = ? WHERE id = ?",
                [result.data.referenceId, inv.id]
            );
            res.json({ success: true, data: result.data });
        } else {
            res.json({ success: false, message: result.message });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/change-password
router.post('/change-password', requirePortalAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id=?', [req.session.customerId]);
        
        const validPass = customer.portal_password ?
            await bcrypt.compare(current_password, customer.portal_password) :
            (current_password === '1234');
        
        if (!validPass) return res.json({ success: false, message: 'Password lama salah' });
        
        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE customers SET portal_password = ? WHERE id = ?', [hashed, req.session.customerId]);
        res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/update-profile
router.post('/update-profile', requirePortalAuth, async (req, res) => {
    const { phone, email } = req.body;
    try {
        await pool.query('UPDATE customers SET phone = ?, email = ? WHERE id = ?', [phone, email, req.session.customerId]);
        res.json({ success: true, message: 'Profil berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/ticket — Create trouble ticket
router.post('/ticket', requirePortalAuth, async (req, res) => {
    const { title, description } = req.body;
    try {
        await pool.query(
            'INSERT INTO trouble_tickets (customer_id, title, description, status, priority) VALUES (?, ?, ?, "open", "normal")',
            [req.session.customerId, title, description]
        );
        res.json({ success: true, message: 'Laporan berhasil dikirim, tim kami akan segera memprosesnya.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /portal/tickets — Fetch customer's own tickets (with technician name)
router.get('/tickets', requirePortalAuth, async (req, res) => {
    try {
        const [tickets] = await pool.query(`
            SELECT t.*,
                   COALESCE(
                       (SELECT GROUP_CONCAT(us.username ORDER BY us.username SEPARATOR ', ')
                        FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                        WHERE tt.ticket_id=t.id),
                       u.username
                   ) as technician_names,
                   (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id=t.id AND (tc.is_internal=0 OR tc.is_internal IS NULL)) as comment_count
            FROM trouble_tickets t
            LEFT JOIN users u ON u.id=t.technician_id
            WHERE t.customer_id=? ORDER BY t.created_at DESC`, [req.session.customerId]);
        res.json({ success: true, tickets });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /portal/ticket/:id — Detail tiket + komentar publik
router.get('/ticket/:id', requirePortalAuth, async (req, res) => {
    try {
        const [[ticket]] = await pool.query(`
            SELECT t.*,
                   COALESCE(
                       (SELECT GROUP_CONCAT(us.username ORDER BY us.username SEPARATOR ', ')
                        FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                        WHERE tt.ticket_id=t.id),
                       u.username
                   ) as technician_names
            FROM trouble_tickets t
            LEFT JOIN users u ON u.id=t.technician_id
            WHERE t.id=? AND t.customer_id=?`, [req.params.id, req.session.customerId]);
        if (!ticket) return res.json({ success: false, message: 'Tiket tidak ditemukan' });

        const [comments] = await pool.query(
            'SELECT * FROM ticket_comments WHERE ticket_id=? AND (is_internal=0 OR is_internal IS NULL) ORDER BY created_at ASC',
            [req.params.id]);

        res.json({ success: true, ticket, comments });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /portal/ticket/:id/comment — Pelanggan kirim balasan ke tiket
router.post('/ticket/:id/comment', requirePortalAuth, async (req, res) => {
    const { comment } = req.body;
    if (!comment || !comment.trim()) return res.json({ success: false, message: 'Pesan tidak boleh kosong' });
    try {
        const [[ticket]] = await pool.query(
            'SELECT id FROM trouble_tickets WHERE id=? AND customer_id=?',
            [req.params.id, req.session.customerId]);
        if (!ticket) return res.json({ success: false, message: 'Tiket tidak ditemukan' });

        await pool.query(
            'INSERT INTO ticket_comments (ticket_id, username, role, comment, is_internal) VALUES (?, ?, "customer", ?, 0)',
            [req.params.id, req.session.customerName, comment.trim()]);
        res.json({ success: true, message: 'Pesan terkirim' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /portal/wifi — Fetch SSID & Password from GenieACS
router.get('/wifi', requirePortalAuth, async (req, res) => {
    try {
        const [[customer]] = await pool.query('SELECT pppoe_username FROM customers WHERE id = ?', [req.session.customerId]);
        if (!customer || !customer.pppoe_username) return res.json({ success: false, message: 'PPPoE Username tidak ditemukan' });

        const [settingsRows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_path_pppoe')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        if (!s.acs_url) return res.json({ success: false, message: 'ACS belum dikonfigurasi' });

        const pppoePath = s.acs_path_pppoe || 'VirtualParameters.PPPoEUser';
        const config = { auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined, timeout: 15000 };

        // 1. Find device by PPPoE Username
        const findRes = await axios.get(`${s.acs_url}/devices`, {
            ...config,
            params: { 
                query: JSON.stringify({ [pppoePath]: customer.pppoe_username }),
                projection: '_id,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey'
            }
        });

        const device = findRes.data ? findRes.data[0] : null;
        if (!device) return res.json({ success: false, message: 'ONT tidak terdeteksi online di ACS' });

        const getVal = (obj, path) => {
            const parts = path.split('.');
            let curr = obj;
            for (const p of parts) { 
                curr = (curr && curr[p]) ? curr[p] : undefined; 
            }
            return (curr && curr._value) ? curr._value : curr;
        };

        const ssid = getVal(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
        const pass = getVal(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey');

        res.json({ success: true, ssid: ssid || '', password: pass || '' });
    } catch (e) {
        res.json({ success: false, message: 'Gagal mengambil data WiFi: ' + e.message });
    }
});

// POST /portal/wifi — Update SSID & Password
router.post('/wifi', requirePortalAuth, async (req, res) => {
    const { ssid, password } = req.body;
    try {
        const [[customer]] = await pool.query('SELECT pppoe_username FROM customers WHERE id = ?', [req.session.customerId]);
        const [settingsRows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_path_pppoe')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        if (!s.acs_url) return res.json({ success: false, message: 'ACS belum dikonfigurasi' });

        const pppoePath = s.acs_path_pppoe || 'VirtualParameters.PPPoEUser';
        const config = { auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined, timeout: 5000 };

        // 1. Find device
        const findRes = await axios.get(`${s.acs_url}/devices`, {
            ...config,
            params: { query: JSON.stringify({ [pppoePath]: customer.pppoe_username }), projection: '_id' }
        });

        const device = findRes.data ? findRes.data[0] : null;
        if (!device) return res.json({ success: false, message: 'ONT tidak ditemukan' });

        // 2. Push a single task to update both SSID and Password
        const deviceId = encodeURIComponent(device._id);
        const task = { 
            name: 'setParameterValues', 
            parameterValues: [
                ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid, 'xsd:string'],
                ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', password, 'xsd:string']
            ] 
        };

        await axios.post(`${s.acs_url}/devices/${deviceId}/tasks`, task, { ...config, params: { connection_request: '' } });

        res.json({ success: true, message: 'Pengaturan WiFi sedang dikirim ke ONT. WiFi akan segera berubah.' });
    } catch (e) {
        res.json({ success: false, message: 'Gagal update WiFi: ' + e.message });
    }
});

// GET /portal/qr-status/:referenceId — Cek status QR (polling dari frontend)
// FIX (audit 2026-09): jika status SUCCEEDED/COMPLETED, langsung tandai invoice
// lunas — jadi pembayaran tetap terproses walau webhook tidak sampai.
router.get('/qr-status/:referenceId', requirePortalAuth, async (req, res) => {
    try {
        const result = await xendit.getQRCode(pool, req.params.referenceId);
        if (result.success && result.data && ['SUCCEEDED', 'COMPLETED', 'PAID'].includes(result.data.status)) {
            const ref = req.params.referenceId;
            const [[inv]] = await pool.query(
                'SELECT id, status FROM invoices WHERE payment_ref = ? OR invoice_number = ? LIMIT 1',
                [ref, ref]
            );
            if (inv && inv.status !== 'paid') {
                const billingHelper = require('../helpers/billing');
                await billingHelper.markInvoicePaid(pool, inv.id, 'Xendit QRIS')
                    .then(r => { if (r.success) console.log(`[Xendit] Invoice #${inv.id} lunas via polling QR (ref: ${ref})`); })
                    .catch(e => console.error('[Xendit] Poll-mark error:', e.message));
            }
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/upload-proof/:invoiceId — Upload payment proof image
router.post('/upload-proof/:invoiceId', requirePortalAuth, proofUpload.single('proof'), async (req, res) => {
    try {
        const invoiceId = req.params.invoiceId;
        const [[inv]] = await pool.query('SELECT id FROM invoices WHERE id = ? AND customer_id = ?', [invoiceId, req.session.customerId]);
        if (!inv) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
        if (!req.file) return res.json({ success: false, message: 'File tidak ditemukan' });

        const filePath = '/uploads/proofs/' + req.file.filename;
        await pool.query('UPDATE invoices SET proof_image = ? WHERE id = ?', [filePath, invoiceId]);
        res.json({ success: true, message: 'Bukti pembayaran berhasil diupload.', path: filePath });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /portal/logout
router.get('/logout', (req, res) => {
    req.session.customerId = null;
    req.session.customerName = null;
    req.session.mustChangePw = false;
    res.redirect('/portal/login');
});

module.exports = router;
