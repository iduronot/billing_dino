const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let client;
let qrData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, READY, AUTHENTICATED

async function initWhatsApp(pool) {
    // If client already exists, destroy it first
    if (client) {
        try {
            console.log('[WA-LOCAL] Destroying existing client before re-init...');
            await client.destroy();
        } catch (e) {
            console.error('[WA-LOCAL] Destroy error:', e.message);
        }
    }

    console.log('[WA-LOCAL] Initializing local WhatsApp client...');
    connectionStatus = 'INITIALIZING';
    qrData = null; // Clear old QR

    const fs = require('fs');
    const paths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/google/chrome/google-chrome',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];

    let chromePath = null;
    for (const p of paths) {
        if (fs.existsSync(p)) {
            chromePath = p;
            break;
        }
    }

    if (chromePath) {
        console.log('[WA-LOCAL] Found Chrome at:', chromePath);
    } else {
        console.error('[WA-LOCAL] Chrome executable NOT FOUND in common paths!');
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            executablePath: chromePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-features=site-per-process',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log('[WA-LOCAL] QR RECEIVED! Generating DataURL...');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('[WA-LOCAL] QR DataURL Error:', err.message);
            } else {
                qrData = url;
                console.log('[WA-LOCAL] QR DataURL ready.');
            }
        });
        connectionStatus = 'DISCONNECTED';
    });

    client.on('authenticated', () => {
        console.log('[WA-LOCAL] AUTHENTICATED SUCCESS!');
        connectionStatus = 'AUTHENTICATED';
        qrData = null;
    });

    client.on('auth_failure', msg => {
        console.error('[WA-LOCAL] AUTHENTICATION FAILURE:', msg);
        connectionStatus = 'DISCONNECTED';
    });

    client.on('ready', () => {
        console.log('[WA-LOCAL] CLIENT IS READY!');
        connectionStatus = 'READY';
        qrData = null;
        // Sync pesan terakhir saat pertama ready
        if (pool) syncRecentMessages(pool).catch(e => console.error('[WA] Sync error:', e.message));
    });

    // Simpan pesan masuk ke DB saat terima pesan baru
    client.on('message', async (msg) => {
        if (!pool) return;
        try {
            // saveMessage sudah handle unread_count & last_message di upsert contact
            await saveMessage(pool, msg, false);
        } catch(e) { console.error('[WA] Save message error:', e.message); }
    });

    // Simpan pesan keluar
    client.on('message_create', async (msg) => {
        if (!msg.fromMe || !pool) return;
        try {
            await saveMessage(pool, msg, true);
        } catch(e) {}
    });

    client.on('loading_screen', (percent, message) => {
        console.log('[WA-LOCAL] LOADING:', percent, '%', message);
        connectionStatus = 'INITIALIZING';
    });

    client.on('disconnected', (reason) => {
        console.log('[WA-LOCAL] Client was logged out', reason);
        connectionStatus = 'DISCONNECTED';
        // Auto-restart on disconnect after 5s
        setTimeout(() => initWhatsApp(pool), 5000);
    });

    try {
        await client.initialize();
    } catch (e) {
        console.error('[WA-LOCAL] Initialization Error:', e.message);
        connectionStatus = 'DISCONNECTED';
    }
}

async function restartWhatsApp(pool) {
    return await initWhatsApp(pool);
}

let pool = null;
function setPool(p) { pool = p; }

// Normalisasi nomor WA — strip semua suffix (@c.us, @lid, @g.us, dll)
function normalizePhone(raw) {
    if (!raw) return '';
    return raw.split('@')[0].replace(/\D/g, '');
}

async function saveMessage(dbPool, msg, fromMe) {
    const rawId = fromMe ? msg.to : msg.from;
    const phone = normalizePhone(rawId);
    const chatId = rawId; // simpan chatId asli untuk referensi

    // Cross-ref customer
    const [[cust]] = await dbPool.query(
        'SELECT id, name FROM customers WHERE REPLACE(REPLACE(phone, "+", ""), "-", "") LIKE ? LIMIT 1',
        ['%' + phone.slice(-9) + '%']
    ).catch(() => [[]]);

    await dbPool.query(`
        INSERT IGNORE INTO wa_messages (message_id, chat_id, phone, contact_name, body, from_me, is_read, timestamp, customer_id, customer_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        msg.id._serialized || msg.id.id,
        chatId, phone,
        msg._data?.notifyName || null,
        msg.body || '',
        fromMe ? 1 : 0,
        fromMe ? 1 : 0,
        msg.timestamp,
        cust ? cust.id : null,
        cust ? cust.name : null
    ]);

    // Upsert contact — unread_count naik hanya untuk pesan masuk (fromMe=false)
    const addUnread = fromMe ? 0 : 1;
    await dbPool.query(`
        INSERT INTO wa_contacts (phone, name, customer_id, customer_name, last_message, last_message_at, unread_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            name            = COALESCE(VALUES(name), name),
            customer_id     = COALESCE(VALUES(customer_id), customer_id),
            customer_name   = COALESCE(VALUES(customer_name), customer_name),
            last_message    = VALUES(last_message),
            last_message_at = VALUES(last_message_at),
            unread_count    = unread_count + VALUES(unread_count)
    `, [
        phone,
        msg._data?.notifyName || null,
        cust ? cust.id : null,
        cust ? cust.name : null,
        (msg.body || '').substring(0, 255),
        msg.timestamp,
        addUnread
    ]);
}

async function syncRecentMessages(dbPool, limit = 50) {
    if (!client || connectionStatus !== 'READY') return;
    try {
        const chats = await client.getChats();
        let saved = 0;
        for (const chat of chats.slice(0, 30)) {
            const messages = await chat.fetchMessages({ limit: Math.min(limit, 20) });
            for (const msg of messages) {
                if (msg.type !== 'chat') continue;
                await saveMessage(dbPool, msg, msg.fromMe).catch(() => {});
                saved++;
            }
        }
        console.log(`[WA] Synced ${saved} messages from ${Math.min(chats.length, 30)} chats`);
    } catch(e) {
        console.error('[WA] Sync error:', e.message);
    }
}

async function getChats(dbPool) {
    const [contacts] = await dbPool.query(`
        SELECT c.*
        FROM wa_contacts c
        WHERE c.last_message_at IS NOT NULL
        ORDER BY c.last_message_at DESC
        LIMIT 50
    `);
    return contacts;
}

async function getChatMessages(dbPool, phone, limit = 50) {
    const [messages] = await dbPool.query(`
        SELECT * FROM wa_messages WHERE phone = ?
        ORDER BY timestamp DESC LIMIT ?
    `, [phone, limit]);
    return messages.reverse();
}

async function markAsRead(dbPool, phone) {
    await dbPool.query(
        'UPDATE wa_messages SET is_read = 1 WHERE phone = ? AND from_me = 0',
        [phone]
    );
    await dbPool.query(
        'UPDATE wa_contacts SET unread_count = 0 WHERE phone = ?',
        [phone]
    );
    // Mark read di WA juga
    if (client && connectionStatus === 'READY') {
        try {
            // Coba berbagai format chatId
            const tryIds = [phone + '@c.us', phone + '@lid'];
            for (const chatId of tryIds) {
                try {
                    const chat = await client.getChatById(chatId);
                    if (chat) { await chat.sendSeen(); break; }
                } catch(e) {}
            }
        } catch(e) {}
    }
}

function getClient() { return client; }

async function sendLocalWhatsApp(phone, message) {
    if (connectionStatus !== 'READY') {
        return { success: false, message: 'WhatsApp tidak terhubung' };
    }
    try {
        // Normalisasi nomor
        let formatted = phone.split('@')[0].replace(/[^0-9]/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);

        // Coba @c.us dulu, fallback ke @lid jika gagal
        const tryIds = [formatted + '@c.us', formatted + '@lid'];
        let lastError = null;

        for (const chatId of tryIds) {
            try {
                await client.sendMessage(chatId, message);
                return { success: true };
            } catch (e) {
                lastError = e;
                // Jika error bukan soal LID, langsung stop
                if (!e.message.includes('LID') && !e.message.includes('lid')) {
                    break;
                }
                // Jika error LID, coba format berikutnya
                console.log(`[WA] Try ${chatId} failed (${e.message}), trying next...`);
            }
        }

        return { success: false, message: lastError ? lastError.message : 'Gagal kirim pesan' };
    } catch (e) {
        return { success: false, message: e.message };
    }
}

function getStatus() {
    return { status: connectionStatus, qr: qrData };
}

module.exports = {
    initWhatsApp,
    restartWhatsApp,
    sendLocalWhatsApp,
    getStatus,
    getClient,
    setPool,
    saveMessage,
    syncRecentMessages,
    getChats,
    getChatMessages,
    markAsRead
};
