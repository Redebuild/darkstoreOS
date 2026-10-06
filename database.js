import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFilePath = path.join(__dirname, 'darkstore.db');

let dbInstance = null;

export function persistDB() {
  if (!dbInstance) return;
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbFilePath, buffer);
}

export async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbFilePath)) {
    const filebuffer = fs.readFileSync(dbFilePath);
    dbInstance = new SQL.Database(filebuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  // Multi-tenant relational schema with seller platform integrations
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seller_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT CHECK(platform IN ('Blinkit', 'Zepto', 'Instamart')) NOT NULL,
      seller_id TEXT NOT NULL,
      api_key TEXT,
      last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'CONNECTED',
      UNIQUE(user_id, platform, seller_id)
    );

    CREATE TABLE IF NOT EXISTS dark_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT CHECK(platform IN ('Blinkit', 'Zepto', 'Instamart')) NOT NULL,
      cluster_name TEXT NOT NULL,
      pincode TEXT NOT NULL,
      lead_time_hours REAL NOT NULL DEFAULT 3.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, platform, cluster_name)
    );

    CREATE TABLE IF NOT EXISTS skus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sku_code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, sku_code)
    );

    CREATE TABLE IF NOT EXISTS store_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES dark_stores(id) ON DELETE CASCADE,
      sku_id INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
      current_stock INTEGER NOT NULL DEFAULT 0,
      hourly_burn_rate REAL NOT NULL DEFAULT 0.0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, store_id, sku_id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      po_number TEXT NOT NULL,
      store_id INTEGER NOT NULL REFERENCES dark_stores(id),
      sku_id INTEGER NOT NULL REFERENCES skus(id),
      dispatched_qty INTEGER NOT NULL,
      received_qty INTEGER NOT NULL DEFAULT 0,
      rejected_qty INTEGER NOT NULL DEFAULT 0,
      rejection_reason TEXT,
      status TEXT CHECK(status IN ('DISPATCHED', 'INWARDED', 'DISPUTED')) DEFAULT 'DISPATCHED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, po_number)
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stn_number TEXT NOT NULL,
      source_hub TEXT NOT NULL,
      target_store_id INTEGER NOT NULL REFERENCES dark_stores(id),
      sku_id INTEGER NOT NULL REFERENCES skus(id),
      units INTEGER NOT NULL,
      courier_mode TEXT NOT NULL,
      status TEXT CHECK(status IN ('PENDING', 'IN_TRANSIT', 'COMPLETED')) DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, stn_number)
    );
  `);

  persistDB();
  return dbInstance;
}

export const db = {
  all(sql, params = []) {
    const stmt = dbInstance.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  },
  get(sql, params = []) {
    const results = this.all(sql, params);
    return results.length > 0 ? results[0] : null;
  },
  run(sql, params = []) {
    dbInstance.run(sql, params);
    persistDB();
    const lastIdRes = dbInstance.exec("SELECT last_insert_rowid() as id;");
    const lastID = lastIdRes[0]?.values[0]?.[0] || null;
    return { lastID };
  }
};