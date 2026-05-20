const express = require('express');
const router  = express.Router();
const mikrotik = require('../helpers/mikrotik');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// ── SSE client registry ──────────────────────────────────────────
const sseClients = new Set();

router.broadcast = (data) => {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        try { client.write(payload); } catch (_) { sseClients.delete(client); }
    });
};

// GET /monitoring
router.get('/', (req, res) => {
    res.render('monitoring', { user: req.session, currentPage: 'monitoring' });
});

// GET /monitoring/sse — real-time push
router.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

// GET /monitoring/api/summary
router.get('/api/summary', async (req, res) => {
    try {
        const [[onu]] = await pool.query(`
            SELECT
                COUNT(*)                                                         AS total,
                SUM(status = 'Up')                                               AS online,
                SUM(status = 'Down')                                             AS offline,
                SUM(CAST(rx_power AS DECIMAL(10,2)) < -27 AND status = 'Up')    AS weak_signal,
                SUM(CAST(rx_power AS DECIMAL(10,2)) < -30)                      AS critical_signal
            FROM hioso_onus
        `);

        const [[tickets]] = await pool.query(`
            SELECT
                SUM(status='open')                                          AS open_count,
                SUM(status='in_progress')                                   AS inprogress_count,
                SUM(status IN ('open','in_progress') AND priority IN ('critical','high')) AS urgent_count
            FROM trouble_tickets
        `);

        const [[routers]] = await pool.query(`SELECT COUNT(*) AS total FROM routers`);

        res.json({ success: true, onu, tickets, router_total: routers.total });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /monitoring/api/olt-status
router.get('/api/olt-status', async (req, res) => {
    try {
        const [olts] = await pool.query(`
            SELECT
                o.id, o.name, o.host, o.brand,
                COUNT(u.id)                                                        AS total_onu,
                SUM(u.status = 'Up')                                               AS online_onu,
                SUM(u.status = 'Down')                                             AS offline_onu,
                ROUND(AVG(CAST(u.rx_power AS DECIMAL(10,2))), 1)                   AS avg_rx,
                SUM(CAST(u.rx_power AS DECIMAL(10,2)) < -27 AND u.status = 'Up')   AS weak_count,
                MAX(u.last_updated)                                                AS last_updated
            FROM hioso_olts o
            LEFT JOIN hioso_onus u ON u.olt_id = o.id
            GROUP BY o.id
            ORDER BY o.name ASC
        `);
        res.json({ success: true, olts });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /monitoring/api/routers — MikroTik CPU/RAM/PPPoE (paralel, timeout-safe)
router.get('/api/routers', async (req, res) => {
    try {
        const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');

        const results = await Promise.all(routers.map(async (r) => {
            const [statusRes, activeRes, resourceRes] = await Promise.allSettled([
                mikrotik.checkStatus(r),
                mikrotik.getActiveConnections(r),
                mikrotik.getSystemResource(r)
            ]);

            const online  = statusRes.status === 'fulfilled' && statusRes.value?.success;
            const active  = activeRes.status  === 'fulfilled' && activeRes.value?.success  ? activeRes.value.data  : null;
            const resrc   = resourceRes.status === 'fulfilled' && resourceRes.value?.success ? resourceRes.value.data : null;

            const freeMem  = resrc ? parseInt(resrc.freeMemory)  : 0;
            const totalMem = resrc ? parseInt(resrc.totalMemory) : 1;
            const memPct   = totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 100) : null;

            return {
                id:           r.id,
                name:         r.name,
                ip_address:   r.ip_address,
                online,
                identity:     statusRes.status === 'fulfilled' ? statusRes.value?.identity : null,
                active_pppoe: active ? active.length : null,
                cpu_load:     resrc ? parseInt(resrc.cpuLoad) : null,
                mem_pct:      memPct,
                uptime:       resrc ? resrc.uptime : null
            };
        }));

        res.json({ success: true, routers: results });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /monitoring/api/weak-signal — ONU sinyal lemah atau offline
router.get('/api/weak-signal', async (req, res) => {
    try {
        const [onus] = await pool.query(`
            SELECT
                u.id, u.name, u.sn, u.rx_power, u.status, u.last_updated,
                o.name  AS olt_name,
                c.name  AS customer_name,
                c.id    AS customer_id,
                c.phone AS customer_phone
            FROM hioso_onus u
            JOIN hioso_olts o ON o.id = u.olt_id
            LEFT JOIN customers c ON c.pppoe_username = u.name
            WHERE u.status = 'Down'
               OR CAST(u.rx_power AS DECIMAL(10,2)) < -27
            ORDER BY
                CASE WHEN u.status='Down' THEN 0 ELSE 1 END ASC,
                CAST(u.rx_power AS DECIMAL(10,2)) ASC
            LIMIT 50
        `);
        res.json({ success: true, onus });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /monitoring/api/alerts — feed alert terbaru
router.get('/api/alerts', async (req, res) => {
    try {
        const [offlineOnus] = await pool.query(`
            SELECT u.sn, u.name, u.rx_power, u.status, u.last_updated, o.name AS olt_name,
                   c.name AS customer_name
            FROM hioso_onus u
            JOIN hioso_olts o ON o.id = u.olt_id
            LEFT JOIN customers c ON c.pppoe_username = u.name
            WHERE u.status = 'Down'
            ORDER BY u.last_updated DESC LIMIT 15
        `);

        const [weakOnus] = await pool.query(`
            SELECT u.sn, u.name, u.rx_power, u.last_updated, o.name AS olt_name,
                   c.name AS customer_name
            FROM hioso_onus u
            JOIN hioso_olts o ON o.id = u.olt_id
            LEFT JOIN customers c ON c.pppoe_username = u.name
            WHERE u.status = 'Up' AND CAST(u.rx_power AS DECIMAL(10,2)) < -27
            ORDER BY CAST(u.rx_power AS DECIMAL(10,2)) ASC LIMIT 10
        `);

        const [urgentTickets] = await pool.query(`
            SELECT t.id, t.title, t.priority, t.status, t.created_at, c.name AS customer_name
            FROM trouble_tickets t
            LEFT JOIN customers c ON c.id = t.customer_id
            WHERE t.status IN ('open','in_progress')
            ORDER BY FIELD(t.priority,'critical','high','normal','low'), t.created_at DESC
            LIMIT 5
        `);

        const alerts = [];

        offlineOnus.forEach(u => alerts.push({
            type: 'offline', severity: 'critical',
            message: `ONU Offline: ${u.name || u.sn}`,
            detail: `OLT: ${u.olt_name}${u.customer_name ? ' · ' + u.customer_name : ''}`,
            time: u.last_updated
        }));

        weakOnus.forEach(u => alerts.push({
            type: 'weak_signal',
            severity: parseFloat(u.rx_power) < -30 ? 'critical' : 'warning',
            message: `Sinyal Lemah: ${u.name || u.sn} (${parseFloat(u.rx_power).toFixed(1)} dBm)`,
            detail: `OLT: ${u.olt_name}${u.customer_name ? ' · ' + u.customer_name : ''}`,
            time: u.last_updated
        }));

        urgentTickets.forEach(t => alerts.push({
            type: 'ticket',
            severity: t.priority === 'critical' ? 'critical' : 'warning',
            message: `Tiket ${t.priority === 'critical' ? 'Kritis' : 'Aktif'}: ${t.title}`,
            detail: t.customer_name || 'Infrastruktur',
            time: t.created_at,
            ticket_id: t.id
        }));

        alerts.sort((a, b) => new Date(b.time) - new Date(a.time));
        res.json({ success: true, alerts: alerts.slice(0, 25) });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;
