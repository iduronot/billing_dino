/**
 * Xendit QRIS Payment Helper
 * Docs: https://developers.xendit.co/api-reference/#qr-codes
 */
const axios = require('axios');

async function getXenditSettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('xendit_api_key','xendit_webhook_token','xendit_callback_url')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

function getAuthHeader(apiKey) {
    return 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
}

/**
 * Buat QR Code dinamis untuk satu invoice
 * @param {Object} pool
 * @param {Object} params - { invoiceId, amount, customerName, externalId }
 * @returns {{ success, qrString, qrImageUrl, referenceId, expiresAt }}
 */
async function createQRCode(pool, params) {
    try {
        const s = await getXenditSettings(pool);
        if (!s.xendit_api_key) {
            return { success: false, message: 'Xendit API Key belum dikonfigurasi' };
        }

        const referenceId = `INV-${params.invoiceId}-${Date.now()}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 jam

        const payload = {
            reference_id: referenceId,
            type: 'DYNAMIC',
            currency: 'IDR',
            amount: parseInt(params.amount),
            expires_at: expiresAt,
            metadata: {
                invoice_id: params.invoiceId,
                customer_name: params.customerName || ''
            }
        };

        const res = await axios.post('https://api.xendit.co/qr_codes', payload, {
            headers: {
                Authorization: getAuthHeader(s.xendit_api_key),
                'Content-Type': 'application/json',
                'api-version': '2022-07-31'
            },
            timeout: 15000
        });

        const data = res.data;
        return {
            success: true,
            data: {
                referenceId: data.reference_id,
                qrString: data.qr_string,
                qrImageUrl: data.qr_image_url || null,
                amount: data.amount,
                expiresAt: data.expires_at,
                status: data.status
            }
        };
    } catch (e) {
        const msg = e.response?.data?.message || e.response?.data?.error_code || e.message;
        console.error('[Xendit] createQRCode error:', msg);
        return { success: false, message: msg };
    }
}

/**
 * Verifikasi webhook callback dari Xendit
 * Header: x-callback-token harus cocok dengan xendit_webhook_token di settings
 */
function verifyWebhookToken(headerToken, webhookToken) {
    if (!webhookToken) return false;
    return headerToken === webhookToken;
}

/**
 * Ambil detail QR Code dari Xendit (untuk cek status manual)
 */
async function getQRCode(pool, referenceId) {
    try {
        const s = await getXenditSettings(pool);
        if (!s.xendit_api_key) return { success: false, message: 'API Key tidak ada' };

        const res = await axios.get(`https://api.xendit.co/qr_codes/${referenceId}`, {
            headers: {
                Authorization: getAuthHeader(s.xendit_api_key),
                'api-version': '2022-07-31'
            },
            timeout: 10000
        });

        return { success: true, data: res.data };
    } catch (e) {
        return { success: false, message: e.response?.data?.message || e.message };
    }
}

/**
 * Test koneksi ke Xendit API
 */
async function testConnection(pool) {
    try {
        const s = await getXenditSettings(pool);
        if (!s.xendit_api_key) return { success: false, message: 'API Key belum diisi' };

        // Gunakan endpoint balance sebagai health check
        const res = await axios.get('https://api.xendit.co/balance', {
            headers: { Authorization: getAuthHeader(s.xendit_api_key) },
            timeout: 8000
        });

        return { success: true, message: `Koneksi berhasil. Balance: IDR ${(res.data.balance || 0).toLocaleString('id-ID')}` };
    } catch (e) {
        const msg = e.response?.data?.message || e.message;
        return { success: false, message: 'Gagal terhubung: ' + msg };
    }
}

module.exports = {
    createQRCode,
    verifyWebhookToken,
    getQRCode,
    testConnection,
    getXenditSettings
};
