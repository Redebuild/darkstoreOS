import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { initDB, db } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JWT_SECRET = 'darkstore-secret-superkey-9988';

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // Support base64 email attachment payloads
app.use(cookieParser());

// Initialize Database Schema
await initDB();

// ---------------- 1. AUTHENTICATION ROUTES ----------------

app.post('/api/auth/register', async (req, res) => {
  const { email, password, company_name } = req.body;
  if (!email || !password || !company_name) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const existing = db.get(`SELECT id FROM users WHERE email = ?`, [email.toLowerCase().trim()]);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists.' });
  }

  const userId = 'usr_' + Date.now().toString(36);
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    db.run(
      `INSERT INTO users (id, email, password_hash, company_name) VALUES (?, ?, ?, ?)`,
      [userId, email.toLowerCase().trim(), passwordHash, company_name.trim()]
    );

    const token = jwt.sign({ userId, email, company: company_name }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ token, user: { id: userId, email, company: company_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  const user = db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase().trim()]);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = jwt.sign({ userId: user.id, email: user.email, company: user.company_name }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ token, user: { id: user.id, email: user.email, company: user.company_name } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthenticated' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Session expired' });
  }
});

// Middleware to guard protected routes
function authenticate(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Please login to continue' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Serve public static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 2. ONE-CLICK PLATFORM CATALOG AUTO-SYNC ----------------

function mockFetchFromPlatform(platform, sellerId) {
  return [
    {
      sku_code: 'CB-250-NITRO',
      sku_name: 'Nitro Cold Brew Can 250ml',
      category: 'Beverages',
      unit_price: 150.0,
      cluster_name: `${platform} - DLF Phase 3`,
      pincode: '122010',
      lead_time_hours: 2.5,
      current_stock: 8,
      burn_rate: 4.2 // 8 / 4.2 = 1.9 hrs runway vs 2.5 hrs lead time -> DELIST THREAT!
    },
    {
      sku_code: 'CB-250-NITRO',
      sku_name: 'Nitro Cold Brew Can 250ml',
      category: 'Beverages',
      unit_price: 150.0,
      cluster_name: `${platform} - South Extension 2`,
      pincode: '110049',
      lead_time_hours: 3.0,
      current_stock: 35,
      burn_rate: 2.1 // 35 / 2.1 = 16.6 hrs runway -> HEALTHY
    },
    {
      sku_code: 'OAT-LATTE-200',
      sku_name: 'Classic Oat Milk Latte 200ml',
      category: 'Beverages',
      unit_price: 180.0,
      cluster_name: `${platform} - Indirapuram Hub`,
      pincode: '201014',
      lead_time_hours: 3.5,
      current_stock: 4,
      burn_rate: 2.0 // 4 / 2.0 = 2.0 hrs runway vs 3.5 hrs lead time -> DELIST THREAT!
    }
  ];
}

app.post('/api/integrations/connect', authenticate, (req, res) => {
  const { platform, seller_id, api_key } = req.body;

  if (!platform || !seller_id) {
    return res.status(400).json({ error: 'Platform and Seller ID are required.' });
  }

  try {
    db.run(`
      INSERT INTO seller_integrations (user_id, platform, seller_id, api_key, last_synced, status)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'CONNECTED')
      ON CONFLICT(user_id, platform, seller_id) DO UPDATE SET
        api_key = excluded.api_key,
        last_synced = CURRENT_TIMESTAMP,
        status = 'CONNECTED'
    `, [req.userId, platform, seller_id.trim(), api_key || 'LIVE_TOKEN_MOCK']);

    const platformCatalog = mockFetchFromPlatform(platform, seller_id.trim());

    for (const item of platformCatalog) {
      db.run(`
        INSERT OR IGNORE INTO skus (user_id, sku_code, name, category, unit_price)
        VALUES (?, ?, ?, ?, ?)
      `, [req.userId, item.sku_code, item.sku_name, item.category, item.unit_price]);

      db.run(`
        INSERT OR IGNORE INTO dark_stores (user_id, platform, cluster_name, pincode, lead_time_hours)
        VALUES (?, ?, ?, ?, ?)
      `, [req.userId, platform, item.cluster_name, item.pincode, item.lead_time_hours]);

      const store = db.get(`SELECT id FROM dark_stores WHERE user_id = ? AND cluster_name = ?`, [req.userId, item.cluster_name]);
      const sku = db.get(`SELECT id FROM skus WHERE user_id = ? AND sku_code = ?`, [req.userId, item.sku_code]);

      if (store && sku) {
        db.run(`
          INSERT INTO store_inventory (user_id, store_id, sku_id, current_stock, hourly_burn_rate)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, store_id, sku_id) DO UPDATE SET
            current_stock = excluded.current_stock,
            hourly_burn_rate = excluded.hourly_burn_rate,
            last_updated = CURRENT_TIMESTAMP
        `, [req.userId, store.id, sku.id, item.current_stock, item.burn_rate]);
      }
    }

    res.json({
      success: true,
      message: `Successfully connected ${platform} Seller ID [${seller_id.trim()}]. Auto-mapped ${platformCatalog.length} dark store positions!`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/integrations', authenticate, (req, res) => {
  try {
    const integrations = db.all(`
      SELECT platform, seller_id, last_synced, status 
      FROM seller_integrations 
      WHERE user_id = ?
    `, [req.userId]);
    res.json({ integrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- 3. INBOUND EMAIL INGESTION WEBHOOK ----------------

app.post('/api/webhooks/inbound-email', async (req, res) => {
  try {
    const payload = req.body;

    // Resolve recipient address from common inbound email parsers (Postmark, SendGrid, Mailgun)
    const toAddress = payload.OriginalRecipient || payload.to || (payload.ToFull && payload.ToFull[0]?.Email) || '';
    
    // Pattern: inward-{userId}@inbound.darkstoreos.com
    const match = toAddress.match(/inward-([a-zA-Z0-9_-]+)@/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid or missing tenant inbound address format.' });
    }
    const tenantUserId = match[1];

    // Validate tenant existence
    const user = db.get(`SELECT id FROM users WHERE id = ?`, [tenantUserId]);
    if (!user) {
      return res.status(404).json({ error: `Tenant account [${tenantUserId}] not found.` });
    }

    // Process Base64 CSV attachments
    const attachments = payload.Attachments || [];
    let recordsUpdated = 0;

    for (const file of attachments) {
      if (file.Name && file.Name.toLowerCase().endsWith('.csv')) {
        const fileContent = Buffer.from(file.Content, 'base64').toString('utf8');
        const rows = fileContent.trim().split('\n');

        // Expected format: sku_code, store_id, current_stock, hourly_burn_rate
        for (const line of rows.slice(1)) {
          const parts = line.split(',').map(s => s.trim());
          if (parts.length >= 4) {
            const [sku_code, store_id, stock, burn] = parts;
            db.run(`
              INSERT INTO store_inventory (user_id, store_id, sku_id, current_stock, hourly_burn_rate)
              VALUES (?, ?, (SELECT id FROM skus WHERE sku_code = ? AND user_id = ?), ?, ?)
              ON CONFLICT(user_id, store_id, sku_id) DO UPDATE SET
                current_stock = excluded.current_stock,
                hourly_burn_rate = excluded.hourly_burn_rate,
                last_updated = CURRENT_TIMESTAMP
            `, [
              tenantUserId,
              parseInt(store_id),
              sku_code.toUpperCase(),
              tenantUserId,
              parseInt(stock),
              parseFloat(burn)
            ]);
            recordsUpdated++;
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      tenant: tenantUserId,
      processed_attachments: attachments.length,
      rows_synced: recordsUpdated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- 4. PROTECTED DASHBOARD APIS ----------------

app.get('/api/dashboard', authenticate, (req, res) => {
  try {
    const query = `
      SELECT 
        si.id as inventory_id,
        s.id as sku_id,
        s.name as sku_name,
        s.sku_code,
        s.category,
        s.unit_price,
        ds.id as store_id,
        ds.platform,
        ds.cluster_name,
        ds.pincode,
        ds.lead_time_hours,
        si.current_stock,
        si.hourly_burn_rate,
        CASE 
          WHEN si.hourly_burn_rate > 0 
          THEN ROUND(CAST(si.current_stock AS REAL) / si.hourly_burn_rate, 1)
          ELSE 999.0 
        END as hours_to_delist
      FROM store_inventory si
      JOIN skus s ON si.sku_id = s.id AND s.user_id = ?
      JOIN dark_stores ds ON si.store_id = ds.id AND ds.user_id = ?
      WHERE si.user_id = ?
      ORDER BY hours_to_delist ASC
    `;
    const inventory = db.all(query, [req.userId, req.userId, req.userId]);

    let criticalCount = 0;
    inventory.forEach(item => {
      if (item.hours_to_delist <= item.lead_time_hours) {
        criticalCount++;
      }
    });

    const pendingClaims = db.get(`
      SELECT COUNT(*) as count, COALESCE(SUM(po.rejected_qty * s.unit_price), 0) as total_value
      FROM purchase_orders po
      JOIN skus s ON po.sku_id = s.id
      WHERE po.status = 'DISPUTED' AND po.user_id = ?
    `, [req.userId]);

    const disputesList = db.all(`
      SELECT 
        po.po_number,
        po.rejected_qty,
        po.rejection_reason,
        po.created_at,
        s.name as sku_name,
        (po.rejected_qty * s.unit_price) as claim_value,
        ds.platform,
        ds.cluster_name
      FROM purchase_orders po
      JOIN skus s ON po.sku_id = s.id
      JOIN dark_stores ds ON po.store_id = ds.id
      WHERE po.status = 'DISPUTED' AND po.user_id = ?
      ORDER BY po.id DESC
      LIMIT 6
    `, [req.userId]);

    res.json({
      summary: {
        total_skus: inventory.length,
        critical_alerts: criticalCount,
        dispute_value: pendingClaims?.total_value || 0,
        active_disputes: pendingClaims?.count || 0
      },
      inventory,
      disputes: disputesList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stores', authenticate, (req, res) => {
  const { platform, cluster_name, pincode, lead_time_hours } = req.body;
  if (!platform || !cluster_name || !pincode) {
    return res.status(400).json({ error: 'Missing required store metadata' });
  }
  try {
    const result = db.run(`
      INSERT INTO dark_stores (user_id, platform, cluster_name, pincode, lead_time_hours)
      VALUES (?, ?, ?, ?, ?)
    `, [req.userId, platform, cluster_name, pincode, lead_time_hours || 3.0]);
    res.status(201).json({ id: result.lastID, message: 'Dark store created' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/skus', authenticate, (req, res) => {
  const { sku_code, name, category, unit_price } = req.body;
  if (!sku_code || !name || !unit_price) {
    return res.status(400).json({ error: 'Missing required SKU details' });
  }
  try {
    const result = db.run(`
      INSERT INTO skus (user_id, sku_code, name, category, unit_price)
      VALUES (?, ?, ?, ?, ?)
    `, [req.userId, sku_code.toUpperCase(), name, category || 'General', unit_price]);
    res.status(201).json({ id: result.lastID, message: 'SKU created' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventory', authenticate, (req, res) => {
  const { store_id, sku_id, current_stock, hourly_burn_rate } = req.body;
  try {
    db.run(`
      INSERT INTO store_inventory (user_id, store_id, sku_id, current_stock, hourly_burn_rate)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, store_id, sku_id) DO UPDATE SET
        current_stock = excluded.current_stock,
        hourly_burn_rate = excluded.hourly_burn_rate,
        last_updated = CURRENT_TIMESTAMP
    `, [req.userId, store_id, sku_id, current_stock || 0, hourly_burn_rate || 0.0]);
    res.json({ message: 'Store inventory committed' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inwarding', authenticate, (req, res) => {
  const { po_number, store_id, sku_id, dispatched_qty, received_qty, rejection_reason } = req.body;
  const rejected_qty = Math.max(0, dispatched_qty - received_qty);
  const status = rejected_qty > 0 ? 'DISPUTED' : 'INWARDED';

  try {
    db.run(`
      INSERT INTO purchase_orders (user_id, po_number, store_id, sku_id, dispatched_qty, received_qty, rejected_qty, rejection_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [req.userId, po_number, store_id, sku_id, dispatched_qty, received_qty, rejected_qty, rejection_reason || null, status]);

    db.run(`
      INSERT INTO store_inventory (user_id, store_id, sku_id, current_stock, hourly_burn_rate)
      VALUES (?, ?, ?, ?, 0.0)
      ON CONFLICT(user_id, store_id, sku_id) DO UPDATE SET
        current_stock = current_stock + excluded.current_stock,
        last_updated = CURRENT_TIMESTAMP
    `, [req.userId, store_id, sku_id, received_qty]);

    res.status(201).json({ status, rejected_qty, message: 'Inwarding processed' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stn', authenticate, (req, res) => {
  const { source_hub, target_store_id, sku_id, units, courier_mode } = req.body;
  const stn_number = `STN-${Date.now().toString().slice(-6)}`;

  try {
    db.run(`
      INSERT INTO stock_transfer_notes (user_id, stn_number, source_hub, target_store_id, sku_id, units, courier_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.userId, stn_number, source_hub, target_store_id, sku_id, units, courier_mode]);

    res.status(201).json({ stn_number, message: 'Stock Transfer Note dispatched' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/upload-csv', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  try {
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const lines = fileContent.trim().split('\n');

    for (const row of lines.slice(1)) {
      const parts = row.split(',').map(s => s.trim());
      if (parts.length >= 4) {
        const [sku_code, store_id, stock, burn] = parts;
        db.run(`
          INSERT INTO store_inventory (user_id, store_id, sku_id, current_stock, hourly_burn_rate)
          VALUES (?, ?, (SELECT id FROM skus WHERE sku_code = ? AND user_id = ?), ?, ?)
          ON CONFLICT(user_id, store_id, sku_id) DO UPDATE SET
            current_stock = excluded.current_stock,
            hourly_burn_rate = excluded.hourly_burn_rate,
            last_updated = CURRENT_TIMESTAMP
        `, [req.userId, parseInt(store_id), sku_code.toUpperCase(), req.userId, parseInt(stock), parseFloat(burn)]);
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ message: `Ingested ${lines.length - 1} records from CSV` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metadata', authenticate, (req, res) => {
  try {
    const stores = db.all(`SELECT id, platform, cluster_name, pincode FROM dark_stores WHERE user_id = ?`, [req.userId]);
    const skus = db.all(`SELECT id, sku_code, name FROM skus WHERE user_id = ?`, [req.userId]);
    res.json({ stores, skus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[DarkStore OS Authenticated Service] Running on http://localhost:${PORT}`);
});