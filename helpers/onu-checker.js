/**
 * ONU Checker — query status ONU dari DB untuk bot Telegram & WA
 * Data: hioso_onus (rx/tx power) + acs_devices (redaman ACS) + customers
 */

// Ambil indikator sinyal berdasarkan rx_power (dBm)
function signalIcon(rxPower) {
    const v = parseFloat(rxPower);
    if (isNaN(v) || v === 0) return '⚫';
    if (v >= -27)             return '🟢'; // Normal
    if (v >= -30)             return '🟡'; // Lemah
    return '🔴';                           // Kritis
}

function signalLabel(rxPower) {
    const v = parseFloat(rxPower);
    if (isNaN(v) || v === 0) return 'N/A';
    if (v >= -27)             return 'Normal';
    if (v >= -30)             return 'Lemah';
    return 'Kritis';
}

/**
 * Format detail satu ONU menjadi pesan teks siap kirim
 */
function formatONUDetail(onu, acsDevice) {
    const statusIcon = onu.status === 'Up' ? '🟢' : '🔴';
    const rxIcon     = onu.status === 'Up' ? signalIcon(onu.rx_power) : '⚫';
    const rxLabel    = onu.status === 'Up' ? signalLabel(onu.rx_power) : '-';
    const rxVal      = (onu.rx_power && parseFloat(onu.rx_power) !== 0)
                       ? `${onu.rx_power} dBm` : 'N/A';
    const txVal      = (onu.tx_power && parseFloat(onu.tx_power) !== 0)
                       ? `${onu.tx_power} dBm` : 'N/A';

    const updated = onu.last_updated
        ? new Date(onu.last_updated).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
        : '-';

    let msg = `📡 *${onu.name}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `${statusIcon} Status: *${onu.status === 'Up' ? 'ONLINE' : 'OFFLINE'}*\n`;
    msg += `${rxIcon} Rx Power: *${rxVal}* (${rxLabel})\n`;
    msg += `📤 Tx Power: ${txVal}\n`;
    if (onu.sn && onu.sn !== 'Unknown') msg += `🔢 SN: ${onu.sn}\n`;
    msg += `🔌 OLT: ${onu.olt_name || '-'}\n`;

    // Info pelanggan jika sudah dipetakan
    if (onu.customer_name) {
        msg += `👤 Pelanggan: *${onu.customer_name}*\n`;
        if (onu.customer_phone) msg += `📱 HP: ${onu.customer_phone}\n`;
        if (onu.package_name)   msg += `📦 Paket: ${onu.package_name}\n`;
        if (onu.customer_address) msg += `🏠 Alamat: ${onu.customer_address}\n`;
    }

    // Data dari GenieACS jika ada
    if (acsDevice) {
        msg += `━━━━━━━━━━━━━━━━━━\n`;
        msg += `📊 *Data ACS (dari ONT):*\n`;
        try {
            const vp = typeof acsDevice.vparams === 'string'
                ? JSON.parse(acsDevice.vparams)
                : (acsDevice.vparams || {});

            if (vp['VirtualParameters.redaman'] && vp['VirtualParameters.redaman'] !== 'N/A') {
                const red = vp['VirtualParameters.redaman'];
                const redIcon = parseFloat(red) >= -27 ? '🟢' : parseFloat(red) >= -30 ? '🟡' : '🔴';
                msg += `${redIcon} Redaman: *${red} dBm*\n`;
            }
            if (vp['VirtualParameters.uptimeDevice']) {
                msg += `⏱ Uptime: ${vp['VirtualParameters.uptimeDevice']}\n`;
            }
            if (vp['VirtualParameters.userconnected'] !== undefined) {
                msg += `👥 User konek: ${vp['VirtualParameters.userconnected']}\n`;
            }
        } catch (_) {}

        if (acsDevice.ip_address) msg += `🌐 IP: ${acsDevice.ip_address}\n`;
    }

    msg += `🕐 Update: ${updated}`;
    return msg;
}

/**
 * Cari ONU berdasarkan keyword (nama ONU atau nama pelanggan)
 * Returns: array ONU (max 5), masing-masing sudah join customer + ACS
 */
async function searchONU(pool, keyword) {
    const kw = `%${keyword}%`;

    const [onus] = await pool.query(`
        SELECT
            u.id, u.name, u.sn, u.mac, u.tx_power, u.rx_power,
            u.status, u.last_updated, u.olt_id,
            o.name  AS olt_name,
            o.brand AS olt_brand,
            c.id    AS customer_id,
            c.name  AS customer_name,
            c.phone AS customer_phone,
            c.address AS customer_address,
            p.name  AS package_name
        FROM hioso_onus u
        JOIN hioso_olts o ON u.olt_id = o.id
        LEFT JOIN customers c ON c.id = u.customer_id
        LEFT JOIN packages  p ON p.id = c.package_id
        WHERE u.name LIKE ?
           OR u.sn   LIKE ?
           OR c.name LIKE ?
        ORDER BY u.status DESC, u.name ASC
        LIMIT 5
    `, [kw, kw, kw]).catch(() => [[]]);

    if (!onus || onus.length === 0) return [];

    // Ambil data ACS untuk setiap ONU via MAC address
    const result = [];
    for (const onu of onus) {
        let acsDevice = null;
        if (onu.mac && onu.mac.trim() && onu.mac !== '0:0:0:0:0:0') {
            const macClean = onu.mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
            const [[dev]] = await pool.query(
                `SELECT status, ip_address, vparams FROM acs_devices
                 WHERE UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) LIKE ?
                 LIMIT 1`,
                [`%${macClean.slice(-6)}%`]
            ).catch(() => [[]]);
            if (dev) acsDevice = dev;
        }
        // Fallback: cari via pppoe_username jika customer diketahui
        if (!acsDevice && onu.customer_id) {
            const [[cust]] = await pool.query(
                'SELECT pppoe_username FROM customers WHERE id = ?', [onu.customer_id]
            ).catch(() => [[]]);
            if (cust && cust.pppoe_username) {
                const [[dev]] = await pool.query(
                    `SELECT status, ip_address, vparams FROM acs_devices
                     WHERE vparams LIKE ? LIMIT 1`,
                    [`%${cust.pppoe_username}%`]
                ).catch(() => [[]]);
                if (dev) acsDevice = dev;
            }
        }
        result.push({ onu, acsDevice });
    }
    return result;
}

/**
 * List ONU dengan sinyal lemah (rx_power < -27 dBm & status Up)
 */
async function getWeakONUs(pool, threshold = -27) {
    const [onus] = await pool.query(`
        SELECT u.name, u.rx_power, u.tx_power, u.status, u.last_updated,
               o.name AS olt_name,
               c.name AS customer_name
        FROM hioso_onus u
        JOIN hioso_olts o ON u.olt_id = o.id
        LEFT JOIN customers c ON c.id = u.customer_id
        WHERE u.status = 'Up'
          AND CAST(u.rx_power AS DECIMAL(10,2)) < ?
        ORDER BY CAST(u.rx_power AS DECIMAL(10,2)) ASC
        LIMIT 20
    `, [threshold]).catch(() => [[]]);

    return onus || [];
}

/**
 * Ringkasan status semua OLT
 */
async function getOLTSummary(pool) {
    const [rows] = await pool.query(`
        SELECT o.name AS olt_name,
               COUNT(*) AS total,
               SUM(u.status = 'Up')   AS online,
               SUM(u.status = 'Down') AS offline,
               SUM(CASE WHEN u.status='Up' AND CAST(u.rx_power AS DECIMAL(10,2)) < -30 THEN 1 ELSE 0 END) AS kritis,
               SUM(CASE WHEN u.status='Up' AND CAST(u.rx_power AS DECIMAL(10,2)) BETWEEN -30 AND -27 THEN 1 ELSE 0 END) AS lemah
        FROM hioso_onus u
        JOIN hioso_olts o ON u.olt_id = o.id
        GROUP BY o.id, o.name
        ORDER BY o.name ASC
    `).catch(() => [[]]);

    return rows || [];
}

module.exports = { searchONU, formatONUDetail, getWeakONUs, getOLTSummary, signalIcon, signalLabel };
