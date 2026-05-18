const express = require('express');
const router  = express.Router();
let pool;
router.setPool = (p) => { pool = p; };

// Middleware: hanya admin yang bisa DELETE dan operasi destructive
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.role === 'admin') return next();
    return res.status(403).json({ success: false, message: 'Hanya admin yang dapat melakukan operasi ini' });
};

const TUBE_COLORS = ['Merah','Hijau','Biru','Kuning','Putih','Abu-abu','Coklat','Ungu','Tosca','Hitam','Oranye','Pink'];
const CORE_COLORS = ['Merah','Hijau','Biru','Kuning','Putih','Abu-abu','Coklat','Ungu','Tosca','Hitam','Oranye','Pink'];

// ══════════════════════ PAGES ══════════════════════

router.get('/', async (req, res) => {
    try {
        const [nodes]     = await pool.query(`
            SELECT n.*,
                   fc.name as feed_cable_name,
                   ft.tube_color as feed_tube_color, ft.tube_number as feed_tube_number,
                   co.core_color as feed_core_color, co.core_number as feed_core_number
            FROM fo_nodes n
            LEFT JOIN fo_cables fc ON fc.id = n.feed_cable_id
            LEFT JOIN fo_tubes  ft ON ft.id = n.feed_tube_id
            LEFT JOIN fo_cores  co ON co.id = n.feed_core_id
            ORDER BY n.type, n.name ASC`);
        const [cables]    = await pool.query('SELECT * FROM fo_cables ORDER BY name ASC');
        const [customers] = await pool.query('SELECT id,name,lat,lng,status FROM customers WHERE lat IS NOT NULL AND lat != ""');
        const [[stats]]   = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM fo_nodes WHERE type='ODP') as total_odp,
                (SELECT COUNT(*) FROM fo_nodes WHERE type='ODC') as total_odc,
                (SELECT COUNT(*) FROM fo_nodes WHERE type='OLT') as total_olt,
                (SELECT COUNT(*) FROM fo_nodes WHERE status='damaged') as damaged_nodes,
                (SELECT COUNT(*) FROM fo_cables) as total_cables,
                (SELECT COALESCE(SUM(length_m),0) FROM fo_cables) as total_length,
                (SELECT COUNT(*) FROM fo_cores WHERE status='available') as avail_cores,
                (SELECT COUNT(*) FROM fo_core_assignments) as total_assignments`);
        res.render('fo_map', {
            user: req.session,
            nodes:     nodes.map(n => ({...n, lat:parseFloat(n.lat||0), lng:parseFloat(n.lng||0)})),
            cables:    cables.map(c => ({...c, path: c.path ? JSON.parse(c.path) : []})),
            customers: customers.map(c => ({...c, lat:parseFloat(c.lat), lng:parseFloat(c.lng)})),
            stats: stats || {},
            currentPage: 'fo'
        });
    } catch(err) { console.error(err); res.status(500).send("Error: " + err.message); }
});

router.get('/nodes', async (req, res) => {
    try {
        const type   = req.query.type   || '';
        const search = req.query.search || '';
        const status = req.query.status || '';
        const conds = [], params = [];
        if (type)   { conds.push('n.type=?');   params.push(type); }
        if (status) { conds.push('n.status=?'); params.push(status); }
        if (search) { conds.push('(n.name LIKE ? OR n.address LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }
        const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
        const [nodes] = await pool.query(`
            SELECT n.*, pn.name as parent_name,
                   fc.name as feed_cable_name,
                   ft.tube_color as feed_tube_color, ft.tube_number as feed_tube_number,
                   co.core_color as feed_core_color, co.core_number as feed_core_number,
                   (SELECT COUNT(*) FROM fo_core_assignments a WHERE a.node_id=n.id) as assignment_count,
                   (SELECT COUNT(*) FROM fo_ports p WHERE p.node_id=n.id AND p.status='used') as used_ports_count,
                   (SELECT COUNT(*) FROM fo_ports p WHERE p.node_id=n.id) as total_ports_count
            FROM fo_nodes n
            LEFT JOIN fo_nodes pn ON pn.id=n.parent_id
            LEFT JOIN fo_cables fc ON fc.id=n.feed_cable_id
            LEFT JOIN fo_tubes  ft ON ft.id=n.feed_tube_id
            LEFT JOIN fo_cores  co ON co.id=n.feed_core_id
            ${where} ORDER BY n.type, n.name ASC`, params);
        const [[nstats]] = await pool.query(`SELECT COUNT(*) as total, SUM(type='ODP') as odp, SUM(type='ODC') as odc, SUM(type='OLT') as olt, SUM(type='Tiang') as tiang, SUM(status='damaged') as damaged FROM fo_nodes`);
        const [allNodes] = await pool.query('SELECT id,name,type FROM fo_nodes ORDER BY type,name ASC');
        res.render('fo_nodes', { user: req.session, nodes, nstats: nstats||{}, allNodes, typeFilter:type, statusFilter:status, search, currentPage:'fo' });
    } catch(err) { res.status(500).send("Error: " + err.message); }
});

router.get('/cables', async (req, res) => {
    try {
        const [cables] = await pool.query(`
            SELECT c.*,
                   COUNT(DISTINCT t.id) as tube_count,
                   COUNT(DISTINCT co.id) as core_count_db,
                   COUNT(DISTINCT a.id) as assignment_count
            FROM fo_cables c
            LEFT JOIN fo_tubes t ON t.cable_id=c.id
            LEFT JOIN fo_cores co ON co.cable_id=c.id
            LEFT JOIN fo_core_assignments a ON a.cable_id=c.id
            GROUP BY c.id ORDER BY c.name ASC`);
        const [[cstats]] = await pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(length_m),0) as total_m, COALESCE(SUM(core_count),0) as total_core FROM fo_cables`);
        const [nodes] = await pool.query('SELECT id,name,type FROM fo_nodes ORDER BY type,name ASC');
        res.render('fo_cables', { user: req.session, cables, cstats: cstats||{}, nodes, currentPage:'fo' });
    } catch(err) { res.status(500).send("Error: " + err.message); }
});

router.get('/assets', async (req, res) => {
    try {
        const search = req.query.search || '', catFilter = req.query.category || '';
        const conds = [], params = [];
        if (search)    { conds.push('(name LIKE ? OR brand LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }
        if (catFilter) { conds.push('category=?'); params.push(catFilter); }
        const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
        const [assets]   = await pool.query(`SELECT a.*, n.name as node_name FROM fo_assets a LEFT JOIN fo_nodes n ON n.id=a.location_node_id ${where} ORDER BY a.category,a.name`, params);
        const [nodes]    = await pool.query('SELECT id,name,type FROM fo_nodes ORDER BY name');
        const [[astats]] = await pool.query(`SELECT SUM(quantity) as total_qty, SUM(purchase_price*quantity) as total_value, COUNT(*) as total_items, SUM(condition_status!='baik') as need_attention FROM fo_assets ${where}`, params);
        res.render('fo_assets', { user: req.session, assets, nodes, astats: astats||{}, search, catFilter, currentPage:'fo' });
    } catch(err) { res.status(500).send("Error: " + err.message); }
});

// ══════════════════════ SPLICE PAGE ══════════════════════

router.get('/splice/:cableId', async (req, res) => {
    try {
        const [[cable]] = await pool.query('SELECT * FROM fo_cables WHERE id=?', [req.params.cableId]);
        if (!cable) return res.status(404).send('Kabel tidak ditemukan');

        const [tubes] = await pool.query('SELECT * FROM fo_tubes WHERE cable_id=? ORDER BY tube_number ASC', [req.params.cableId]);
        for (const tube of tubes) {
            // Ambil cores dulu
            const [cores] = await pool.query(
                'SELECT * FROM fo_cores WHERE tube_id=? ORDER BY core_number ASC', [tube.id]);
            // Ambil assignments per core secara terpisah (hindari JSON_ARRAYAGG yang bermasalah)
            for (const core of cores) {
                const [assignments] = await pool.query(
                    'SELECT * FROM fo_core_assignments WHERE core_id=? ORDER BY km_position ASC', [core.id]);
                core.assignments = assignments;
            }
            tube.cores = cores;
        }

        const [nodes]   = await pool.query('SELECT id,name,type FROM fo_nodes ORDER BY type,name ASC');
        const [allCores]= await pool.query(`
            SELECT c.id, c.core_number, c.core_color, c.status, t.tube_color, t.tube_number, f.name as cable_name
            FROM fo_cores c JOIN fo_tubes t ON t.id=c.tube_id JOIN fo_cables f ON f.id=c.cable_id
            WHERE c.cable_id != ? ORDER BY f.name, t.tube_number, c.core_number ASC`, [req.params.cableId]);

        res.render('fo_splice', { user: req.session, cable, tubes, nodes, allCores, currentPage:'fo' });
    } catch(err) { res.status(500).send("Error: " + err.message); }
});

// ══════════════════════ API NODES ══════════════════════

router.get('/api/nodes', async (req, res) => {
    try {
        const [nodes] = await pool.query(`
            SELECT n.*,
                   COUNT(DISTINCT p.id) as total_ports,
                   SUM(p.status='used') as used_ports_count,
                   fc.name as feed_cable_name,
                   ft.tube_color as feed_tube_color, ft.tube_number as feed_tube_number,
                   co.core_color as feed_core_color, co.core_number as feed_core_number
            FROM fo_nodes n
            LEFT JOIN fo_ports p ON p.node_id=n.id
            LEFT JOIN fo_cables fc ON fc.id=n.feed_cable_id
            LEFT JOIN fo_tubes  ft ON ft.id=n.feed_tube_id
            LEFT JOIN fo_cores  co ON co.id=n.feed_core_id
            GROUP BY n.id ORDER BY n.type,n.name ASC`);
        res.json({ success:true, nodes });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.get('/api/nodes/:id', async (req, res) => {
    try {
        const [[node]] = await pool.query(`
            SELECT n.*, fc.name as feed_cable_name,
                   ft.tube_color as feed_tube_color, co.core_color as feed_core_color
            FROM fo_nodes n
            LEFT JOIN fo_cables fc ON fc.id=n.feed_cable_id
            LEFT JOIN fo_tubes ft ON ft.id=n.feed_tube_id
            LEFT JOIN fo_cores co ON co.id=n.feed_core_id
            WHERE n.id=?`, [req.params.id]);
        if (!node) return res.json({ success:false, message:'Node tidak ditemukan' });
        const [ports] = await pool.query(`SELECT p.*,c.name as customer_name FROM fo_ports p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.node_id=? ORDER BY p.port_number ASC`, [req.params.id]);
        const [assignments] = await pool.query(`
            SELECT a.*, co.core_number, co.core_color, t.tube_number, t.tube_color, cab.name as cable_name
            FROM fo_core_assignments a
            JOIN fo_cores co ON co.id=a.core_id
            JOIN fo_tubes t ON t.id=co.tube_id
            JOIN fo_cables cab ON cab.id=a.cable_id
            WHERE a.node_id=? ORDER BY cab.name, t.tube_number, co.core_number ASC`, [req.params.id]);
        res.json({ success:true, node, ports, assignments });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/api/nodes', async (req, res) => {
    try {
        const { name, type, lat, lng, address, capacity, parent_id, brand, model, install_date, status, feed_cable_id, feed_tube_id, feed_core_id, notes } = req.body;
        if (!name || !type) return res.json({ success:false, message:'Nama dan tipe wajib diisi' });
        const [r] = await pool.query(
            'INSERT INTO fo_nodes (name,type,lat,lng,address,capacity,parent_id,brand,model,install_date,status,feed_cable_id,feed_tube_id,feed_core_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [name,type,lat||null,lng||null,address||null,capacity||0,parent_id||null,brand||null,model||null,install_date||null,status||'active',feed_cable_id||null,feed_tube_id||null,feed_core_id||null,notes||null]
        );
        // Tambah assignment otomatis jika ada feed_core_id
        if (feed_core_id && feed_cable_id) {
            await pool.query(
                'INSERT INTO fo_core_assignments (core_id,cable_id,tube_id,node_id,node_name,usage_type) VALUES (?,?,?,?,?,?)',
                [feed_core_id, feed_cable_id, feed_tube_id||0, r.insertId, name, 'drop']
            );
            await updateCoreStatus(feed_core_id);
        }
        if (capacity && parseInt(capacity) > 0) {
            const portVals = Array.from({length:parseInt(capacity)},(_,i)=>[r.insertId,i+1,`Port-${i+1}`,'available']);
            await pool.query('INSERT INTO fo_ports (node_id,port_number,port_label,status) VALUES ?', [portVals]);
        }
        res.json({ success:true, id:r.insertId, message:`${type} berhasil ditambahkan` });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.put('/api/nodes/:id', async (req, res) => {
    try {
        const { name, type, lat, lng, address, capacity, parent_id, brand, model, install_date, status, feed_cable_id, feed_tube_id, feed_core_id, notes } = req.body;
        const [[old]] = await pool.query('SELECT feed_core_id,feed_cable_id FROM fo_nodes WHERE id=?', [req.params.id]);
        await pool.query(
            'UPDATE fo_nodes SET name=?,type=?,lat=?,lng=?,address=?,capacity=?,parent_id=?,brand=?,model=?,install_date=?,status=?,feed_cable_id=?,feed_tube_id=?,feed_core_id=?,notes=? WHERE id=?',
            [name,type,lat||null,lng||null,address||null,capacity||0,parent_id||null,brand||null,model||null,install_date||null,status||'active',feed_cable_id||null,feed_tube_id||null,feed_core_id||null,notes||null,req.params.id]
        );
        // Update assignment jika core berubah
        if (old && old.feed_core_id != feed_core_id) {
            if (old.feed_core_id) {
                await pool.query('DELETE FROM fo_core_assignments WHERE node_id=? AND core_id=?', [req.params.id, old.feed_core_id]);
                await updateCoreStatus(old.feed_core_id);
            }
            if (feed_core_id && feed_cable_id) {
                await pool.query('INSERT IGNORE INTO fo_core_assignments (core_id,cable_id,tube_id,node_id,node_name,usage_type) VALUES (?,?,?,?,?,?)',
                    [feed_core_id, feed_cable_id, feed_tube_id||0, req.params.id, name, 'drop']);
                await updateCoreStatus(feed_core_id);
            }
        }
        res.json({ success:true, message:'Node diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/api/nodes/:id', requireAdmin, async (req, res) => {
    try {
        const [[n]] = await pool.query('SELECT feed_core_id FROM fo_nodes WHERE id=?', [req.params.id]);
        const [assignments] = await pool.query('SELECT DISTINCT core_id FROM fo_core_assignments WHERE node_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_core_assignments WHERE node_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_ports WHERE node_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_nodes WHERE id=?', [req.params.id]);
        for (const a of assignments) await updateCoreStatus(a.core_id);
        res.json({ success:true, message:'Node dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ API CABLES ══════════════════════

router.get('/api/cables', async (req, res) => {
    try {
        const [cables] = await pool.query(`SELECT c.*,fn.name as from_name,tn.name as to_name FROM fo_cables c LEFT JOIN fo_nodes fn ON fn.id=c.from_node_id LEFT JOIN fo_nodes tn ON tn.id=c.to_node_id ORDER BY c.name ASC`);
        res.json({ success:true, cables: cables.map(c => ({...c, path: c.path?JSON.parse(c.path):[]})) });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/api/cables', async (req, res) => {
    try {
        const { name, from_node_id, to_node_id, cable_type, core_count, length_m, path, color, status, install_date, notes } = req.body;
        if (!name) return res.json({ success:false, message:'Nama kabel wajib diisi' });
        const [r] = await pool.query(
            'INSERT INTO fo_cables (name,from_node_id,to_node_id,cable_type,core_count,length_m,path,color,status,install_date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [name,from_node_id||null,to_node_id||null,cable_type||'Single Mode',core_count||12,length_m||0,JSON.stringify(path||[]),color||'#FF6B35',status||'active',install_date||null,notes||null]
        );
        res.json({ success:true, id:r.insertId, message:'Kabel FO berhasil ditambahkan' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.put('/api/cables/:id', async (req, res) => {
    try {
        const { name, from_node_id, to_node_id, cable_type, core_count, length_m, path, color, status, install_date, notes } = req.body;
        await pool.query(
            'UPDATE fo_cables SET name=?,from_node_id=?,to_node_id=?,cable_type=?,core_count=?,length_m=?,path=?,color=?,status=?,install_date=?,notes=? WHERE id=?',
            [name,from_node_id||null,to_node_id||null,cable_type||'Single Mode',core_count||12,length_m||0,JSON.stringify(path||[]),color||'#FF6B35',status||'active',install_date||null,notes||null,req.params.id]
        );
        res.json({ success:true, message:'Kabel diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/api/cables/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM fo_core_assignments WHERE cable_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_cores WHERE cable_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_tubes WHERE cable_id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_cables WHERE id=?', [req.params.id]);
        res.json({ success:true, message:'Kabel dan semua core dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ GENERATE TUBE & CORE ══════════════════════

router.post('/api/cables/:id/generate-tubes', async (req, res) => {
    try {
        const cableId = req.params.id;
        const [[cable]] = await pool.query('SELECT * FROM fo_cables WHERE id=?', [cableId]);
        if (!cable) return res.json({ success:false, message:'Kabel tidak ditemukan' });

        const coresPerTube = parseInt(req.body.cores_per_tube) || 12;
        const totalCores   = cable.core_count || 12;
        const totalTubes   = Math.ceil(totalCores / coresPerTube);

        // Hapus existing (jaga assignments)
        const [oldTubes] = await pool.query('SELECT id FROM fo_tubes WHERE cable_id=?', [cableId]);
        for (const t of oldTubes) {
            await pool.query('DELETE FROM fo_core_assignments WHERE tube_id=?', [t.id]);
            await pool.query('DELETE FROM fo_cores WHERE tube_id=?', [t.id]);
        }
        await pool.query('DELETE FROM fo_tubes WHERE cable_id=?', [cableId]);

        let coreNum = 1;
        for (let t = 0; t < totalTubes; t++) {
            const coresInTube = Math.min(coresPerTube, totalCores - t*coresPerTube);
            const [tr] = await pool.query(
                'INSERT INTO fo_tubes (cable_id,tube_number,tube_color,core_count) VALUES (?,?,?,?)',
                [cableId, t+1, TUBE_COLORS[t%TUBE_COLORS.length], coresInTube]
            );
            for (let c = 0; c < coresInTube; c++) {
                await pool.query(
                    'INSERT INTO fo_cores (tube_id,cable_id,core_number,core_color,status) VALUES (?,?,?,?,?)',
                    [tr.insertId, cableId, coreNum, CORE_COLORS[c%CORE_COLORS.length], 'available']
                );
                coreNum++;
            }
        }
        res.json({ success:true, message:`${totalTubes} tube × ${totalCores} core berhasil digenerate` });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ CORE ASSIGNMENTS ══════════════════════

// Tambah assignment: 1 core → 1 node (bisa dipanggil berkali-kali untuk node berbeda)
router.post('/api/cores/:id/assign', async (req, res) => {
    try {
        const { node_id, km_position, usage_type, notes } = req.body;
        if (!node_id) return res.json({ success:false, message:'Node wajib dipilih' });

        const [[core]] = await pool.query('SELECT c.* FROM fo_cores c WHERE c.id=?', [req.params.id]);
        if (!core) return res.json({ success:false, message:'Core tidak ditemukan' });

        const [[node]] = await pool.query('SELECT name FROM fo_nodes WHERE id=?', [node_id]);
        if (!node) return res.json({ success:false, message:'Node tidak ditemukan' });

        // Cek apakah sudah ada assignment ke node ini
        const [[existing]] = await pool.query('SELECT id FROM fo_core_assignments WHERE core_id=? AND node_id=?', [req.params.id, node_id]);
        if (existing) return res.json({ success:false, message:'Core ini sudah di-assign ke node tersebut' });

        await pool.query(
            'INSERT INTO fo_core_assignments (core_id,cable_id,tube_id,node_id,node_name,km_position,usage_type,notes) VALUES (?,?,?,?,?,?,?,?)',
            [req.params.id, core.cable_id, core.tube_id, node_id, node.name, km_position||0, usage_type||'drop', notes||null]
        );
        await updateCoreStatus(req.params.id);
        res.json({ success:true, message:`Core berhasil di-assign ke ${node.name}` });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Hapus satu assignment
router.delete('/api/assignments/:id', requireAdmin, async (req, res) => {
    try {
        const [[a]] = await pool.query('SELECT core_id FROM fo_core_assignments WHERE id=?', [req.params.id]);
        await pool.query('DELETE FROM fo_core_assignments WHERE id=?', [req.params.id]);
        if (a) await updateCoreStatus(a.core_id);
        res.json({ success:true, message:'Assignment dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Update status core otomatis berdasarkan jumlah assignment
async function updateCoreStatus(coreId) {
    try {
        const [[{ cnt }]] = await pool.query('SELECT COUNT(*) as cnt FROM fo_core_assignments WHERE core_id=?', [coreId]);
        const [[core]]    = await pool.query('SELECT status FROM fo_cores WHERE id=?', [coreId]);
        if (!core || core.status === 'broken') return;
        const newStatus = cnt === 0 ? 'available' : 'partial'; // partial = digunakan tapi masih bisa ditambah
        await pool.query('UPDATE fo_cores SET status=? WHERE id=?', [newStatus, coreId]);
    } catch(e) {}
}

// Update status core manual (misal broken)
router.put('/api/cores/:id', async (req, res) => {
    try {
        const { status, notes } = req.body;
        await pool.query('UPDATE fo_cores SET status=?,notes=? WHERE id=?', [status, notes||null, req.params.id]);
        res.json({ success:true, message:'Core diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ CASCADE DROPDOWN ══════════════════════

router.get('/api/cables/:id/tubes-list', async (req, res) => {
    try {
        const [tubes] = await pool.query('SELECT id,tube_number,tube_color,core_count FROM fo_tubes WHERE cable_id=? ORDER BY tube_number ASC', [req.params.id]);
        res.json({ success:true, tubes });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.get('/api/tubes/:id/cores-list', async (req, res) => {
    try {
        const [cores] = await pool.query(`
            SELECT c.id, c.core_number, c.core_color, c.status,
                   COUNT(a.id) as assignment_count,
                   GROUP_CONCAT(a.node_name ORDER BY a.km_position SEPARATOR ', ') as assigned_to
            FROM fo_cores c LEFT JOIN fo_core_assignments a ON a.core_id=c.id
            WHERE c.tube_id=? GROUP BY c.id ORDER BY c.core_number ASC`, [req.params.id]);
        res.json({ success:true, cores });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ PORT ══════════════════════

router.put('/api/ports/:id', async (req, res) => {
    try {
        const { status, customer_id, notes, port_label } = req.body;
        let custName = null;
        if (customer_id) { const [[c]] = await pool.query('SELECT name FROM customers WHERE id=?',[customer_id]); if(c) custName=c.name; }
        await pool.query('UPDATE fo_ports SET status=?,customer_id=?,customer_name=?,notes=?,port_label=? WHERE id=?',
            [status,customer_id||null,custName,notes||null,port_label||null,req.params.id]);
        const [[{used}]] = await pool.query("SELECT COUNT(*) as used FROM fo_ports WHERE node_id=(SELECT node_id FROM fo_ports WHERE id=?) AND status='used'",[req.params.id]);
        await pool.query("UPDATE fo_nodes SET used_ports=? WHERE id=(SELECT node_id FROM fo_ports WHERE id=?)",[used,req.params.id]);
        res.json({ success:true, message:'Port diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════ ASSETS ══════════════════════

router.post('/api/assets', async (req, res) => {
    try {
        const { name,category,brand,model,quantity,unit,condition_status,location_node_id,purchase_date,purchase_price,notes } = req.body;
        if (!name) return res.json({ success:false, message:'Nama aset wajib diisi' });
        await pool.query('INSERT INTO fo_assets (name,category,brand,model,quantity,unit,condition_status,location_node_id,purchase_date,purchase_price,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [name,category||'Lain-lain',brand||null,model||null,quantity||1,unit||'pcs',condition_status||'baik',location_node_id||null,purchase_date||null,purchase_price||null,notes||null]);
        res.json({ success:true, message:'Aset ditambahkan' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
router.put('/api/assets/:id', async (req, res) => {
    try {
        const { name,category,brand,model,quantity,unit,condition_status,location_node_id,purchase_date,purchase_price,notes } = req.body;
        await pool.query('UPDATE fo_assets SET name=?,category=?,brand=?,model=?,quantity=?,unit=?,condition_status=?,location_node_id=?,purchase_date=?,purchase_price=?,notes=? WHERE id=?',
            [name,category||'Lain-lain',brand||null,model||null,quantity||1,unit||'pcs',condition_status||'baik',location_node_id||null,purchase_date||null,purchase_price||null,notes||null,req.params.id]);
        res.json({ success:true, message:'Aset diperbarui' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
router.delete('/api/assets/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM fo_assets WHERE id=?', [req.params.id]);
        res.json({ success:true, message:'Aset dihapus' });
    } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
