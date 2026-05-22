const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

const HiosoOLT = require('../helpers/olt');

// GET /olt — dengan pagination, filter OLT, status, dan pencarian nama
router.get('/', async (req, res) => {
    try {
        const page         = Math.max(1, parseInt(req.query.page) || 1);
        const perPage      = 50;
        const offset       = (page - 1) * perPage;
        const search       = req.query.search || '';
        const oltFilter    = req.query.olt_id || '';
        const statusFilter = req.query.status || '';

        // Bangun kondisi WHERE secara dinamis
        const conditions = [];
        const params     = [];

        if (search) {
            conditions.push('(u.name LIKE ? OR u.sn LIKE ? OR u.mac LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (oltFilter) {
            conditions.push('u.olt_id = ?');
            params.push(oltFilter);
        }
        if (statusFilter) {
            conditions.push('u.status = ?');
            params.push(statusFilter);
        }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        // Query ONU dengan pagination
        const [onus] = await pool.query(`
            SELECT u.*, o.name as olt_name, o.brand as olt_brand
            FROM hioso_onus u
            JOIN hioso_olts o ON u.olt_id = o.id
            ${where}
            ORDER BY u.olt_id ASC, u.status DESC, u.rx_power ASC
            LIMIT ${perPage} OFFSET ${offset}
        `, params);

        // Total untuk kalkulasi halaman
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM hioso_onus u JOIN hioso_olts o ON u.olt_id = o.id ${where}`,
            params
        );

        // Statistik ringkas (selalu dari semua data, bukan hasil filter)
        const [[stats]] = await pool.query(`
            SELECT
                COUNT(*)                                          as total,
                SUM(CASE WHEN status = 'Up'   THEN 1 ELSE 0 END) as online,
                SUM(CASE WHEN status = 'Down' THEN 1 ELSE 0 END) as offline
            FROM hioso_onus
        `);

        const [olts] = await pool.query('SELECT * FROM hioso_olts');

        res.render('olt', {
            user: req.session,
            olts,
            onus,
            stats: stats || { total: 0, online: 0, offline: 0 },
            pagination: {
                total,
                page,
                perPage,
                totalPages: Math.ceil(total / perPage)
            },
            search,
            oltFilter,
            statusFilter,
            currentPage: 'olt'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// ── Helper: sync satu OLT ke DB ──────────────────────────────────────
async function syncOneOlt(olt, forceResetProfile = false) {
    const profile = forceResetProfile ? null
        : (olt.brand && olt.brand !== 'HIOSO' ? olt.brand : (olt.last_profile || null));

    console.log(`[OLT SYNC] "${olt.name}" — profile: ${profile || 'auto-detect'}${forceResetProfile ? ' (RESET)' : ''}`);

    const helper = new HiosoOLT(olt.host, olt.community, olt.port || 161);
    const { onus, detectedProfile } = await helper.getOnuList(profile);

    // Simpan profile yang terdeteksi
    if (detectedProfile && detectedProfile !== olt.last_profile) {
        await pool.query('UPDATE hioso_olts SET last_profile = ? WHERE id = ?', [detectedProfile, olt.id]);
        console.log(`[OLT SYNC] "${olt.name}" — profile diperbarui: ${olt.last_profile} → ${detectedProfile}`);
    }

    if (onus.length === 0) {
        throw new Error(`SNMP berhasil terhubung tetapi 0 ONU ditemukan. Periksa community string atau profile OLT.`);
    }

    // Full replace: hapus semua lalu insert ulang agar data benar-benar segar
    await pool.query('DELETE FROM hioso_onus WHERE olt_id = ?', [olt.id]);
    const values = onus.map(o => [olt.id, o.index, o.name, o.sn || '', o.mac || '', o.tx_power, o.rx_power, o.status]);
    await pool.query(
        `INSERT INTO hioso_onus (olt_id, onu_index, name, sn, mac, tx_power, rx_power, status, last_updated)
         VALUES ?`,
        [values.map(v => [...v, new Date()])]
    );

    const upCount   = onus.filter(o => o.status === 'Up').length;
    const downCount = onus.length - upCount;
    console.log(`[OLT SYNC] "${olt.name}" selesai — ${onus.length} ONU (${upCount} Up / ${downCount} Down)`);
    return { total: onus.length, up: upCount, down: downCount, profile: detectedProfile || profile };
}

// ── POST /olt/api/sync — sync semua OLT aktif ────────────────────────
router.post('/api/sync', async (req, res) => {
    try {
        const [olts] = await pool.query("SELECT * FROM hioso_olts WHERE status = 'active' OR status IS NULL");
        if (olts.length === 0)
            return res.json({ success: false, message: 'Belum ada OLT yang terdaftar atau aktif.' });

        let totalOnus = 0, successCount = 0;
        const errors = [];

        for (const olt of olts) {
            try {
                const r = await syncOneOlt(olt, false);
                totalOnus += r.total;
                successCount++;
            } catch (err) {
                console.error(`[OLT SYNC] Error "${olt.name}":`, err.message);
                errors.push(`${olt.name}: ${err.message}`);
            }
        }

        if (successCount === 0)
            return res.json({ success: false, message: 'Gagal sync semua OLT: ' + errors.join(' | ') });

        const msg = `Sync selesai: ${successCount}/${olts.length} OLT berhasil, ${totalOnus} ONU ditemukan.`
            + (errors.length ? ` Gagal: ${errors.join(' | ')}` : '');
        res.json({ success: true, message: msg });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── POST /olt/api/sync/:id — sync satu OLT spesifik ─────────────────
router.post('/api/sync/:id', async (req, res) => {
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [req.params.id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan.' });

        const forceReset = req.body && req.body.reset_profile === true;
        const r = await syncOneOlt(olt, forceReset);
        res.json({
            success: true,
            message: `✅ "${olt.name}" berhasil disync — ${r.total} ONU (${r.up} Up / ${r.down} Down).`,
            data: r
        });
    } catch (e) {
        res.status(500).json({ success: false, message: `❌ Sync "${req.params && req.params.id}" gagal: ${e.message}` });
    }
});

// ── GET /olt/api/last-sync — info terakhir sync per OLT ──────────────
router.get('/api/last-sync', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT o.id, o.name, o.brand, o.last_profile,
                   COUNT(u.id)                                          as total,
                   SUM(u.status = 'Up')                                 as up_count,
                   SUM(u.status = 'Down')                               as down_count,
                   MAX(u.last_updated)                                  as last_sync
            FROM hioso_olts o
            LEFT JOIN hioso_onus u ON u.olt_id = o.id
            GROUP BY o.id, o.name, o.brand, o.last_profile
            ORDER BY o.name ASC
        `);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reboot ONU API
router.post('/api/reboot', async (req, res) => {
    const { olt_id, index } = req.body;
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan' });

        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        const success = await helper.rebootOnu(index, olt.web_user, olt.web_password);
        
        if (success) {
            res.json({ success: true, message: `Perintah reboot berhasil dikirim ke ONU ${index}` });
        } else {
            res.json({ success: false, message: 'Gagal mengirim perintah reboot. Cek kredensial Web OLT di pengaturan.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Set ONU VLAN API
router.post('/api/onu/vlan', async (req, res) => {
    const { olt_id, index, vlan_id } = req.body;
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan' });

        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        const success = await helper.setOnuVlan(index, vlan_id, olt.last_profile || (olt.brand === 'HIOSO' ? 'HIOSO_C' : olt.brand));
        
        if (success) {
            res.json({ success: true, message: `VLAN ID ${vlan_id} berhasil diatur pada ONU ${index}` });
        } else {
            res.json({ success: false, message: 'Gagal mengatur VLAN. Pastikan OLT mendukung perintah ini.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// CRUD for OLTs
router.post('/api/olts', async (req, res) => {
    const { name, host, port, community, web_user, web_password, brand, model } = req.body;
    try {
        await pool.query(
            'INSERT INTO hioso_olts (name, host, port, community, web_user, web_password, brand, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
            [name, host, port || 161, community || 'public', web_user || 'admin', web_password || 'admin', brand || 'HIOSO', model || null]
        );
        res.json({ success: true, message: 'OLT berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/olts/:id', async (req, res) => {
    const { name, host, port, community, status, web_user, web_password, brand, model } = req.body;
    try {
        await pool.query(
            'UPDATE hioso_olts SET name=?, host=?, port=?, community=?, status=?, web_user=?, web_password=?, brand=?, model=? WHERE id=?', 
            [name, host, port, community, status, web_user, web_password, brand || 'HIOSO', model || null, req.params.id]
        );
        res.json({ success: true, message: 'OLT berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/olts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM hioso_olts WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'OLT berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test', async (req, res) => {
    const { host, community } = req.body;
    try {
        const helper = new HiosoOLT(host, community || 'public');
        const sysName = await helper.walk('1.3.6.1.2.1.1.5.0');
        res.json({ 
            success: true, 
            message: `Berhasil! OLT merespon via SNMP: ${(sysName[0] && sysName[0].value) ? sysName[0].value.toString() : 'Connected'}` 
        });
    } catch (e) {
        res.json({ success: false, message: `Gagal SNMP ke ${host}: ${e.message}` });
    }
});

// Endpoint diagnostik: walk sub-tree SNMP untuk menemukan OID yang tepat
router.post('/api/snmpwalk-discovery', async (req, res) => {
    const { olt_id, subtree } = req.body;
    if (!subtree) return res.json({ success: false, message: 'Parameter subtree (OID) wajib diisi' });
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan' });

        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        const results = await helper.discoverOids(subtree, 40);

        if (results.length === 0) {
            return res.json({ 
                success: false, 
                message: `Tidak ada OID ditemukan di bawah subtree ${subtree}. Coba subtree lain.`,
                results: []
            });
        }
        res.json({ 
            success: true, 
            message: `Ditemukan ${results.length} OID di bawah ${subtree}`,
            results 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
