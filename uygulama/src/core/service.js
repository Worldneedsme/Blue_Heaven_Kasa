'use strict';
// İş kuralları. Arayüz sadece bu fonksiyonları çağırır; fiyat, kur ve bakiye hesapları burada yapılır.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CURS = ['TL', 'EUR', 'USD', 'GBP'];
const COL = { TL: 'tl', EUR: 'eur', USD: 'usd', GBP: 'gbp' };
const SYM = { TL: 'TL', EUR: '€', USD: '$', GBP: '£' };
const EXPENSE_CATS = ['Mutfak / Bar / Restoran', 'Tüp / Gaz', 'Teknik / Tamir', 'Çamaşırhane', 'Masaj terapisti (Sevgi Hanım)', 'Diğer'];
const PAY_LABEL = { EUR: 'Nakit €', TL: 'Nakit TL', KART: 'Kart', SPLIT: 'Bölünmüş', ODA: 'Oda hesabı' };
const DEFAULT_RATES = { EUR: { alis: 53, satis: 55 }, USD: { alis: 47, satis: 49 }, GBP: { alis: 62, satis: 65 } };

const pad = n => String(n).padStart(2, '0');
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowStr = () => { const d = new Date(); return `${dkey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const r2 = x => Math.round(x * 100) / 100;
const fmt = n => r2(n).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
// Şifre tuzlu scrypt özetiyle saklanır; şifrenin kendisi hiçbir yerde tutulmaz ve kodda varsayılan şifre yoktur.
const hashPin = pin => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`; };
const checkPin = (pin, stored) => {
  if (!stored || typeof stored !== 'string') return false;
  const [kind, salt, hex] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const a = Buffer.from(hex, 'hex'), b = crypto.scryptSync(String(pin == null ? '' : pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const PIN_RE = /^\d{4,12}$/;
const nextDate = k => { const [y, m, d] = k.split('-').map(Number); return dkey(new Date(y, m - 1, d + 1)); };
const ROOM_RE = /^[1-5]0[1-8]$/;

// Excel kodu paketlenirken tek dosyaya derlenir (excel.bundle.js); geliştirmede kaynak dosya kullanılır.
const loadExcel = () => { try { return require('./excel.bundle.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; return require('./excel'); } };

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };
const num = (v, name, { min = 0, allowZero = true } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) fail(`${name} geçersiz.`);
  return n;
};

class Service {
  constructor(store, backup, opts = {}) {
    this.s = store;
    this.backup = backup;
    this.version = opts.version || '';
    this.reportsDir = opts.reportsDir || null;
    this.log = opts.log || (() => {});
    this.tokens = new Set();
    this.seed();
    this.migrate();
    if (this.openDay()) this.s.tx(() => this.cleanupAccounts());
  }

  // ---------- kurulum / ayarlar ----------
  seed() {
    const s = this.s;
    s.tx(() => {
      if (!this.setting('rates')) this.setSetting('rates', DEFAULT_RATES);
      if (!s.get('SELECT id FROM products LIMIT 1')) {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fiyat-listesi.json'), 'utf8'));
        let sort = 0;
        for (const c of data.kategoriler) for (const u of c.urunler) {
          s.run('INSERT INTO products(name,category,currency,price,unit,active,sort) VALUES(?,?,?,?,?,1,?)',
            [u.ad, c.ad, u.cur, u.price, u.unit === 'gun' ? 'gün' : u.unit, sort++]);
        }
        this.setSetting('categories', data.kategoriler.map(c => c.ad));
      }
    });
  }
  // Güncellemeyle gelen tek seferlik veri düzenlemeleri. Her adım bir kez çalışır ve "migrations" ayarına işlenir.
  migrate() {
    const done = this.setting('migrations') || [];
    const run = (id, fn) => {
      if (done.includes(id)) return;
      this.s.tx(() => { fn(); done.push(id); this.setSetting('migrations', done); });
    };
    // 1.0.10: listede olmayan satışlar için "Diğer" ürünü (tutar ve açıklama elle)
    run('2026-10-diger-urun', () => {
      if (this.s.get("SELECT id FROM products WHERE name='Diğer'")) return;
      const last = this.s.get("SELECT COALESCE(MAX(sort),0) AS s FROM products WHERE category='Hizmetler'").s;
      this.s.run('UPDATE products SET sort=sort+1 WHERE sort>?', [last]);
      this.s.run("INSERT INTO products(name,category,currency,price,unit,active,sort) VALUES('Diğer','Hizmetler','EUR',NULL,'adet',1,?)", [last + 1]);
    });
    // 1.0.5: "Market Resepsiyon" ve "Laundry" kategorileri; "Hediyelik & Market" → "Hediyelik"
    run('2026-10-kategoriler', () => {
      const s = this.s;
      const MOVE = ['Kartpostal', 'Kartpostal + Pul', 'Resepsiyon Market (diğer)'];
      s.run("UPDATE products SET category='Market Resepsiyon' WHERE category='İçecek & Yiyecek'");
      s.run(`UPDATE products SET category='Market Resepsiyon' WHERE category='Hediyelik & Market' AND name IN (${MOVE.map(() => '?').join(',')})`, MOVE);
      s.run("UPDATE products SET category='Hediyelik' WHERE category='Hediyelik & Market'");
      s.run("UPDATE products SET category='Laundry' WHERE name='Çamaşır (Laundry)'");
      // Geçmiş satışlar da raporda yeni kategoride görünsün
      s.run('UPDATE sale_items SET category=(SELECT p.category FROM products p WHERE p.id=sale_items.product_id) WHERE product_id IS NOT NULL');
      const base = ['Hizmetler', 'Masaj', 'Market Resepsiyon', 'Laundry', 'Hediyelik'];
      const extra = (this.setting('categories') || []).filter(c => !base.includes(c) && c !== 'İçecek & Yiyecek' && c !== 'Hediyelik & Market');
      const cats = base.concat(extra);
      this.setSetting('categories', cats);
      // Ürün listesi kategori sırasına göre dizilsin
      const rows = s.all('SELECT id, category, sort FROM products ORDER BY sort, id');
      rows.sort((a, b) => (cats.indexOf(a.category) - cats.indexOf(b.category)) || (a.sort - b.sort));
      rows.forEach((r, i) => s.run('UPDATE products SET sort=? WHERE id=?', [i, r.id]));
    });
  }

  setting(key) { const r = this.s.get('SELECT value FROM settings WHERE key=?', [key]); return r ? JSON.parse(r.value) : null; }
  setSetting(key, val) { this.s.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(val)]); }
  rates() { return this.setting('rates'); }
  openDay() { return this.s.get('SELECT * FROM days WHERE closed_at IS NULL ORDER BY date DESC LIMIT 1'); }
  requireDay() { const d = this.openDay(); if (!d) fail('Önce ilk kurulum yapılmalı.'); return d; }
  requireToken(t) { if (!this.tokens.has(t)) fail('Bu bölüm için şifre gerekli.'); }

  setup({ devir, pin }) {
    if (this.s.get('SELECT date FROM days LIMIT 1')) fail('Kurulum zaten yapılmış.');
    if (!PIN_RE.test(String(pin || ''))) fail('Rapor şifresi 4–12 rakam olmalı.');
    const v = {}; for (const c of CURS) v[c] = num(devir && devir[c] || 0, `${SYM[c]} devir`);
    this.s.tx(() => {
      this.setSetting('pin_hash', hashPin(pin));
      this.s.run('INSERT INTO days(date,opened_at,devir_tl,devir_eur,devir_usd,devir_gbp) VALUES(?,?,?,?,?,?)',
        [dkey(new Date()), nowStr(), v.TL, v.EUR, v.USD, v.GBP]);
    });
    return this.getState();
  }

  // ---------- durum ----------
  dayTotals(date) {
    const d = this.s.get('SELECT * FROM days WHERE date=?', [date]);
    const b = { TL: d.devir_tl, EUR: d.devir_eur, USD: d.devir_usd, GBP: d.devir_gbp };
    const r = this.s.get('SELECT SUM(tl) tl, SUM(eur) eur, SUM(usd) usd, SUM(gbp) gbp, SUM(card_tl) card FROM transactions WHERE day=? AND void=0', [date]);
    for (const c of CURS) b[c] = r2(b[c] + (r[COL[c]] || 0));
    return { day: d, balances: b, card: r2(r.card || 0) };
  }

  // Hesabın görünümü: toplamlar sadece henüz ödenmemiş kalemlerden hesaplanır.
  accountView(a) {
    const items = this.s.all('SELECT * FROM account_items WHERE account_id=? AND void=0 ORDER BY id', [a.id]);
    for (const i of items) if (i.kind === 'acik') { i.nights = this.openNights(i); i.amount = r2(i.nights * i.unit_price); }
    const tot = { TL: 0, EUR: 0 };
    for (const i of items) if (!i.paid_tx_id) tot[i.currency] = r2((tot[i.currency] || 0) + i.amount);
    const rate = this.rates().EUR.satis;
    return { ...a, items, totals: tot, eurEq: r2(tot.EUR + tot.TL / rate), tlEq: Math.round(tot.TL + tot.EUR * rate) };
  }
  // Açık kalemin gece sayısı: başladığı günden bugüne kadar kapatılan gün sayısı (12.10'da başlayıp 15.10'da çıkan = 3 gece)
  openNights(i) {
    const day = this.openDay();
    const end = day ? day.date : '9999-12-31';
    return this.s.get('SELECT COUNT(*) AS n FROM days WHERE closed_at IS NOT NULL AND date>=? AND date<?', [i.start_day, end]).n;
  }
  // Açık kalemi kapatır: gece sayısı kesinleşir, satış olarak kaydedilir (rapor bu günde sayar), hesapta sabit kalem olur.
  finalizeOpen(item, nights) {
    const a = this.s.get('SELECT * FROM accounts WHERE id=?', [item.account_id]);
    const n = nights == null || nights === '' ? Math.max(1, this.openNights(item)) : num(nights, 'Gece sayısı', { allowZero: false });
    if (!Number.isInteger(n)) fail('Gece sayısı tam sayı olmalı.');
    const p = this.s.get('SELECT * FROM products WHERE id=?', [item.product_id]) || { name: item.description, category: 'Hizmetler' };
    const rate = this.rates().EUR.satis, amount = r2(n * item.unit_price);
    const amountEur = r2(item.currency === 'EUR' ? amount : amount / rate), tl = Math.round(item.currency === 'TL' ? amount : amount * rate);
    const desc = `${p.name} ${n} ${item.unit}`;
    const day = this.requireDay();
    const txId = this.insertTx({ type: 'satis', room: a.room, description: `${desc} → ${a.room} hesabına ${fmt(amountEur)} € (açık kalem kesinleşti)`,
      mv: {}, card: 0, method: 'ODA', accountId: a.id, meta: { eur: amountEur, tl, finalizes: item.id } });
    this.s.run(`INSERT INTO sale_items(tx_id,product_id,name,category,qty,unit,currency,unit_price,list_price,amount,amount_eur,discount_note)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,?,NULL)`, [txId, item.product_id, p.name, p.category, n, item.unit, item.currency, item.unit_price, amount, amountEur]);
    this.s.run("UPDATE account_items SET kind='satis', amount=?, description=?, tx_id=?, stop_day=? WHERE id=?", [amount, desc, txId, day.date, item.id]);
  }
  stopOpenItem({ itemId, nights }) {
    const it = this.s.get("SELECT * FROM account_items WHERE id=? AND kind='acik' AND void=0", [itemId]); if (!it) fail('Açık kalem bulunamadı.');
    return this.s.tx(() => { this.finalizeOpen(it, nights); return this.getState(); });
  }

  // İptallerden sonra boşalan açık hesapları kapatır: hiç kalem kalmadıysa iptal edilir (listeden kalkar),
  // sadece ödenmiş kalemler kaldıysa "ödendi" olarak kapanır.
  cleanupAccounts() {
    const day = this.openDay();
    const rows = this.s.all(`SELECT a.id,
        SUM(CASE WHEN i.void=0 AND i.kind<>'not' THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN i.void=0 AND i.kind<>'not' AND i.paid_tx_id IS NULL THEN 1 ELSE 0 END) AS unpaid
      FROM accounts a LEFT JOIN account_items i ON i.account_id=a.id WHERE a.status='open' GROUP BY a.id`);
    for (const r of rows) {
      if (r.live && r.unpaid) continue;
      this.s.run('UPDATE accounts SET status=?, closed_day=?, closed_at=? WHERE id=?', [r.live ? 'closed' : 'cancelled', day ? day.date : null, nowStr(), r.id]);
    }
  }

  openAccounts() { return this.s.all("SELECT * FROM accounts WHERE status='open' ORDER BY room, id").map(a => this.accountView(a)); }

  txRows(date) {
    const rows = this.s.all('SELECT * FROM transactions WHERE day=? ORDER BY id DESC', [date]);
    return rows.map(t => ({ ...t, meta: t.meta ? JSON.parse(t.meta) : null }));
  }

  getState() {
    const day = this.openDay();
    const base = { rates: this.rates(), expenseCats: EXPENSE_CATS, today: dkey(new Date()), version: this.version };
    if (!day) return { ...base, setupNeeded: true };
    const { balances, card } = this.dayTotals(day.date);
    return {
      ...base,
      setupNeeded: false,
      day: { date: day.date, devir: { TL: day.devir_tl, EUR: day.devir_eur, USD: day.devir_usd, GBP: day.devir_gbp } },
      stale: day.date < base.today,
      balances, cardToday: card,
      tx: this.txRows(day.date),
      accounts: this.openAccounts(),
      products: this.s.all('SELECT * FROM products WHERE active=1 ORDER BY sort, id'),
      categories: this.setting('categories'),
      lastBackup: this.setting('last_backup'),
    };
  }

  // ---------- kayıt yardımcıları ----------
  insertTx(o) {
    const day = this.requireDay();
    this.s.run(`INSERT INTO transactions(day,created_at,type,room,description,tl,eur,usd,gbp,card_tl,method,account_id,category,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [day.date, nowStr(), o.type, o.room || null, o.description, r2(o.mv.TL || 0), r2(o.mv.EUR || 0), r2(o.mv.USD || 0), r2(o.mv.GBP || 0),
        r2(o.card || 0), o.method || null, o.accountId || null, o.category || null, JSON.stringify({ rates: this.rates(), ...(o.meta || {}) })]);
    return this.s.lastId();
  }

  // Ödeme: tutarı € ve TL karşılığıyla birlikte alır, kasaya giren nakit ve kart tutarını döndürür.
  resolvePayment(payment, eur, tl) {
    const rate = this.rates().EUR.satis;
    const m = payment && payment.method;
    if (m === 'EUR') return { mv: { EUR: eur }, card: 0 };
    if (m === 'TL') return { mv: { TL: tl }, card: 0 };
    if (m === 'KART') return { mv: {}, card: tl };
    if (m === 'SPLIT') {
      const e = num(payment.eur || 0, 'Nakit €'), t = num(payment.tl || 0, 'Nakit TL'), k = num(payment.card || 0, 'Kart');
      if (Math.abs(tl - (e * rate + t + k)) > 1) fail(`Bölünmüş ödeme toplamı tutmuyor (beklenen ${fmt(tl)} TL).`);
      return { mv: { EUR: e, TL: t }, card: k };
    }
    fail('Ödeme şekli seçin.');
  }

  // Odaya yazarken hangi hesabın kullanılacağı: mevcut hesap ya da (gerekirse eskisini "çıktı, ödenmedi" yapıp) yeni hesap.
  resolveAccount(room, acc) {
    if (!ROOM_RE.test(String(room || ''))) fail('Geçerli bir oda seçin.');
    const open = this.s.all("SELECT * FROM accounts WHERE status='open' AND room=? ORDER BY id DESC", [room]);
    if (acc && acc.mode === 'existing') {
      const a = open.find(x => x.id === acc.id);
      if (!a) fail('Seçilen oda hesabı bulunamadı.');
      return a.id;
    }
    if (open.length && !(acc && acc.mode === 'new')) fail('Bu odada açık hesap var; aynı misafir mi yeni misafir mi seçilmeli.');
    for (const a of open) this.s.run('UPDATE accounts SET left_unpaid=1 WHERE id=?', [a.id]);
    const day = this.requireDay();
    this.s.run('INSERT INTO accounts(room,opened_day,opened_at) VALUES(?,?,?)', [room, day.date, nowStr()]);
    return this.s.lastId();
  }

  // Kapanan oda hesapları (en yeni önce): bütün kalemler, tahsilatlar ve toplamlar. Sadece görüntüleme içindir.
  closedAccounts({ room, limit } = {}) {
    const r = String(room || '').trim(), lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = this.s.all(`SELECT * FROM accounts WHERE status='closed'${r ? ' AND room=?' : ''} ORDER BY closed_at DESC, id DESC LIMIT ?`, r ? [r, lim] : [lim]);
    return rows.map(a => {
      const items = this.s.all('SELECT * FROM account_items WHERE account_id=? AND void=0 ORDER BY id', [a.id]);
      const payments = this.s.all("SELECT * FROM transactions WHERE type='tahsilat' AND account_id=? AND void=0 ORDER BY id", [a.id])
        .map(t => { const m = t.meta ? JSON.parse(t.meta) : {}; return { id: t.id, day: t.day, created_at: t.created_at, method: t.method, tl: t.tl, eur: t.eur, usd: t.usd, gbp: t.gbp, card_tl: t.card_tl, eurEq: m.eur || 0, tlEq: m.tl || 0, partial: !!m.partial }; });
      const totals = { TL: 0, EUR: 0 };
      for (const i of items) if (i.kind !== 'not') totals[i.currency] = r2(totals[i.currency] + i.amount);
      return { ...a, items, payments, totals, paidEur: r2(payments.reduce((s, p) => s + p.eurEq, 0)) };
    });
  }
  openAccountsForRoom(room) {
    return this.s.all("SELECT * FROM accounts WHERE status='open' AND room=? ORDER BY id DESC", [room]).map(a => this.accountView(a));
  }

  // ---------- satış ----------
  addSale({ room, lines, payment, account }) {
    const write = this.prepSale({ room, lines, payment });
    return this.s.tx(() => { write(account); return this.getState(); });
  }
  // Sepetteki ürünler farklı ödeme şekilleriyle (ör. biri nakit, biri oda hesabına): her ödeme şekli ayrı kayıt, hepsi tek seferde
  addSaleBatch({ room, groups, account }) {
    if (!Array.isArray(groups) || !groups.length) fail('Ürün seçin.');
    const methods = groups.map(g => g.payment && g.payment.method);
    if (new Set(methods).size !== methods.length) fail('Aynı ödeme şekli iki kez olamaz.');
    const writers = groups.map(g => this.prepSale({ room, lines: g.lines, payment: g.payment }));
    return this.s.tx(() => { writers.forEach(w => w(account)); return this.getState(); });
  }
  // Satışı doğrular ve hesaplar; döndürdüğü fonksiyon kaydı yazar (veritabanı işlemi içinde çağrılır)
  prepSale({ room, lines, payment }) {
    if (!Array.isArray(lines) || !lines.length) fail('Ürün seçin.');
    if (room && !ROOM_RE.test(String(room))) fail('Geçersiz oda numarası.');
    const rate = this.rates().EUR.satis;
    const L = lines.map(l => {
      const p = this.s.get('SELECT * FROM products WHERE id=? AND active=1', [l.productId]);
      if (!p) fail('Ürün bulunamadı.');
      if (l.openEnded) {
        if (!['gece', 'gün'].includes(p.unit) || p.price == null) fail(`${p.name} için “belli değil” seçilemez.`);
        return { p, open: true, currency: p.currency, unitPrice: p.price, desc: `${p.name} (açık, ${p.price} ${p.currency === 'EUR' ? '€' : 'TL'}/${p.unit})`, amount: 0, amountEur: 0 };
      }
      const qty = num(l.qty || 1, 'Adet', { min: 0, allowZero: false });
      let currency = p.currency, unitPrice = p.price, listPrice = null, note = null, freeNote = '';
      if (p.price == null) {
        unitPrice = num(l.freeAmount, `${p.name} tutarı`, { allowZero: false });
        if (l.freeCurrency) { if (!['EUR', 'TL'].includes(l.freeCurrency)) fail('Para birimi geçersiz.'); currency = l.freeCurrency; }
        freeNote = String(l.freeNote || '').trim();
        if (p.name === 'Diğer' && !freeNote) fail('“Diğer” için ne olduğunu açıklamaya yazın.');
      } else if (l.overridePrice != null && l.overridePrice !== '') {
        const o = num(l.overridePrice, 'Yeni fiyat');
        if (o !== p.price) {
          note = String(l.note || '').trim();
          if (!note) fail('İndirim için açıklama yazın.');
          listPrice = p.price; unitPrice = o;
        }
      }
      const amount = r2(unitPrice * qty);
      const amountEur = r2(currency === 'EUR' ? amount : amount / rate);
      const qtxt = qty > 1 ? (p.unit === 'adet' ? ` ×${qty}` : ` ${qty} ${p.unit}`) : (p.unit !== 'adet' ? ` ${qty} ${p.unit}` : '');
      const desc = (freeNote ? (p.name === 'Diğer' ? freeNote : `${p.name}: ${freeNote}`) : p.name) + qtxt + (note ? ` [indirim: ${note}]` : '');
      return { p, qty, currency, unitPrice, listPrice, note, amount, amountEur, desc };
    });
    if (L.some(l => l.open) && !(payment && payment.method === 'ODA')) fail('Gece sayısı belli olmayan kalem sadece oda hesabına yazılabilir.');
    if (L.some(l => l.open) && !room) fail('Açık kalem için oda seçin.');
    const eur = r2(L.reduce((s, l) => s + l.amountEur, 0));
    const tl = Math.round(L.reduce((s, l) => s + (l.currency === 'TL' ? l.amount : l.amount * rate), 0));
    const linesDesc = L.map(l => l.desc).join(' + ');

    return account => {
      let mv = {}, card = 0, accountId = null, description;
      if (payment && payment.method === 'ODA') {
        accountId = this.resolveAccount(room, account);
        description = `${linesDesc} → ${room} hesabına ${eur > 0 ? fmt(eur) + ' €' + (L.some(l => l.open) ? ' + açık kalem' : '') : 'açık olarak yazıldı'}`;
      } else {
        ({ mv, card } = this.resolvePayment(payment, eur, tl));
        description = `${linesDesc} (${PAY_LABEL[payment.method]})`;
      }
      const txId = this.insertTx({ type: 'satis', room, description, mv, card, method: payment.method, accountId, meta: { eur, tl } });
      for (const l of L) {
        if (l.open) {
          const day = this.requireDay();
          this.s.run(`INSERT INTO account_items(account_id,day,created_at,kind,description,currency,amount,tx_id,unit_price,unit,start_day,product_id,open_tx_id)
            VALUES(?,?,?,'acik',?,?,0,?,?,?,?,?,?)`, [accountId, day.date, nowStr(), l.p.name, l.currency, txId, l.unitPrice, l.p.unit, day.date, l.p.id, txId]);
          continue;
        }
        this.s.run(`INSERT INTO sale_items(tx_id,product_id,name,category,qty,unit,currency,unit_price,list_price,amount,amount_eur,discount_note)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [txId, l.p.id, l.p.name, l.p.category, l.qty, l.p.unit, l.currency, l.unitPrice, l.listPrice, l.amount, l.amountEur, l.note]);
        if (accountId) {
          const day = this.requireDay();
          this.s.run('INSERT INTO account_items(account_id,day,created_at,kind,description,currency,amount,tx_id) VALUES(?,?,?,?,?,?,?,?)',
            [accountId, day.date, nowStr(), 'satis', l.desc, l.currency, l.amount, txId]);
        }
      }
    };
  }

  // ---------- para bozma ----------
  addExchange({ dir, cur, amount, rate }) {
    if (!['alis', 'satis'].includes(dir)) fail('İşlem seçin.');
    if (!['EUR', 'USD', 'GBP'].includes(cur)) fail('Para birimi seçin.');
    const a = num(amount, 'Döviz tutarı', { allowZero: false }), r = num(rate, 'Kur', { allowZero: false });
    const tl = Math.round(a * r);
    const al = dir === 'alis';
    const description = al ? `Para bozma ${fmt(a)} ${SYM[cur]} → ${fmt(tl)} TL (kur ${r})` : `Ters bozma ${fmt(tl)} TL → ${fmt(a)} ${SYM[cur]} (kur ${r})`;
    return this.s.tx(() => {
      this.insertTx({ type: 'doviz', description, mv: al ? { [cur]: a, TL: -tl } : { [cur]: -a, TL: tl }, meta: { dir, cur, amount: a, rate: r, tl } });
      return this.getState();
    });
  }

  // ---------- gider ----------
  addExpense({ category, desc, currency, amount }) {
    if (!EXPENSE_CATS.includes(category)) fail('Kategori seçin.');
    if (!['TL', 'EUR', 'USD'].includes(currency)) fail('Para birimi geçersiz.');
    const a = num(amount, 'Tutar', { allowZero: false });
    const d = String(desc || '').trim();
    return this.s.tx(() => {
      this.insertTx({ type: 'gider', description: category + (d ? ' — ' + d : ''), mv: { [currency]: -a }, category, meta: { currency, amount: a } });
      return this.getState();
    });
  }

  // ---------- Cengiz Bey ----------
  addOwner({ tl, tlOut, eurIn, eur, usd, gbp }) {
    const v = { TL: num(tl || 0, 'Getirdiği TL'), TLOUT: num(tlOut || 0, 'Aldığı TL'), EURIN: num(eurIn || 0, 'Getirdiği €'), EUR: num(eur || 0, '€'), USD: num(usd || 0, '$'), GBP: num(gbp || 0, '£') };
    if (!v.TL && !v.TLOUT && !v.EURIN && !v.EUR && !v.USD && !v.GBP) fail('Tutar girin.');
    const p = [];
    if (v.TL) p.push(`${fmt(v.TL)} TL getirdi`);
    if (v.EURIN) p.push(`${fmt(v.EURIN)} € getirdi`);
    if (v.TLOUT) p.push(`${fmt(v.TLOUT)} TL aldı`);
    for (const c of ['EUR', 'USD', 'GBP']) if (v[c]) p.push(`${fmt(v[c])} ${SYM[c]} aldı`);
    return this.s.tx(() => {
      this.insertTx({ type: 'patron', description: 'Cengiz Bey: ' + p.join(', '), mv: { TL: v.TL - v.TLOUT, EUR: v.EURIN - v.EUR, USD: -v.USD, GBP: -v.GBP },
        meta: { tlIn: v.TL, tlOut: v.TLOUT, eurIn: v.EURIN, eurOut: v.EUR } });
      return this.getState();
    });
  }

  // ---------- oda hesapları ----------
  addAvans({ room, desc, currency, amount, account }) {
    const d = String(desc || '').trim(); if (!d) fail('Açıklama yazın.');
    if (!['TL', 'EUR'].includes(currency)) fail('Para birimi geçersiz.');
    const a = num(amount, 'Tutar', { allowZero: false });
    return this.s.tx(() => {
      const accountId = this.resolveAccount(room, account);
      const txId = this.insertTx({ type: 'avans', room, description: `${room} misafir adına: ${d}`, mv: { [currency]: -a }, accountId });
      const day = this.requireDay();
      this.s.run('INSERT INTO account_items(account_id,day,created_at,kind,description,currency,amount,tx_id) VALUES(?,?,?,?,?,?,?,?)',
        [accountId, day.date, nowStr(), 'avans', 'Misafir adına: ' + d, currency, a, txId]);
      return this.getState();
    });
  }

  correctAccount({ accountId, desc, currency, amount }) {
    const a = this.s.get("SELECT * FROM accounts WHERE id=? AND status='open'", [accountId]); if (!a) fail('Hesap bulunamadı.');
    const d = String(desc || '').trim(); if (!d) fail('Düzeltme için açıklama yazın.');
    if (!['TL', 'EUR'].includes(currency)) fail('Para birimi geçersiz.');
    const n = Number(amount); if (!Number.isFinite(n) || n === 0) fail('Tutar geçersiz (düşmek için eksi yazın).');
    return this.s.tx(() => {
      const day = this.requireDay();
      this.s.run('INSERT INTO account_items(account_id,day,created_at,kind,description,currency,amount) VALUES(?,?,?,?,?,?,?)',
        [a.id, day.date, nowStr(), 'duzeltme', 'Düzeltme: ' + d, currency, r2(n)]);
      return this.getState();
    });
  }

  moveAccount({ accountId, room }) {
    const a = this.s.get("SELECT * FROM accounts WHERE id=? AND status='open'", [accountId]); if (!a) fail('Hesap bulunamadı.');
    const r = String(room || '').trim(); if (!ROOM_RE.test(r)) fail('Geçersiz oda numarası.');
    if (r === a.room) fail('Hesap zaten bu odada.');
    return this.s.tx(() => {
      const day = this.requireDay();
      this.s.run('INSERT INTO account_items(account_id,day,created_at,kind,description,currency,amount) VALUES(?,?,?,?,?,?,0)',
        [a.id, day.date, nowStr(), 'not', `Oda değişikliği: ${a.room} → ${r}`, 'EUR']);
      this.s.run('UPDATE accounts SET room=? WHERE id=?', [r, a.id]);
      return this.getState();
    });
  }

  // Oda hesabından tahsilat. itemIds verilmezse ödenmemiş kalemlerin hepsi tahsil edilir.
  // Ödenmemiş kalem kalmazsa hesap kapanır; kalırsa hesap açık kalır ve kalan borç görünür.
  payAccount({ accountId, itemIds, payment, nights }) {
    const a = this.s.get("SELECT * FROM accounts WHERE id=? AND status='open'", [accountId]); if (!a) fail('Hesap bulunamadı.');
    const unpaid = this.s.all("SELECT * FROM account_items WHERE account_id=? AND void=0 AND paid_tx_id IS NULL AND kind<>'not' ORDER BY id", [a.id]);
    if (!unpaid.length) fail('Tahsil edilecek kalem yok.');
    const sel = itemIds == null ? unpaid : unpaid.filter(i => itemIds.map(Number).includes(i.id));
    if (!sel.length) fail('Tahsil edilecek kalem seçin.');
    // Açık kalemler (ör. klima) tahsilatta gece sayısıyla kesinleşir; gece sayısı pencerede düzeltilebilir
    const nightsOf = i => {
      const v = nights && nights[i.id];
      const n = v == null || v === '' ? Math.max(1, this.openNights(i)) : num(v, 'Gece sayısı', { allowZero: false });
      if (!Number.isInteger(n)) fail('Gece sayısı tam sayı olmalı.');
      return n;
    };
    const rate = this.rates().EUR.satis;
    const tot = { TL: 0, EUR: 0 };
    for (const i of sel) tot[i.currency] += i.kind === 'acik' ? nightsOf(i) * i.unit_price : i.amount;
    const eur = r2(tot.EUR + tot.TL / rate), tl = Math.round(tot.TL + tot.EUR * rate);
    if (eur < 0) fail('Seçilen kalemlerin toplamı eksi; düzeltmeyi diğer kalemlerle birlikte seçin.');
    const all = sel.length === unpaid.length;
    return this.s.tx(() => {
      for (const i of sel) if (i.kind === 'acik') this.finalizeOpen(i, nightsOf(i));
      let mv = {}, card = 0;
      if (eur > 0) ({ mv, card } = this.resolvePayment(payment, eur, tl));
      const label = eur > 0 ? PAY_LABEL[payment.method] : 'ödeme yok';
      const description = all ? `${a.room} oda hesabı kapatıldı — ${sel.length} kalem (${label})` : `${a.room} oda hesabından ${sel.length} kalem tahsil edildi (${label})`;
      const txId = this.insertTx({ type: 'tahsilat', room: a.room, description, mv, card, method: eur > 0 ? payment.method : null, accountId: a.id, meta: { eur, tl, partial: !all } });
      this.s.run(`UPDATE account_items SET paid_tx_id=? WHERE id IN (${sel.map(() => '?').join(',')})`, [txId, ...sel.map(i => i.id)]);
      if (all) {
        const day = this.requireDay();
        this.s.run("UPDATE accounts SET status='closed', closed_day=?, closed_at=? WHERE id=?", [day.date, nowStr(), a.id]);
      }
      return this.getState();
    });
  }
  closeAccount({ accountId, payment }) { return this.payAccount({ accountId, itemIds: null, payment }); }

  // ---------- iptal ----------
  voidTx({ id }) {
    const day = this.requireDay();
    const t = this.s.get('SELECT * FROM transactions WHERE id=?', [id]);
    if (!t || t.void) fail('İşlem bulunamadı.');
    if (t.day !== day.date) fail('Sadece açık günün işlemleri iptal edilebilir.');
    return this.s.tx(() => {
      if (t.type === 'tahsilat') {
        this.s.run('UPDATE account_items SET paid_tx_id=NULL WHERE paid_tx_id=?', [t.id]);
        this.s.run("UPDATE accounts SET status='open', closed_day=NULL, closed_at=NULL WHERE id=?", [t.account_id]);
      } else if (t.account_id && this.s.get("SELECT id FROM account_items WHERE open_tx_id=? AND tx_id<>open_tx_id AND void=0", [t.id])) {
        fail('Bu açık kalem kapatılmış. Önce kapanış kaydını iptal edin.');
      } else if (t.account_id && t.meta && JSON.parse(t.meta).finalizes) {
        const it = this.s.get('SELECT * FROM account_items WHERE id=?', [JSON.parse(t.meta).finalizes]);
        if (it && it.paid_tx_id) fail('Bu kalemin tahsilatı yapılmış. Önce o tahsilatı iptal edin.');
        if (it) this.s.run("UPDATE account_items SET kind='acik', amount=0, description=?, tx_id=open_tx_id, stop_day=NULL WHERE id=?", [it.description.replace(/ \d+ (gece|gün)$/, ''), it.id]);
      } else if (t.account_id) {
        const a = this.s.get('SELECT status FROM accounts WHERE id=?', [t.account_id]);
        if (a && a.status !== 'open') fail('Bu kalemin oda hesabı kapatılmış. Önce o hesabın tahsilatını iptal edin.');
        if (this.s.get('SELECT id FROM account_items WHERE tx_id=? AND paid_tx_id IS NOT NULL', [t.id])) fail('Bu kalemin tahsilatı yapılmış. Önce o tahsilatı iptal edin.');
        this.s.run('UPDATE account_items SET void=1 WHERE tx_id=?', [t.id]);
      }
      this.s.run('UPDATE transactions SET void=1, voided_at=? WHERE id=?', [nowStr(), t.id]);
      this.cleanupAccounts();
      return this.getState();
    });
  }

  // ---------- gün sonu ----------
  closeDay({ counts }) {
    const day = this.requireDay();
    const c = {}; for (const k of CURS) {
      if (counts == null || counts[k] === '' || counts[k] == null) fail('Tüm para birimlerini sayıp yazın (yoksa 0).');
      c[k] = num(counts[k], `Sayılan ${SYM[k]}`);
    }
    // Gün sonu birkaç gün gecikmişse yeni gün aradaki boş günler yerine bugünden açılır.
    const today = dkey(new Date());
    const nd = nextDate(day.date) < today ? today : nextDate(day.date);
    this.s.tx(() => {
      this.s.run('UPDATE days SET closed_at=?, kapanis_tl=?, kapanis_eur=?, kapanis_usd=?, kapanis_gbp=? WHERE date=?', [nowStr(), c.TL, c.EUR, c.USD, c.GBP, day.date]);
      this.s.run('INSERT INTO days(date,opened_at,devir_tl,devir_eur,devir_usd,devir_gbp) VALUES(?,?,?,?,?,?)', [nd, nowStr(), c.TL, c.EUR, c.USD, c.GBP]);
    });
    this.makeBackup('gun-sonu');
    this.autoExport(day.date);
    return this.getState();
  }

  // ---------- Excel raporları ----------
  // Gün kapatılınca o günün ve ayın Excel raporu raporlar klasörüne kendiliğinden yazılır (hata olursa gün sonu yine tamamlanır).
  autoExport(date) {
    if (!this.reportsDir) return Promise.resolve();
    const excel = loadExcel();
    return excel.dayReport(this, date, this.reportsDir)
      .then(() => excel.monthReport(this, date.slice(0, 7), this.reportsDir))
      .catch(e => this.log(e));
  }
  async exportDay({ token, date }) {
    this.requireToken(token);
    if (!this.reportsDir) fail('Raporlar klasörü ayarlı değil.');
    if (!this.s.get('SELECT date FROM days WHERE date=?', [date])) fail('Gün bulunamadı.');
    return { file: await loadExcel().dayReport(this, date, this.reportsDir) };
  }
  async exportMonth({ token, month }) {
    this.requireToken(token);
    if (!this.reportsDir) fail('Raporlar klasörü ayarlı değil.');
    if (!/^\d{4}-\d{2}$/.test(String(month || ''))) fail('Ay geçersiz.');
    return { file: await loadExcel().monthReport(this, month, this.reportsDir) };
  }
  listReports({ token }) {
    this.requireToken(token);
    if (!this.reportsDir || !fs.existsSync(this.reportsDir)) return { dir: this.reportsDir, files: [] };
    const files = fs.readdirSync(this.reportsDir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
      .map(f => ({ name: f, size: fs.statSync(path.join(this.reportsDir, f)).size, mtime: fs.statSync(path.join(this.reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return { dir: this.reportsDir, files };
  }

  // ---------- Müdür sayfası (yerel ağ) ----------
  // Sayfaya sadece eşleştirilmiş cihazlar girebilir. Eşleştirme kodu resepsiyon ekranında (Ayarlar) üretilir, 10 dakika geçerlidir.
  // Cihaz anahtarlarının sadece özeti saklanır.
  lanConfig() { return { enabled: false, port: 8080, ...(this.setting('lan') || {}) }; }
  lanStatus({ token }) {
    this.requireToken(token);
    const devices = (this.setting('lan_devices') || []).map(({ hash, ...d }) => d);
    const code = this.pairCode && this.pairCode.expires > Date.now() ? { code: this.pairCode.code, expires: this.pairCode.expires } : null;
    return { ...this.lanConfig(), devices, code, ...(this.lanInfo ? this.lanInfo() : { running: false, addresses: [] }) };
  }
  lanSetEnabled({ token, enabled }) {
    this.requireToken(token);
    this.s.tx(() => this.setSetting('lan', { ...this.lanConfig(), enabled: !!enabled }));
    if (this.onLanChange) this.onLanChange(this.lanConfig());
    return this.lanStatus({ token });
  }
  lanNewCode({ token }) {
    this.requireToken(token);
    this.pairCode = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 10 * 60 * 1000 };
    return this.lanStatus({ token });
  }
  lanRemoveDevice({ token, id }) {
    this.requireToken(token);
    this.s.tx(() => this.setSetting('lan_devices', (this.setting('lan_devices') || []).filter(d => d.id !== id)));
    return this.lanStatus({ token });
  }
  // Sunucu tarafı (şifresiz, sadece lanserver kullanır)
  lanPair(code, ip) {
    if (!this.pairCode || this.pairCode.expires < Date.now() || String(code).trim() !== this.pairCode.code) return null;
    this.pairCode = null;
    const key = crypto.randomBytes(24).toString('hex');
    const list = this.setting('lan_devices') || [];
    const id = crypto.randomBytes(4).toString('hex');
    list.push({ id, hash: crypto.createHash('sha256').update(key).digest('hex'), created: nowStr(), lastSeen: nowStr(), ip });
    this.s.tx(() => this.setSetting('lan_devices', list));
    return key;
  }
  lanCheckDevice(key, ip) {
    if (!key) return false;
    const h = crypto.createHash('sha256').update(String(key)).digest('hex');
    const list = this.setting('lan_devices') || [];
    const d = list.find(x => x.hash === h);
    if (!d) return false;
    const now = nowStr();
    if (d.lastSeen.slice(0, 16) !== now.slice(0, 16) || d.ip !== ip) { d.lastSeen = now; d.ip = ip; this.s.tx(() => this.setSetting('lan_devices', list)); }
    return true;
  }
  // Müdür sayfasına giden özet durum (sadece görüntüleme)
  viewState() {
    const st = this.getState();
    if (st.setupNeeded) return { setupNeeded: true };
    const { day, balances, cardToday, tx, accounts, rates, version, stale } = st;
    return { day, balances, cardToday, tx, accounts, rates, version, stale };
  }

  // ---------- geçmiş ----------
  listClosedDays() {
    return this.s.all('SELECT date FROM days WHERE closed_at IS NOT NULL ORDER BY date DESC').map(r => r.date);
  }
  getDayDetail(date) {
    const d = this.s.get('SELECT * FROM days WHERE date=?', [date]); if (!d) fail('Gün bulunamadı.');
    const { balances, card } = this.dayTotals(date);
    const txs = this.txRows(date).reverse();
    const inn = { TL: 0, EUR: 0, USD: 0, GBP: 0 }, out = { TL: 0, EUR: 0, USD: 0, GBP: 0 };
    let nVoid = 0, nSale = 0;
    for (const t of txs) {
      if (t.void) { nVoid++; continue; }
      if (t.type === 'satis') nSale++;
      for (const c of CURS) { const v = t[COL[c]]; if (v > 0) inn[c] = r2(inn[c] + v); else out[c] = r2(out[c] - v); }
    }
    const devir = { TL: d.devir_tl, EUR: d.devir_eur, USD: d.devir_usd, GBP: d.devir_gbp };
    const kapanis = d.closed_at ? { TL: d.kapanis_tl, EUR: d.kapanis_eur, USD: d.kapanis_usd, GBP: d.kapanis_gbp } : null;
    return { date, closed: !!d.closed_at, devir, inn, out, expected: balances, kapanis, card, nVoid, nSale, tx: txs };
  }

  // ---------- şifre ----------
  verifyPin(pin) {
    if (!checkPin(pin, this.setting('pin_hash'))) return { ok: false };
    const token = crypto.randomBytes(16).toString('hex');
    this.tokens.add(token);
    return { ok: true, token };
  }
  lock(token) { this.tokens.delete(token); return true; }

  // ---------- rapor ----------
  report({ token, period }) {
    this.requireToken(token);
    const day = this.requireDay();
    let dates, label;
    if (period === 'day') { dates = [day.date]; label = 'Açık gün'; }
    else {
      let [y, m] = day.date.split('-').map(Number);
      if (period === 'prevmonth') { m -= 1; if (m === 0) { m = 12; y -= 1; } }
      const pre = `${y}-${pad(m)}`;
      dates = this.monthDates(pre);
      label = pre;
    }
    return this.aggregate(dates, label);
  }
  monthDates(ym) { return this.s.all('SELECT date FROM days WHERE date LIKE ? ORDER BY date', [ym + '%']).map(r => r.date); }

  // Verilen günlerin rapor toplamları (ekrandaki rapor ve Excel dosyaları aynı hesabı kullanır)
  aggregate(dates, label) {
    const A = { label, sale: 0, cnt: 0, cat: {}, prod: {}, pay: { EUR: 0, TL: 0, KART: 0, ODA: 0 }, dx: {}, gider: {}, giderTL: 0,
      owner: { TL: 0, TLOUT: 0, EURIN: 0, EUR: 0, USD: 0, GBP: 0 }, cardTL: 0, disc: 0, discN: 0, avans: 0, daily: {}, days: dates.length };
    if (!dates.length) return { ...A, openAccounts: 0 };
    const ph = dates.map(() => '?').join(',');
    const txs = this.s.all(`SELECT * FROM transactions WHERE void=0 AND day IN (${ph})`, dates);
    const items = this.s.all(`SELECT i.*, t.day FROM sale_items i JOIN transactions t ON t.id=i.tx_id WHERE t.void=0 AND t.day IN (${ph})`, dates);
    for (const i of items) {
      A.sale += i.amount_eur;
      A.cat[i.category] = (A.cat[i.category] || 0) + i.amount_eur;
      const p = A.prod[i.name] || (A.prod[i.name] = { q: 0, e: 0 }); p.q += i.qty; p.e += i.amount_eur;
      const dn = Number(i.day.slice(8)); A.daily[dn] = (A.daily[dn] || 0) + i.amount_eur;
      if (i.list_price != null && i.list_price > i.unit_price) {
        const diff = (i.list_price - i.unit_price) * i.qty;
        A.disc += i.currency === 'EUR' ? diff : diff * (i.amount_eur / i.amount || 0);
        A.discN++;
      }
    }
    for (const t of txs) {
      const meta = t.meta ? JSON.parse(t.meta) : {};
      const rates = meta.rates || this.rates();
      const sr = rates.EUR.satis;
      A.cardTL += t.card_tl;
      if (t.type === 'satis') {
        A.cnt++;
        if (t.method === 'ODA') A.pay.ODA += meta.eur || 0;
        else { A.pay.EUR += t.eur; A.pay.TL += t.tl / sr; A.pay.KART += t.card_tl / sr; }
      } else if (t.type === 'doviz') {
        const d = A.dx[meta.cur] || (A.dx[meta.cur] = { al: 0, alTL: 0, sa: 0, saTL: 0, n: 0 });
        d.n++;
        if (meta.dir === 'alis') { d.al += meta.amount; d.alTL += meta.tl; } else { d.sa += meta.amount; d.saTL += meta.tl; }
      } else if (t.type === 'gider') {
        const tlEq = -t.tl - t.eur * sr - t.usd * (rates.USD ? rates.USD.satis : 0);
        A.gider[t.category] = (A.gider[t.category] || 0) + tlEq; A.giderTL += tlEq;
      } else if (t.type === 'patron') {
        if (meta.tlIn != null) { A.owner.TL += meta.tlIn; A.owner.TLOUT += meta.tlOut; } else A.owner.TL += t.tl;
        if (meta.eurOut != null) { A.owner.EURIN += meta.eurIn; A.owner.EUR += meta.eurOut; } else A.owner.EUR -= t.eur; A.owner.USD -= t.usd; A.owner.GBP -= t.gbp;
      } else if (t.type === 'avans') {
        A.avans += -(t.tl) - t.eur * sr;
      }
    }
    const open = this.openAccounts();
    return { ...A, openAccounts: r2(open.reduce((s, a) => s + a.eurEq, 0)), openAccountCount: open.length };
  }

  // ---------- ayarlar (şifreli) ----------
  getSettings({ token }) {
    this.requireToken(token);
    return { rates: this.rates(), products: this.s.all('SELECT * FROM products ORDER BY sort, id'), categories: this.setting('categories'),
      backupDir2: this.setting('backup_dir2'), backups: this.backup.list(), backupDirs: this.backup.dirs(this.setting('backup_dir2')) };
  }
  setRates({ token, rates }) {
    this.requireToken(token);
    const out = {};
    for (const c of ['EUR', 'USD', 'GBP']) out[c] = { alis: num(rates[c].alis, `${SYM[c]} alış kuru`, { allowZero: false }), satis: num(rates[c].satis, `${SYM[c]} satış kuru`, { allowZero: false }) };
    this.s.tx(() => this.setSetting('rates', out));
    return this.getSettings({ token });
  }
  saveProduct({ token, product }) {
    this.requireToken(token);
    const p = product || {};
    const name = String(p.name || '').trim(); if (!name) fail('Ürün adı yazın.');
    const cats = this.setting('categories'); if (!cats.includes(p.category)) fail('Kategori seçin.');
    if (!['EUR', 'TL'].includes(p.currency)) fail('Para birimi seçin.');
    const price = p.price === '' || p.price == null ? null : num(p.price, 'Fiyat');
    const unit = ['adet', 'gece', 'gün', 'makine'].includes(p.unit) ? p.unit : 'adet';
    const active = p.active ? 1 : 0;
    this.s.tx(() => {
      if (p.id) this.s.run('UPDATE products SET name=?,category=?,currency=?,price=?,unit=?,active=? WHERE id=?', [name, p.category, p.currency, price, unit, active, p.id]);
      else {
        const mx = this.s.get('SELECT COALESCE(MAX(sort),0)+1 AS s FROM products WHERE category=?', [p.category]).s;
        this.s.run('UPDATE products SET sort=sort+1 WHERE sort>=?', [mx]);
        this.s.run('INSERT INTO products(name,category,currency,price,unit,active,sort) VALUES(?,?,?,?,?,?,?)', [name, p.category, p.currency, price, unit, active, mx]);
      }
    });
    return this.getSettings({ token });
  }
  changePin({ token, oldPin, newPin }) {
    this.requireToken(token);
    if (!checkPin(oldPin, this.setting('pin_hash'))) fail('Mevcut şifre yanlış.');
    if (!PIN_RE.test(String(newPin || ''))) fail('Yeni şifre 4–12 rakam olmalı.');
    this.s.tx(() => this.setSetting('pin_hash', hashPin(newPin)));
    return true;
  }
  setBackupDir2({ token, dir }) {
    this.requireToken(token);
    this.s.tx(() => this.setSetting('backup_dir2', dir || null));
    return this.getSettings({ token });
  }
  makeBackup(reason) {
    const r = this.backup.make(reason, this.setting('backup_dir2'));
    this.s.tx(() => this.setSetting('last_backup', r));
    return r;
  }
  backupNow({ token }) { this.requireToken(token); this.makeBackup('elle'); return this.getSettings({ token }); }
  // Tüm kasa kayıtlarını siler ve programı ilk kurulum (devir + şifre) ekranına döndürür.
  // Ürünler, fiyatlar ve kurlar korunur. Silmeden önce otomatik yedek alınır.
  resetAll({ token }) {
    this.requireToken(token);
    this.makeBackup('sifirlama-oncesi');
    this.s.tx(() => {
      for (const t of ['account_items', 'accounts', 'sale_items', 'transactions', 'days']) this.s.run(`DELETE FROM ${t}`);
      this.s.run("DELETE FROM settings WHERE key IN ('pin_hash','last_backup')");
    });
    this.tokens.clear();
    return this.getState();
  }
  restoreBackup({ token, name }) {
    this.requireToken(token);
    this.makeBackup('geri-yukleme-oncesi');
    this.s.replaceWith(this.backup.read(name));
    return this.getState();
  }
}

module.exports = { Service, UserError, EXPENSE_CATS, dkey };
