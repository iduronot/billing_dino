const express = require('express');
const router = express.Router();

let pool;

router.setPool = (p) => {
    pool = p;
};

// GET all map data
router.get('/api/data', async (req, res) => {
    try {
        const [customers] = await pool.query('SELECT id, name, lat, lng, status, address FROM customers WHERE lat IS NOT NULL AND lng IS NOT NULL');
        const [objects] = await pool.query('SELECT * FROM map_objects');
        const [cables] = await pool.query('SELECT * FROM map_cables');
        
        res.json({
            success: true,
            customers,
            objects,
            cables: cables.map(c => ({
                ...c,
                path: JSON.parse(c.path)
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /map/api/parse-coordinates — Parsing koordinat dari nama secret PPPoE MikroTik
// Nama secret berformat "Nama@-7.xxx,111.xxx" → kolom customers.lat/lng
// Hanya mengisi baris yang belum punya koordinat; nama secret TIDAK diubah
router.post('/api/parse-coordinates', async (req, res) => {
    const mikrotik = require('../helpers/mikrotik');
    const COORD_RE = /@\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    try {
        const [routers] = await pool.query("SELECT * FROM routers WHERE status='active'");
        if (!routers.length) return res.json({ success: false, message: 'Tidak ada router aktif' });

        const [customers] = await pool.query('SELECT id, name, lat, lng FROM customers');

        // Index pelanggan by nama normalisasi
        const byName = new Map();
        for (const cust of customers) {
            const key = norm(cust.name);
            if (!key) continue;
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(cust);
        }

        let parsed = 0, exact = 0, prefix = 0, skippedHasCoord = 0, skippedAmbiguous = 0, noMatch = 0, routerFail = 0;
        const updates = new Map();
        const noMatchSamples = [];

        for (const r of routers) {
            const result = await mikrotik.getPPPoESecrets(r);
            if (!result.success) { routerFail++; continue; }

            for (const s of result.data) {
                const mt = s.name.match(COORD_RE);
                if (!mt) continue;
                const lat = parseFloat(mt[1]), lng = parseFloat(mt[2]);
                if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
                parsed++;

                const key = norm(s.name.slice(0, mt.index));
                if (key.length < 3) continue;

                let list = byName.get(key) || [];
                let how = 'exact';
                if (list.length === 0) {
                    // Fallback: prefix dua arah
                    list = customers.filter(x => {
                        const k = norm(x.name);
                        return k.length >= 4 && (k.startsWith(key) || key.startsWith(k));
                    });
                    how = 'prefix';
                }
                if (list.length === 0) {
                    noMatch++;
                    if (noMatchSamples.length < 8) noMatchSamples.push(s.name);
                    continue;
                }
                if (list.length > 1) { skippedAmbiguous++; continue; }

                const cust = list[0];
                if (cust.lat && cust.lng) { skippedHasCoord++; continue; }
                if (updates.has(cust.id)) continue; // pelanggan sudah terisi dari secret lain
                updates.set(cust.id, { id: cust.id, lat: String(lat), lng: String(lng) });
                if (how === 'exact') exact++; else prefix++;
            }
        }

        // Tulis ke DB — hanya baris yang lat-nya masih kosong
        let updated = 0;
        for (const u of updates.values()) {
            const [r2] = await pool.query(
                'UPDATE customers SET lat=?, lng=?, updated_at=NOW() WHERE id=? AND (lat IS NULL OR lat="")',
                [u.lat, u.lng, u.id]
            );
            updated += r2.affectedRows;
        }

        res.json({
            success: true,
            updated,
            stats: {
                secrets_with_coords: parsed,
                matched_exact: exact,
                matched_prefix: prefix,
                already_has_coords: skippedHasCoord,
                ambiguous_skipped: skippedAmbiguous,
                no_match: noMatch,
                router_failed: routerFail
            },
            no_match_samples: noMatchSamples
        });
    } catch (err) {
        console.error('[ParseCoords]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET detail satu pelanggan (untuk popup peta)
router.get('/api/customer/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT c.id, c.name, c.phone, c.address, c.pppoe_username, c.status, c.lat, c.lng,
                   p.name as package_name, p.price as package_price
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            WHERE c.id = ?
        `, [req.params.id]);
        if (!rows.length) return res.json({ success: false, message: 'Pelanggan tidak ditemukan' });

        const [inv] = await pool.query(`
            SELECT COUNT(*) as unpaid_count, COALESCE(SUM(amount),0) as unpaid_total
            FROM invoices WHERE customer_id = ? AND status = 'unpaid'
        `, [req.params.id]);

        res.json({ success: true, data: { ...rows[0], ...inv[0] } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// SAVE Map Object (Server/ODP)
router.post('/api/objects', async (req, res) => {
    const { name, type, lat, lng } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO map_objects (name, type, lat, lng) VALUES (?, ?, ?, ?)',
            [name, type, lat, lng]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// SAVE Cable Path
router.post('/api/cables', async (req, res) => {
    const { name, path, color } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO map_cables (name, path, color) VALUES (?, ?, ?)',
            [name, JSON.stringify(path), color || '#3b82f6']
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE Map Object
router.delete('/api/objects/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM map_objects WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE Cable
router.delete('/api/cables/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM map_cables WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
