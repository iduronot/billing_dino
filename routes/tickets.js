const express = require('express');
const router  = express.Router();
const { notifyTicketCreated, notifyTicketAssigned, notifyTicketClosed } = require('../helpers/notification');
let pool;
router.setPool = (p) => { pool = p; };

const CATEGORIES = ['gangguan','no_signal','lambat','billing','pasang_baru','relokasi','lain-lain'];
const PRIORITIES  = ['low','normal','high','critical'];

// ── GET /tickets ──
router.get('/', async (req, res) => {
    try {
        const isTechnicianRole = req.session.role === 'technician';
        const statusFilter   = req.query.status   || (isTechnicianRole ? 'all' : 'open');
        const priorityFilter = req.query.priority || '';
        const catFilter      = req.query.category || '';
        const techFilter     = req.query.tech     || '';
        const search         = req.query.search   || '';
        const page           = Math.max(1, parseInt(req.query.page)||1);
        const perPage        = 20;

        const isTechnician = isTechnicianRole;
        const conds = [], params = [];
        if (statusFilter !== 'all') { conds.push('t.status=?'); params.push(statusFilter); }
        if (priorityFilter) { conds.push('t.priority=?'); params.push(priorityFilter); }
        if (catFilter)      { conds.push('t.category=?'); params.push(catFilter); }
        // Teknisi hanya lihat tiket yang ditugaskan ke dia (via junction table atau technician_id)
        if (isTechnician) {
            conds.push(`(t.technician_id=? OR EXISTS (
                SELECT 1 FROM ticket_technicians tt WHERE tt.ticket_id=t.id AND tt.technician_id=?
            ))`);
            params.push(req.session.userId, req.session.userId);
        } else if (techFilter) {
            conds.push('t.technician_id=?'); params.push(techFilter);
        }
        if (search) { conds.push('(t.title LIKE ? OR c.name LIKE ? OR t.description LIKE ?)'); params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
        const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';

        const [tickets] = await pool.query(`
            SELECT t.*,
                   c.name as customer_name, c.phone as customer_phone,
                   u.username as technician_name,
                   (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id=t.id) as comment_count,
                   TIMESTAMPDIFF(HOUR, t.created_at, IFNULL(t.resolved_at, NOW())) as age_hours,
                   COALESCE(
                       (SELECT GROUP_CONCAT(us.username ORDER BY us.username SEPARATOR ',')
                        FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                        WHERE tt.ticket_id=t.id),
                       u.username
                   ) as technician_names,
                   COALESCE(
                       (SELECT GROUP_CONCAT(tt.technician_id ORDER BY us.username SEPARATOR ',')
                        FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                        WHERE tt.ticket_id=t.id),
                       CAST(t.technician_id AS CHAR)
                   ) as technician_ids
            FROM trouble_tickets t
            LEFT JOIN customers c ON c.id=t.customer_id
            LEFT JOIN users u ON u.id=t.technician_id
            ${where}
            ORDER BY FIELD(t.priority,'critical','high','normal','low'), t.created_at DESC
            LIMIT ${perPage} OFFSET ${(page-1)*perPage}`, params);

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM trouble_tickets t LEFT JOIN customers c ON c.id=t.customer_id ${where}`, params);

        const [[stats]] = await pool.query(`
            SELECT
                SUM(status='open')                              as open_count,
                SUM(status='in_progress')                      as inprogress_count,
                SUM(status='closed')                           as closed_count,
                SUM(status='open' AND priority='critical')     as critical_count,
                SUM(status='open' AND priority='high')         as high_count,
                SUM(status='open' AND technician_id IS NULL)   as unassigned_count,
                AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR,created_at,resolved_at) END) as avg_resolve_hours
            FROM trouble_tickets`);

        const [customers]   = await pool.query('SELECT id, name FROM customers ORDER BY name ASC');
        const [technicians] = await pool.query("SELECT id, username FROM users WHERE role='technician' ORDER BY username ASC");

        res.render('tickets', {
            user: req.session, tickets, customers, technicians, stats: stats||{},
            pagination: { total, page, perPage, totalPages: Math.ceil(total/perPage) },
            statusFilter, priorityFilter, catFilter, techFilter, search,
            categories: CATEGORIES,
            isTechnician,
            currentPage: 'tickets'
        });
    } catch(err) { console.error(err); res.status(500).send("Error: "+err.message); }
});

// ── GET /tickets/:id — detail tiket ──
router.get('/:id', async (req, res) => {
    try {
        const [[ticket]] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
                   u.username as technician_name, u.telegram_id as technician_telegram
            FROM trouble_tickets t
            LEFT JOIN customers c ON c.id=t.customer_id
            LEFT JOIN users u ON u.id=t.technician_id
            WHERE t.id=?`, [req.params.id]);

        // Ambil semua teknisi yang ditugaskan
        const [assignedTechs] = await pool.query(`
            SELECT u.id, u.username FROM ticket_technicians tt
            JOIN users u ON u.id=tt.technician_id
            WHERE tt.ticket_id=? ORDER BY u.username ASC`, [req.params.id]);
        if (!ticket) return res.status(404).send('Tiket tidak ditemukan');

        const [comments] = await pool.query(
            'SELECT * FROM ticket_comments WHERE ticket_id=? ORDER BY created_at ASC', [req.params.id]);
        const [customers]   = await pool.query('SELECT id, name FROM customers ORDER BY name ASC');
        const [technicians] = await pool.query("SELECT id, username FROM users WHERE role='technician' ORDER BY username ASC");

        res.render('ticket_detail', {
            user: req.session, ticket, comments, customers, technicians,
            assignedTechs, categories: CATEGORIES, currentPage: 'tickets'
        });
    } catch(err) { res.status(500).send("Error: "+err.message); }
});

// ── POST /api/create ──
router.post('/api/create', async (req, res) => {
    try {
        const { customer_id, title, description, priority, category, location, lat, lng, source } = req.body;
        if (!title) return res.json({ success:false, message:'Judul tiket wajib diisi' });
        const [r] = await pool.query(
            'INSERT INTO trouble_tickets (customer_id,title,description,priority,category,location,lat,lng,status,source) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [customer_id||null, title, description||'', priority||'normal', category||'gangguan', location||null, lat||null, lng||null, 'open', source||'admin']
        );
        // Jika ada technician_id dari create, tambah ke junction table juga
        const techId = req.body.technician_id;
        const techIds = techId ? [techId] : [];
        if (techId) {
            await pool.query('INSERT IGNORE INTO ticket_technicians (ticket_id, technician_id) VALUES (?,?)', [r.insertId, techId]);
        }
        // Notifikasi WA/Telegram
        const [[newTicket]] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.phone as customer_phone
            FROM trouble_tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`, [r.insertId]);
        notifyTicketCreated(pool, newTicket, techIds).catch(()=>{});
        res.json({ success:true, id:r.insertId, message:'Tiket berhasil dibuat' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── PUT /api/:id ──
router.put('/api/:id', async (req, res) => {
    try {
        const { title, description, priority, category, technician_id, location, status } = req.body;
        await pool.query(
            'UPDATE trouble_tickets SET title=?,description=?,priority=?,category=?,technician_id=?,location=?,status=? WHERE id=?',
            [title, description||'', priority||'normal', category||'gangguan', technician_id||null, location||null, status||'open', req.params.id]
        );
        // Tambah komentar otomatis jika status berubah
        if (status === 'in_progress') {
            const techName = req.session.username;
            await pool.query('INSERT INTO ticket_comments (ticket_id,username,role,comment) VALUES (?,?,?,?)',
                [req.params.id, techName, req.session.role, `Tiket diambil oleh ${techName}`]);
        }
        res.json({ success:true, message:'Tiket diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── POST /api/:id/assign — tambah satu teknisi ──
router.post('/api/:id/assign', async (req, res) => {
    try {
        const { technician_id } = req.body;
        if (!technician_id) return res.json({ success:false, message:'Pilih teknisi' });
        const [[tech]] = await pool.query('SELECT username FROM users WHERE id=?', [technician_id]);
        if (!tech) return res.json({ success:false, message:'Teknisi tidak ditemukan' });

        // Insert ke junction table (ignore jika sudah ada)
        await pool.query('INSERT IGNORE INTO ticket_technicians (ticket_id, technician_id) VALUES (?,?)', [req.params.id, technician_id]);

        // Sync: jika ada technician_id lama di tabel utama yang belum di junction table, tambahkan
        const [[existingTech]] = await pool.query('SELECT technician_id FROM trouble_tickets WHERE id=? AND technician_id IS NOT NULL', [req.params.id]);
        if (existingTech && existingTech.technician_id && existingTech.technician_id != technician_id) {
            await pool.query('INSERT IGNORE INTO ticket_technicians (ticket_id, technician_id) VALUES (?,?)', [req.params.id, existingTech.technician_id]);
        }
        // Update technician_id di tabel utama (sebagai primary assignee)
        await pool.query('UPDATE trouble_tickets SET technician_id=?, status=IF(status="open","in_progress",status) WHERE id=?', [technician_id, req.params.id]);
        await pool.query('INSERT INTO ticket_comments (ticket_id,username,role,comment) VALUES (?,?,?,?)',
            [req.params.id, req.session.username, req.session.role, `👷 Teknisi ditambahkan: ${tech.username}`]);
        // Notifikasi ke teknisi
        const [[tkt]] = await pool.query(`SELECT t.*, c.name as customer_name FROM trouble_tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`, [req.params.id]);
        notifyTicketAssigned(pool, tkt, technician_id).catch(()=>{});
        res.json({ success:true, message:`${tech.username} ditambahkan ke tiket` });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── DELETE /api/:id/assign/:techId — hapus satu teknisi ──
router.delete('/api/:id/assign/:techId', async (req, res) => {
    try {
        const [[tech]] = await pool.query('SELECT username FROM users WHERE id=?', [req.params.techId]);
        await pool.query('DELETE FROM ticket_technicians WHERE ticket_id=? AND technician_id=?', [req.params.id, req.params.techId]);
        // Update primary assignee ke teknisi pertama yg tersisa, atau null
        const [[first]] = await pool.query('SELECT technician_id FROM ticket_technicians WHERE ticket_id=? LIMIT 1', [req.params.id]);
        await pool.query('UPDATE trouble_tickets SET technician_id=? WHERE id=?', [first?.technician_id||null, req.params.id]);
        await pool.query('INSERT INTO ticket_comments (ticket_id,username,role,comment) VALUES (?,?,?,?)',
            [req.params.id, req.session.username, req.session.role, `👷 Teknisi dilepas: ${tech?.username||'-'}`]);
        res.json({ success:true, message:'Teknisi dilepas dari tiket' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── POST /api/:id/close ──
router.post('/api/:id/close', async (req, res) => {
    try {
        const { response_note } = req.body;
        await pool.query("UPDATE trouble_tickets SET status='closed', resolved_at=NOW(), response_note=? WHERE id=?",
            [response_note||null, req.params.id]);
        if (response_note) {
            await pool.query('INSERT INTO ticket_comments (ticket_id,username,role,comment) VALUES (?,?,?,?)',
                [req.params.id, req.session.username, req.session.role, `✅ Tiket diselesaikan: ${response_note}`]);
        }
        // Notifikasi ke admin
        const [[closedTkt]] = await pool.query(`SELECT t.*, c.name as customer_name FROM trouble_tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`, [req.params.id]);
        if (closedTkt) { closedTkt.response_note = response_note; notifyTicketClosed(pool, closedTkt).catch(()=>{}); }
        res.json({ success:true, message:'Tiket berhasil ditutup' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── POST /api/:id/reopen ──
router.post('/api/:id/reopen', async (req, res) => {
    try {
        await pool.query("UPDATE trouble_tickets SET status='open', resolved_at=NULL WHERE id=?", [req.params.id]);
        await pool.query('INSERT INTO ticket_comments (ticket_id,username,role,comment) VALUES (?,?,?,?)',
            [req.params.id, req.session.username, req.session.role, '🔄 Tiket dibuka kembali']);
        res.json({ success:true, message:'Tiket dibuka kembali' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── POST /api/:id/comment ──
router.post('/api/:id/comment', async (req, res) => {
    try {
        const { comment, is_internal } = req.body;
        if (!comment) return res.json({ success:false, message:'Komentar tidak boleh kosong' });
        await pool.query('INSERT INTO ticket_comments (ticket_id,user_id,username,role,comment,is_internal) VALUES (?,?,?,?,?,?)',
            [req.params.id, req.session.userId, req.session.username, req.session.role, comment, is_internal?1:0]);
        res.json({ success:true, message:'Komentar ditambahkan' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── GET /tickets/report — laporan statistik ──
router.get('/report', async (req, res) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Tiket per bulan (12 bulan)
        const [perMonth] = await pool.query(`
            SELECT MONTH(created_at) as month, COUNT(*) as total,
                   SUM(status='closed') as closed,
                   SUM(status='open' OR status='in_progress') as open,
                   AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR,created_at,resolved_at) END) as avg_hours
            FROM trouble_tickets WHERE YEAR(created_at)=?
            GROUP BY MONTH(created_at) ORDER BY month ASC`, [year]);

        // Tiket per kategori
        const [perCategory] = await pool.query(`
            SELECT category, COUNT(*) as total,
                   SUM(status='closed') as closed,
                   ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR,created_at,resolved_at) END),1) as avg_hours
            FROM trouble_tickets WHERE YEAR(created_at)=?
            GROUP BY category ORDER BY total DESC`, [year]);

        // Tiket per prioritas
        const [perPriority] = await pool.query(`
            SELECT priority, COUNT(*) as total, SUM(status='closed') as closed
            FROM trouble_tickets WHERE YEAR(created_at)=?
            GROUP BY priority ORDER BY FIELD(priority,'critical','high','normal','low')`, [year]);

        // Tiket per teknisi
        const [perTech] = await pool.query(`
            SELECT u.username, COUNT(DISTINCT t.id) as total,
                   SUM(t.status='closed') as closed,
                   ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR,t.created_at,t.resolved_at) END),1) as avg_hours
            FROM ticket_technicians tt
            JOIN trouble_tickets t ON t.id=tt.ticket_id
            JOIN users u ON u.id=tt.technician_id
            WHERE YEAR(t.created_at)=?
            GROUP BY u.id ORDER BY total DESC`, [year]);

        // Summary global tahun ini
        const [[summary]] = await pool.query(`
            SELECT COUNT(*) as total,
                   SUM(status='open') as open,
                   SUM(status='in_progress') as inprogress,
                   SUM(status='closed') as closed,
                   SUM(priority='critical') as critical,
                   SUM(priority='high') as high,
                   ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR,created_at,resolved_at) END),1) as avg_resolve_hours,
                   SUM(source='infrastruktur') as infra_count
            FROM trouble_tickets WHERE YEAR(created_at)=?`, [year]);

        // Daftar tahun untuk filter
        const [years] = await pool.query(`SELECT DISTINCT YEAR(created_at) as yr FROM trouble_tickets ORDER BY yr DESC`);

        res.render('ticket_report', {
            user: req.session, year, years,
            perMonth, perCategory, perPriority, perTech, summary: summary||{},
            currentPage: 'tickets'
        });
    } catch(err) { res.status(500).send("Error: "+err.message); }
});

// ── DELETE /api/:id ──
router.delete('/api/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM ticket_comments WHERE ticket_id=?', [req.params.id]);
        await pool.query('DELETE FROM trouble_tickets WHERE id=?', [req.params.id]);
        res.json({ success:true, message:'Tiket dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── GET /api/:id ──
router.get('/api/:id', async (req, res) => {
    try {
        const [[ticket]] = await pool.query(`
            SELECT t.*, c.name as customer_name,
                   (SELECT GROUP_CONCAT(us.username ORDER BY us.username SEPARATOR ',')
                    FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                    WHERE tt.ticket_id=t.id) as technician_names,
                   (SELECT GROUP_CONCAT(tt.technician_id ORDER BY us.username SEPARATOR ',')
                    FROM ticket_technicians tt JOIN users us ON us.id=tt.technician_id
                    WHERE tt.ticket_id=t.id) as technician_ids
            FROM trouble_tickets t
            LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`, [req.params.id]);
        if (!ticket) return res.status(404).json({ success:false, message:'Tiket tidak ditemukan' });
        res.json({ success:true, data:ticket });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
