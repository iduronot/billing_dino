const express = require('express');
const router  = express.Router();
let pool;
router.setPool = (p) => { pool = p; };

// GET /expenses
router.get('/', async (req, res) => {
    try {
        const page      = Math.max(1, parseInt(req.query.page) || 1);
        const perPage   = 20;
        const offset    = (page - 1) * perPage;
        const search    = req.query.search    || '';
        const catFilter = req.query.category  || '';
        const monthFilter = req.query.month   || '';
        const yearFilter  = req.query.year    || new Date().getFullYear();

        const conds = [], params = [];
        if (search)    { conds.push('(e.description LIKE ? OR e.notes LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
        if (catFilter) { conds.push('e.category_id = ?'); params.push(catFilter); }
        if (monthFilter) { conds.push('MONTH(e.date) = ?'); params.push(monthFilter); }
        conds.push('YEAR(e.date) = ?'); params.push(yearFilter);
        const where = 'WHERE ' + conds.join(' AND ');

        const [expenses] = await pool.query(
            `SELECT e.*, c.name as category_name, c.color as category_color, c.icon as category_icon
             FROM expenses e LEFT JOIN expense_categories c ON e.category_id = c.id
             ${where} ORDER BY e.date DESC, e.id DESC LIMIT ${perPage} OFFSET ${offset}`,
            params
        );
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM expenses e LEFT JOIN expense_categories c ON e.category_id = c.id ${where}`,
            params
        );

        // Stats bulan/tahun terpilih
        const statConds  = ['YEAR(date) = ?'];
        const statParams = [yearFilter];
        if (monthFilter) { statConds.push('MONTH(date) = ?'); statParams.push(monthFilter); }
        const statWhere = 'WHERE ' + statConds.join(' AND ');

        const [[stats]] = await pool.query(
            `SELECT COALESCE(SUM(amount),0) as totalExpense, COUNT(*) as totalCount,
                    MAX(amount) as maxExpense, MIN(amount) as minExpense,
                    AVG(amount) as avgExpense
             FROM expenses ${statWhere}`, statParams
        );

        const [byCategory] = await pool.query(
            `SELECT c.name, c.color, c.icon, COALESCE(SUM(e.amount),0) as total, COUNT(e.id) as count
             FROM expense_categories c
             LEFT JOIN expenses e ON e.category_id = c.id AND ${statConds.map(c => c.replace('date','e.date')).join(' AND ')}
             GROUP BY c.id, c.name, c.color, c.icon HAVING total > 0 ORDER BY total DESC`,
            statParams
        );

        // Trend harian dalam bulan terpilih
        const trendMonth = monthFilter || new Date().getMonth() + 1;
        const [dailyTrend] = await pool.query(
            `SELECT DAY(date) as day, COALESCE(SUM(amount),0) as total
             FROM expenses WHERE MONTH(date)=? AND YEAR(date)=?
             GROUP BY DAY(date) ORDER BY day ASC`,
            [trendMonth, yearFilter]
        );

        // Perbandingan pemasukan vs pengeluaran 6 bulan
        const monthlyComparison = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(); d.setMonth(d.getMonth() - i);
            const m = d.getMonth() + 1; const y = d.getFullYear();
            const label = d.toLocaleString('id-ID', { month: 'short', year: 'numeric' });
            const [[{ rev }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as rev FROM invoices WHERE status='paid' AND MONTH(paid_at)=? AND YEAR(paid_at)=?", [m, y]);
            const [[{ exp }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as exp FROM expenses WHERE MONTH(date)=? AND YEAR(date)=?", [m, y]);
            monthlyComparison.push({ month: label, revenue: parseFloat(rev), expense: parseFloat(exp), profit: parseFloat(rev) - parseFloat(exp) });
        }

        const [categories] = await pool.query('SELECT * FROM expense_categories ORDER BY name ASC');

        // Data per kategori per bulan (6 bulan terakhir) untuk stacked bar chart
        const [categoryMonthly] = await pool.query(`
            SELECT
                c.name     as category_name,
                c.color    as color,
                MONTH(e.date) as month,
                YEAR(e.date)  as year,
                COALESCE(SUM(e.amount), 0)  as total,
                COUNT(e.id)                 as count
            FROM expense_categories c
            LEFT JOIN expenses e ON e.category_id = c.id
                AND e.date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
            GROUP BY c.id, c.name, c.color, MONTH(e.date), YEAR(e.date)
            HAVING total > 0
            ORDER BY year ASC, month ASC, total DESC
        `);

        res.render('expenses', {
            user: req.session, expenses, categories, stats, byCategory,
            dailyTrend, monthlyComparison,
            pagination: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
            search, catFilter, monthFilter, yearFilter: parseInt(yearFilter),
            categoryMonthly: categoryMonthly || [],
            currentPage: 'expenses'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

// POST /expenses/api/add
router.post('/api/add', async (req, res) => {
    try {
        const { category_id, amount, date, description, notes } = req.body;
        if (!amount || !date) return res.json({ success: false, message: 'Jumlah dan tanggal wajib diisi' });
        const user = req.session.username || 'admin';
        await pool.query(
            'INSERT INTO expenses (category_id, amount, date, description, notes, created_by) VALUES (?,?,?,?,?,?)',
            [category_id || null, parseFloat(amount), date, description || '', notes || '', user]
        );
        res.json({ success: true, message: 'Pengeluaran berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /expenses/api/:id
router.put('/api/:id', async (req, res) => {
    try {
        const { category_id, amount, date, description, notes } = req.body;
        await pool.query(
            'UPDATE expenses SET category_id=?, amount=?, date=?, description=?, notes=? WHERE id=?',
            [category_id || null, parseFloat(amount), date, description || '', notes || '', req.params.id]
        );
        res.json({ success: true, message: 'Pengeluaran berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /expenses/api/:id
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM expenses WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Pengeluaran dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── Kategori ──
router.get('/categories', async (req, res) => {
    try {
        const [categories] = await pool.query(
            `SELECT c.*, COUNT(e.id) as expense_count, COALESCE(SUM(e.amount),0) as total_amount
             FROM expense_categories c LEFT JOIN expenses e ON e.category_id = c.id
             GROUP BY c.id ORDER BY c.name ASC`
        );
        res.render('expense_categories', { user: req.session, categories, currentPage: 'expenses' });
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

router.post('/api/categories', async (req, res) => {
    try {
        const { name, color, icon, description } = req.body;
        if (!name) return res.json({ success: false, message: 'Nama kategori wajib diisi' });
        await pool.query(
            'INSERT INTO expense_categories (name, color, icon, description) VALUES (?,?,?,?)',
            [name, color || '#6366F1', icon || 'fa-tag', description || '']
        );
        res.json({ success: true, message: 'Kategori berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/categories/:id', async (req, res) => {
    try {
        const { name, color, icon, description } = req.body;
        await pool.query(
            'UPDATE expense_categories SET name=?, color=?, icon=?, description=? WHERE id=?',
            [name, color || '#6366F1', icon || 'fa-tag', description || '', req.params.id]
        );
        res.json({ success: true, message: 'Kategori berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/categories/:id', async (req, res) => {
    try {
        const [[{ cnt }]] = await pool.query('SELECT COUNT(*) as cnt FROM expenses WHERE category_id=?', [req.params.id]);
        if (parseInt(cnt) > 0) return res.json({ success: false, message: `Kategori masih digunakan oleh ${cnt} pengeluaran. Pindahkan dulu sebelum menghapus.` });
        await pool.query('DELETE FROM expense_categories WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'Kategori dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /expenses/api/summary — untuk API chart
router.get('/api/summary', async (req, res) => {
    try {
        const month = req.query.month || new Date().getMonth() + 1;
        const year  = req.query.year  || new Date().getFullYear();
        const [[{ totalExpense }]] = await pool.query(
            'SELECT COALESCE(SUM(amount),0) as totalExpense FROM expenses WHERE MONTH(date)=? AND YEAR(date)=?',
            [month, year]
        );
        const [[{ totalRevenue }]] = await pool.query(
            'SELECT COALESCE(SUM(amount),0) as totalRevenue FROM invoices WHERE status="paid" AND MONTH(paid_at)=? AND YEAR(paid_at)=?',
            [month, year]
        );
        res.json({ success: true, totalExpense: parseFloat(totalExpense), totalRevenue: parseFloat(totalRevenue), profit: parseFloat(totalRevenue) - parseFloat(totalExpense) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
