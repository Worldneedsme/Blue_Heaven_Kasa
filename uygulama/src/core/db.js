'use strict';
// Veritabanı katmanı: sql.js (WebAssembly SQLite) + her değişiklikten sonra diske atomik yazma.
// Elektrik kesilirse en fazla o an kaydedilmekte olan tek işlem kaybolur; dosya asla yarım kalmaz
// (önce geçici dosyaya yazılır, diske zorlanır, sonra eski dosyanın yerine taşınır).

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-wasm.js');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, category TEXT NOT NULL, currency TEXT NOT NULL,
  price REAL, unit TEXT NOT NULL DEFAULT 'adet', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT,
  devir_tl REAL NOT NULL DEFAULT 0, devir_eur REAL NOT NULL DEFAULT 0, devir_usd REAL NOT NULL DEFAULT 0, devir_gbp REAL NOT NULL DEFAULT 0,
  kapanis_tl REAL, kapanis_eur REAL, kapanis_usd REAL, kapanis_gbp REAL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, created_at TEXT NOT NULL, type TEXT NOT NULL, room TEXT, description TEXT NOT NULL,
  tl REAL NOT NULL DEFAULT 0, eur REAL NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, gbp REAL NOT NULL DEFAULT 0,
  card_tl REAL NOT NULL DEFAULT 0, method TEXT, account_id INTEGER, category TEXT,
  void INTEGER NOT NULL DEFAULT 0, voided_at TEXT, meta TEXT
);
CREATE INDEX IF NOT EXISTS ix_tx_day ON transactions(day);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id INTEGER NOT NULL, product_id INTEGER,
  name TEXT NOT NULL, category TEXT NOT NULL, qty REAL NOT NULL, unit TEXT, currency TEXT NOT NULL,
  unit_price REAL NOT NULL, list_price REAL, amount REAL NOT NULL, amount_eur REAL NOT NULL, discount_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_tx ON sale_items(tx_id);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, opened_day TEXT NOT NULL, opened_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', left_unpaid INTEGER NOT NULL DEFAULT 0, closed_day TEXT, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS account_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL,
  kind TEXT NOT NULL, description TEXT NOT NULL, currency TEXT NOT NULL, amount REAL NOT NULL,
  tx_id INTEGER, void INTEGER NOT NULL DEFAULT 0, paid_tx_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_acc_items ON account_items(account_id);
`;

class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  async open() {
    const SQL = await initSqlJs({ locateFile: f => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), f) });
    this.SQL = SQL;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Yarım kalmış bir yazma varsa (.tmp) asıl dosya hâlâ sağlamdır; geçici dosyayı yok say.
    if (fs.existsSync(this.file)) this.db = new SQL.Database(fs.readFileSync(this.file));
    else this.db = new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(SCHEMA);
    this.upgrade();
    const v = this.get("SELECT value FROM settings WHERE key='schema_version'");
    if (!v) this.run("INSERT INTO settings(key,value) VALUES('schema_version',?)", [String(SCHEMA_VERSION)]);
    this.persist();
    return this;
  }

  // Eski sürümlerden gelen veritabanlarına sonradan eklenen sütunlar
  upgrade() {
    const cols = this.all('PRAGMA table_info(account_items)').map(c => c.name);
    if (!cols.includes('paid_tx_id')) this.db.run('ALTER TABLE account_items ADD COLUMN paid_tx_id INTEGER');
    // Açık (gece sayısı belli olmayan) kalemler için: birim fiyat, başlangıç/bitiş günü, ürün, başlatan işlem
    // Adisyonda Adet / Fiyat sütunları için: adet ve ürün adı (adet eki olmadan)
    for (const [c, t] of [['unit_price', 'REAL'], ['unit', 'TEXT'], ['start_day', 'TEXT'], ['stop_day', 'TEXT'], ['product_id', 'INTEGER'], ['open_tx_id', 'INTEGER'], ['qty', 'REAL'], ['item_name', 'TEXT']]) {
      if (!cols.includes(c)) this.db.run(`ALTER TABLE account_items ADD COLUMN ${c} ${t}`);
    }
  }

  // Her değişiklikten sonra çağrılır: geçici dosyaya yaz → diske zorla → yerine taşı.
  persist() {
    const data = Buffer.from(this.db.export());
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data, 0, data.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  run(sql, params = []) { this.db.run(sql, params); }
  all(sql, params = []) {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally { st.free(); }
  }
  get(sql, params = []) { return this.all(sql, params)[0] || null; }
  lastId() { return this.get('SELECT last_insert_rowid() AS id').id; }

  // Birden fazla yazmayı tek seferde uygular; hata olursa hiçbiri uygulanmaz, sonra diske yazar.
  tx(fn) {
    this.db.run('BEGIN');
    let result;
    try {
      result = fn();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.persist();
    return result;
  }

  // Yedekten geri yüklerken: dosyayı doğrula ve bellekteki veritabanını değiştir.
  replaceWith(buffer) {
    const test = new this.SQL.Database(buffer);
    const ok = test.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'");
    test.close();
    if (!ok.length) throw new Error('Seçilen dosya bir kasa yedeği değil.');
    this.db.close();
    this.db = new this.SQL.Database(buffer);
    this.db.run(SCHEMA);
    this.upgrade();
    this.persist();
  }
}

module.exports = { Store };
