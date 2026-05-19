const express = require('express');
const router = express.Router();
let pool;
router.setPool = (p) => { pool = p; };

// GET - Dashboard inventory
router.get('/', async (req, res) => {
    try {
        const [items] = await pool.query('SELECT * FROM inventory ORDER BY name ASC');

        const [[stats]] = await pool.query(`
            SELECT
                COUNT(*) as total_items,
                COALESCE(SUM(stock * price), 0) as total_value,
                SUM(stock < min_stock AND min_stock > 0) as low_stock_count,
                SUM(stock = 0) as empty_count
            FROM inventory
        `);

        const [todayMutations] = await pool.query(`
            SELECT m.*, i.name as item_name, i.unit
            FROM inventory_mutations m
            JOIN inventory i ON m.inventory_id = i.id
            WHERE DATE(m.created_at) = CURDATE()
            ORDER BY m.created_at DESC
            LIMIT 20
        `);

        // Ambil teknisi yang terlibat di mutasi hari ini
        if (todayMutations.length > 0) {
            const mutIds = todayMutations.map(m => m.id);
            const [techRows] = await pool.query(
                `SELECT mutation_id, technician_name FROM mutation_technicians WHERE mutation_id IN (?)`,
                [mutIds]
            );
            const techMap = {};
            techRows.forEach(t => {
                if (!techMap[t.mutation_id]) techMap[t.mutation_id] = [];
                techMap[t.mutation_id].push(t.technician_name);
            });
            todayMutations.forEach(m => { m.technicians = techMap[m.id] || []; });
        }

        // Daftar teknisi untuk picker
        const [technicians] = await pool.query(
            `SELECT id, username FROM users WHERE role = 'technician' ORDER BY username ASC`
        );

        res.render('inventory', { items, stats, todayMutations, technicians, user: req.session, currentPage: 'inventory' });
    } catch (err) {
        res.status(500).send("Inventory error: " + err.message);
    }
});

// POST - Save item (add/edit)
router.post('/api/save', async (req, res) => {
    const { id, name, category, stock, unit, description, price, min_stock } = req.body;
    try {
        if (id) {
            await pool.query(
                'UPDATE inventory SET name=?, category=?, stock=?, unit=?, description=?, price=?, min_stock=? WHERE id=?',
                [name, category, stock, unit, description || '', price || 0, min_stock || 0, id]
            );
        } else {
            await pool.query(
                'INSERT INTO inventory (name, category, stock, unit, description, price, min_stock) VALUES (?,?,?,?,?,?,?)',
                [name, category, stock || 0, unit, description || '', price || 0, min_stock || 0]
            );
        }
        res.json({ success: true, message: 'Data barang berhasil disimpan' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST - Mutasi stok (masuk/keluar)
router.post('/api/mutasi', async (req, res) => {
    const { inventory_id, type, quantity, note, technician_ids } = req.body;
    const qty = parseInt(quantity);
    if (!inventory_id || !type || !qty || qty <= 0)
        return res.status(400).json({ success: false, message: 'Data tidak lengkap' });

    if (type === 'out' && (!technician_ids || technician_ids.length === 0))
        return res.status(400).json({ success: false, message: 'Pilih minimal satu teknisi untuk barang keluar' });

    try {
        const [[item]] = await pool.query('SELECT * FROM inventory WHERE id=?', [inventory_id]);
        if (!item) return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });

        if (type === 'out' && item.stock < qty)
            return res.json({ success: false, message: `Stok tidak cukup. Stok saat ini: ${item.stock} ${item.unit}` });

        const newStock = type === 'in' ? item.stock + qty : item.stock - qty;
        await pool.query('UPDATE inventory SET stock=? WHERE id=?', [newStock, inventory_id]);

        const [result] = await pool.query(
            'INSERT INTO inventory_mutations (inventory_id, type, quantity, note, user_name) VALUES (?,?,?,?,?)',
            [inventory_id, type, qty, note || '', req.session?.username || 'Admin']
        );
        const mutationId = result.insertId;

        // Simpan relasi teknisi (untuk barang keluar)
        if (type === 'out' && technician_ids && technician_ids.length > 0) {
            const ids = Array.isArray(technician_ids) ? technician_ids : [technician_ids];
            // Ambil nama teknisi
            const [techRows] = await pool.query(
                `SELECT id, username FROM users WHERE id IN (?)`, [ids]
            );
            if (techRows.length > 0) {
                const values = techRows.map(t => [mutationId, t.id, t.username]);
                await pool.query(
                    'INSERT INTO mutation_technicians (mutation_id, technician_id, technician_name) VALUES ?',
                    [values]
                );
            }
        }

        const techNames = type === 'out' && technician_ids?.length
            ? ' — diambil teknisi'
            : '';

        res.json({
            success: true,
            message: `Stok ${type === 'in' ? 'masuk' : 'keluar'} ${qty} ${item.unit} berhasil dicatat${techNames}`,
            newStock
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET - Riwayat mutasi per item (dengan teknisi)
router.get('/api/mutasi/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM inventory_mutations WHERE inventory_id=? ORDER BY created_at DESC LIMIT 50',
            [req.params.id]
        );

        if (rows.length > 0) {
            const mutIds = rows.map(r => r.id);
            const [techRows] = await pool.query(
                `SELECT mutation_id, technician_id, technician_name FROM mutation_technicians WHERE mutation_id IN (?)`,
                [mutIds]
            );
            const techMap = {};
            techRows.forEach(t => {
                if (!techMap[t.mutation_id]) techMap[t.mutation_id] = [];
                techMap[t.mutation_id].push(t.technician_name);
            });
            rows.forEach(r => { r.technicians = techMap[r.id] || []; });
        }

        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// DELETE - Hapus item
router.delete('/api/:id', async (req, res) => {
    try {
        // Hapus technician relations dulu
        const [muts] = await pool.query('SELECT id FROM inventory_mutations WHERE inventory_id=?', [req.params.id]);
        if (muts.length > 0) {
            const mutIds = muts.map(m => m.id);
            await pool.query('DELETE FROM mutation_technicians WHERE mutation_id IN (?)', [mutIds]);
        }
        await pool.query('DELETE FROM inventory_mutations WHERE inventory_id=?', [req.params.id]);
        await pool.query('DELETE FROM inventory WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Barang berhasil dihapus' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
