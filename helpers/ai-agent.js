/**
 * AI Agent Helper — Groq API integration untuk auto-reply WA
 * Konteks dinamis: data pelanggan + paket + jangkauan + info perusahaan dari DB
 */

const axios = require('axios');

// ── Conversation history per nomor HP ──────────────────────────────
const conversationHistory = new Map();
const lastMessageTime     = new Map();
const processing          = new Set();

const MAX_HISTORY_PAIRS = 8;
const HISTORY_TTL_MS    = 30 * 60 * 1000; // 30 menit idle → reset

// ── Cache sistem (paket + company) agar tidak query DB setiap pesan ─
let systemContextCache     = null;
let systemContextCacheTime = 0;
const SYSTEM_CACHE_TTL     = 10 * 60 * 1000; // refresh tiap 10 menit

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ═══════════════════════════════════════════════════════════════════
// 1. AMBIL KONTEKS SISTEM (paket + company + jangkauan) — di-cache
// ═══════════════════════════════════════════════════════════════════
async function getSystemContext(pool) {
    const now = Date.now();
    if (systemContextCache && (now - systemContextCacheTime) < SYSTEM_CACHE_TTL) {
        return systemContextCache;
    }

    // a. Info perusahaan dari settings
    const [settingRows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name','company_phone','company_address','company_email','company_website','bank_name','bank_account','bank_holder','default_due_day','late_tolerance_days')"
    ).catch(() => [[]]);
    const s = {};
    (settingRows || []).forEach(r => { s[r.setting_key] = r.setting_value; });

    // b. Semua paket aktif
    const [packages] = await pool.query(
        'SELECT name, price, speed_limit, description FROM packages ORDER BY price ASC'
    ).catch(() => [[]]);

    // c. Area jangkauan dari ODP nodes (lokasi fiber optik yang sudah terpasang)
    const [nodes] = await pool.query(
        "SELECT name, address FROM fo_nodes WHERE type IN ('ODP','ODC','OLT') AND status = 'active' ORDER BY type, name"
    ).catch(() => [[]]);

    // d. Area dari alamat pelanggan aktif (distinct kelurahan/kecamatan)
    const [custAreas] = await pool.query(
        "SELECT DISTINCT address FROM customers WHERE status = 'active' AND address IS NOT NULL AND address != '' LIMIT 80"
    ).catch(() => [[]]);

    systemContextCache = { s, packages: packages || [], nodes: nodes || [], custAreas: custAreas || [] };
    systemContextCacheTime = now;
    return systemContextCache;
}

// Paksa refresh cache (dipanggil saat save pengaturan)
function invalidateSystemCache() {
    systemContextCache = null;
    systemContextCacheTime = 0;
}

// ═══════════════════════════════════════════════════════════════════
// 2. AMBIL KONTEKS PELANGGAN INDIVIDUAL
// ═══════════════════════════════════════════════════════════════════
async function getCustomerContext(pool, phone) {
    const last9 = phone.replace(/\D/g, '').slice(-9);

    const [[cust]] = await pool.query(`
        SELECT c.id, c.name, c.status, c.isolated, c.address, c.email,
               c.pppoe_username, c.installation_status,
               p.name AS package_name, p.price AS package_price,
               p.speed_limit, p.description AS package_desc
        FROM customers c
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE REPLACE(REPLACE(c.phone, '+', ''), '-', '') LIKE ?
        LIMIT 1
    `, [`%${last9}%`]).catch(() => [[]]);

    if (!cust) return null;

    // Semua tagihan belum lunas
    const [invoices] = await pool.query(`
        SELECT invoice_number, amount, due_date, status,
               DATEDIFF(CURDATE(), due_date) AS days_overdue
        FROM invoices
        WHERE customer_id = ? AND status != 'paid'
        ORDER BY due_date ASC LIMIT 5
    `, [cust.id]).catch(() => [[]]);

    // Tagihan terakhir yang sudah dibayar (untuk info pembayaran terakhir)
    const [[lastPaid]] = await pool.query(`
        SELECT amount, due_date, paid_at
        FROM invoices
        WHERE customer_id = ? AND status = 'paid'
        ORDER BY paid_at DESC LIMIT 1
    `, [cust.id]).catch(() => [[]]);

    // Tiket gangguan aktif
    const [tickets] = await pool.query(`
        SELECT subject, status, created_at
        FROM trouble_tickets
        WHERE customer_id = ? AND status NOT IN ('closed','resolved')
        ORDER BY created_at DESC LIMIT 3
    `, [cust.id]).catch(() => [[]]);

    return { cust, invoices: invoices || [], lastPaid: lastPaid || null, tickets: tickets || [] };
}

// ═══════════════════════════════════════════════════════════════════
// 3. BANGUN SYSTEM PROMPT LENGKAP
// ═══════════════════════════════════════════════════════════════════
function buildSystemPrompt(basePrompt, sysCtx, custCtx) {
    const { s, packages, nodes, custAreas } = sysCtx;
    const companyName = s.company_name || 'ISP';
    const lines = [basePrompt, ''];

    // ── Info Perusahaan ──────────────────────────────────────────────
    lines.push('═══════════════════════════════════');
    lines.push('INFORMASI PERUSAHAAN (gunakan data ini saat ditanya):');
    lines.push(`Nama: ${companyName}`);
    if (s.company_phone)   lines.push(`No. HP/WA: ${s.company_phone}`);
    if (s.company_address) lines.push(`Alamat: ${s.company_address}`);
    if (s.company_email)   lines.push(`Email: ${s.company_email}`);
    if (s.company_website) lines.push(`Website: ${s.company_website}`);
    if (s.bank_name)       lines.push(`Bank: ${s.bank_name} a/n ${s.bank_holder || '-'}, No: ${s.bank_account || '-'}`);
    if (s.default_due_day) lines.push(`Jatuh tempo tagihan: setiap tanggal ${s.default_due_day} setiap bulan`);

    // ── Daftar Paket ─────────────────────────────────────────────────
    if (packages.length > 0) {
        lines.push('');
        lines.push('DAFTAR PAKET INTERNET YANG TERSEDIA:');
        packages.forEach(p => {
            const harga = 'Rp ' + Math.floor(Number(p.price)).toLocaleString('id-ID') + '/bulan';
            const speed = p.speed_limit ? ` | Kecepatan: ${p.speed_limit}` : '';
            lines.push(`- ${p.name}${speed} | Harga: ${harga}`);
        });
        lines.push('Cara pendaftaran: hubungi nomor WA/HP perusahaan di atas.');
    }

    // ── Area Jangkauan ───────────────────────────────────────────────
    const coverageAreas = new Set();

    // Dari ODP/OLT nodes
    nodes.forEach(n => {
        if (n.address && n.address.trim()) coverageAreas.add(n.address.trim());
    });

    // Dari alamat pelanggan — ambil pola kecamatan/kabupaten (kata-kata khas)
    custAreas.forEach(r => {
        if (!r.address) return;
        // Coba ekstrak nama desa/kecamatan (kata setelah karakter RT/RW selesai)
        const addr = r.address.trim();
        // Ambil 2-3 kata terakhir dari alamat sebagai representasi area
        const words = addr.split(/[\s,]+/).filter(w => w.length > 3 && !/^\d+$/.test(w));
        if (words.length >= 2) {
            coverageAreas.add(words.slice(-3).join(', '));
        }
    });

    if (coverageAreas.size > 0) {
        lines.push('');
        lines.push('AREA JANGKAUAN LAYANAN:');
        const areaList = Array.from(coverageAreas).slice(0, 30);
        lines.push(areaList.join(' | '));
        lines.push('Untuk memastikan jangkauan di lokasi Anda, silakan hubungi kami.');
    }

    // ── Konteks Pelanggan Individual ─────────────────────────────────
    if (custCtx) {
        const { cust, invoices, lastPaid, tickets } = custCtx;
        lines.push('');
        lines.push('═══════════════════════════════════');
        lines.push('DATA PELANGGAN YANG SEDANG CHAT:');
        lines.push(`Nama: ${cust.name}`);
        lines.push(`Status layanan: ${(cust.status === 'isolated' || cust.isolated) ? '🔴 TERISOLIR (internet diputus)' : '🟢 Aktif'}`);

        if (cust.package_name) {
            const hargaPaket = cust.package_price ? ' (Rp ' + Math.floor(Number(cust.package_price)).toLocaleString('id-ID') + '/bln)' : '';
            const speedPaket = cust.speed_limit ? ' | ' + cust.speed_limit : '';
            lines.push(`Paket aktif: ${cust.package_name}${speedPaket}${hargaPaket}`);
        } else {
            lines.push('Paket aktif: belum terdaftar paket');
        }

        if (cust.address) lines.push(`Alamat: ${cust.address}`);
        if (cust.pppoe_username) lines.push(`Username PPPoE: ${cust.pppoe_username}`);

        if (invoices.length > 0) {
            lines.push('Tagihan belum lunas:');
            invoices.forEach(inv => {
                const tgl = inv.due_date ? new Date(inv.due_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }) : '-';
                const nominal = 'Rp ' + Math.floor(Number(inv.amount)).toLocaleString('id-ID');
                const overdue = inv.days_overdue > 0 ? ` ⚠️ TELAT ${inv.days_overdue} hari` : '';
                lines.push(`  • ${inv.invoice_number || '-'}: ${nominal}, jatuh tempo ${tgl}${overdue}`);
            });
        } else {
            lines.push('Tagihan: ✅ Semua tagihan sudah lunas');
        }

        if (lastPaid) {
            const tglBayar = lastPaid.paid_at ? new Date(lastPaid.paid_at).toLocaleDateString('id-ID') : '-';
            lines.push(`Pembayaran terakhir: Rp ${Math.floor(Number(lastPaid.amount)).toLocaleString('id-ID')} pada ${tglBayar}`);
        }

        if (tickets.length > 0) {
            lines.push('Tiket gangguan aktif:');
            tickets.forEach(t => {
                lines.push(`  • ${t.subject} (${t.status})`);
            });
        }
    } else {
        lines.push('');
        lines.push('═══════════════════════════════════');
        lines.push('Pengirim pesan ini BUKAN pelanggan terdaftar (nomor tidak ada di database).');
        lines.push('Bantu informasi umum tentang paket dan layanan saja. Jangan klaim bisa cek data tagihan mereka.');
    }

    lines.push('═══════════════════════════════════');
    lines.push('ATURAN WAJIB:');
    lines.push('1. HANYA gunakan informasi di atas. JANGAN mengarang data yang tidak tercantum.');
    lines.push('2. Jika tidak tahu → arahkan ke CS: hubungi nomor ' + (s.company_phone || 'perusahaan'));
    lines.push('3. Jawab singkat, natural, Bahasa Indonesia, maksimal 4 kalimat.');
    lines.push('4. Gunakan sapaan "Kak" atau nama pelanggan jika diketahui.');

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 4. MAIN FUNCTION — dapatkan balasan AI
// ═══════════════════════════════════════════════════════════════════
async function getAIReply(pool, phone, userMessage) {
    if (processing.has(phone)) return null;
    processing.add(phone);

    try {
        // Ambil pengaturan AI dari DB
        const [settingRows] = await pool.query(
            "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('ai_agent_enabled','groq_api_key','groq_model','ai_system_prompt','ai_max_tokens')"
        ).catch(() => [[]]);
        const cfg = {};
        (settingRows || []).forEach(r => { cfg[r.setting_key] = r.setting_value; });

        if (cfg.ai_agent_enabled !== '1') return null;
        const apiKey = cfg.groq_api_key?.trim();
        if (!apiKey) return null;

        const model     = cfg.groq_model || 'llama-3.1-8b-instant';
        const maxTokens = parseInt(cfg.ai_max_tokens || '400', 10);
        const basePrompt = cfg.ai_system_prompt || DEFAULT_BASE_PROMPT;

        // Ambil konteks paralel
        const [sysCtx, custCtx] = await Promise.all([
            getSystemContext(pool),
            getCustomerContext(pool, phone)
        ]);

        // Bangun system prompt lengkap dengan data dari DB
        const systemPrompt = buildSystemPrompt(basePrompt, sysCtx, custCtx);

        // Kelola conversation history
        const now = Date.now();
        if (lastMessageTime.has(phone) && (now - lastMessageTime.get(phone)) > HISTORY_TTL_MS) {
            conversationHistory.delete(phone);
        }
        lastMessageTime.set(phone, now);
        if (!conversationHistory.has(phone)) conversationHistory.set(phone, []);
        const history = conversationHistory.get(phone);

        history.push({ role: 'user', content: userMessage });
        while (history.length > MAX_HISTORY_PAIRS * 2) history.splice(0, 2);

        // Panggil Groq API
        const response = await axios.post(GROQ_API_URL, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...history
            ],
            max_tokens: maxTokens,
            temperature: 0.5  // lebih rendah = lebih konsisten/faktual
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        const aiText = response.data?.choices?.[0]?.message?.content?.trim();
        if (!aiText) return null;

        history.push({ role: 'assistant', content: aiText });

        const usage = response.data?.usage;
        if (usage) {
            console.log(`[AI-AGENT] ${phone} | ${model} | in:${usage.prompt_tokens} out:${usage.completion_tokens} tokens`);
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

// ═══════════════════════════════════════════════════════════════════
// 5. TEST (dari halaman pengaturan — tidak simpan ke history)
// ═══════════════════════════════════════════════════════════════════
async function testAIReply(pool, apiKey, model, basePrompt, testMessage) {
    // Untuk test, tetap sertakan konteks sistem dari DB (paket + company)
    let systemPrompt = basePrompt || DEFAULT_BASE_PROMPT;
    if (pool) {
        try {
            const sysCtx = await getSystemContext(pool);
            const mockCustCtx = null; // test tanpa data pelanggan spesifik
            systemPrompt = buildSystemPrompt(basePrompt || DEFAULT_BASE_PROMPT, sysCtx, mockCustCtx);
        } catch (_) {}
    }

    const response = await axios.post(GROQ_API_URL, {
        model: model || 'llama-3.1-8b-instant',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: testMessage || 'Halo, ada paket internet apa saja?' }
        ],
        max_tokens: 400,
        temperature: 0.5
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || '(tidak ada balasan)';
}

function clearHistory(phone) {
    conversationHistory.delete(phone);
    lastMessageTime.delete(phone);
}

// ─── Default base prompt (bisa di-override dari pengaturan) ──────────────────
const DEFAULT_BASE_PROMPT = `Kamu adalah asisten CS (Customer Service) dari perusahaan ISP yang ramah, sopan, dan profesional.
Tugasmu membantu pelanggan via WhatsApp menjawab pertanyaan tentang layanan internet.

Panduan menjawab:
- Jawab HANYA berdasarkan data yang disediakan di bawah ini
- Jika info tidak tersedia, katakan jujur dan arahkan ke CS manusia
- Bahasa Indonesia yang natural, singkat, dan mudah dipahami
- Maksimal 4 kalimat per balasan
- Gunakan sapaan "Kak [nama]" jika nama pelanggan diketahui`;

module.exports = { getAIReply, clearHistory, testAIReply, invalidateSystemCache, DEFAULT_BASE_PROMPT };
