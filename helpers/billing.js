/**
 * Billing Helper — logika inti billing yang dipakai bersama
 * ------------------------------------------------------------------
 * Dibuat saat refactor (audit 2026-09):
 *   - markInvoicePaid()      → alur lunas lengkap (dipakai 4 jalur bayar)
 *   - activateAfterPayment() → unisolate + enable PPPoE MikroTik
 *   - applyRollingBilling()  → auto-switch rolling (bayar tgl ≥ 25) + invoice +30 hari
 *   - isolateCustomer()      → isolir inti: UPDATE status + disable PPPoE MikroTik
 *
 * Aturan: jangan duplikasi logika ini di route/cron — panggil fungsi di sini.
 */

const mikrotik = require('./mikrotik');
const { notifyPaymentReceived } = require('./notification');

/**
 * Unisolate pelanggan + nyalakan lagi PPPoE di MikroTik (jika sebelumnya isolated).
 * @param {Object} pool  - mysql2 pool
 * @param {Object} customer - row customers + field router (r_ip, r_user, r_pass, r_port)
 * @returns {Boolean} true jika pelanggan baru saja diaktifkan
 */
async function activateAfterPayment(pool, customer) {
    if (customer.status !== 'isolated') return false;
    await pool.query("UPDATE customers SET status='active' WHERE id=?", [customer.id]);
    customer.status = 'active';
    if (customer.pppoe_username && customer.r_ip) {
        await mikrotik.enablePPPoESecret(
            { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port },
            customer.pppoe_username
        ).catch(e => console.error(`[Billing] MikroTik activation failed: ${e.message}`));
    }
    return true;
}

/**
 * Rolling billing: bayar pada/tanggal 25 ke atas → auto-switch ke rolling,
 * lalu buat invoice berikutnya jatuh tempo +30 hari (anti duplikat).
 */
async function applyRollingBilling(pool, customer) {
    const today = new Date();
    let billingMethod = customer.billing_method || 'fixed';

    if (today.getDate() >= 25) {
        billingMethod = 'rolling';
        await pool.query("UPDATE customers SET billing_method='rolling' WHERE id=?", [customer.id]);
        customer.billing_method = 'rolling';
    }

    if (billingMethod === 'rolling') {
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + 30);
        const nextDueStr = nextDue.toISOString().split('T')[0];

        const [[exists]] = await pool.query(
            'SELECT id FROM invoices WHERE customer_id=? AND due_date=?',
            [customer.id, nextDueStr]
        );
        if (!exists) {
            const [pkg] = await pool.query('SELECT price FROM packages WHERE id=?', [customer.package_id]);
            const amount = pkg[0] ? pkg[0].price : 0;
            await pool.query(
                'INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)',
                [customer.id, customer.package_id, amount, nextDueStr, 'unpaid']
            );
        }
    }
}

/**
 * Tandai invoice lunas + aktifkan layanan + notif WA + rolling billing.
 * Idempotent — aman dipanggul berkali-kali (webhook + polling bisa bareng).
 * @returns {Object} { success, already? }
 */
async function markInvoicePaid(pool, invoiceId, paymentMethod = 'Manual') {
    const [[inv]] = await pool.query('SELECT * FROM invoices WHERE id=?', [invoiceId]);
    if (!inv) return { success: false, message: 'Invoice tidak ditemukan' };
    if (inv.status === 'paid') return { success: true, already: true };

    await pool.query(
        "UPDATE invoices SET status='paid', paid_at=NOW(), payment_method=? WHERE id=?",
        [paymentMethod, invoiceId]
    );

    const [[cust]] = await pool.query(`
        SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port
        FROM customers c
        LEFT JOIN routers r ON c.router_id = r.id
        WHERE c.id = ?
    `, [inv.customer_id]);

    if (cust) {
        await activateAfterPayment(pool, cust);
        await notifyPaymentReceived(pool, cust, inv.amount);
        await applyRollingBilling(pool, cust);
    }
    return { success: true };
}

/**
 * Isolir satu pelanggan: UPDATE status (hanya jika masih active) + disable PPPoE.
 * @param {Object} customer - row customers + field router (r_ip, r_user, r_pass, r_port)
 * @returns {Object} { changed, mikrotikOk }
 */
async function isolateCustomer(pool, customer) {
    const [result] = await pool.query(
        "UPDATE customers SET status='isolated' WHERE id=? AND status='active'",
        [customer.id]
    );
    const changed = result.affectedRows > 0;

    let mikrotikOk = true;
    if (changed && customer.pppoe_username && customer.r_ip) {
        const r = await mikrotik.disablePPPoESecret(
            { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port },
            customer.pppoe_username
        );
        mikrotikOk = r.success;
        if (!r.success) console.log(`[MikroTik] Gagal isolir ${customer.pppoe_username}: ${r.message}`);
    }
    return { changed, mikrotikOk };
}

module.exports = {
    markInvoicePaid,
    activateAfterPayment,
    applyRollingBilling,
    isolateCustomer
};
