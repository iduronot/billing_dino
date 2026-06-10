/**
 * Telegram Bot — polling untuk perintah teknisi
 * Perintah:
 *   /cek [nama]   — cek status ONU berdasarkan nama/pelanggan
 *   /lemah        — list ONU sinyal lemah (rx < -27 dBm)
 *   /status       — ringkasan semua OLT
 *   /help         — bantuan perintah
 */

const axios = require('axios');
const { searchONU, formatONUDetail, getWeakONUs, getOLTSummary, signalIcon } = require('./onu-checker');

let botRunning  = false;
let lastUpdateId = 0;
let dbPool       = null;
let botToken     = null;

// ── Kirim pesan balik ke Telegram ─────────────────────────────────
async function sendReply(chatId, text) {
    if (!botToken) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown'
        }, { timeout: 10000 });
    } catch (e) {
        console.error('[TG-BOT] Send error:', e.response?.data?.description || e.message);
    }
}

// ── Handler setiap pesan masuk ────────────────────────────────────
async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();
    const userId = msg.from?.id;
    const username = msg.from?.username || msg.from?.first_name || 'Teknisi';

    if (!text.startsWith('/') && !text.toLowerCase().startsWith('cek ')) return;

    // Verifikasi: hanya user yang terdaftar di DB yang bisa akses
    const [users] = await dbPool.query(
        "SELECT id, username FROM users WHERE telegram_id = ? AND role IN ('admin','technician') LIMIT 1",
        [String(userId)]
    ).catch(() => [[]]);

    if (!users || users.length === 0) {
        await sendReply(chatId, `⛔ Akses ditolak.\nTelegram ID Anda (${userId}) belum terdaftar sebagai admin/teknisi.\n\nHubungi administrator sistem.`);
        return;
    }

    const cmd = text.split(' ')[0].toLowerCase();
    const arg = text.slice(cmd.length).trim();

    // ── /help ──────────────────────────────────────────────────────
    if (cmd === '/help' || cmd === '/start') {
        await sendReply(chatId,
            `👋 Halo *${username}*!\n\n` +
            `*Perintah yang tersedia:*\n\n` +
            `🔍 */cek [nama]* — cek status ONU\n` +
            `   Contoh: /cek Gunari atau /cek blimbing\n\n` +
            `⚠️ */lemah* — list ONU sinyal lemah\n` +
            `   (rx_power < -27 dBm)\n\n` +
            `📊 */status* — ringkasan semua OLT\n\n` +
            `📋 */kritis* — list ONU sinyal kritis\n` +
            `   (rx_power < -30 dBm)\n\n` +
            `🔴 */offline* — list ONU yang offline (Down)`
        );
        return;
    }

    // ── /cek [nama] ───────────────────────────────────────────────
    if (cmd === '/cek') {
        if (!arg) {
            await sendReply(chatId, '❓ Masukkan nama ONU atau pelanggan.\nContoh: `/cek Gunari`');
            return;
        }
        await sendReply(chatId, `🔍 Mencari ONU: *${arg}*...`);
        const results = await searchONU(dbPool, arg);
        if (!results || results.length === 0) {
            await sendReply(chatId, `❌ ONU dengan nama *"${arg}"* tidak ditemukan.\n\nCoba kata kunci lain, misal nama desa atau bagian dari nama ONU.`);
            return;
        }
        for (const { onu, acsDevice } of results) {
            await sendReply(chatId, formatONUDetail(onu, acsDevice));
            await new Promise(r => setTimeout(r, 300)); // delay antar pesan
        }
        if (results.length > 1) {
            await sendReply(chatId, `📋 Ditemukan *${results.length}* ONU cocok dengan "${arg}".`);
        }
        return;
    }

    // ── /lemah ─────────────────────────────────────────────────────
    if (cmd === '/lemah') {
        await sendReply(chatId, '⚠️ Mengambil daftar ONU sinyal lemah...');
        const list = await getWeakONUs(dbPool, -27);
        if (!list || list.length === 0) {
            await sendReply(chatId, '✅ Semua ONU online memiliki sinyal normal (rx ≥ -27 dBm).');
            return;
        }
        let msg = `⚠️ *ONU Sinyal Lemah* (rx < -27 dBm)\n`;
        msg += `Ditemukan *${list.length}* ONU:\n━━━━━━━━━━━━━━━━━━\n`;
        list.forEach((o, i) => {
            const icon = signalIcon(o.rx_power);
            const custInfo = o.customer_name ? ` — ${o.customer_name}` : '';
            msg += `${i+1}. ${icon} *${o.name}*${custInfo}\n`;
            msg += `   Rx: ${o.rx_power} dBm | OLT: ${o.olt_name}\n`;
        });
        msg += `\nGunakan /cek [nama] untuk detail lengkap.`;
        await sendReply(chatId, msg);
        return;
    }

    // ── /kritis ───────────────────────────────────────────────────
    if (cmd === '/kritis') {
        await sendReply(chatId, '🔴 Mengambil daftar ONU sinyal kritis...');
        const list = await getWeakONUs(dbPool, -30);
        if (!list || list.length === 0) {
            await sendReply(chatId, '✅ Tidak ada ONU dengan sinyal kritis (rx < -30 dBm).');
            return;
        }
        let msg = `🔴 *ONU Sinyal KRITIS* (rx < -30 dBm)\n`;
        msg += `Ditemukan *${list.length}* ONU:\n━━━━━━━━━━━━━━━━━━\n`;
        list.forEach((o, i) => {
            const custInfo = o.customer_name ? ` — ${o.customer_name}` : '';
            msg += `${i+1}. 🔴 *${o.name}*${custInfo}\n`;
            msg += `   Rx: ${o.rx_power} dBm | OLT: ${o.olt_name}\n`;
        });
        await sendReply(chatId, msg);
        return;
    }

    // ── /offline ──────────────────────────────────────────────────
    if (cmd === '/offline') {
        await sendReply(chatId, '🔴 Mengambil daftar ONU offline...');
        const [list] = await dbPool.query(`
            SELECT u.name, u.last_updated, o.name AS olt_name, c.name AS customer_name
            FROM hioso_onus u
            JOIN hioso_olts o ON u.olt_id = o.id
            LEFT JOIN customers c ON c.id = u.customer_id
            WHERE u.status = 'Down'
            ORDER BY o.name ASC, u.name ASC
            LIMIT 30
        `).catch(() => [[]]);
        if (!list || list.length === 0) {
            await sendReply(chatId, '✅ Tidak ada ONU offline saat ini.');
            return;
        }
        let msg = `🔴 *ONU Offline* — ${list.length} unit\n━━━━━━━━━━━━━━━━━━\n`;
        list.forEach((o, i) => {
            const custInfo = o.customer_name ? ` — ${o.customer_name}` : '';
            const tgl = o.last_updated
                ? new Date(o.last_updated).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
                : '-';
            msg += `${i+1}. *${o.name}*${custInfo}\n`;
            msg += `   OLT: ${o.olt_name} | Update: ${tgl}\n`;
        });
        if (list.length === 30) msg += `\n_...dan mungkin masih ada lagi (limit 30)_`;
        await sendReply(chatId, msg);
        return;
    }

    // ── /status ───────────────────────────────────────────────────
    if (cmd === '/status') {
        await sendReply(chatId, '📊 Mengambil ringkasan OLT...');
        const rows = await getOLTSummary(dbPool);
        if (!rows || rows.length === 0) {
            await sendReply(chatId, '❌ Tidak ada data OLT.');
            return;
        }
        const totalOnline  = rows.reduce((a, r) => a + parseInt(r.online  || 0), 0);
        const totalOffline = rows.reduce((a, r) => a + parseInt(r.offline || 0), 0);
        const totalKritis  = rows.reduce((a, r) => a + parseInt(r.kritis  || 0), 0);
        const totalLemah   = rows.reduce((a, r) => a + parseInt(r.lemah   || 0), 0);
        const totalAll     = rows.reduce((a, r) => a + parseInt(r.total   || 0), 0);
        const now = new Date().toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });

        let msg = `📊 *Ringkasan OLT* — ${now}\n━━━━━━━━━━━━━━━━━━\n`;
        rows.forEach(r => {
            const offIcon = parseInt(r.offline) > 0 ? '🔴' : '🟢';
            msg += `${offIcon} *${r.olt_name}*\n`;
            msg += `   🟢 Online: ${r.online} | 🔴 Offline: ${r.offline} | Total: ${r.total}\n`;
            if (parseInt(r.kritis) > 0) msg += `   ⚡ Kritis: ${r.kritis} | ⚠️ Lemah: ${r.lemah}\n`;
        });
        msg += `━━━━━━━━━━━━━━━━━━\n`;
        msg += `🌐 *Global:* ${totalOnline} online, ${totalOffline} offline / ${totalAll} total\n`;
        if (totalKritis > 0) msg += `⚡ Sinyal kritis: ${totalKritis} ONU\n`;
        if (totalLemah > 0)  msg += `⚠️ Sinyal lemah: ${totalLemah} ONU\n`;
        await sendReply(chatId, msg);
        return;
    }
}

// ── Polling loop ───────────────────────────────────────────────────
async function poll() {
    if (!botToken || !dbPool) return;
    try {
        const res = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
            params: { offset: lastUpdateId + 1, timeout: 25, allowed_updates: ['message'] },
            timeout: 30000
        });
        const updates = res.data?.result || [];
        for (const upd of updates) {
            lastUpdateId = upd.update_id;
            if (upd.message?.text) {
                handleMessage(upd.message).catch(e =>
                    console.error('[TG-BOT] Handler error:', e.message)
                );
            }
        }
    } catch (e) {
        if (!e.message?.includes('timeout') && !e.message?.includes('ECONNRESET')) {
            console.error('[TG-BOT] Poll error:', e.response?.data?.description || e.message);
        }
    }
    // Schedule next poll
    if (botRunning) setTimeout(poll, 1000);
}

// ── Start/Stop ─────────────────────────────────────────────────────
async function startTelegramBot(pool) {
    if (botRunning) return;
    dbPool = pool;

    // Ambil token dari DB
    const [[row]] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'telegram_bot_token'"
    ).catch(() => [[]]);

    botToken = row?.setting_value?.trim();
    if (!botToken) {
        console.log('[TG-BOT] Token belum dikonfigurasi, bot tidak dijalankan.');
        return;
    }

    // Verifikasi token
    try {
        const me = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, { timeout: 5000 });
        console.log(`[TG-BOT] Bot aktif: @${me.data.result.username}`);
    } catch (e) {
        console.error('[TG-BOT] Token tidak valid:', e.response?.data?.description || e.message);
        return;
    }

    botRunning = true;
    poll();
    console.log('[TG-BOT] Polling dimulai — perintah: /cek /lemah /kritis /offline /status /help');
}

function stopTelegramBot() {
    botRunning = false;
    console.log('[TG-BOT] Polling dihentikan.');
}

// Reload token dari DB (dipanggil saat settings disimpan)
async function reloadBotToken(pool) {
    const [[row]] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'telegram_bot_token'"
    ).catch(() => [[]]);
    const newToken = row?.setting_value?.trim();
    if (newToken && newToken !== botToken) {
        botToken = newToken;
        console.log('[TG-BOT] Token diperbarui.');
        if (!botRunning && pool) {
            botRunning = true;
            dbPool = pool;
            poll();
        }
    }
}

module.exports = { startTelegramBot, stopTelegramBot, reloadBotToken };
