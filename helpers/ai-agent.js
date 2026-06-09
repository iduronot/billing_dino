/**
 * AI Agent Helper — Groq API integration untuk auto-reply WA
 * Model: Llama 3.1 / 3.3 via Groq (gratis)
 */

const axios = require('axios');

// Conversation history per nomor HP (Map: phone -> [{role, content}])
const conversationHistory = new Map();
// Waktu pesan terakhir per nomor HP
const lastMessageTime     = new Map();
// Nomor yang sedang diproses (hindari race condition)
const processing          = new Set();

const MAX_HISTORY_PAIRS = 8;   // simpan max 8 pasang (user+assistant)
const HISTORY_TTL_MS    = 30 * 60 * 1000; // 30 menit idle → reset konteks

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah asisten layanan pelanggan dari sebuah ISP (Internet Service Provider) yang ramah, sopan, dan profesional.
Nama kamu adalah Dino Assistant.

Kamu membantu pelanggan dengan pertanyaan seputar:
- Tagihan dan cara pembayaran internet
- Status layanan, paket internet yang aktif
- Informasi gangguan koneksi
- Proses aktivasi dan isolir layanan
- Informasi umum tentang layanan ISP

Instruksi penting:
- Selalu jawab dalam Bahasa Indonesia yang natural dan singkat (maksimal 3-4 kalimat)
- Gunakan sapaan "Kak" atau nama pelanggan jika diketahui
- Jika ada data tagihan, sebutkan dengan jelas nominalnya
- Jika ada masalah teknis kompleks, sarankan menghubungi teknisi
- Jangan buat-buat informasi yang tidak ada di konteks`;

/**
 * Ambil pengaturan AI dari database
 */
async function getAISettings(pool) {
    const keys = ['ai_agent_enabled', 'groq_api_key', 'groq_model', 'ai_system_prompt', 'ai_max_tokens'];
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
        keys
    ).catch(() => [[]]);

    const s = {};
    (rows || []).forEach(r => { s[r.setting_key] = r.setting_value; });
    return s;
}

/**
 * Ambil data pelanggan berdasarkan nomor HP untuk konteks AI
 */
async function getCustomerContext(pool, phone) {
    // Normalisasi: ambil 9 digit terakhir untuk pencarian fleksibel
    const last9 = phone.replace(/\D/g, '').slice(-9);

    const [[cust]] = await pool.query(`
        SELECT c.id, c.name, c.status, c.isolated, c.address,
               p.name AS package_name, p.speed
        FROM customers c
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE REPLACE(REPLACE(c.phone, '+', ''), '-', '') LIKE ?
        LIMIT 1
    `, [`%${last9}%`]).catch(() => [[]]);

    if (!cust) return null;

    // Ambil tagihan belum lunas
    const [invoices] = await pool.query(`
        SELECT amount, due_date, status
        FROM invoices
        WHERE customer_id = ? AND status != 'paid'
        ORDER BY due_date ASC LIMIT 3
    `, [cust.id]).catch(() => [[]]);

    return { cust, invoices: invoices || [] };
}

/**
 * Bangun string konteks pelanggan untuk system prompt
 */
function buildContextString(ctx) {
    if (!ctx) return '';

    const { cust, invoices } = ctx;
    let lines = ['\n\n[Informasi Pelanggan]'];
    lines.push(`Nama: ${cust.name}`);
    lines.push(`Status layanan: ${cust.status === 'isolated' || cust.isolated ? 'TERISOLIR' : 'Aktif'}`);
    if (cust.package_name) lines.push(`Paket: ${cust.package_name}${cust.speed ? ' (' + cust.speed + ')' : ''}`);
    if (cust.address) lines.push(`Alamat: ${cust.address}`);

    if (invoices.length > 0) {
        lines.push('Tagihan belum lunas:');
        invoices.forEach(inv => {
            const tgl = inv.due_date ? new Date(inv.due_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }) : '-';
            const nominal = 'Rp ' + Math.floor(Number(inv.amount)).toLocaleString('id-ID');
            lines.push(`  - ${nominal}, jatuh tempo ${tgl} (${inv.status})`);
        });
    } else {
        lines.push('Tagihan: Semua tagihan sudah lunas ✅');
    }

    return lines.join('\n');
}

/**
 * Main function: dapatkan balasan AI untuk pesan pelanggan
 * Returns: string | null  (null = AI dinonaktifkan / error / tidak perlu balas)
 */
async function getAIReply(pool, phone, userMessage) {
    // Hindari double-processing nomor yang sama
    if (processing.has(phone)) return null;
    processing.add(phone);

    try {
        // 1. Ambil pengaturan
        const settings = await getAISettings(pool);
        if (settings.ai_agent_enabled !== '1') return null;

        const apiKey = settings.groq_api_key;
        if (!apiKey || apiKey.trim() === '') return null;

        const model      = settings.groq_model || 'llama-3.1-8b-instant';
        const maxTokens  = parseInt(settings.ai_max_tokens || '400', 10);
        const systemBase = settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT;

        // 2. Ambil konteks pelanggan
        const ctx = await getCustomerContext(pool, phone);
        const systemPrompt = systemBase + buildContextString(ctx);

        // 3. Kelola conversation history
        const now = Date.now();
        if (lastMessageTime.has(phone) && (now - lastMessageTime.get(phone)) > HISTORY_TTL_MS) {
            conversationHistory.delete(phone); // reset setelah idle 30 menit
        }
        lastMessageTime.set(phone, now);

        if (!conversationHistory.has(phone)) conversationHistory.set(phone, []);
        const history = conversationHistory.get(phone);

        // Tambah pesan user
        history.push({ role: 'user', content: userMessage });

        // Batasi panjang history (hapus pasang terlama jika melebihi batas)
        while (history.length > MAX_HISTORY_PAIRS * 2) history.splice(0, 2);

        // 4. Panggil Groq API
        const response = await axios.post(GROQ_API_URL, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...history
            ],
            max_tokens: maxTokens,
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        const aiText = response.data?.choices?.[0]?.message?.content?.trim();
        if (!aiText) return null;

        // Simpan balasan AI ke history
        history.push({ role: 'assistant', content: aiText });

        const usage = response.data?.usage;
        if (usage) {
            console.log(`[AI-AGENT] ${phone} | model:${model} | prompt:${usage.prompt_tokens} + completion:${usage.completion_tokens} tokens`);
        }

        return aiText;
    } catch (e) {
        const errDetail = e.response?.data?.error?.message || e.message;
        console.error('[AI-AGENT] Error:', errDetail);
        return null;
    } finally {
        processing.delete(phone);
    }
}

/**
 * Reset history percakapan untuk nomor tertentu (misal setelah CS ambil alih)
 */
function clearHistory(phone) {
    conversationHistory.delete(phone);
    lastMessageTime.delete(phone);
}

/**
 * Test langsung tanpa simpan ke history (untuk halaman pengaturan)
 */
async function testAIReply(apiKey, model, systemPrompt, testMessage) {
    const response = await axios.post(GROQ_API_URL, {
        model: model || 'llama-3.1-8b-instant',
        messages: [
            { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
            { role: 'user', content: testMessage || 'Halo, tagihan saya berapa ya?' }
        ],
        max_tokens: 300,
        temperature: 0.7
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || '(tidak ada balasan)';
}

module.exports = { getAIReply, clearHistory, testAIReply, DEFAULT_SYSTEM_PROMPT };
