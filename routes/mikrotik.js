const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// GET /mikrotik — cek status semua router secara PARALEL
router.get('/', async (req, res) => {
    try {
        const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');

        // Paralel: semua router dicek bersamaan, bukan satu per satu
        const routersWithStatus = await Promise.all(
            routers.map(async (r) => {
                const status = await mikrotik.checkStatus(r);
                return {
                    ...r,
                    online:   status.success,
                    identity: status.identity || null,
                    error:    status.message  || null
                };
            })
        );

        res.render('mikrotik', { user: req.session, routers: routersWithStatus, currentPage: 'mikrotik' });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// POST /api/add
router.post('/api/add', async (req, res) => {
    const { name, ip_address, username, password, port } = req.body;
    try {
        await pool.query(
            'INSERT INTO routers (name, ip_address, username, password, port) VALUES (?, ?, ?, ?, ?)',
            [name, ip_address, username, password, port || 8728]
        );
        res.json({ success: true, message: 'Router berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /api/:id
router.put('/api/:id', async (req, res) => {
    const { name, ip_address, username, password, port } = req.body;
    try {
        const fields = ['name=?', 'ip_address=?', 'username=?', 'port=?'];
        const values = [name, ip_address, username, port || 8728];
        if (password) { fields.push('password=?'); values.push(password); }
        values.push(req.params.id);
        await pool.query(`UPDATE routers SET ${fields.join(',')} WHERE id=?`, values);
        res.json({ success: true, message: 'Router berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /api/:id
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM routers WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Router berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /api/:id/sync — FIX: batch query, tidak looping per-user
router.post('/api/:id/sync', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.id]);
        if (!routerData) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

        // Fetch PPPoE secrets dan active connections secara PARALEL
        const [secretsResult, activeResult] = await Promise.all([
            mikrotik.getPPPoESecrets(routerData),
            mikrotik.getActiveConnections(routerData)
        ]);

        if (!secretsResult.success) {
            return res.json({ success: false, message: `Gagal terhubung ke ${routerData.ip_address}: ${secretsResult.message}` });
        }

        // Buat Set username aktif
        const activeUsers = new Set();
        if (activeResult.success) {
            activeResult.data.forEach(a => activeUsers.add(a.name));
        }

        // FIX BUG 3: Ambil semua customer sekaligus, bukan query per-user (N+1)
        const [allCustomers] = await pool.query(
            'SELECT id, pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != ""'
        );
        const customerMap = new Map();
        allCustomers.forEach(c => customerMap.set(c.pppoe_username, c.id));

        // Pisah secrets yang ada di DB dan yang tidak
        const toUpdate = [];
        let notFound = 0;

        for (const secret of secretsResult.data) {
            const customerId = customerMap.get(secret.name);
            if (customerId) {
                const isActive = activeUsers.has(secret.name) && !secret.disabled;
                toUpdate.push([routerData.id, isActive ? 'active' : 'isolated', secret.name]);
            } else {
                notFound++;
            }
        }

        // Batch UPDATE — satu query per status, bukan satu per user
        if (toUpdate.length > 0) {
            const activeNames  = toUpdate.filter(r => r[1] === 'active').map(r => r[2]);
            const isolateNames = toUpdate.filter(r => r[1] === 'isolated').map(r => r[2]);

            if (activeNames.length > 0) {
                const placeholders = activeNames.map(() => '?').join(',');
                await pool.query(
                    `UPDATE customers SET router_id = ?, status = 'active' WHERE pppoe_username IN (${placeholders})`,
                    [routerData.id, ...activeNames]
                );
            }
            if (isolateNames.length > 0) {
                const placeholders = isolateNames.map(() => '?').join(',');
                await pool.query(
                    `UPDATE customers SET router_id = ?, status = 'isolated' WHERE pppoe_username IN (${placeholders})`,
                    [routerData.id, ...isolateNames]
                );
            }
        }

        const sysResult = await mikrotik.getSystemResource(routerData);
        const sysInfo = sysResult.success ? ` | ${sysResult.data.boardName} v${sysResult.data.version}` : '';

        res.json({
            success: true,
            message: `Sync selesai${sysInfo}. ${toUpdate.length} pelanggan diperbarui, ${notFound} PPPoE tidak terdaftar di database.`
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /api/:id/check
router.post('/api/:id/check', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.id]);
        if (!routerData) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

        const status = await mikrotik.checkStatus(routerData);
        if (status.success) {
            const sysResult = await mikrotik.getSystemResource(routerData);
            const sys = sysResult.success ? sysResult.data : null;
            res.json({ success: true, message: `✅ Router ${routerData.name} online (${status.identity})`, data: sys });
        } else {
            res.json({ success: false, message: `❌ Router ${routerData.name} offline: ${status.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /pppoe-active — FIX: data via API JSON, bukan render blocking
// Halaman render dulu (kosong), data diambil via fetch di browser
router.get('/pppoe-active', async (req, res) => {
    try {
        const [routers] = await pool.query('SELECT id, name FROM routers ORDER BY name ASC');
        res.render('pppoe_active', {
            user: req.session,
            routers,            // hanya daftar router untuk dropdown filter
            activeConnections: [],  // kosong, diisi via AJAX
            currentPage: 'pppoe_active'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

// GET /api/pppoe-active/:routerId — ambil koneksi aktif satu router (AJAX)
router.get('/api/pppoe-active/:routerId', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.routerId]);
        if (!routerData) return res.json({ success: false, message: 'Router tidak ditemukan' });

        const activeResult = await mikrotik.getActiveConnections(routerData);
        if (!activeResult.success) {
            return res.json({ success: false, message: activeResult.message });
        }

        // Cross-reference dengan DB
        const [customers] = await pool.query(
            'SELECT pppoe_username, name, phone FROM customers WHERE pppoe_username IS NOT NULL'
        );
        const custMap = new Map();
        customers.forEach(c => custMap.set(c.pppoe_username, c));

        const data = activeResult.data.map(conn => {
            const cust = custMap.get(conn.name);
            return {
                ...conn,
                routerName:    routerData.name,
                routerId:      routerData.id,
                customerName:  cust ? cust.name  : null,
                customerPhone: cust ? cust.phone : null
            };
        });

        res.json({ success: true, data, total: data.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /api/pppoe-count/:routerId — hitung total PPPoE secrets (cepat)
router.get('/api/pppoe-count/:routerId', async (req, res) => {
    try {
        const [[routerData]] = await pool.query('SELECT * FROM routers WHERE id=?', [req.params.routerId]);
        if (!routerData) return res.json({ success: false, count: 0 });

        const result = await mikrotik.getPPPoESecrets(routerData);
        if (!result.success) return res.json({ success: false, count: 0 });

        res.json({ success: true, count: result.data.length });
    } catch (e) {
        res.json({ success: false, count: 0 });
    }
});

module.exports = router;
