const express = require('express');
const router  = express.Router();

let pool;
router.setPool = (p) => { pool = p; };

// ── Helper: hitung uptime dari event history ──
// Menerima array events {status, changed_at} urut ASC + status awal sebelum periode
function calcUptime(events, periodStart, periodEnd, initialStatus) {
    const totalMs   = periodEnd - periodStart;
    if (totalMs <= 0) return { uptime: 100, downMs: 0 };

    let downMs      = 0;
    let curStatus   = initialStatus || 'Up';
    let curTime     = periodStart;

    for (const ev of events) {
        const evTime = new Date(ev.changed_at).getTime();
        if (evTime < periodStart || evTime > periodEnd) continue;
        if (curStatus === 'Down') {
            downMs += evTime - curTime;
        }
        curStatus = ev.status;
        curTime   = evTime;
    }
    // Sisa periode setelah event terakhir
    if (curStatus === 'Down') {
        downMs += periodEnd - curTime;
    }

    const uptime = Math.max(0, Math.min(100, ((totalMs - downMs) / totalMs) * 100));
    return { uptime: parseFloat(uptime.toFixed(2)), downMs };
}

function msToHours(ms) {
    return parseFloat((ms / 3600000).toFixed(1));
}

function clusterLabel(uptime) {
    if (uptime < 90)  return { key: 'critical', label: 'Kritis',       color: '#EF4444', bg: 'rgba(239,68,68,.12)',   icon: '🔴' };
    if (uptime < 95)  return { key: 'bad',      label: 'Buruk',        color: '#F97316', bg: 'rgba(249,115,22,.12)',  icon: '🟠' };
    if (uptime < 99)  return { key: 'warn',     label: 'Perlu Pantau', color: '#F59E0B', bg: 'rgba(245,158,11,.12)',  icon: '🟡' };
    return               { key: 'good',     label: 'Baik',         color: '#10B981', bg: 'rgba(16,185,129,.12)',  icon: '🟢' };
}

// ── GET /sla — Dashboard ──
router.get('/', async (req, res) => {
    try {
        const [olts]  = await pool.query('SELECT id, name FROM hioso_olts ORDER BY name ASC');
        res.render('sla', { user: req.session, currentPage: 'sla', olts });
    } catch (e) {
        res.status(500).send('Error: ' + e.message);
    }
});

// ── GET /sla/api/summary ──
// Query params: period (YYYY-MM), olt_id, cluster, search
router.get('/api/summary', async (req, res) => {
    try {
        const { period, olt_id, cluster, search } = req.query;

        // Tentukan rentang periode
        let periodStart, periodEnd;
        if (period && /^\d{4}-\d{2}$/.test(period)) {
            const [y, m] = period.split('-').map(Number);
            periodStart  = new Date(y, m - 1, 1, 0, 0, 0).getTime();
            periodEnd    = new Date(y, m,     0, 23, 59, 59).getTime(); // hari terakhir bulan
        } else {
            // Default: bulan ini
            const now   = new Date();
            periodStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).getTime();
            periodEnd   = now.getTime();
        }

        const pStart = new Date(periodStart);
        const pEnd   = new Date(periodEnd);

        // Ambil semua ONU unik yang ada di history atau saat ini
        let onuQuery = `
            SELECT DISTINCT h.olt_id, h.onu_index, h.onu_name, h.pon_port,
                   o.name AS olt_name,
                   u.customer_id,
                   c.name AS customer_name,
                   c.phone AS customer_phone,
                   c.pppoe_username,
                   u.rx_power, u.tx_power
            FROM onu_status_history h
            LEFT JOIN hioso_olts o  ON o.id = h.olt_id
            LEFT JOIN hioso_onus u  ON u.olt_id = h.olt_id AND u.onu_index = h.onu_index
            LEFT JOIN customers  c  ON c.id = u.customer_id
                                    OR CONVERT(c.pppoe_username USING utf8mb4) = CONVERT(h.onu_name USING utf8mb4)
            WHERE h.changed_at BETWEEN ? AND ?
        `;
        const params = [pStart, pEnd];

        if (olt_id) { onuQuery += ' AND h.olt_id = ?'; params.push(parseInt(olt_id)); }
        if (search)  { onuQuery += ' AND (h.onu_name LIKE ? OR c.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

        const [onuList] = await pool.query(onuQuery, params);

        // Untuk setiap ONU, hitung uptime
        const results = [];
        for (const onu of onuList) {
            // Status sebelum periode dimulai (untuk tahu state awal)
            const [[lastBefore]] = await pool.query(`
                SELECT status FROM onu_status_history
                WHERE olt_id = ? AND onu_index = ? AND changed_at < ?
                ORDER BY changed_at DESC LIMIT 1
            `, [onu.olt_id, onu.onu_index, pStart]);

            // Semua event dalam periode
            const [events] = await pool.query(`
                SELECT status, changed_at FROM onu_status_history
                WHERE olt_id = ? AND onu_index = ?
                  AND changed_at BETWEEN ? AND ?
                ORDER BY changed_at ASC
            `, [onu.olt_id, onu.onu_index, pStart, pEnd]);

            const initialStatus = lastBefore ? lastBefore.status : 'Up';
            const { uptime, downMs } = calcUptime(events, periodStart, periodEnd, initialStatus);
            const downHours = msToHours(downMs);
            const cl = clusterLabel(uptime);

            // Filter cluster
            if (cluster && cl.key !== cluster) continue;

            // Cari waktu down terakhir
            const lastDownEv = events.slice().reverse().find(e => e.status === 'Down');
            const lastDown   = lastDownEv ? lastDownEv.changed_at : null;

            results.push({
                olt_id:          onu.olt_id,
                olt_name:        onu.olt_name,
                onu_index:       onu.onu_index,
                onu_name:        onu.onu_name,
                pon_port:        onu.pon_port,
                customer_id:     onu.customer_id,
                customer_name:   onu.customer_name,
                customer_phone:  onu.customer_phone,
                pppoe_username:  onu.pppoe_username,
                rx_power:        onu.rx_power,
                tx_power:        onu.tx_power,
                uptime,
                down_hours:      downHours,
                incident_count:  events.filter(e => e.status === 'Down').length,
                last_down:       lastDown,
                cluster:         cl
            });
        }

        // Urutkan: uptime terendah dulu
        results.sort((a, b) => a.uptime - b.uptime);

        // Hitung statistik cluster
        const stats = {
            critical: results.filter(r => r.cluster.key === 'critical').length,
            bad:      results.filter(r => r.cluster.key === 'bad').length,
            warn:     results.filter(r => r.cluster.key === 'warn').length,
            good:     results.filter(r => r.cluster.key === 'good').length,
            total:    results.length
        };

        res.json({ success: true, data: results, stats, period: { start: pStart, end: pEnd } });
    } catch (e) {
        console.error('[SLA API]', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── GET /sla/api/timeline — Detail down events suatu ONU ──
router.get('/api/timeline', async (req, res) => {
    try {
        const { olt_id, onu_index, period } = req.query;
        let pStart, pEnd;
        if (period && /^\d{4}-\d{2}$/.test(period)) {
            const [y, m] = period.split('-').map(Number);
            pStart = new Date(y, m - 1, 1);
            pEnd   = new Date(y, m, 0, 23, 59, 59);
        } else {
            const now = new Date();
            pStart = new Date(now.getFullYear(), now.getMonth(), 1);
            pEnd   = now;
        }

        const [events] = await pool.query(`
            SELECT status, changed_at FROM onu_status_history
            WHERE olt_id = ? AND onu_index = ?
              AND changed_at BETWEEN ? AND ?
            ORDER BY changed_at ASC
        `, [olt_id, onu_index, pStart, pEnd]);

        // Buat pasangan Down→Up untuk tampilan durasi
        const incidents = [];
        let downStart = null;
        for (const ev of events) {
            if (ev.status === 'Down') {
                downStart = ev.changed_at;
            } else if (ev.status === 'Up' && downStart) {
                const dur = new Date(ev.changed_at) - new Date(downStart);
                incidents.push({
                    down_at:    downStart,
                    up_at:      ev.changed_at,
                    duration_m: Math.round(dur / 60000)
                });
                downStart = null;
            }
        }
        // Jika masih Down sampai sekarang
        if (downStart) {
            const dur = new Date() - new Date(downStart);
            incidents.push({
                down_at:    downStart,
                up_at:      null,
                duration_m: Math.round(dur / 60000)
            });
        }

        res.json({ success: true, incidents, events });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── POST /sla/api/map-customer — Mapping manual ONU → Customer ──
router.post('/api/map-customer', async (req, res) => {
    try {
        const { olt_id, onu_index, customer_id } = req.body;
        await pool.query(
            'UPDATE hioso_onus SET customer_id = ? WHERE olt_id = ? AND onu_index = ?',
            [customer_id || null, olt_id, onu_index]
        );
        res.json({ success: true, message: 'Mapping berhasil disimpan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── GET /sla/api/customers-search ──
router.get('/api/customers-search', async (req, res) => {
    try {
        const { q } = req.query;
        const [rows] = await pool.query(
            `SELECT id, name, pppoe_username, phone FROM customers
             WHERE name LIKE ? OR pppoe_username LIKE ?
             ORDER BY name ASC LIMIT 20`,
            [`%${q}%`, `%${q}%`]
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
