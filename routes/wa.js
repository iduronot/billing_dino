const express = require('express');
const router  = express.Router();
const wa      = require('../helpers/whatsapp');
let pool;
router.setPool = (p) => { pool = p; };

// GET /wa — halaman utama WA Manager
router.get('/', async (req, res) => {
    try {
        const waStatus = wa.getStatus();

        // Stats
        const [[stats]] = await pool.query(`
            SELECT
                COUNT(*)                                            as total,
                SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END)      as incoming,
                SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END)      as outgoing,
                SUM(CASE WHEN from_me = 0 AND is_read = 0 THEN 1 ELSE 0 END) as unread
            FROM wa_messages
            WHERE timestamp >= UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 30 DAY))
        `);

        // Trend harian 7 hari (masuk & keluar)
        const [dailyStats] = await pool.query(`
            SELECT
                DATE(FROM_UNIXTIME(timestamp)) as date,
                SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as incoming,
                SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as outgoing
            FROM wa_messages
            WHERE timestamp >= UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 7 DAY))
            GROUP BY DATE(FROM_UNIXTIME(timestamp))
            ORDER BY date ASC
        `);

        // Kontak / inbox terbaru
        const [contacts] = await pool.query(`
            SELECT c.*
            FROM wa_contacts c
            WHERE c.last_message_at IS NOT NULL
            ORDER BY c.last_message_at DESC
            LIMIT 50
        `);

        // Customers untuk dropdown kirim pesan
        const [customers] = await pool.query(
            "SELECT id, name, phone FROM customers WHERE phone IS NOT NULL AND phone != '' ORDER BY name ASC"
        );

        res.render('wa_manager', {
            user: req.session,
            waStatus, stats: stats || { total:0, incoming:0, outgoing:0, unread:0 },
            dailyStats: dailyStats || [],
            contacts: contacts || [],
            customers: customers || [],
            currentPage: 'wa'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

// GET /wa/api/messages/:phone — ambil pesan satu kontak (AJAX)
router.get('/api/messages/:phone', async (req, res) => {
    try {
        // Strip suffix @c.us/@lid/@g.us jika ada
        const rawPhone = req.params.phone;
        const phone = rawPhone.split('@')[0].replace(/\D/g, '');
        const [messages] = await pool.query(
            'SELECT * FROM wa_messages WHERE phone = ? ORDER BY timestamp ASC LIMIT 100',
            [phone]
        );
        // Mark as read
        await wa.markAsRead(pool, phone);
        res.json({ success: true, messages });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /wa/api/send — kirim pesan
router.post('/api/send', async (req, res) => {
    try {
        const { phone, message } = req.body;
        if (!phone || !message) return res.json({ success: false, message: 'Phone dan pesan wajib diisi' });

        // Cari chatId asli dari DB (bisa @c.us atau @lid)
        const cleanPhone = phone.split('@')[0].replace(/\D/g, '');
        const [[lastMsg]] = await pool.query(
            'SELECT chat_id FROM wa_messages WHERE phone = ? ORDER BY timestamp DESC LIMIT 1',
            [cleanPhone]
        );

        // Kalau ada chatId di DB, pakai itu langsung
        // Kalau tidak ada, fallback ke sendLocalWhatsApp yang auto-detect
        let result;
        if (lastMsg && lastMsg.chat_id && lastMsg.chat_id.includes('@')) {
            const waHelper = require('../helpers/whatsapp');
            const waClient = waHelper.getClient();
            const status   = waHelper.getStatus();
            if (status.status !== 'READY') {
                return res.json({ success: false, message: 'WhatsApp tidak terhubung' });
            }
            try {
                await waClient.sendMessage(lastMsg.chat_id, message);
                result = { success: true };
            } catch(e) {
                // Fallback ke auto-detect
                result = await wa.sendLocalWhatsApp(cleanPhone, message);
            }
        } else {
            result = await wa.sendLocalWhatsApp(cleanPhone, message);
        }

        if (result.success) {
            res.json({ success: true, message: 'Pesan berhasil dikirim' });
        } else {
            res.json({ success: false, message: result.message || 'Gagal kirim pesan' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /wa/api/sync — sync pesan dari WA
router.post('/api/sync', async (req, res) => {
    try {
        const status = wa.getStatus();
        if (status.status !== 'READY') {
            return res.json({ success: false, message: 'WhatsApp belum terhubung' });
        }
        await wa.syncRecentMessages(pool, 30);
        res.json({ success: true, message: 'Sinkronisasi pesan selesai' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /wa/api/status — cek status WA
router.get('/api/status', (req, res) => {
    res.json(wa.getStatus());
});

// POST /wa/api/mark-read/:phone
router.post('/api/mark-read/:phone', async (req, res) => {
    try {
        await wa.markAsRead(pool, req.params.phone);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /wa/api/cleanup — bersihkan & hitung ulang unread
router.post('/api/cleanup', async (req, res) => {
    try {
        // Normalisasi phone yang masih @lid/@c.us
        await pool.query(`UPDATE wa_messages SET phone = SUBSTRING_INDEX(phone, '@', 1) WHERE phone LIKE '%@%'`);
        await pool.query(`UPDATE wa_contacts SET phone = SUBSTRING_INDEX(phone, '@', 1) WHERE phone LIKE '%@%'`);

        // Hitung ulang unread_count dari wa_messages (lebih akurat)
        await pool.query(`
            UPDATE wa_contacts c
            SET c.unread_count = (
                SELECT COUNT(*) FROM wa_messages m
                WHERE m.phone = c.phone AND m.from_me = 0 AND m.is_read = 0
            )
        `);

        // Update last_message & last_message_at dari pesan terakhir
        await pool.query(`
            UPDATE wa_contacts c
            JOIN (
                SELECT phone, body, timestamp
                FROM wa_messages m1
                WHERE m1.id = (
                    SELECT id FROM wa_messages m2
                    WHERE m2.phone = m1.phone
                    ORDER BY timestamp DESC LIMIT 1
                )
            ) latest ON latest.phone = c.phone
            SET c.last_message = latest.body,
                c.last_message_at = latest.timestamp
        `);

        const [[{total}]] = await pool.query('SELECT COUNT(*) as total FROM wa_contacts');
        const [[{unread}]] = await pool.query('SELECT SUM(unread_count) as unread FROM wa_contacts');
        res.json({ success: true, message: `Data dibersihkan. ${total} kontak, ${unread||0} pesan belum dibaca.` });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── TEMPLATE PESAN ──────────────────────────────────────────
router.get('/api/templates', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM wa_templates ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/api/templates', async (req, res) => {
    try {
        const { name, content } = req.body;
        if (!name || !content) return res.json({ success: false, message: 'Nama dan isi template wajib diisi' });
        const [r] = await pool.query('INSERT INTO wa_templates (name, content) VALUES (?, ?)', [name, content]);
        res.json({ success: true, message: 'Template disimpan', id: r.insertId });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.put('/api/templates/:id', async (req, res) => {
    try {
        const { name, content } = req.body;
        await pool.query('UPDATE wa_templates SET name=?, content=? WHERE id=?', [name, content, req.params.id]);
        res.json({ success: true, message: 'Template diperbarui' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.delete('/api/templates/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM wa_templates WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Template dihapus' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── AUTO REPLY ───────────────────────────────────────────────
router.get('/api/auto-replies', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM wa_auto_replies ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/api/auto-replies', async (req, res) => {
    try {
        const { keyword, reply, match_type } = req.body;
        if (!keyword || !reply) return res.json({ success: false, message: 'Keyword dan balasan wajib diisi' });
        const [r] = await pool.query('INSERT INTO wa_auto_replies (keyword, reply, match_type) VALUES (?, ?, ?)', [keyword, reply, match_type || 'contains']);
        res.json({ success: true, message: 'Auto-reply disimpan', id: r.insertId });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.put('/api/auto-replies/:id', async (req, res) => {
    try {
        const { keyword, reply, match_type, is_active } = req.body;
        await pool.query('UPDATE wa_auto_replies SET keyword=?, reply=?, match_type=?, is_active=? WHERE id=?',
            [keyword, reply, match_type || 'contains', is_active != null ? is_active : 1, req.params.id]);
        res.json({ success: true, message: 'Auto-reply diperbarui' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/api/auto-replies/:id/toggle', async (req, res) => {
    try {
        await pool.query('UPDATE wa_auto_replies SET is_active = IF(is_active=1,0,1) WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.delete('/api/auto-replies/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM wa_auto_replies WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Auto-reply dihapus' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /wa/api/stats — stats untuk live update
router.get('/api/stats', async (req, res) => {
    try {
        const [[stats]] = await pool.query(`
            SELECT
                SUM(CASE WHEN from_me=0 AND is_read=0 THEN 1 ELSE 0 END) as unread,
                SUM(CASE WHEN from_me=0 THEN 1 ELSE 0 END) as incoming,
                SUM(CASE WHEN from_me=1 THEN 1 ELSE 0 END) as outgoing,
                COUNT(*) as total
            FROM wa_messages
            WHERE timestamp >= UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 30 DAY))
        `);
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
