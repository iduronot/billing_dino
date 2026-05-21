const express = require('express');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const dotenv = require('dotenv');
const { exec } = require('child_process');
const IS_WIN = process.platform === 'win32';

// Check if .env exists, if not, we are in "install mode"
const envPath = path.join(__dirname, '.env');
const isInstalled = fs.existsSync(envPath);

if (isInstalled) {
  dotenv.config();
}

const app = express();
const PORT = process.env.APP_PORT || 3999;

// Background Task Requirements
const cron = require('node-cron');
const { notifyIsolation, notifyInvoiceCreated, notifyReminder } = require('./helpers/notification');
const mikrotikHelper = require('./helpers/mikrotik');
const bcrypt = require('bcryptjs');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true
}));

let pool; // Global database pool
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: true
}));

// Localization Middleware
const locales = {
  id: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'id.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8'))
};

app.use((req, res, next) => {
  const lang = req.session.lang || 'id';
  res.locals.lang = lang;
  res.locals.t = locales[lang] || locales['id'];
  next();
});

app.get('/set-lang/:lang', (req, res) => {
  const lang = req.params.lang;
  if (['id', 'en'].includes(lang)) {
    req.session.lang = lang;
  }
  res.redirect('back');
});

// Setup Routes
if (!isInstalled) {
  console.log("No .env found. Running in Install Mode.");
  
  // Redirect all traffic to /install
  app.use((req, res, next) => {
    if (!req.path.startsWith('/install') && !req.path.startsWith('/assets')) {
      return res.redirect('/install');
    }
    next();
  });

  app.get('/install', (req, res) => {
    res.render('installer', { step: 1, error: null });
  });

  app.post('/install/setup', async (req, res) => {
    const { dbHost, dbUser, dbPass, dbName } = req.body;
    
    // Test DB Connection
    try {
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: dbHost,
        user: dbUser,
        password: dbPass
      });
      
      // Create DB if not exists
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
      await connection.query(`USE \`${dbName}\`;`);
      
      // Create Users table and insert default admin
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(100) DEFAULT NULL,
          phone VARCHAR(20) DEFAULT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          telegram_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const bcrypt = require('bcryptjs');
      const hashedPass = await bcrypt.hash('admin', 10);

      // Check if admin exists
      const [rows] = await connection.query(`SELECT * FROM users WHERE username = 'admin'`);
      if (rows.length === 0) {
        await connection.query(`INSERT INTO users (username, password, name, role) VALUES ('admin', ?, 'Administrator', 'admin')`, [hashedPass]);
      }
      
      // Generate .env file
      const envContent = `DB_HOST=${dbHost}
DB_PORT=3306
DB_NAME=${dbName}
DB_USER=${dbUser}
DB_PASS=${dbPass}
APP_PORT=3999
APP_NAME=Dino-Bill
NODE_ENV=production
SESSION_SECRET=${Math.random().toString(36).substring(2, 15)}
`;
      fs.writeFileSync(envPath, envContent);
      
      // Needs restart or dynamic reload
      res.render('installer', { step: 'success', error: null });
      
      setTimeout(() => {
        console.log("Restarting server to apply .env changes...");
        process.exit(0); // PM2 or nodemon will restart it
      }, 3000);
      
    } catch (err) {
      res.render('installer', { step: 1, error: "Database Connection Failed: " + err.message });
    }
  });

} else {
  // App is installed, load normal routes
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');
  
  // Create DB pool
  pool = mysql.createPool({
    host:              process.env.DB_HOST,
    user:              process.env.DB_USER,
    password:          process.env.DB_PASS,
    database:          process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:   20,
    queueLimit:        0,
    connectTimeout:    10000,
    acquireTimeout:    10000,
    idleTimeoutMillis: 30000,
    enableKeepAlive:   true,
    keepAliveInitialDelay: 0,
    multipleStatements: false,
    charset:           'utf8mb4'
  });


  // Auto-initialize tables that might be missing
  pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      speed_limit VARCHAR(50),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      address TEXT,
      package_id INT,
      router_id INT,
      pppoe_username VARCHAR(50),
      pppoe_password VARCHAR(100) DEFAULT '123456',
      billing_method VARCHAR(20) DEFAULT 'fixed',
      isolation_date INT DEFAULT 20,
      lat VARCHAR(30),
      lng VARCHAR(30),
      portal_password VARCHAR(255) NULL,
      email VARCHAR(100),
      nik VARCHAR(20) NULL,
      odp_id INT,
      status VARCHAR(20) DEFAULT 'active',
      technician_id INT,
      installation_status VARCHAR(20) DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Add missing columns if upgrade from old schema
  const checkAndAddColumn = async (table, column, definition) => {
    try {
      const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
      if (rows.length === 0) {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[DB Migration] Added column ${column} to ${table}`);
      }
    } catch (e) {
      console.error(`[DB Migration] Failed to check/add column ${column} to ${table}:`, e.message);
    }
  };

  // Run migrations
  checkAndAddColumn('customers', 'router_id', 'INT');
  checkAndAddColumn('customers', 'isolation_date', 'INT DEFAULT 20');
  checkAndAddColumn('customers', 'billing_method', "VARCHAR(20) DEFAULT 'fixed'");
  checkAndAddColumn('customers', 'lat', 'VARCHAR(30)');
  checkAndAddColumn('customers', 'lng', 'VARCHAR(30)');
  checkAndAddColumn('packages', 'description', 'TEXT');
  checkAndAddColumn('invoices', 'package_id', 'INT');
  checkAndAddColumn('invoices', 'paid_at', 'TIMESTAMP NULL');
  checkAndAddColumn('invoices', 'description', 'TEXT');
  checkAndAddColumn('invoices', 'payment_method', "VARCHAR(50) DEFAULT 'Manual'");
  checkAndAddColumn('invoices', 'invoice_number', "VARCHAR(50) DEFAULT ''");
  checkAndAddColumn('invoices', 'proof_image', 'VARCHAR(255) NULL');
  checkAndAddColumn('routers', 'status', "VARCHAR(20) DEFAULT 'active'");
  checkAndAddColumn('customers', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  checkAndAddColumn('trouble_tickets', 'closed_at', 'TIMESTAMP NULL');
  checkAndAddColumn('customers', 'portal_password', 'VARCHAR(255) NULL');
  checkAndAddColumn('customers', 'inactive_at', 'DATETIME NULL');
  checkAndAddColumn('customers', 'inactive_reason', 'VARCHAR(255) NULL');
  checkAndAddColumn('customers', 'pppoe_password', "VARCHAR(100) DEFAULT '123456'");
  checkAndAddColumn('customers', 'email', 'VARCHAR(100)');
  checkAndAddColumn('trouble_tickets', 'description', 'TEXT');
  checkAndAddColumn('hioso_olts', 'last_profile', 'VARCHAR(100)');
  // Safer migration for 'brand' column
  // Safer migration for OLT columns
  const checkAndAddOltColumn = async (col, def) => {
    const [rows] = await pool.query(`SHOW COLUMNS FROM hioso_olts LIKE ?`, [col]);
    if (rows.length === 0) {
      await pool.query(`ALTER TABLE hioso_olts ADD COLUMN ${col} ${def}`).catch(() => {});
    }
  };
  checkAndAddOltColumn('brand', "VARCHAR(50) DEFAULT 'HIOSO'");
  checkAndAddOltColumn('model', "VARCHAR(50) DEFAULT NULL");
  checkAndAddOltColumn('last_profile', "VARCHAR(100) DEFAULT NULL");
  checkAndAddColumn('hioso_onus', 'mac', 'VARCHAR(100)');
  checkAndAddColumn('customers', 'odp_id', 'INT');
  checkAndAddColumn('customers', 'technician_id', 'INT');
  checkAndAddColumn('customers', 'installation_status', "VARCHAR(20) DEFAULT 'completed'");
  checkAndAddColumn('customers', 'nik', 'VARCHAR(20) NULL');
  checkAndAddColumn('trouble_tickets', 'technician_id', 'INT');
  checkAndAddColumn('inventory', 'price', 'DECIMAL(15,2) DEFAULT 0');
  checkAndAddColumn('inventory', 'min_stock', 'INT DEFAULT 5');

  // ── Perbaiki tipe kolom yang berbeda di DB lama (MODIFY COLUMN) ──
  const checkAndModifyColumn = async (table, column, definition) => {
    try {
      const [rows] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
      if (rows.length > 0) {
        const current = rows[0].Type.toLowerCase();
        const needed  = definition.split(' ')[0].toLowerCase();
        if (!current.startsWith(needed)) {
          await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
          console.log(`[DB Migration] Modified column ${column} in ${table}: ${current} → ${definition}`);
        }
      }
    } catch (e) {
      console.error(`[DB Migration] Failed to modify column ${column} in ${table}:`, e.message);
    }
  };
  checkAndModifyColumn('customers', 'pppoe_password', "VARCHAR(100) DEFAULT '123456'");
  checkAndModifyColumn('customers', 'pppoe_username', 'VARCHAR(100)');
  checkAndModifyColumn('invoices', 'amount', 'DECIMAL(15,2) NOT NULL DEFAULT 0');
  pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_mutations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inventory_id INT NOT NULL,
      type ENUM('in','out') NOT NULL,
      quantity INT NOT NULL,
      note VARCHAR(255),
      user_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_inv (inventory_id)
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS mutation_technicians (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mutation_id INT NOT NULL,
      technician_id INT NOT NULL,
      technician_name VARCHAR(100) NOT NULL,
      INDEX idx_mut (mutation_id),
      INDEX idx_tech (technician_id)
    )
  `).catch(console.error);

  // Tabel many-to-many: satu tiket bisa ditangani banyak teknisi
  pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_technicians (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      technician_id INT NOT NULL,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_ticket_tech (ticket_id, technician_id),
      INDEX idx_ticket (ticket_id),
      INDEX idx_tech (technician_id)
    )
  `).catch(console.error);
  checkAndAddColumn('trouble_tickets', 'category', "VARCHAR(50) DEFAULT 'gangguan'");
  checkAndAddColumn('trouble_tickets', 'location', 'TEXT NULL');
  checkAndAddColumn('trouble_tickets', 'lat', 'DECIMAL(10,8) NULL');
  checkAndAddColumn('trouble_tickets', 'lng', 'DECIMAL(11,8) NULL');
  checkAndAddColumn('trouble_tickets', 'resolved_at', 'TIMESTAMP NULL');
  checkAndAddColumn('trouble_tickets', 'response_note', 'TEXT NULL');
  checkAndAddColumn('trouble_tickets', 'rating', 'INT NULL');
  checkAndAddColumn('trouble_tickets', 'source', "VARCHAR(20) DEFAULT 'admin'");

  // Tabel komentar/riwayat tiket
  pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      role VARCHAR(20) NULL,
      comment TEXT NOT NULL,
      is_internal TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ticket (ticket_id)
    )
  `).catch(console.error);
  checkAndAddColumn('users', 'name', 'VARCHAR(100) DEFAULT NULL');
  checkAndAddColumn('users', 'telegram_id', 'VARCHAR(50)');

  pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      package_id INT,
      invoice_number VARCHAR(50) DEFAULT '',
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) DEFAULT 'unpaid',
      description TEXT,
      payment_method VARCHAR(50) DEFAULT 'Manual',
      proof_image VARCHAR(255) NULL,
      due_date DATE,
      paid_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS routers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      ip_address VARCHAR(50) NOT NULL,
      username VARCHAR(50) NOT NULL,
      password VARCHAR(100) NOT NULL,
      port INT DEFAULT 8728,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(50) NOT NULL UNIQUE,
      setting_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);
  
  // Initialize Default Settings for Full Autopilot
  const defaultSettings = [
    ['auto_billing_enabled', '1'],
    ['auto_isolate_enabled', '1'],
    ['reminder_days_before', '3'],
    ['auto_generate_day', '1'],
    ['late_tolerance_days', '0'],
    ['invoice_prefix', 'INV'],
    ['currency', 'IDR'],
    ['timezone', 'Asia/Jakarta'],
    ['wa_provider', 'external'],
    ['wa_api_token', ''],
    ['wa_api_url', ''],
    ['wa_delay', '5'],
    ['wa_limit', '50']
];
  for (const [key, val] of defaultSettings) {
    pool.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, val]).catch(() => {});
  // Default setting presensi
  pool.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('attendance_radius','100')").catch(()=>{});
  pool.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('attendance_late_time','08:30')").catch(()=>{});
  }

  pool.query(`
    CREATE TABLE IF NOT EXISTS technician_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS sales_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      balance DECIMAL(15,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS trouble_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      title VARCHAR(200),
      description TEXT,
      status VARCHAR(20) DEFAULT 'open',
      priority VARCHAR(20) DEFAULT 'normal',
      category VARCHAR(50) DEFAULT 'gangguan',
      technician_id INT,
      location TEXT NULL,
      lat DECIMAL(10,8) NULL,
      lng DECIMAL(11,8) NULL,
      source VARCHAR(20) DEFAULT 'admin',
      resolved_at TIMESTAMP NULL,
      closed_at TIMESTAMP NULL,
      response_note TEXT NULL,
      rating INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS map_objects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL, -- 'server', 'odp'
      lat VARCHAR(50) NOT NULL,
      lng VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS map_cables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100),
      path TEXT NOT NULL, -- JSON array of [lat, lng]
      color VARCHAR(20) DEFAULT '#3b82f6',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);
  
  pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(50),
      stock INT DEFAULT 0,
      unit VARCHAR(20) DEFAULT 'pcs',
      price DECIMAL(15,2) DEFAULT 0,
      min_stock INT DEFAULT 5,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      profile VARCHAR(50),
      status VARCHAR(20) DEFAULT 'unused',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS hioso_olts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      host VARCHAR(100) NOT NULL,
      port INT DEFAULT 161,
      community VARCHAR(100) DEFAULT 'public',
      web_user VARCHAR(100) DEFAULT 'admin',
      web_password VARCHAR(100) DEFAULT 'admin',
      brand VARCHAR(50) DEFAULT 'HIOSO',
      model VARCHAR(50) DEFAULT NULL,
      status VARCHAR(20) DEFAULT 'active',
      last_profile VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS hioso_onus (
      id INT AUTO_INCREMENT PRIMARY KEY,
      olt_id INT NOT NULL,
      onu_index VARCHAR(100) NOT NULL,
      name VARCHAR(100),
      sn VARCHAR(100),
      mac VARCHAR(100),
      tx_power VARCHAR(20),
      rx_power VARCHAR(20),
      status VARCHAR(50),
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY (olt_id, onu_index)
    )
  `).catch(console.error);

  // ═══════════════════════════════════════════
  // Tabel Infrastruktur Fiber Optik
  // ═══════════════════════════════════════════

  // Node FO: OLT, ODC, ODP, Splitter, Tiang, Closure
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_nodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      type VARCHAR(50) NOT NULL DEFAULT 'ODP',
      lat DECIMAL(10,8) NULL,
      lng DECIMAL(11,8) NULL,
      address TEXT NULL,
      capacity INT DEFAULT 0,
      used_ports INT DEFAULT 0,
      parent_id INT NULL,
      parent_type VARCHAR(20) NULL,
      brand VARCHAR(100) NULL,
      model VARCHAR(100) NULL,
      install_date DATE NULL,
      status ENUM('active','inactive','damaged') DEFAULT 'active',
      -- Relasi ke core kabel FO yang menginduk node ini (primary connection)
      feed_cable_id INT NULL,
      feed_tube_id  INT NULL,
      feed_core_id  INT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Tambah kolom relasi kabel ke fo_nodes yang sudah ada
  checkAndAddColumn('users', 'phone', 'VARCHAR(20) NULL');

  // ── Tabel Tipe Node FO (dinamis) ──
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_node_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      icon VARCHAR(10) DEFAULT '📍',
      color VARCHAR(20) DEFAULT '#94A3B8',
      is_default TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).then(() => {
    // Seed default types jika belum ada
    const defaults = [
      ['OLT',      '🏢', '#10B981', 1],
      ['ODC',      '📦', '#8B5CF6', 1],
      ['ODP',      '📍', '#3B82F6', 1],
      ['Splitter', '🔀', '#F59E0B', 1],
      ['Tiang',    '🪝', '#94A3B8', 1],
      ['Closure',  '🔒', '#06B6D4', 1],
      ['HandHole', '🕳', '#EF4444', 1],
    ];
    for (const [name, icon, color, is_default] of defaults) {
      pool.query('INSERT IGNORE INTO fo_node_types (name, icon, color, is_default) VALUES (?,?,?,?)', [name, icon, color, is_default]).catch(()=>{});
    }
  }).catch(console.error);

  // Migrasi: ubah fo_nodes.type dari ENUM ke VARCHAR agar bisa pakai tipe custom
  pool.query(`SHOW COLUMNS FROM fo_nodes LIKE 'type'`).then(([rows]) => {
    if (rows.length > 0 && rows[0].Type.toLowerCase().startsWith('enum')) {
      pool.query(`ALTER TABLE fo_nodes MODIFY COLUMN type VARCHAR(50) NOT NULL DEFAULT 'ODP'`)
        .then(() => console.log('[DB Migration] fo_nodes.type: ENUM → VARCHAR(50)'))
        .catch(e => console.error('[DB Migration] fo_nodes.type modify failed:', e.message));
    }
  }).catch(()=>{});

  // ── Tabel Presensi Teknisi ──
  pool.query(`
    CREATE TABLE IF NOT EXISTS attendances (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(100) NOT NULL,
      date DATE NOT NULL,
      check_in_time TIMESTAMP NULL,
      lat DECIMAL(10,8) NULL,
      lng DECIMAL(11,8) NULL,
      distance_m FLOAT NULL,
      status ENUM('hadir','terlambat','ditolak') DEFAULT 'hadir',
      device_info VARCHAR(200) NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_date (user_id, date),
      INDEX idx_date (date),
      INDEX idx_user (user_id)
    )
  `).catch(console.error);
  checkAndAddColumn('fo_nodes', 'feed_cable_id', 'INT NULL');
  checkAndAddColumn('fo_nodes', 'feed_tube_id',  'INT NULL');
  checkAndAddColumn('fo_nodes', 'feed_core_id',  'INT NULL');

  // Assignment core ke node (many-to-many: satu core bisa ke banyak node)
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_core_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      core_id INT NOT NULL,
      cable_id INT NOT NULL,
      tube_id INT NOT NULL,
      node_id INT NOT NULL,
      node_name VARCHAR(150) NULL,
      km_position FLOAT DEFAULT 0,
      usage_type ENUM('drop','splice','pass-through') DEFAULT 'drop',
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_core (core_id),
      INDEX idx_node (node_id)
    )
  `).catch(console.error);

  // Tube & Core per kabel FO
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_tubes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cable_id INT NOT NULL,
      tube_number INT NOT NULL,
      tube_color VARCHAR(30) NOT NULL,
      core_count INT DEFAULT 12,
      notes TEXT NULL,
      UNIQUE KEY uk_cable_tube (cable_id, tube_number)
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_cores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tube_id INT NOT NULL,
      cable_id INT NOT NULL,
      core_number INT NOT NULL,
      core_color VARCHAR(30) NOT NULL,
      status ENUM('available','partial','full','broken') DEFAULT 'available',
      notes TEXT NULL,
      UNIQUE KEY uk_tube_core (tube_id, core_number)
    )
  `).catch(console.error);

  // Kabel FO: rute antar node
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_cables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      from_node_id INT NULL,
      to_node_id INT NULL,
      cable_type ENUM('Single Mode','Multi Mode','ADSS','OPGW','Drop Cable') DEFAULT 'Single Mode',
      core_count INT DEFAULT 12,
      length_m FLOAT DEFAULT 0,
      path TEXT NULL,
      color VARCHAR(20) DEFAULT '#FF6B35',
      status ENUM('active','inactive','damaged','under_construction') DEFAULT 'active',
      install_date DATE NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Port / Core tracking per node
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_ports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      node_id INT NOT NULL,
      port_number INT NOT NULL,
      port_label VARCHAR(50) NULL,
      status ENUM('available','used','reserved','damaged') DEFAULT 'available',
      customer_id INT NULL,
      customer_name VARCHAR(150) NULL,
      cable_id INT NULL,
      notes TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Aset FO: inventaris perangkat
  pool.query(`
    CREATE TABLE IF NOT EXISTS fo_assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      category ENUM('Kabel FO','Splitter','ODP Box','ODC','Closure','Konektor','Tool','Lain-lain') DEFAULT 'Lain-lain',
      brand VARCHAR(100) NULL,
      model VARCHAR(100) NULL,
      quantity INT DEFAULT 0,
      unit VARCHAR(20) DEFAULT 'pcs',
      condition_status ENUM('baik','rusak','perlu_ganti') DEFAULT 'baik',
      location_node_id INT NULL,
      purchase_date DATE NULL,
      purchase_price DECIMAL(15,2) NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Tabel WA Messages
  pool.query(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(255) NOT NULL UNIQUE,
      chat_id VARCHAR(100) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      contact_name VARCHAR(150) NULL,
      body TEXT NOT NULL,
      from_me TINYINT(1) DEFAULT 0,
      is_read TINYINT(1) DEFAULT 0,
      timestamp BIGINT NOT NULL,
      customer_id INT NULL,
      customer_name VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_chat (chat_id),
      INDEX idx_phone (phone),
      INDEX idx_read (is_read),
      INDEX idx_ts (timestamp)
    )
  `).catch(console.error);

  // Tabel WA Contacts (cache kontak)
  pool.query(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(150) NULL,
      customer_id INT NULL,
      customer_name VARCHAR(150) NULL,
      last_message TEXT NULL,
      last_message_at BIGINT NULL,
      unread_count INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS wa_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS wa_auto_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      keyword VARCHAR(100) NOT NULL,
      reply TEXT NOT NULL,
      match_type ENUM('contains','exact','startswith') DEFAULT 'contains',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Tabel Pengeluaran / Dana Operasional
  pool.query(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) DEFAULT '#6366F1',
      icon VARCHAR(50) DEFAULT 'fa-tag',
      description TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NULL,
      amount DECIMAL(15,2) NOT NULL,
      date DATE NOT NULL,
      description TEXT NULL,
      notes TEXT NULL,
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL
    )
  `).catch(console.error);

  // Seed kategori default jika belum ada
  pool.query(`
    INSERT IGNORE INTO expense_categories (id, name, color, icon) VALUES
    (1, 'Operasional', '#3B82F6', 'fa-cogs'),
    (2, 'Internet & Bandwidth', '#10B981', 'fa-wifi'),
    (3, 'Peralatan & Hardware', '#F59E0B', 'fa-tools'),
    (4, 'Listrik & Utilitas', '#EF4444', 'fa-bolt'),
    (5, 'Gaji & SDM', '#8B5CF6', 'fa-users'),
    (6, 'Marketing', '#06B6D4', 'fa-bullhorn'),
    (7, 'Lain-lain', '#94A3B8', 'fa-ellipsis-h')
  `).catch(console.error);

  // Tabel ACS devices — menyimpan cache dari GenieACS
  pool.query(`
    CREATE TABLE IF NOT EXISTS acs_devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(255) NOT NULL UNIQUE,
      sn VARCHAR(100),
      manufacturer VARCHAR(100),
      product_class VARCHAR(100),
      pppoe_user VARCHAR(100),
      ip_address VARCHAR(50),
      status VARCHAR(20) DEFAULT 'offline',
      last_inform DATETIME NULL,
      customer_id INT NULL,
      customer_name VARCHAR(100) NULL,
      extra_params TEXT NULL,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(console.error);

  // Global Settings Middleware — dengan cache 60 detik agar tidak query DB setiap request
  let _settingsCache = null;
  let _settingsCacheAt = 0;
  const SETTINGS_TTL = 300000; // 5 menit

  async function getSettings(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _settingsCache && (now - _settingsCacheAt) < SETTINGS_TTL) {
      return _settingsCache;
    }
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings');
    _settingsCache = {};
    rows.forEach(r => _settingsCache[r.setting_key] = r.setting_value);
    _settingsCacheAt = now;
    return _settingsCache;
  }

  // Expose ke global agar route lain bisa invalidate cache saat settings disimpan
  global.invalidateSettingsCache = () => { _settingsCache = null; };

  // ── Tambah index untuk mempercepat query ──
  const addIndexes = [
    "ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_status (status)",
    "ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_pppoe (pppoe_username)",
    "ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_phone (phone)",
    "ALTER TABLE invoices ADD INDEX IF NOT EXISTS idx_status (status)",
    "ALTER TABLE invoices ADD INDEX IF NOT EXISTS idx_customer (customer_id)",
    "ALTER TABLE invoices ADD INDEX IF NOT EXISTS idx_due (due_date)",
    "ALTER TABLE trouble_tickets ADD INDEX IF NOT EXISTS idx_status (status)",
    "ALTER TABLE trouble_tickets ADD INDEX IF NOT EXISTS idx_priority (priority)",
    "ALTER TABLE trouble_tickets ADD INDEX IF NOT EXISTS idx_created (created_at)",
    "ALTER TABLE fo_nodes ADD INDEX IF NOT EXISTS idx_type (type)",
    "ALTER TABLE fo_cores ADD INDEX IF NOT EXISTS idx_cable (cable_id)",
    "ALTER TABLE fo_core_assignments ADD INDEX IF NOT EXISTS idx_core (core_id)",
  ];
  for (const sql of addIndexes) {
    pool.query(sql).catch(() => {});
  }

  app.use(async (req, res, next) => {
    // Skip untuk static assets agar tidak ada overhead sama sekali
    // Skip static assets dan API requests
    if (req.path.match(/\.(css|js|png|jpg|ico|woff|svg|map)$/)) return next();
    if (req.path.startsWith('/api/') || req.path.includes('/api/')) return next();
    try {
      res.locals.settings = await getSettings();
      next();
    } catch (err) {
      console.error("Settings Middleware Error:", err);
      res.locals.settings = {};
      next();
    }
  });

  // Daily Admin Report Cron (Run at 08:30 AM)
  cron.schedule('30 8 * * *', async () => {
    try {
      console.log('[CRON] Sending Daily Admin Report...');
      const [[stats]] = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM customers) as total_cust,
          (SELECT COUNT(*) FROM customers WHERE status='active') as active_cust,
          (SELECT COUNT(*) FROM customers WHERE status='isolated') as isolated_cust,
          (SELECT COUNT(*) FROM trouble_tickets WHERE status='open') as open_tickets,
          (SELECT COALESCE(SUM(amount),0) FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW())) as revenue_month
        FROM (SELECT 1) as t
      `);

      const { sendWhatsApp, sendTelegram } = require('./helpers/notification');
      const [adminRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'wa_admin'");
      const adminPhone = adminRows[0] ? adminRows[0].setting_value : null;

      const reportMsg = `📊 *Laporan Harian Dino-Bill*\n\n` +
        `👥 Pelanggan: ${stats.total_cust} (${stats.active_cust} Aktif, ${stats.isolated_cust} Isolir)\n` +
        `🎫 Tiket Terbuka: ${stats.open_tickets}\n` +
        `💰 Omset Bln Ini: Rp ${parseFloat(stats.revenue_month).toLocaleString('id-ID')}\n\n` +
        `Sistem berjalan normal. ✅`;

      if (adminPhone) await sendWhatsApp(pool, adminPhone, reportMsg).catch(() => {});
      await sendTelegram(pool, reportMsg).catch(() => {});
    } catch (e) {
      console.error('[CRON] Admin Report Error:', e.message);
    }
  });

  // Removed redundant manual setInterval scheduler (runDailyTasks) 
  // as tasks are now handled by node-cron jobs below for better precision.


  // Auth Middleware
  const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
      return res.redirect('/login');
    }
    next();
  };

  const requireRole = (role) => {
    return (req, res, next) => {
      if (!req.session.userId) return res.redirect('/login');
      if (req.session.role !== 'admin' && req.session.role !== role) {
        return res.status(403).send("Forbidden: Anda tidak memiliki akses ke halaman ini.");
      }
      next();
    };
  };

  // Middleware: hanya admin yang bisa akses
  const adminOnly = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.role !== 'admin') {
      // Teknisi redirect ke portal, sales redirect ke sales
      if (req.session.role === 'technician') return res.redirect('/tickets');
      if (req.session.role === 'sales') return res.redirect('/sales');
      return res.status(403).send('Akses ditolak');
    }
    next();
  };

  const acsRoutes = require('./routes/acs');
  acsRoutes.setPool(pool);
  app.use('/acs', adminOnly, acsRoutes);

  const oltRoutes = require('./routes/olt');
  oltRoutes.setPool(pool);
  app.use('/olt', adminOnly, oltRoutes);

  app.get('/technician', requireRole('technician'), async (req, res) => {
    try {
        const search = req.query.search || '';
        let tickets = [];
        let searchResults = [];

        // 1. Get Open Tickets
        [tickets] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.address as customer_address, c.phone as customer_phone, c.pppoe_username, c.lat, c.lng 
            FROM trouble_tickets t 
            JOIN customers c ON t.customer_id = c.id 
            WHERE t.status = "open" 
            ORDER BY t.priority DESC, t.created_at ASC`);

        // 1.5 Get Pending Installations for this technician
        const [installations] = await pool.query(`
            SELECT * FROM customers 
            WHERE technician_id = ? AND installation_status = 'pending'
            ORDER BY created_at DESC
        `, [req.session.userId]);

        // 2. Handle Search if provided
        if (search) {
            [searchResults] = await pool.query(`
                SELECT c.*, p.name as package_name, 
                       u.rx_power, u.status as onu_status, u.onu_index, u.olt_id, o.name as olt_name
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN hioso_onus u ON u.id = (
                    SELECT id FROM hioso_onus 
                    WHERE (name = c.pppoe_username OR name = c.name) AND name IS NOT NULL AND name != ''
                    ORDER BY status DESC, last_updated DESC 
                    LIMIT 1
                )
                LEFT JOIN hioso_olts o ON u.olt_id = o.id
                WHERE c.phone LIKE ? OR c.pppoe_username LIKE ? OR c.name LIKE ?
                LIMIT 10
            `, [`%${search}%`, `%${search}%`, `%${search}%`]);
        }

        // 3. Get all customers with coordinates for the map
        const [customerMarkers] = await pool.query(`
            SELECT id, name, lat, lng, status, address, pppoe_username 
            FROM customers 
            WHERE lat IS NOT NULL AND lng IS NOT NULL
        `);

        // 4. Get map objects and cables
        const [mapObjects] = await pool.query('SELECT * FROM map_objects');
        const [mapCables] = await pool.query('SELECT * FROM map_cables');

        res.render('technician_portal', { 
            user: req.session, 
            tickets, 
            installations,
            searchResults,
            customerMarkers,
            mapObjects,
            mapCables: mapCables.map(c => ({ ...c, path: JSON.parse(c.path) })),
            search,
            currentPage: 'technician' 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Portal error: " + e.message);
    }
  });

  // API to fetch real-time Wifi SSID from GenieACS
  app.get('/technician/api/wifi-info', requireRole('technician'), async (req, res) => {
    const { pppoe } = req.query;
    if (!pppoe) return res.json({ success: false, message: 'PPPoE user required' });

    try {
        const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        
        if (!s.acs_url) return res.json({ success: false, message: 'ACS not configured' });

        const axios = require('axios');
        const auth = s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined;
        
        // Find device by PPPoE username
        const query = {
            "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username": pppoe
        };
        const projection = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase";

        const response = await axios.get(`${s.acs_url}/devices`, {
            params: { query: JSON.stringify(query), projection },
            auth,
            timeout: 15000
        });

        if (response.data && response.data.length > 0) {
            const dev = response.data[0];
            const getVal = (p) => {
                const parts = p.split('.');
                let v = dev;
                for (const pt of parts) {
                  v = (v && v[pt]) ? v[pt] : undefined;
                }
                return (v && v._value) ? v._value : v;
            };
            const ssid = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            const pass = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase');
            res.json({ success: true, ssid: ssid || 'Unknown', password: pass || 'Unknown' });
        } else {
            res.json({ success: false, message: 'Device not found in ACS' });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });

  // API to fetch real-time ONU Signal (RX Power) from OLT
  app.get('/technician/api/onu-info', requireRole('technician'), async (req, res) => {
    const { olt_id, index } = req.query;
    if (!olt_id || !index) return res.json({ success: false, message: 'OLT ID and Index required' });

    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT not found' });

        const HiosoOLT = require('./helpers/olt');
        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        
        // Fetch real-time data
        const data = await helper.getOnuData(index, olt.last_profile);
        
        // Update database with latest values
        await pool.query(
            'UPDATE hioso_onus SET rx_power = ?, status = ?, last_updated = NOW() WHERE olt_id = ? AND onu_index = ?',
            [data.rx_power, data.status, olt_id, index]
        );

        res.json({ success: true, rx_power: data.rx_power, status: data.status });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });

  app.post('/technician/api/installation-done/:id', requireRole('technician'), async (req, res) => {
    try {
        await pool.query("UPDATE customers SET installation_status = 'completed' WHERE id = ? AND technician_id = ?", [req.params.id, req.session.userId]);
        res.json({ success: true, message: 'Instalasi ditandai sebagai selesai' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
  });

  // API to fetch active PPPoE connections from all routers that are NOT in the database
  app.get('/api/mikrotik/active-pppoe-unlinked', requireAuth, async (req, res) => {
    try {
        const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
        if (routers.length === 0) return res.json({ success: false, message: 'No active routers' });

        const [existingCustomers] = await pool.query("SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != ''");
        const existingNames = new Set(existingCustomers.map(c => c.pppoe_username));

        const MikroTik = require('./helpers/mikrotik');
        let allActive = [];

        for (const router of routers) {
            const result = await MikroTik.getActiveConnections(router);
            if (result.success) {
                // Filter ones not in database
                const unlinked = result.data.filter(c => !existingNames.has(c.name));
                allActive = allActive.concat(unlinked.map(c => ({ 
                    username: c.name, 
                    address: c.address, 
                    uptime: c.uptime,
                    router_id: router.id, 
                    router_name: router.name 
                })));
            }
        }

        res.json({ success: true, data: allActive });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
  });


  app.get('/sales', requireRole('sales'), async (req, res) => {
    const [leads] = await pool.query('SELECT * FROM customers ORDER BY created_at DESC LIMIT 20');
    const [[{ totalLeads }]] = await pool.query('SELECT COUNT(*) as totalLeads FROM customers');
    const [[{ closingMonth }]] = await pool.query('SELECT COUNT(*) as closingMonth FROM customers WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())');
    const [packages] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
    const [routers] = await pool.query('SELECT * FROM routers ORDER BY name ASC');
    res.render('sales_portal', { 
        user: req.session, 
        leads, 
        totalLeads, 
        closingMonth, 
        packages,
        routers,
        commission: closingMonth * 50000,
        currentPage: 'sales'
    });
  });

  const mapRouter = require('./routes/map');
  mapRouter.setPool(pool);
  app.use('/map', adminOnly, mapRouter);

  app.get('/map', adminOnly, async (req, res) => {
    const [customers] = await pool.query(`
        SELECT c.*, o.lat as odp_lat, o.lng as odp_lng, o.name as odp_name 
        FROM customers c 
        LEFT JOIN map_objects o ON c.odp_id = o.id 
        WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL
    `);
    const [objects] = await pool.query('SELECT * FROM map_objects');
    const [cables] = await pool.query('SELECT * FROM map_cables');
    res.render('map', { 
        user: req.session, 
        customers, 
        objects,
        cables: cables.map(c => ({ ...c, path: JSON.parse(c.path) })),
        currentPage: 'map' 
    });
  });

  app.get('/api/mikrotik/traffic', requireAuth, async (req, res) => {
    try {
      const { interface: iface } = req.query;
      const targetIface = iface || 'ether1';
      const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
      const trafficData = [];
      const mikrotik = require('./helpers/mikrotik');
      
      for (const r of routers) {
        // Use target interface from query or default to ether1
        const result = await mikrotik.getInterfaceTraffic(r, targetIface);
        if (result.success) {
          trafficData.push({
            router_id: r.id,
            router_name: r.name,
            rx: parseInt(result.data.rx),
            tx: parseInt(result.data.tx)
          });
        }
      }
      res.json({ success: true, data: trafficData });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  const hotspotRoutes = require('./routes/hotspot');
  hotspotRoutes.setPool(pool);
  app.use('/hotspot', adminOnly, hotspotRoutes);
  app.use('/vouchers', (req, res) => res.redirect('/hotspot/vouchers'));

  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { error: null });
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      if (rows.length > 0) {
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (match) {
          req.session.userId = user.id;
          req.session.role = user.role;
          req.session.username = user.username;
          
          if (user.role === 'technician') return res.redirect('/tickets');
          if (user.role === 'sales') return res.redirect('/sales');
          return res.redirect('/');
        }
      }
      res.render('login', { error: 'invalid_credentials' });
    } catch (err) {
      res.render('login', { error: 'database_error' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', adminOnly, async (req, res) => {
    try {
      // Filter tanggal (default: bulan ini)
      const now     = new Date();
      const defFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      const defTo   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const dateFrom = req.query.dateFrom || defFrom;
      const dateTo   = req.query.dateTo   || defTo;

      const [[{ totalCustomers }]]   = await pool.query("SELECT COUNT(*) as totalCustomers FROM customers");
      const [[{ activeCustomers }]]  = await pool.query("SELECT COUNT(*) as activeCustomers FROM customers WHERE status='active'");
      const [[{ isolatedCustomers }]]= await pool.query("SELECT COUNT(*) as isolatedCustomers FROM customers WHERE status='isolated'");
      const [[{ unpaidInvoices }]]   = await pool.query("SELECT COUNT(*) as unpaidInvoices FROM invoices WHERE status='unpaid'");
      const [[{ overdueInvoices }]]  = await pool.query("SELECT COUNT(*) as overdueInvoices FROM invoices WHERE status='unpaid' AND due_date < CURDATE()");
      const [[{ totalRevenue }]]     = await pool.query(
        "SELECT COALESCE(SUM(amount),0) as totalRevenue FROM invoices WHERE status='paid' AND DATE(paid_at) BETWEEN ? AND ?",
        [dateFrom, dateTo]
      );
      const [[{ newCustomers }]]     = await pool.query(
        "SELECT COUNT(*) as newCustomers FROM customers WHERE DATE(created_at) BETWEEN ? AND ?",
        [dateFrom, dateTo]
      );
      const [[{ openTickets }]]      = await pool.query("SELECT COUNT(*) as openTickets FROM trouble_tickets WHERE status='open'");

      // Grafik 6 bulan terakhir
      const monthlyRevenue   = [];
      const monthlyCustomers = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setMonth(d.getMonth() - i);
        const m = d.getMonth() + 1; const y = d.getFullYear();
        const label = d.toLocaleString('id-ID', { month: 'short', year: 'numeric' });
        const [[{ rev }]] = await pool.query("SELECT COALESCE(SUM(amount),0) as rev FROM invoices WHERE status='paid' AND MONTH(paid_at)=? AND YEAR(paid_at)=?", [m, y]);
        const [[{ cnt }]] = await pool.query("SELECT COUNT(*) as cnt FROM customers WHERE MONTH(created_at)=? AND YEAR(created_at)=?", [m, y]);
        monthlyRevenue.push({ month: label, revenue: parseFloat(rev) });
        monthlyCustomers.push({ month: label, count: parseInt(cnt) });
      }

      const [recentInvoices]  = await pool.query(
        `SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id=c.id ORDER BY i.created_at DESC LIMIT 8`
      );
      const [recentCustomers] = await pool.query(
        `SELECT c.*, p.name as package_name FROM customers c LEFT JOIN packages p ON c.package_id=p.id ORDER BY c.created_at DESC LIMIT 5`
      );

      const [[oltStats]]    = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="Up" THEN 1 ELSE 0 END) as online FROM hioso_onus');
      const [[routerStats]] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as online FROM routers');

      // Fetch ACS stats live from GenieACS API (same source as /acs menu)
      let acsStats = { total: 0, online: 0, linked: 0 };
      try {
        const [acsSettingsRows] = await pool.query(
          "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('acs_url','acs_user','acs_pass')"
        );
        const acsSets = {};
        acsSettingsRows.forEach(r => { acsSets[r.setting_key] = r.setting_value; });
        if (acsSets.acs_url) {
          const _axios = require('axios');
          const acsResp = await _axios.get(`${acsSets.acs_url}/devices`, {
            timeout: 8000,
            auth: acsSets.acs_user ? { username: acsSets.acs_user, password: acsSets.acs_pass } : undefined,
            params: { projection: '_id,_lastInform' }
          });
          if (Array.isArray(acsResp.data)) {
            const _now = Date.now();
            acsStats.total  = acsResp.data.length;
            acsStats.online = acsResp.data.filter(d => d._lastInform && (_now - new Date(d._lastInform).getTime() < 300000)).length;
          }
        }
        // linked count from local DB (customer association)
        const [[{ linked }]] = await pool.query('SELECT COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END),0) as linked FROM acs_devices');
        acsStats.linked = parseInt(linked) || 0;
      } catch (acsErr) {
        console.error('[Dashboard] GenieACS live stats error:', acsErr.message);
        // Fallback to local DB
        try {
          const [[dbAcs]] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="online" THEN 1 ELSE 0 END) as online, SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) as linked FROM acs_devices');
          if (dbAcs) acsStats = { total: parseInt(dbAcs.total)||0, online: parseInt(dbAcs.online)||0, linked: parseInt(dbAcs.linked)||0 };
        } catch(_) {}
      }

      // Pengeluaran bulan berjalan
      const [[expenseStats]] = await pool.query(`
        SELECT COALESCE(SUM(amount),0) as totalExpense,
               COUNT(*) as totalCount
        FROM expenses
        WHERE MONTH(date)=MONTH(NOW()) AND YEAR(date)=YEAR(NOW())
      `);

      // Pengeluaran per kategori bulan ini
      const [expenseByCategory] = await pool.query(`
        SELECT c.name, c.color, c.icon,
               COALESCE(SUM(e.amount),0) as total
        FROM expense_categories c
        LEFT JOIN expenses e ON e.category_id = c.id
          AND MONTH(e.date)=MONTH(NOW()) AND YEAR(e.date)=YEAR(NOW())
        GROUP BY c.id, c.name, c.color, c.icon
        HAVING total > 0
        ORDER BY total DESC
      `);

      // Pengeluaran 6 bulan terakhir
      const monthlyExpenses = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(); d.setMonth(d.getMonth() - i);
        const m = d.getMonth() + 1; const y = d.getFullYear();
        const label = d.toLocaleString('id-ID', { month: 'short', year: 'numeric' });
        const [[{ exp }]] = await pool.query(
          "SELECT COALESCE(SUM(amount),0) as exp FROM expenses WHERE MONTH(date)=? AND YEAR(date)=?", [m, y]
        );
        monthlyExpenses.push({ month: label, expense: parseFloat(exp) });
      }

      // Distribusi pelanggan per paket internet
      const [packageDistRaw] = await pool.query(`
        SELECT p.id, p.name as package_name, p.price, p.speed_limit,
               COUNT(c.id) as total_customers,
               SUM(CASE WHEN c.status='active'   THEN 1 ELSE 0 END) as active,
               SUM(CASE WHEN c.status='isolated' THEN 1 ELSE 0 END) as isolated
        FROM packages p
        LEFT JOIN customers c ON c.package_id = p.id
        GROUP BY p.id, p.name, p.price, p.speed_limit
        ORDER BY total_customers DESC
      `);
      const packageDist = packageDistRaw.filter(r => parseInt(r.total_customers) > 0);

      // OLT per-device untuk bar chart
      const [oltPerDevice] = await pool.query(`
        SELECT o.name as olt_name,
               COUNT(u.id)                                         as total,
               SUM(CASE WHEN u.status='Up'   THEN 1 ELSE 0 END)   as online,
               SUM(CASE WHEN u.status='Down' THEN 1 ELSE 0 END)   as offline
        FROM hioso_olts o
        LEFT JOIN hioso_onus u ON u.olt_id = o.id
        GROUP BY o.id, o.name ORDER BY total DESC
      `);

      // Distribusi kualitas sinyal RX (rx_power adalah VARCHAR, perlu CAST)
      const [[signalDist]] = await pool.query(`
        SELECT
          SUM(CASE WHEN CAST(rx_power AS DECIMAL(8,2)) > -20                                        THEN 1 ELSE 0 END) as excellent,
          SUM(CASE WHEN CAST(rx_power AS DECIMAL(8,2)) <= -20 AND CAST(rx_power AS DECIMAL(8,2)) > -25 THEN 1 ELSE 0 END) as good,
          SUM(CASE WHEN CAST(rx_power AS DECIMAL(8,2)) <= -25 AND CAST(rx_power AS DECIMAL(8,2)) > -27 THEN 1 ELSE 0 END) as fair,
          SUM(CASE WHEN CAST(rx_power AS DECIMAL(8,2)) <= -27 AND CAST(rx_power AS DECIMAL(8,2)) > -30 THEN 1 ELSE 0 END) as weak,
          SUM(CASE WHEN CAST(rx_power AS DECIMAL(8,2)) <= -30 OR rx_power = '0' OR rx_power IS NULL  THEN 1 ELSE 0 END) as bad
        FROM hioso_onus WHERE status = 'Up'
      `);

      // ── Tab 3: Tagihan jatuh tempo minggu ini ──
      const [dueThisWeek] = await pool.query(`
        SELECT i.*, c.name as customer_name, c.phone as customer_phone, p.name as package_name
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE i.status = 'unpaid'
          AND i.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
        ORDER BY i.due_date ASC
        LIMIT 50
      `).catch(() => [[]]);

      // ── Tab 3: Pelanggan isolir beserta durasi ──
      const [isolatedList] = await pool.query(`
        SELECT c.*, p.name as package_name, p.price,
               DATEDIFF(NOW(), c.updated_at) as days_isolated
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE c.status = 'isolated'
        ORDER BY days_isolated DESC
        LIMIT 50
      `).catch(() => [[]]);

      // ── Tab 4: Tiket per teknisi (semua teknisi, termasuk yg belum punya tiket) ──
      const [ticketsByTech] = await pool.query(`
        SELECT
          u.id, u.username as technician,
          COUNT(t.id)                                                as total,
          SUM(CASE WHEN t.status='open'        THEN 1 ELSE 0 END)   as open,
          SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END)   as in_progress,
          SUM(CASE WHEN t.status='resolved'    THEN 1 ELSE 0 END)   as resolved
        FROM users u
        LEFT JOIN trouble_tickets t ON t.technician_id = u.id
        WHERE u.role = 'technician'
        GROUP BY u.id, u.username
        ORDER BY open DESC, total DESC
      `).catch(() => [[]]);

      // ── Tab 4: Tiket dibuka hari ini ──
      const [todayTickets] = await pool.query(`
        SELECT t.*, c.name as customer_name, u.username as technician_name
        FROM trouble_tickets t
        LEFT JOIN customers c ON t.customer_id = c.id
        LEFT JOIN users u ON t.technician_id = u.id
        WHERE DATE(t.created_at) = CURDATE()
        ORDER BY t.created_at DESC
        LIMIT 30
      `).catch(() => [[]]);

      // ── Tab 4: Statistik tiket ──
      const [[ticketStats]] = await pool.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status='open'        THEN 1 ELSE 0 END) as open,
          SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status='resolved'    THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) THEN 1 ELSE 0 END) as this_month,
          SUM(CASE WHEN DATE(created_at)=CURDATE() THEN 1 ELSE 0 END) as today
        FROM trouble_tickets
      `).catch(() => [[{ total:0, open:0, in_progress:0, resolved:0, this_month:0, today:0 }]]);

      // ── Tab 2: PPPoE Stats per Router ──
      const [pppoePerRouter] = await pool.query(`
        SELECT r.id, r.name as router_name, r.ip_address, r.status,
               COUNT(c.id)                                               as total_users,
               SUM(CASE WHEN c.status='active'   THEN 1 ELSE 0 END)     as active_users,
               SUM(CASE WHEN c.status='isolated' THEN 1 ELSE 0 END)     as isolated_users
        FROM routers r
        LEFT JOIN customers c ON c.router_id = r.id
        GROUP BY r.id, r.name, r.ip_address, r.status
        ORDER BY total_users DESC
      `).catch(() => [[]]);

      const [[pppoeStats]] = await pool.query(`
        SELECT
          COUNT(*)                                           as total_accounts,
          SUM(CASE WHEN status='active'   THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status='isolated' THEN 1 ELSE 0 END) as isolated,
          SUM(CASE WHEN pppoe_username IS NOT NULL AND pppoe_username != '' THEN 1 ELSE 0 END) as with_pppoe
        FROM customers
      `).catch(() => [[{ total_accounts:0, active:0, isolated:0, with_pppoe:0 }]]);

      res.render('dashboard', {
        user: req.session,
        stats: { totalCustomers, activeCustomers, isolatedCustomers, unpaidInvoices, overdueInvoices, totalRevenue, openTickets, newCustomers },
        monthlyRevenue, monthlyCustomers, recentInvoices, recentCustomers,
        oltStats:    oltStats    || { total: 0, online: 0 },
        routerStats: routerStats || { total: 0, online: 0 },
        acsStats:    acsStats    || { total: 0, online: 0, linked: 0 },
        expenseStats: expenseStats || { totalExpense: 0, totalCount: 0 },
        dueThisWeek: dueThisWeek || [], isolatedList: isolatedList || [],
        ticketsByTech: ticketsByTech || [], todayTickets: todayTickets || [],
        ticketStats: ticketStats || { total:0, open:0, in_progress:0, resolved:0, this_month:0, today:0 },
        pppoePerRouter: pppoePerRouter || [],
        pppoeStats: pppoeStats || { total_accounts:0, active:0, isolated:0, with_pppoe:0 },
        expenseByCategory: expenseByCategory || [],
        monthlyExpenses: monthlyExpenses || [],
        oltPerDevice: oltPerDevice || [],
        signalDist:   signalDist  || { excellent:0, good:0, fair:0, weak:0, bad:0 },
        packageDist:  packageDist  || [],
        dateFrom, dateTo,
        currentPage: 'dashboard'
      });
    } catch (err) {
      console.error(err);
      res.render('dashboard', {
        user: req.session, stats: {},
        monthlyRevenue: [], monthlyCustomers: [], recentInvoices: [], recentCustomers: [],
        oltStats: { total:0, online:0 }, routerStats: { total:0, online:0 },
        oltPerDevice: [], signalDist: { excellent:0, good:0, fair:0, weak:0, bad:0 },
        packageDist: [],
        acsStats: { total: 0, online: 0, linked: 0 },
        expenseStats: { totalExpense: 0, totalCount: 0 },
        expenseByCategory: [], monthlyExpenses: [],
        dueThisWeek: [], isolatedList: [],
        ticketsByTech: [], todayTickets: [],
        ticketStats: { total:0, open:0, in_progress:0, resolved:0, this_month:0, today:0 },
        pppoePerRouter: [], pppoeStats: { total_accounts:0, active:0, isolated:0, with_pppoe:0 },
        dateFrom: '', dateTo: '',
        currentPage: 'dashboard'
      });
    }
  });

  // ── API: Live PPPoE active sessions per router (for dashboard card) ──
  app.get('/api/dashboard/pppoe-live', adminOnly, async (req, res) => {
    try {
      const [routers] = await pool.query(
        "SELECT id, name as router_name, ip_address, username, password, port, status FROM routers WHERE status='active'"
      );
      const results = await Promise.all(routers.map(async (r) => {
        try {
          const result = await mikrotikHelper.getActiveConnections(r);
          return {
            id: r.id,
            router_name: r.router_name,
            ip_address: r.ip_address,
            status: r.status,
            active_live: result.success ? result.data.length : null,
            error: result.success ? null : result.message
          };
        } catch (e) {
          return { id: r.id, router_name: r.router_name, ip_address: r.ip_address, status: r.status, active_live: null, error: e.message };
        }
      }));
      res.json({ success: true, data: results });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  // Register Routes
  const customersRouter = require('./routes/customers');
  customersRouter.setPool(pool);
  app.use('/customers', adminOnly, customersRouter);

  const billingRouter = require('./routes/billing');
  billingRouter.setPool(pool);
  app.use('/billing', adminOnly, billingRouter);

  const mikrotikRouter = require('./routes/mikrotik');
  mikrotikRouter.setPool(pool);
  app.use('/mikrotik', adminOnly, mikrotikRouter);

  const settingsRouter = require('./routes/settings');
  settingsRouter.setPool(pool);
  app.use('/settings', adminOnly, settingsRouter);

  const expensesRouter = require('./routes/expenses');
  expensesRouter.setPool(pool);
  app.use('/expenses', adminOnly, expensesRouter);

  const waRouter = require('./routes/wa');
  waRouter.setPool(pool);
  app.use('/wa', adminOnly, waRouter);

  const attendanceRouter = require('./routes/attendance');
  attendanceRouter.setPool(pool);
  app.use('/attendance', requireAuth, attendanceRouter);

  const foRouter = require('./routes/fo');
  foRouter.setPool(pool);
  // FO bisa diakses admin dan teknisi
  app.use('/fo', (req, res, next) => {
      if (!req.session.userId) return res.redirect('/login');
      if (!['admin','technician'].includes(req.session.role)) return res.status(403).send('Akses ditolak');
      next();
  }, foRouter);

  const portalRoutes = require('./routes/portal');
  portalRoutes.setPool(pool);
  app.use('/portal', portalRoutes);

  const packagesRouter = require('./routes/packages');
  packagesRouter.setPool(pool);
  app.use('/packages', adminOnly, packagesRouter);

  const ticketsRouter = require('./routes/tickets');
  ticketsRouter.setPool(pool);
  app.use('/tickets', requireAuth, ticketsRouter);

  const inventoryRouter = require('./routes/inventory');
  inventoryRouter.setPool(pool);
  app.use('/inventory', adminOnly, inventoryRouter);

  const monitoringRouter = require('./routes/monitoring');
  monitoringRouter.setPool(pool);
  app.use('/monitoring', adminOnly, monitoringRouter);

  // Background Tasks / Cron Jobs

  // Daily at midnight: auto-isolate overdue customers + MikroTik + WA
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('[CRON] Running daily auto-isolir...');
      const [overdueRows] = await pool.query(
        `SELECT DISTINCT i.customer_id FROM invoices i
         WHERE i.status = 'unpaid' AND i.due_date < CURDATE()`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;
      let count = 0;

      for (const row of overdueRows) {
        if (sentCount >= waLimit) break;
        const [result] = await pool.query(
          "UPDATE customers SET status='isolated' WHERE id=? AND status='active'", [row.customer_id]
        );
        if (result.affectedRows > 0) {
          count++;
          // Disable on MikroTik + send WA
          const [[cust]] = await pool.query(
            "SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port FROM customers c LEFT JOIN routers r ON c.router_id = r.id WHERE c.id=?",
            [row.customer_id]
          );
          if (cust) {
            if (cust.pppoe_username && cust.r_ip) {
              mikrotikHelper.disablePPPoESecret(
                { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port },
                cust.pppoe_username
              ).catch(() => {});
            }
            await notifyIsolation(pool, cust);
            sentCount++;
            await new Promise(r => setTimeout(r, waDelay));
          }
        }
      }
      console.log(`[CRON] Auto-isolir done. ${count} customers isolated and notified.`);
    } catch (e) {
      console.error('[CRON] Auto-isolir error:', e.message);
    }
  });


  // Daily at 8 AM: send WA reminder for invoices due in 3 days
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[CRON] Sending payment reminders...');
      const [upcoming] = await pool.query(
        `SELECT i.*, c.name, c.phone FROM invoices i
         JOIN customers c ON i.customer_id = c.id
         WHERE i.status = 'unpaid' AND i.due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY)
         AND c.phone IS NOT NULL AND c.phone != ''`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const inv of upcoming) {
        if (sentCount >= waLimit) break;
        const dueStr = new Date(inv.due_date).toLocaleDateString('id-ID');
        await notifyReminder(pool, inv, inv.amount, dueStr);
        sentCount++;
        await new Promise(r => setTimeout(r, waDelay));
      }
      console.log(`[CRON] Reminders sent: ${sentCount}`);
    } catch (e) {
      console.error('[CRON] Reminder error:', e.message);
    }
  });

  // Monthly on 1st: generate invoices for all active customers + send WA
  cron.schedule('0 6 1 * *', async () => {
    try {
      console.log('[CRON] Generating monthly invoices...');
      const [customers] = await pool.query(
        `SELECT c.*, p.price as package_price FROM customers c 
         LEFT JOIN packages p ON c.package_id = p.id WHERE c.status = 'active' AND (c.billing_method IS NULL OR c.billing_method = 'fixed')`
      );
      const month = new Date().getMonth() + 1;
      const year = new Date().getFullYear();
      let created = 0;
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const c of customers) {
        if (sentCount >= waLimit) break;
        const [[exists]] = await pool.query(
          'SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=?',
          [c.id, month, year]
        );
        if (!exists) {
          const day = c.isolation_date || 20;
          const dueDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          await pool.query(
            'INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?,?,?,?,?)',
            [c.id, c.package_id, c.package_price || 0, dueDate, 'unpaid']
          );
          created++;
          // Send WA notification (sequential)
          await notifyInvoiceCreated(pool, c, c.package_price || 0, dueDate);
          sentCount++;
          await new Promise(r => setTimeout(r, waDelay));
        }
      }
      console.log(`[CRON] Monthly invoices: ${created} created and notified.`);
    } catch (e) {
      console.error('[CRON] Invoice generation error:', e.message);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // CRON: Auto Sync OLT — round-robin satu OLT per interval
  // Interval default: setiap 5 menit
  // Bisa diubah lewat settings: olt_sync_interval (dalam menit, min 2)
  // ═══════════════════════════════════════════════════════════════
  let _oltSyncIndex = 0;

  const doOltSync = async () => {
    try {
      const [olts] = await pool.query(`SELECT * FROM hioso_olts WHERE status = 'active' OR status IS NULL`);
      if (!olts || olts.length === 0) return;

      // Round-robin: ambil satu OLT per giliran
      const olt = olts[_oltSyncIndex % olts.length];
      _oltSyncIndex++;

      const HiosoOLT = require('./helpers/olt');
      const helper   = new HiosoOLT(olt.host, olt.community, olt.port || 161);
      const profile  = (olt.brand && olt.brand !== 'HIOSO') ? olt.brand : (olt.last_profile || null);

      console.log(`[CRON OLT] Sync "${olt.name}" (profile: ${profile || 'auto-detect'})...`);
      const { onus, detectedProfile } = await helper.getOnuList(profile);

      // Simpan profile yang terdeteksi jika berbeda
      if (detectedProfile && detectedProfile !== olt.last_profile) {
        await pool.query('UPDATE hioso_olts SET last_profile = ? WHERE id = ?', [detectedProfile, olt.id]);
      }

      if (onus && onus.length > 0) {
        // Upsert: update jika sudah ada, insert jika baru
        for (const o of onus) {
          await pool.query(`
            INSERT INTO hioso_onus (olt_id, onu_index, name, sn, mac, tx_power, rx_power, status, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              name        = VALUES(name),
              tx_power    = VALUES(tx_power),
              rx_power    = VALUES(rx_power),
              status      = VALUES(status),
              last_updated = NOW()
          `, [olt.id, o.index, o.name, o.sn || '', o.mac || '', o.tx_power, o.rx_power, o.status]);
        }

        // Hapus ONU yang sudah tidak ada di OLT (sudah dicabut)
        const activeIndexes = onus.map(o => o.index);
        if (activeIndexes.length > 0) {
          const placeholders = activeIndexes.map(() => '?').join(',');
          await pool.query(
            `DELETE FROM hioso_onus WHERE olt_id = ? AND onu_index NOT IN (${placeholders})`,
            [olt.id, ...activeIndexes]
          );
        }

        console.log(`[CRON OLT] "${olt.name}" selesai — ${onus.length} ONU (${onus.filter(o=>o.status==='Up').length} Up / ${onus.filter(o=>o.status==='Down').length} Down)`);
      } else {
        console.log(`[CRON OLT] "${olt.name}" — tidak ada ONU ditemukan, data lama dipertahankan.`);
      }
    } catch (e) {
      console.error('[CRON OLT] Error:', e.message);
    }
  };

  // Jalankan setiap 5 menit (bisa disesuaikan)
  cron.schedule('*/5 * * * *', doOltSync);
  console.log('[CRON OLT] Auto-sync aktif — interval 5 menit (round-robin per OLT)');

  // ═══════════════════════════════════════════════════════════════
  // CRON: Auto Sync GenieACS → MySQL (setiap 5 menit)
  // Menyimpan semua device ONT dari GenieACS ke tabel acs_devices
  // Cross-reference otomatis dengan tabel customers via pppoe_user
  // ═══════════════════════════════════════════════════════════════
  const doAcsSync = async () => {
    try {
      const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('acs_url','acs_user','acs_pass','acs_path_pppoe','acs_path_ip','acs_vparams')"
      );
      const s = {};
      rows.forEach(r => s[r.setting_key] = r.setting_value);
      if (!s.acs_url) return;

      const axios = require('axios');
      const vParams = s.acs_vparams ? s.acs_vparams.split(/\r?\n/).filter(p => p.trim()) : [];

      let projection = '_id,_lastInform,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber';
      const commonPaths = [
        s.acs_path_pppoe || 'VirtualParameters.PPPoEUser',
        s.acs_path_ip    || 'VirtualParameters.IPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
      ];
      projection += ',' + [...new Set(commonPaths)].join(',');
      if (vParams.length > 0) projection += ',' + vParams.join(',');

      const getVal = (d, path) => {
        if (!path) return null;
        const parts = path.split('.');
        let val = d;
        for (const part of parts) { val = (val && val[part]) ? val[part] : undefined; }
        return (val && typeof val === 'object' && '_value' in val) ? val._value : (val || null);
      };

      // Fetch semua device dengan pagination (GenieACS default limit 200)
      const BATCH = 200;
      let allDevices = [];
      let skip = 0;
      while (true) {
        const response = await axios.get(`${s.acs_url}/devices`, {
          timeout: 30000,
          auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined,
          params: { projection, limit: BATCH, skip }
        });
        if (!Array.isArray(response.data) || response.data.length === 0) break;
        allDevices = allDevices.concat(response.data);
        console.log(`[CRON ACS] Fetched ${allDevices.length} devices...`);
        if (response.data.length < BATCH) break; // batch terakhir
        skip += BATCH;
      }

      if (allDevices.length === 0) return;

      // Ambil semua customers untuk cross-reference PPPoE
      const [customers] = await pool.query('SELECT id, name, pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != ""');
      const custMap = {};
      customers.forEach(c => { if (c.pppoe_username) custMap[c.pppoe_username.toLowerCase()] = c; });

      let synced = 0;
      for (const d of allDevices) {
        const deviceId    = d._id;
        const sn          = (d._deviceId && d._deviceId._SerialNumber) ? d._deviceId._SerialNumber : deviceId;
        const manufacturer= (d._deviceId && d._deviceId._Manufacturer)  ? d._deviceId._Manufacturer  : 'Unknown';
        const productClass= (d._deviceId && d._deviceId._ProductClass)  ? d._deviceId._ProductClass  : 'ONT';
        const lastInform  = d._lastInform ? new Date(d._lastInform) : null;
        const isOnline    = lastInform ? (Date.now() - lastInform.getTime() < 300000) : false;
        const pppoeUser   = getVal(d, s.acs_path_pppoe)
                         || getVal(d, 'VirtualParameters.PPPoEUser')
                         || getVal(d, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username')
                         || null;
        const ipAddress   = getVal(d, s.acs_path_ip)
                         || getVal(d, 'VirtualParameters.IPAddress')
                         || getVal(d, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress')
                         || null;

        // Cross-reference dengan customers
        let customerId   = null;
        let customerName = null;
        if (pppoeUser) {
          const match = custMap[pppoeUser.toLowerCase()];
          if (match) { customerId = match.id; customerName = match.name; }
        }

        // Extra virtual params sebagai JSON
        const extraParams = {};
        vParams.forEach(p => { extraParams[p] = getVal(d, p); });

        await pool.query(`
          INSERT INTO acs_devices (device_id, sn, manufacturer, product_class, pppoe_user, ip_address, status, last_inform, customer_id, customer_name, extra_params, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            sn            = VALUES(sn),
            manufacturer  = VALUES(manufacturer),
            product_class = VALUES(product_class),
            pppoe_user    = VALUES(pppoe_user),
            ip_address    = VALUES(ip_address),
            status        = VALUES(status),
            last_inform   = VALUES(last_inform),
            customer_id   = VALUES(customer_id),
            customer_name = VALUES(customer_name),
            extra_params  = VALUES(extra_params),
            last_updated  = NOW()
        `, [
          deviceId, sn, manufacturer, productClass,
          pppoeUser, ipAddress,
          isOnline ? 'online' : 'offline',
          lastInform,
          customerId, customerName,
          JSON.stringify(extraParams)
        ]);
        synced++;
      }

      const onlineCount = allDevices.filter(d => d._lastInform && Date.now()-new Date(d._lastInform).getTime()<300000).length;
      console.log(`[CRON ACS] Sync selesai — ${synced} device (${onlineCount} online, ${synced - onlineCount} offline)`);
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
        console.log('[CRON ACS] GenieACS tidak dapat dijangkau, skip sync.');
      } else {
        console.error('[CRON ACS] Error:', e.message);
      }
    }
  };

  cron.schedule('*/5 * * * *', doAcsSync);
  console.log('[CRON ACS] Auto-sync GenieACS aktif — interval 5 menit');
  // Langsung sync saat server start (tidak tunggu 5 menit pertama)
  setTimeout(doAcsSync, 8000);

  // Export CSV - Customers
  app.get('/export/customers', requireAuth, async (req, res) => {
    try {
      const [customers] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.address, p.name as package_name, p.price as package_price,
                c.pppoe_username, c.billing_method, c.isolation_date, c.status, c.created_at
         FROM customers c LEFT JOIN packages p ON c.package_id = p.id ORDER BY c.name ASC`
      );
      let csv = 'ID,Nama,Telepon,Alamat,Paket,Harga,PPPoE,Metode,Tgl Isolir,Status,Tgl Daftar\n';
      for (const c of customers) {
        csv += `${c.id},"${c.name}","${c.phone || ''}","${c.address || ''}","${c.package_name || ''}",${c.package_price || 0},"${c.pppoe_username || ''}","${c.billing_method || 'fixed'}",${c.isolation_date || 20},${c.status},"${new Date(c.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pelanggan-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send('\uFEFF' + csv); // BOM for Excel UTF-8
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Export CSV - Invoices
  app.get('/export/invoices', requireAuth, async (req, res) => {
    try {
      const [invoices] = await pool.query(
        `SELECT i.id, c.name as customer_name, c.pppoe_username, i.amount, i.status, i.due_date, i.paid_at, i.created_at
         FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC`
      );
      let csv = 'ID,Pelanggan,PPPoE,Nominal,Status,Jatuh Tempo,Tanggal Bayar,Dibuat\n';
      for (const i of invoices) {
        csv += `${i.id},"${i.customer_name || ''}","${i.pppoe_username || ''}",${i.amount},${i.status},"${i.due_date || ''}","${i.paid_at ? new Date(i.paid_at).toLocaleDateString('id-ID') : ''}","${new Date(i.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${new Date().toISOString().slice(0,10)}.csv"`);
      res.send('\uFEFF' + csv);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Admin Profile - GET
  app.get('/profile', requireAuth, async (req, res) => {
    try {
      const [[user]] = await pool.query('SELECT id, username, role, created_at FROM users WHERE id=?', [req.session.userId]);
      res.render('profile', { user: req.session, profile: user, currentPage: 'profile' });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Admin Profile - Change Password
  app.post('/profile/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
      const [[user]] = await pool.query('SELECT * FROM users WHERE id=?', [req.session.userId]);
      const match = await bcrypt.compare(current_password, user.password);
      if (!match) return res.json({ success: false, message: 'Password lama salah' });
      const hashed = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password=? WHERE id=?', [hashed, req.session.userId]);
      res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Tripay Callback Webhook (no auth - called by Tripay server)
  app.post('/api/tripay/callback', async (req, res) => {
    try {
      const crypto = require('crypto');
      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'tripay_private_key'");
      if (!settingsRows.length) return res.status(400).json({ success: false });

      const privateKey = settingsRows[0].setting_value;
      const callbackSignature = req.headers['x-callback-signature'] || '';
      const json = JSON.stringify(req.body);
      const signature = crypto.createHmac('sha256', privateKey).update(json).digest('hex');

      if (callbackSignature !== signature) {
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const { merchant_ref, status } = req.body;
      if (status === 'PAID') {
        const invId = merchant_ref.split('-')[1];
        if (invId) {
          await pool.query("UPDATE invoices SET status='paid', paid_at=NOW(), payment_method='Tripay' WHERE id=?", [invId]);
          
          // Auto-unisolate + MikroTik Activation
          const [[cust]] = await pool.query(`
            SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port 
            FROM invoices i 
            JOIN customers c ON i.customer_id = c.id 
            LEFT JOIN routers r ON c.router_id = r.id 
            WHERE i.id = ?`, [invId]);

          if (cust) {
            await pool.query("UPDATE customers SET status='active' WHERE id=? AND status='isolated'", [cust.id]);
            
            // Re-enable on MikroTik
            if (cust.pppoe_username && cust.r_ip) {
              await mikrotikHelper.enablePPPoESecret(
                { ip_address: cust.r_ip, username: cust.r_user, password: cust.r_pass, port: cust.r_port },
                cust.pppoe_username
              ).catch(e => console.error(`[Callback] MikroTik activation failed: ${e.message}`));
            }

            // --- Rolling Billing Logic ---
            const today = new Date();
            const currentDay = today.getDate();
            let billingMethod = cust.billing_method || 'fixed';

            // Auto-switch to rolling if paid on/after 25th
            if (currentDay >= 25) {
              billingMethod = 'rolling';
              await pool.query("UPDATE customers SET billing_method='rolling' WHERE id=?", [cust.id]);
            }

            // If rolling, generate next invoice due in 30 days
            if (billingMethod === 'rolling') {
              const nextDue = new Date();
              nextDue.setDate(nextDue.getDate() + 30);
              const nextDueStr = nextDue.toISOString().split('T')[0];
              
              // Check if invoice for next period already exists to avoid duplicates
              const [[exists]] = await pool.query('SELECT id FROM invoices WHERE customer_id=? AND due_date=?', [cust.id, nextDueStr]);
              if (!exists) {
                const [pkg] = await pool.query('SELECT price FROM packages WHERE id=?', [cust.package_id]);
                const amount = pkg[0] ? pkg[0].price : 0;
                await pool.query('INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?, ?, ?, ?, ?)', 
                  [cust.id, cust.package_id, amount, nextDueStr, 'unpaid']);
              }
            }
          }
          console.log(`[Tripay] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Tripay] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Print Invoice
  app.get('/print/invoice', requireAuth, async (req, res) => {
    try {
      const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.redirect('/billing');
      const placeholders = ids.map(() => '?').join(',');
      const [invoices] = await pool.query(
        `SELECT i.*,
                c.name as customer_name, c.address as customer_address,
                c.phone as customer_phone, c.email as customer_email,
                c.pppoe_username,
                p.name as package_name, p.speed_limit, p.price as package_price
         FROM invoices i
         LEFT JOIN customers c ON i.customer_id = c.id
         LEFT JOIN packages p ON c.package_id = p.id
         WHERE i.id IN (${placeholders})
         ORDER BY i.id ASC`, ids
      );
      const [rows] = await pool.query('SELECT * FROM settings');
      const settings = {};
      rows.forEach(r => settings[r.setting_key] = r.setting_value);
      res.render('print_invoice', { user: req.session, invoices, settings });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Import Customers CSV
  app.post('/import/customers', requireAuth, async (req, res) => {
    try {
      const csv = req.body.csv_data || '';
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.json({ success: false, message: 'File CSV kosong atau tidak valid' });
      let imported = 0, skipped = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const [, name, phone, address, , , pppoe, method, isolDate, status] = cols;
        if (!name) { skipped++; continue; }
        try {
          await pool.query(
            'INSERT INTO customers (name, phone, address, pppoe_username, billing_method, isolation_date, status) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE phone=VALUES(phone)',
            [name, phone || '', address || '', pppoe || '', method || 'fixed', parseInt(isolDate) || 20, status || 'active']
          );
          imported++;
        } catch { skipped++; }
      }
      res.json({ success: true, message: `Import selesai: ${imported} berhasil, ${skipped} dilewati` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Github Auto-Updater Endpoint (secured with auth)
  app.post('/api/system/update', requireAuth, async (req, res) => {
    const simpleGit = require('simple-git');
    const git = simpleGit(__dirname);
    try {
      // Baca URL repo dari settings (jika ada), fallback ke remote origin saat ini
      const [settingRows] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'git_repo_url' LIMIT 1"
      );
      const customRepoUrl = settingRows.length > 0 && settingRows[0].setting_value
        ? settingRows[0].setting_value.trim()
        : null;

      // Baca branch dari settings, default main
      const [branchRows] = await pool.query(
        "SELECT setting_value FROM settings WHERE setting_key = 'git_branch' LIMIT 1"
      );
      const branch = (branchRows.length > 0 && branchRows[0].setting_value)
        ? branchRows[0].setting_value.trim()
        : 'main';

      // Jika ada custom repo URL, set remote origin ke URL tersebut
      if (customRepoUrl) {
        await git.remote(['set-url', 'origin', customRepoUrl]);
        console.log(`[UPDATE] Remote origin diset ke: ${customRepoUrl}`);
      }

      const currentRemote = await git.remote(['get-url', 'origin']);
      console.log(`[UPDATE] Pull dari: ${(currentRemote||'').trim()} branch: ${branch}`);

      await git.pull('origin', branch);

      const { exec } = require('child_process');
      exec('npm install', (error, stdout, stderr) => {
        if (error) {
          console.error(`npm install error: ${error}`);
          return res.status(500).json({ success: false, message: "Update berhasil, tapi npm install gagal. Jalankan manual." });
        }
        res.json({ success: true, message: `Aplikasi berhasil diperbarui dari ${(currentRemote||'').trim()} (${branch}). Server restart dalam 3 detik.` });
        setTimeout(() => {
          console.log("[UPDATE] Restarting...");
          process.exit(0);
        }, 3000);
      });
    } catch (e) {
      console.error('[UPDATE] Error:', e.message);
      res.status(500).json({ success: false, message: "Gagal update: " + e.message });
    }
  });

  // ── Network Tools: Ping & Traceroute ────────────────────────
  function validateIP(ip) {
    return typeof ip === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(n => parseInt(n) <= 255);
  }

  app.post('/api/network/ping', requireAuth, (req, res) => {
    const { ip } = req.body;
    if (!validateIP(ip)) return res.json({ success: false, output: 'IP tidak valid' });
    const cmd = IS_WIN ? `ping -n 4 ${ip}` : `ping -c 4 -W 2 ${ip}`;
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      res.json({ success: true, output: (stdout || '') + (stderr || '') || 'Tidak ada output' });
    });
  });

  app.post('/api/network/traceroute', requireAuth, (req, res) => {
    const { ip } = req.body;
    if (!validateIP(ip)) return res.json({ success: false, output: 'IP tidak valid' });
    const cmd = IS_WIN ? `tracert -h 20 -w 1000 ${ip}` : `traceroute -m 20 -w 2 ${ip}`;
    exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
      res.json({ success: true, output: (stdout || '') + (stderr || '') || 'Tidak ada output' });
    });
  });
}

const server = app.listen(PORT, () => {
  console.log(`Dino-Bill running on http://localhost:${PORT}`);
  
  // Initialize WhatsApp after server is up
  if (isInstalled) {
    const { initWhatsApp } = require('./helpers/whatsapp');
    initWhatsApp(pool).catch(err => console.error('[WA-INIT] Error:', err));
  }
});
server.setTimeout(30000); // 30 detik cukup untuk request HTTP normal
