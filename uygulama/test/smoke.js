'use strict';
// Çekirdek iş kurallarının uçtan uca testi: `npm test`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/core/db');
const { Service } = require('../src/core/service');
const { createBackup } = require('../src/core/backup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhkasa-'));
const dbFile = path.join(dir, 'kasa.db');
const mkBackup = () => createBackup({ dbFile, primaryDir: path.join(dir, 'yedekler'), documentsDir: path.join(dir, 'Belgeler') });
let step = 0;
const ok = (name) => console.log(`  ✓ ${++step}. ${name}`);
const throws = (fn, re) => assert.throws(fn, e => re.test(e.message), `beklenen hata: ${re}`);

(async () => {
  let store = await new Store(dbFile).open();
  let svc = new Service(store, mkBackup());
  const P = name => svc.getState().products.find(p => p.name === name);

  assert.ok(svc.getState().setupNeeded); ok('ilk açılışta kurulum isteniyor');
  throws(() => svc.setup({ devir: { TL: 1 } }), /şifresi/);
  let st = svc.setup({ devir: { TL: 47894, EUR: 39, USD: 0, GBP: 0 }, pin: '2468' });
  assert.deepStrictEqual(st.balances, { TL: 47894, EUR: 39, USD: 0, GBP: 0 }); ok('kurulum + devir');
  assert.strictEqual(st.products.length, 55); ok('fiyat listesi yüklendi (55 ürün)');

  // Klima 7 gece + damacana, nakit € → 71 €
  st = svc.addSale({ room: '203', lines: [{ productId: P('Klima (A/C)').id, qty: 7 }, { productId: P('Damacana').id, qty: 1 }], payment: { method: 'EUR' } });
  assert.strictEqual(st.balances.EUR, 110); assert.match(st.tx[0].description, /Klima \(A\/C\) 7 gece \+ Damacana \(Nakit €\)/); ok('satış nakit € (71 €)');

  // Aynı satış kartla → 3.905 TL kart, kasaya nakit girmez
  st = svc.addSale({ room: '', lines: [{ productId: P('Klima (A/C)').id, qty: 7 }, { productId: P('Damacana').id, qty: 1 }], payment: { method: 'KART' } });
  assert.strictEqual(st.cardToday, 3905); assert.strictEqual(st.balances.TL, 47894); ok('satış kart (3.905 TL), kasa değişmedi');

  // TL fiyatlı ürün € ile: Coke 110 TL = 2 €
  st = svc.addSale({ lines: [{ productId: P('Coke').id, qty: 1 }], payment: { method: 'EUR' } });
  assert.strictEqual(st.balances.EUR, 112); ok('TL fiyatlı ürün € ile ödendi (2 €)');

  // İndirim açıklamasız reddedilir, açıklamalı kabul edilir
  throws(() => svc.addSale({ lines: [{ productId: P('Standart Masaj (40 dk)').id, overridePrice: 30 }], payment: { method: 'EUR' } }), /açıklama/);
  st = svc.addSale({ lines: [{ productId: P('Standart Masaj (40 dk)').id, overridePrice: 30, note: 'tanıdık' }], payment: { method: 'TL' } });
  assert.strictEqual(st.balances.TL, 47894 + 1650); assert.match(st.tx[0].description, /indirim: tanıdık/); ok('açıklamalı indirim (30 € = 1.650 TL)');

  // Bölünmüş ödeme tutmazsa hata
  throws(() => svc.addSale({ lines: [{ productId: P('Kahvaltı').id, qty: 2 }], payment: { method: 'SPLIT', eur: 10, tl: 100 } }), /tutmuyor/);
  st = svc.addSale({ lines: [{ productId: P('Kahvaltı').id, qty: 2 }], payment: { method: 'SPLIT', eur: 10, tl: 550 } });
  ok('bölünmüş ödeme kontrolü');

  // Oda hesabı: yeni hesap, sonra aynı oda için karar zorunlu
  st = svc.addSale({ room: '208', lines: [{ productId: P('Efes').id, qty: 2 }], payment: { method: 'ODA' } });
  let acc = st.accounts.find(a => a.room === '208');
  assert.strictEqual(acc.totals.TL, 480); ok('odaya yazıldı, TL kalem TL olarak tutuluyor');
  throws(() => svc.addSale({ room: '208', lines: [{ productId: P('Damacana').id }], payment: { method: 'ODA' } }), /aynı misafir/);
  st = svc.addSale({ room: '208', lines: [{ productId: P('Damacana').id }], payment: { method: 'ODA' }, account: { mode: 'existing', id: acc.id } });
  const balBefore = st.balances.TL;
  st = svc.addAvans({ room: '208', desc: 'Eczane', currency: 'TL', amount: 1085, account: { mode: 'existing', id: acc.id } });
  assert.strictEqual(st.balances.TL, balBefore - 1085); ok('misafir adına ödeme kasadan düştü, hesaba eklendi');
  acc = st.accounts.find(a => a.room === '208');
  assert.deepStrictEqual(acc.totals, { TL: 1565, EUR: 8 }); assert.strictEqual(acc.tlEq, 1565 + 440); ok('hesap toplamı 1.565 TL + 8 € = 2.005 TL');
  st = svc.correctAccount({ accountId: acc.id, desc: 'Efes fazla yazılmış', currency: 'TL', amount: -240 });
  st = svc.moveAccount({ accountId: acc.id, room: '308' });
  acc = st.accounts.find(a => a.id === acc.id);
  assert.strictEqual(acc.room, '308'); assert.strictEqual(acc.tlEq, 1765); ok('düzeltme ve oda değiştirme');

  // Yeni misafir: eski hesap "çıktı, ödenmedi"
  st = svc.addSale({ room: '308', lines: [{ productId: P('Magnet').id }], payment: { method: 'ODA' }, account: { mode: 'new' } });
  assert.strictEqual(st.accounts.filter(a => a.room === '308').length, 2);
  assert.ok(st.accounts.find(a => a.id === acc.id).left_unpaid); ok('yeni misafir → eski hesap çıktı-ödenmedi');

  // Hesabı kartla kapat
  const card0 = st.cardToday;
  st = svc.closeAccount({ accountId: acc.id, payment: { method: 'KART' } });
  assert.strictEqual(st.cardToday, card0 + 1765); assert.ok(!st.accounts.find(a => a.id === acc.id)); ok('hesap kartla kapatıldı');

  // Kapalı hesaptaki satış iptal edilemez; önce tahsilat iptal → hesap geri açılır
  const efesTx = st.tx.find(t => t.description.startsWith('Efes ×2'));
  throws(() => svc.voidTx({ id: efesTx.id }), /tahsilat/);
  const tah = st.tx.find(t => t.type === 'tahsilat');
  st = svc.voidTx({ id: tah.id });
  assert.ok(st.accounts.find(a => a.id === acc.id)); assert.strictEqual(st.cardToday, card0); ok('tahsilat iptali hesabı geri açtı');
  st = svc.voidTx({ id: efesTx.id });
  assert.strictEqual(st.accounts.find(a => a.id === acc.id).tlEq, 1765 - 480); ok('oda satışı iptali hesaptan düştü');

  // Para bozma, gider, Cengiz Bey
  let tl0 = st.balances.TL, e0 = st.balances.EUR;
  st = svc.addExchange({ dir: 'alis', cur: 'EUR', amount: 1150, rate: 53 });
  assert.strictEqual(st.balances.TL, tl0 - 60950); assert.strictEqual(st.balances.EUR, e0 + 1150);
  st = svc.addExchange({ dir: 'satis', cur: 'EUR', amount: 5, rate: 55 });
  st = svc.addExchange({ dir: 'alis', cur: 'USD', amount: 100, rate: 47 });
  assert.strictEqual(st.balances.USD, 100); ok('para bozma / ters bozma / dolar');
  st = svc.addExpense({ category: 'Mutfak / Bar / Restoran', desc: 'BİM ekmek', currency: 'TL', amount: 469 });
  st = svc.addExpense({ category: 'Masaj terapisti (Sevgi Hanım)', desc: '', currency: 'EUR', amount: 20 });
  throws(() => svc.addExpense({ category: 'Personel', currency: 'TL', amount: 5 }), /Kategori/);
  st = svc.addOwner({ tl: 60000, eur: 1000, usd: 100 });
  assert.strictEqual(st.balances.USD, 0); ok('gider ve Cengiz Bey');
  tl0 = st.balances.TL;
  st = svc.addOwner({ tlOut: 5000 });
  assert.strictEqual(st.balances.TL, tl0 - 5000); assert.match(st.tx[0].description, /5\.000 TL aldı/); ok('Cengiz Bey TL aldı');
  e0 = st.balances.EUR;
  st = svc.addOwner({ eurIn: 500, eur: 200 });
  assert.strictEqual(st.balances.EUR, e0 + 300); assert.match(st.tx[0].description, /500 € getirdi, 200 € aldı/); ok('Cengiz Bey € getirdi');

  // Rapor şifresi
  assert.strictEqual(svc.verifyPin('123456').ok, false);
  const { token } = svc.verifyPin('2468');
  throws(() => svc.report({ token: 'x', period: 'day' }), /şifre/);
  const rep = svc.report({ token, period: 'day' });
  assert.ok(rep.sale > 0 && rep.dx.EUR.al === 1150 && rep.gider['Mutfak / Bar / Restoran'] === 469 && rep.discN === 1);
  ok(`rapor (satış ${rep.sale.toFixed(2)} €, indirim ${rep.disc} €)`);

  // Gün sonu: sayım farkı kaydedilir, yarına devreder
  const exp = svc.getState().balances;
  throws(() => svc.closeDay({ counts: { TL: 1 } }), /Tüm para/);
  st = svc.closeDay({ counts: { TL: exp.TL + 100, EUR: exp.EUR, USD: 0, GBP: 0 } });
  assert.notStrictEqual(st.day.date, svc.listClosedDays()[0]);
  assert.strictEqual(st.balances.TL, exp.TL + 100); ok('gün sonu + devir');
  const det = svc.getDayDetail(svc.listClosedDays()[0]);
  assert.strictEqual(det.kapanis.TL - det.expected.TL, 100); ok('geçmiş gün detayı (fark +100 TL)');
  throws(() => svc.voidTx({ id: det.tx[0].id }), /açık günün/); ok('kapanmış gün değiştirilemiyor');
  assert.ok(st.accounts.length >= 1); ok('açık oda hesapları ertesi güne taşındı');

  // Kalıcılık: dosyadan yeniden aç
  const before = JSON.stringify(svc.getState().balances);
  store = await new Store(dbFile).open();
  svc = new Service(store, mkBackup());
  assert.strictEqual(JSON.stringify(svc.getState().balances), before); ok('diskten yeniden açınca her şey yerinde');

  // Yedek + geri yükleme
  const t2 = svc.verifyPin('2468').token;
  const sets = svc.backupNow({ token: t2 });
  assert.ok(sets.backups.length >= 2 && fs.existsSync(path.join(dir, 'Belgeler', 'BlueHeavenKasa-Yedek')));
  const snap = sets.backups[0].name;
  svc.addExpense({ category: 'Diğer', currency: 'TL', amount: 999 });
  st = svc.restoreBackup({ token: t2, name: snap });
  assert.strictEqual(JSON.stringify(st.balances), before); ok('yedekten geri yükleme');

  // Ayarlar: kur ve şifre değişimi
  svc.setRates({ token: t2, rates: { EUR: { alis: 54, satis: 56 }, USD: { alis: 47, satis: 49 }, GBP: { alis: 62, satis: 65 } } });
  st = svc.addSale({ lines: [{ productId: P('Damacana').id }], payment: { method: 'KART' } });
  assert.strictEqual(st.tx[0].card_tl, 448); ok('kur değişti, yeni satış 56 kurla (448 TL)');
  svc.changePin({ token: t2, oldPin: '2468', newPin: '4321' });
  assert.ok(svc.verifyPin('4321').ok && !svc.verifyPin('2468').ok); ok('şifre değiştirildi');

  // Kategori taşıma: eski (1.0.4) düzendeki bir veritabanı yeni kategorilere geçer
  const cokeId = P('Coke').id;
  svc.addSale({ lines: [{ productId: cokeId }, { productId: P('Çamaşır (Laundry)').id }], payment: { method: 'TL' } });
  store.run("UPDATE products SET category='İçecek & Yiyecek' WHERE category='Market Resepsiyon' AND name NOT IN ('Kartpostal','Kartpostal + Pul','Resepsiyon Market (diğer)')");
  store.run("UPDATE products SET category='Hediyelik & Market' WHERE category IN ('Hediyelik','Market Resepsiyon')");
  store.run("UPDATE products SET category='Hizmetler' WHERE category='Laundry'");
  store.run("UPDATE sale_items SET category=(SELECT category FROM products p WHERE p.id=sale_items.product_id)");
  store.run("UPDATE settings SET value=? WHERE key='categories'", [JSON.stringify(['Hizmetler', 'Masaj', 'İçecek & Yiyecek', 'Hediyelik & Market'])]);
  store.run("DELETE FROM settings WHERE key='migrations'");
  svc = new Service(store, mkBackup());
  const cat = n => svc.getState().products.find(p => p.name === n).category;
  assert.strictEqual(cat('Coke'), 'Market Resepsiyon'); assert.strictEqual(cat('Kartpostal + Pul'), 'Market Resepsiyon');
  assert.strictEqual(cat('Magnet'), 'Hediyelik'); assert.strictEqual(cat('Çamaşır (Laundry)'), 'Laundry');
  assert.deepStrictEqual(svc.getState().categories, ['Hizmetler', 'Masaj', 'Market Resepsiyon', 'Laundry', 'Hediyelik']);
  const r3 = svc.report({ token: svc.verifyPin('4321').token, period: 'day' });
  assert.ok(r3.cat['Market Resepsiyon'] > 0 && r3.cat['Laundry'] > 0 && !r3.cat['İçecek & Yiyecek']);
  ok('eski veritabanı yeni kategorilere taşındı (geçmiş satışlar dahil)');

  // Sıfırlama: kayıtlar silinir, ürün/fiyat/kur kalır, kurulum ekranına dönülür, önce yedek alınır
  const tR = svc.verifyPin('4321').token;
  const nBk = svc.getSettings({ token: tR }).backups.length;
  const prodCount = svc.getState().products.length;
  st = svc.resetAll({ token: tR });
  assert.ok(st.setupNeeded); assert.strictEqual(svc.listClosedDays().length, 0);
  assert.ok(!svc.verifyPin('4321').ok);
  st = svc.setup({ devir: { TL: 1000 }, pin: '5555' });
  assert.strictEqual(st.balances.TL, 1000); assert.strictEqual(st.tx.length, 0); assert.strictEqual(st.accounts.length, 0);
  assert.strictEqual(st.products.length, prodCount); assert.strictEqual(st.rates.EUR.satis, 56);
  assert.ok(svc.getSettings({ token: svc.verifyPin('5555').token }).backups.length > nBk);
  ok('verileri sıfırla → kurulum ekranı, ürünler ve kurlar korundu, önce yedek alındı');

  console.log(`\nTüm testler geçti (${step}).`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('\n✗ TEST HATASI:', e.message); console.error(e.stack); process.exit(1); });
