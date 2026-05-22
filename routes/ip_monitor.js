const express  = require('express');
const router   = express.Router();
const { exec } = require('child_process');
const net      = require('net');
const axios    = require('axios');
const IS_WIN   = process.platform === 'win32';

let pool;
router.setPool = (dbPool) => { pool = dbPool; };

// ── Helper: ping via TCP connect (faster, no root needed) ─────────
function tcpCheck(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok, ms) => {
            if (done) return; done = true;
            sock.destroy();
            resolve({ up: ok, ms });
        };
        const t0 = Date.now();
        sock.setTimeout(timeoutMs);
        sock.connect(port, host, () => finish(true, Date.now() - t0));
        sock.on('error', () => finish(false, Date.now() - t0));
        sock.on('timeout', () => finish(false, Date.now() - t0));
    });
}

// ── Helper: ICMP ping via OS command ─────────────────────────────
function icmpPing(host, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const t0  = Date.now();
        const cmd = IS_WIN
            ? `ping -n 1 -w ${timeoutMs} ${host}`
            : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${host}`;
        exec(cmd, { timeout: timeoutMs + 1000 }, (err, stdout) => {
            const ms  = Date.now() - t0;
            const up  = !err && (IS_WIN
                ? /TTL=/i.test(stdout)
                : /1 received|1 packets received/i.test(stdout));
            resolve({ up, ms: up ? ms : null });
        });
    });
}

// ── Helper: HTTP check ────────────────────────────────────────────
async function httpCheck(url, timeoutMs = 5000) {
    const t0 = Date.now();
    try {
        const r = await axios.get(url, { timeout: timeoutMs, validateStatus: () => true });
        return { up: r.status < 500, ms: Date.now() - t0, statusCode: r.status };
    } catch {
        return { up: false, ms: Date.now() - t0, statusCode: null };
    }
}

// ── Core check dispatcher ─────────────────────────────────────────
async function checkHost(monitor) {
    if (monitor.check_type === 'http') {
        const url = monitor.ip_address.startsWith('http')
            ? monitor.ip_address : `http://${monitor.ip_address}`;
        return httpCheck(url);
    }
    if (monitor.check_type === 'tcp' && monitor.port) {
        return tcpCheck(monitor.ip_address, parseInt(monitor.port));
    }
    return icmpPing(monitor.ip_address);
}

// ── Send Telegram alert ───────────────────────────────────────────
async function sendTelegramAlert(pool, text) {
    try {
        const [rows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('telegram_bot_token','monitor_telegram_chat','telegram_chat_id')"
        );
        const s = {};
        rows.forEach(r => { s[r.setting_key] = r.setting_value; });
        const token   = s.telegram_bot_token;
        const chat_id = s.monitor_telegram_chat || s.telegram_chat_id;
        if (!token || !chat_id) return;
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id, text, parse_mode: 'HTML'
        });
    } catch (e) {
        console.error('[IPMonitor] Telegram error:', e.message);
    }
}

// ── Exported check-all function (called by cron in server.js) ────
router.runChecks = async () => {
    if (!pool) return;
    try {
        const [monitors] = await pool.query(
            "SELECT * FROM ip_monitors WHERE enabled = 1"
        );
        const now = Date.now();

        for (const m of monitors) {
            // Hitung apakah sudah waktunya dicek
            const lastCheck  = m.last_check ? new Date(m.last_check).getTime() : 0;
            const intervalMs = (parseInt(m.check_interval) || 5) * 60 * 1000;
            if (now - lastCheck < intervalMs) continue;

            const result = await checkHost(m).catch(() => ({ up: false, ms: null }));
            const wasUp  = m.status === 'up';
            const isUp   = result.up;
            const nowTs  = new Date();

            // Hitung consecutive_failures
            const failures = isUp ? 0 : (parseInt(m.consecutive_failures) || 0) + 1;

            await pool.query(
                `UPDATE ip_monitors SET
                    status               = ?,
                    last_check           = ?,
                    response_ms          = ?,
                    consecutive_failures = ?,
                    last_up   = IF(? = 1, NOW(), last_up),
                    last_down = IF(? = 0, NOW(), last_down)
                 WHERE id = ?`,
                [
                    isUp ? 'up' : 'down',
                    nowTs,
                    result.ms || null,
                    failures,
                    isUp ? 1 : 0,
                    isUp ? 1 : 0,
                    m.id
                ]
            );

            // Kirim Telegram jika status berubah
            if (wasUp && !isUp) {
                // DOWN alert
                const msg = `🔴 <b>HOST DOWN</b>\n\n`
                    + `📛 Nama   : <b>${m.name}</b>\n`
                    + `🌐 Target : <code>${m.ip_address}${m.port ? ':' + m.port : ''}</code>\n`
                    + `🔍 Tipe   : ${m.check_type.toUpperCase()}\n`
                    + `🕐 Waktu  : ${nowTs.toLocaleString('id-ID')}\n`
                    + `${m.notes ? '📝 Catatan: ' + m.notes : ''}`;
                await sendTelegramAlert(pool, msg);
            } else if (!wasUp && isUp && m.status !== 'unknown') {
                // RECOVERED alert
                const downSince = m.last_down
                    ? new Date(m.last_down).toLocaleString('id-ID') : '-';
                const msg = `🟢 <b>HOST RECOVERED</b>\n\n`
                    + `📛 Nama    : <b>${m.name}</b>\n`
                    + `🌐 Target  : <code>${m.ip_address}${m.port ? ':' + m.port : ''}</code>\n`
                    + `⚡ Respon  : ${result.ms ? result.ms + ' ms' : '-'}\n`
                    + `🕐 Pulih   : ${nowTs.toLocaleString('id-ID')}\n`
                    + `📉 Down sejak: ${downSince}`;
                await sendTelegramAlert(pool, msg);
            }
        }
    } catch (e) {
        console.error('[IPMonitor] runChecks error:', e.message);
    }
};

// ── GET /ip-monitor ───────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [monitors] = await pool.query(
            'SELECT * FROM ip_monitors ORDER BY name ASC'
        );
        const [[{ total }]]  = await pool.query('SELECT COUNT(*) as total FROM ip_monitors');
        const [[{ up }]]     = await pool.query("SELECT COUNT(*) as up FROM ip_monitors WHERE status='up' AND enabled=1");
        const [[{ down }]]   = await pool.query("SELECT COUNT(*) as down FROM ip_monitors WHERE status='down' AND enabled=1");
        const [[{ unknown }]] = await pool.query("SELECT COUNT(*) as `unknown` FROM ip_monitors WHERE status='unknown' AND enabled=1");

        const [[intRow]] = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key='monitor_check_interval'"
        ).catch(() => [[null]]);
        const [[chatRow]] = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key='monitor_telegram_chat'"
        ).catch(() => [[null]]);

        res.render('ip_monitor', {
            user: req.session,
            monitors,
            stats: { total, up: up || 0, down: down || 0, unknown: unknown || 0 },
            globalInterval: intRow ? intRow.setting_value : '5',
            telegramChat: chatRow ? chatRow.setting_value : '',
            currentPage: 'ip_monitor'
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Monitor error: ' + e.message);
    }
});

// ── POST /ip-monitor — tambah target ─────────────────────────────
router.post('/', async (req, res) => {
    try {
        const { name, ip_address, port, check_type, check_interval, notes } = req.body;
        if (!name || !ip_address) return res.json({ success: false, message: 'Nama dan target wajib diisi' });
        await pool.query(
            `INSERT INTO ip_monitors (name, ip_address, port, check_type, check_interval, notes, status, enabled)
             VALUES (?, ?, ?, ?, ?, ?, 'unknown', 1)`,
            [name.trim(), ip_address.trim(), port || null, check_type || 'icmp', parseInt(check_interval) || 5, notes || null]
        );
        res.json({ success: true, message: `Target "${name}" berhasil ditambahkan` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── PUT /ip-monitor/:id — edit target ────────────────────────────
router.put('/:id', async (req, res) => {
    try {
        const { name, ip_address, port, check_type, check_interval, notes } = req.body;
        await pool.query(
            `UPDATE ip_monitors SET name=?, ip_address=?, port=?, check_type=?, check_interval=?, notes=? WHERE id=?`,
            [name.trim(), ip_address.trim(), port || null, check_type || 'icmp', parseInt(check_interval) || 5, notes || null, req.params.id]
        );
        res.json({ success: true, message: 'Target diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── DELETE /ip-monitor/:id ────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM ip_monitors WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Target dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── POST /ip-monitor/:id/toggle — aktif/nonaktif ─────────────────
router.post('/:id/toggle', async (req, res) => {
    try {
        await pool.query('UPDATE ip_monitors SET enabled = IF(enabled=1,0,1) WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── POST /ip-monitor/:id/check — cek manual sekarang ─────────────
router.post('/:id/check', async (req, res) => {
    try {
        const [[m]] = await pool.query('SELECT * FROM ip_monitors WHERE id=?', [req.params.id]);
        if (!m) return res.json({ success: false, message: 'Tidak ditemukan' });

        const result = await checkHost(m).catch(() => ({ up: false, ms: null }));
        const wasUp  = m.status === 'up';
        const isUp   = result.up;
        const nowTs  = new Date();
        const failures = isUp ? 0 : (parseInt(m.consecutive_failures) || 0) + 1;

        await pool.query(
            `UPDATE ip_monitors SET status=?, last_check=?, response_ms=?, consecutive_failures=?,
             last_up=IF(?=1,NOW(),last_up), last_down=IF(?=0,NOW(),last_down) WHERE id=?`,
            [isUp ? 'up' : 'down', nowTs, result.ms || null, failures,
             isUp ? 1 : 0, isUp ? 1 : 0, m.id]
        );

        // Kirim Telegram jika baru down
        if (wasUp && !isUp) {
            await sendTelegramAlert(pool,
                `🔴 <b>HOST DOWN</b> (manual check)\n\n📛 <b>${m.name}</b>\n🌐 <code>${m.ip_address}</code>\n🕐 ${nowTs.toLocaleString('id-ID')}`
            );
        } else if (!wasUp && isUp) {
            await sendTelegramAlert(pool,
                `🟢 <b>HOST RECOVERED</b> (manual check)\n\n📛 <b>${m.name}</b>\n🌐 <code>${m.ip_address}</code>\n⚡ ${result.ms} ms`
            );
        }

        res.json({
            success: true,
            up: isUp,
            ms: result.ms,
            status: isUp ? 'up' : 'down',
            message: isUp ? `UP — ${result.ms ? result.ms + ' ms' : 'OK'}` : 'DOWN — tidak merespons'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── POST /ip-monitor/test-telegram — kirim pesan uji ke grup ────
router.post('/test-telegram', async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('telegram_bot_token','monitor_telegram_chat','telegram_chat_id')"
        );
        const s = {};
        rows.forEach(r => { s[r.setting_key] = r.setting_value; });

        const token   = s.telegram_bot_token;
        const chat_id = s.monitor_telegram_chat || s.telegram_chat_id;

        if (!token)   return res.json({ success: false, message: 'Bot Token belum dikonfigurasi di Pengaturan.' });
        if (!chat_id) return res.json({ success: false, message: 'Chat ID belum dikonfigurasi.' });

        const now = new Date().toLocaleString('id-ID');
        const text = `✅ <b>TEST NOTIFIKASI — IP Monitor</b>\n\n`
                   + `📡 Koneksi bot Telegram berhasil!\n`
                   + `🕐 Waktu  : ${now}\n`
                   + `🤖 Bot    : <code>${token.split(':')[0]}:***</code>\n`
                   + `💬 Chat ID: <code>${chat_id}</code>\n\n`
                   + `Notifikasi DOWN/RECOVERED akan dikirim ke grup ini.`;

        const resp = await axios.post(
            `https://api.telegram.org/bot${token}/sendMessage`,
            { chat_id, text, parse_mode: 'HTML' }
        );

        if (resp.data && resp.data.ok) {
            res.json({ success: true, message: 'Pesan uji berhasil dikirim ke grup Telegram! ✅' });
        } else {
            res.json({ success: false, message: 'Telegram error: ' + JSON.stringify(resp.data) });
        }
    } catch (e) {
        const errMsg = e.response ? JSON.stringify(e.response.data) : e.message;
        res.json({ success: false, message: 'Gagal mengirim: ' + errMsg });
    }
});

// ── POST /ip-monitor/settings — simpan interval & telegram chat ──
router.post('/settings', async (req, res) => {
    try {
        const { monitor_check_interval, monitor_telegram_chat } = req.body;
        const pairs = [
            ['monitor_check_interval', monitor_check_interval || '5'],
            ['monitor_telegram_chat',  monitor_telegram_chat  || '']
        ];
        for (const [k, v] of pairs) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
                [k, v, v]
            );
        }
        res.json({ success: true, message: 'Pengaturan tersimpan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
