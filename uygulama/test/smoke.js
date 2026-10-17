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
const reportsDir = path.join(dir, 'Raporlar');
const mkBackup = () => createBackup({ dbFile, primaryDir: path.join(dir, 'yedekler'), documentsDir: path.join(dir, 'Belgeler') });
let step = 0;
const ok = (name) => console.log(`  ✓ ${++step}. ${name}`);
const throws = (fn, re) => assert.throws(fn, e => re.test(e.message), `beklenen hata: ${re}`);

(async () => {
  let store = await new Store(dbFile).open();
  let svc = new Service(store, mkBackup(), { reportsDir, log: e => { throw e; } });
  const P = name => svc.getState().products.find(p => p.name === name);

  assert.ok(svc.getState().setupNeeded); ok('ilk açılışta kurulum isteniyor');
  throws(() => svc.setup({ devir: { TL: 1 } }), /şifresi/);
  let st = svc.setup({ devir: { TL: 47894, EUR: 39, USD: 0, GBP: 0 }, pin: '2468' });
  assert.deepStrictEqual(st.balances, { TL: 47894, EUR: 39, USD: 0, GBP: 0 }); ok('kurulum + devir');
  assert.strictEqual(st.products.length, 56); ok('fiyat listesi yüklendi (56 ürün)');

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

  // Kısmi tahsilat: 105'e klima + damacana yazılır, önce sadece damacana tahsil edilir
  st = svc.addSale({ room: '105', lines: [{ productId: P('Klima (A/C)').id, qty: 7 }], payment: { method: 'ODA' } });
  let a5 = st.accounts.find(a => a.room === '105');
  st = svc.addSale({ room: '105', lines: [{ productId: P('Damacana').id }], payment: { method: 'ODA' }, account: { mode: 'existing', id: a5.id } });
  a5 = st.accounts.find(a => a.id === a5.id);
  assert.strictEqual(a5.eurEq, 71);
  const dam = a5.items.find(i => i.description === 'Damacana'), eurB = st.balances.EUR;
  throws(() => svc.payAccount({ accountId: a5.id, itemIds: [], payment: { method: 'EUR' } }), /seçin/);
  st = svc.payAccount({ accountId: a5.id, itemIds: [dam.id], payment: { method: 'EUR' } });
  a5 = st.accounts.find(a => a.id === a5.id);
  assert.ok(a5, 'hesap açık kalmalı'); assert.strictEqual(a5.eurEq, 63); assert.strictEqual(st.balances.EUR, eurB + 8);
  assert.ok(a5.items.find(i => i.id === dam.id).paid_tx_id); assert.match(st.tx[0].description, /105 oda hesabından 1 kalem tahsil edildi/);
  ok('kısmi tahsilat: damacana ödendi (8 €), klima borçta kaldı (63 €)');
  const damSale = st.tx.find(t => t.description.startsWith('Damacana →'));
  throws(() => svc.voidTx({ id: damSale.id }), /tahsilatı yapılmış/);
  st = svc.voidTx({ id: st.tx[0].id });
  assert.strictEqual(st.accounts.find(a => a.id === a5.id).eurEq, 71); assert.strictEqual(st.balances.EUR, eurB);
  ok('kısmi tahsilat iptali kalemleri borca geri aldı');
  st = svc.payAccount({ accountId: a5.id, itemIds: [dam.id], payment: { method: 'EUR' } });
  st = svc.closeAccount({ accountId: a5.id, payment: { method: 'KART' } });
  assert.ok(!st.accounts.find(a => a.id === a5.id)); assert.strictEqual(st.tx[0].card_tl, 63 * 55); assert.match(st.tx[0].description, /kapatıldı — 1 kalem/);
  ok('kalan klima kartla tahsil edildi, hesap kapandı');

  // "Diğer" ürünü: açıklama zorunlu, tutar elle
  throws(() => svc.addSale({ lines: [{ productId: P('Diğer').id, freeAmount: 15 }], payment: { method: 'EUR' } }), /açıklama/);
  st = svc.addSale({ lines: [{ productId: P('Diğer').id, freeAmount: 15, freeNote: 'Şemsiye' }], payment: { method: 'EUR' } });
  assert.match(st.tx[0].description, /^Şemsiye \(Nakit €\)/); ok('“Diğer” satışı (açıklama zorunlu)');

  // Açık klima: gece sayısı belli değil; gün sonlarıyla sayılır, tahsilatta kesinleşir
  throws(() => svc.addSale({ room: '204', lines: [{ productId: P('Klima (A/C)').id, openEnded: true }], payment: { method: 'EUR' } }), /oda hesabına/);
  throws(() => svc.addSale({ room: '204', lines: [{ productId: P('Damacana').id, openEnded: true }], payment: { method: 'ODA' } }), /seçilemez/);
  st = svc.addSale({ room: '204', lines: [{ productId: P('Klima (A/C)').id, openEnded: true }, { productId: P('Damacana').id }], payment: { method: 'ODA' } });
  let a4 = st.accounts.find(a => a.room === '204');
  const ac = a4.items.find(i => i.kind === 'acik');
  assert.ok(ac && ac.nights === 0 && a4.eurEq === 8); ok('açık klima başlatıldı (henüz 0 gece)');
  ['2026-12-01', '2026-12-02', '2026-12-03'].forEach(d => store.run('INSERT INTO days(date,opened_at,closed_at) VALUES(?,?,?)', [d, 'x', 'x']));
  store.run('UPDATE account_items SET start_day=? WHERE id=?', ['2026-12-01', ac.id]);
  store.run("UPDATE days SET date='2026-12-04' WHERE closed_at IS NULL");
  store.run("UPDATE transactions SET day='2026-12-04' WHERE day=?", [st.day.date]);
  a4 = svc.getState().accounts.find(a => a.id === a4.id);
  assert.strictEqual(a4.items.find(i => i.id === ac.id).nights, 3); assert.strictEqual(a4.eurEq, 8 + 27); ok('3 gün sonu sonra 3 gece = 27 €');
  throws(() => svc.payAccount({ accountId: a4.id, itemIds: null, payment: { method: 'SPLIT', eur: 1 } }), /tutmuyor/);
  assert.strictEqual(svc.getState().accounts.find(a => a.id === a4.id).items.find(i => i.id === ac.id).kind, 'acik'); ok('hatalı ödemede klima açık kaldı');
  st = svc.payAccount({ accountId: a4.id, itemIds: null, payment: { method: 'KART' }, nights: { [ac.id]: 5 } });
  assert.ok(!st.accounts.find(a => a.id === a4.id)); assert.strictEqual(st.tx[0].card_tl, (8 + 45) * svc.rates().EUR.satis);
  const fin = st.tx.find(t => t.description.startsWith('Klima (A/C) 5 gece'));
  assert.ok(fin, 'kapanış satışı kaydedilmeli'); ok('çıkışta gece sayısı 5 yapılıp tahsil edildi (45 €), satış kaydı oluştu');
  { const ca = svc.closedAccounts({ room: a4.room }).find(a => a.id === a4.id);
    assert.ok(ca && ca.payments.length === 1 && ca.payments[0].method === 'KART' && ca.paidEur === 8 + 45);
    assert.ok(ca.items.some(i => i.description === 'Klima (A/C) 5 gece'));
    assert.ok(!svc.closedAccounts({ room: '999' }).some(a => a.id === a4.id));
    const cd = svc.closedAccountDays(); assert.ok(cd.some(d => d.day === ca.closed_day && d.n >= 1));
    assert.ok(svc.closedAccounts({ day: ca.closed_day }).some(a => a.id === a4.id) && !svc.closedAccounts({ day: '2000-01-01' }).length);
    ok('kapanan hesap ayrıntısı: kalemler, tahsilat ve gün gün liste'); }
  st = svc.voidTx({ id: st.tx[0].id }); st = svc.voidTx({ id: fin.id });
  a4 = st.accounts.find(a => a.id === a4.id);
  assert.strictEqual(a4.items.find(i => i.id === ac.id).kind, 'acik'); ok('tahsilat ve kapanış iptali klimayı yeniden açık yaptı');
  st = svc.stopOpenItem({ itemId: ac.id, nights: 2 });
  a4 = st.accounts.find(a => a.id === a4.id);
  assert.strictEqual(a4.eurEq, 8 + 18); ok('klima durduruldu (2 gece), misafir kalmaya devam ediyor');
  st = svc.closeAccount({ accountId: a4.id, payment: { method: 'EUR' } });
  store.run("UPDATE days SET date=? WHERE closed_at IS NULL", [svc.getState().today]);
  store.run("UPDATE transactions SET day=? WHERE day='2026-12-04'", [svc.getState().today]);
  store.run("DELETE FROM days WHERE date IN ('2026-12-01','2026-12-02','2026-12-03')");

  // Sepette farklı ödeme şekilleri: damacana nakit €, klima 3 gece oda hesabına — tek seferde, iki ayrı kayıt
  let e0 = st.balances.EUR; const nTx = st.tx.length;
  throws(() => svc.addSaleBatch({ room: '307', groups: [{ lines: [{ productId: P('Damacana').id }], payment: { method: 'EUR' } }, { lines: [{ productId: P('Kahvaltı').id }], payment: { method: 'SPLIT', eur: 1 } }] }), /tutmuyor/);
  assert.strictEqual(svc.getState().tx.length, nTx, 'hata olunca hiçbiri kaydedilmemeli');
  st = svc.addSaleBatch({ room: '307', groups: [{ lines: [{ productId: P('Damacana').id }], payment: { method: 'EUR' } }, { lines: [{ productId: P('Klima (A/C)').id, qty: 3 }], payment: { method: 'ODA' } }], account: { mode: 'new' } });
  assert.strictEqual(st.tx.length, nTx + 2); assert.strictEqual(st.balances.EUR, e0 + 8);
  assert.strictEqual(st.accounts.find(a => a.room === '307').eurEq, 27); ok('sepette karışık ödeme: damacana nakit (8 €), klima odaya (27 €), iki kayıt');

  // Adisyon: yazıcı seçilmeden hata; seçilince fiş (resim olarak GS v 0) yazıcıya / geliştirmede dosyaya gider
  { const a307 = svc.getState().accounts.find(a => a.room === '307');
    svc.addSale({ room: '307', lines: [{ productId: P('Efes').id, qty: 2 }], payment: { method: 'ODA' }, account: { mode: 'existing', id: a307.id } });
    const efes = svc.getState().accounts.find(a => a.id === a307.id).items.find(i => i.item_name === 'Efes');
    assert.ok(efes && efes.qty === 2 && efes.unit_price > 0 && efes.description === 'Efes ×2');
    await assert.rejects(() => svc.printAccount({ accountId: a307.id }), /Yazıcı seçilmemiş/);
    const outDir = path.join(dir, 'BlueHeavenKasa-Fisler');
    svc.setSetting('printer', 'KASA-YAZICI');
    await svc.printAccount({ accountId: a307.id });
    const files = fs.readdirSync(outDir); assert.strictEqual(files.length, 1);
    await svc.printAccount({ accountId: a4.id }); assert.strictEqual(fs.readdirSync(outDir).length, 2, 'kapanmış hesabın adisyonu da basılmalı');
    const buf = fs.readFileSync(path.join(outDir, files[0]));
    assert.ok(buf.includes(Buffer.from([0x1d, 0x76, 0x30])) && buf.subarray(-4).equals(Buffer.from([0x1d, 0x56, 0x42, 0x00])));
    svc.setSetting('printer', '');
    ok('adisyon: adet/fiyat saklanıyor, yazıcısız hata, fiş resim olarak üretiliyor'); }

  // İptal sonrası boşalan oda hesabı listeden kalkar; açılışta takılı kalmış boş hesaplar temizlenir
  st = svc.addSale({ room: '101', lines: [{ productId: P('Damacana').id }], payment: { method: 'ODA' }, account: { mode: 'new' } });
  assert.ok(st.accounts.find(a => a.room === '101'));
  st = svc.voidTx({ id: st.tx[0].id });
  assert.ok(!st.accounts.find(a => a.room === '101')); ok('tek kalemi iptal edilen 101 hesabı listeden kalktı');
  st = svc.addSale({ room: '102', lines: [{ productId: P('Damacana').id }, { productId: P('Kahvaltı').id }], payment: { method: 'ODA' }, account: { mode: 'new' } });
  const saleA = st.tx[0];
  let a2 = st.accounts.find(a => a.room === '102');
  st = svc.addSale({ room: '102', lines: [{ productId: P('Efes').id }], payment: { method: 'ODA' }, account: { mode: 'existing', id: a2.id } });
  a2 = st.accounts.find(a => a.id === a2.id);
  st = svc.payAccount({ accountId: a2.id, itemIds: a2.items.filter(i => i.tx_id === saleA.id).map(i => i.id), payment: { method: 'EUR' } });
  st = svc.voidTx({ id: st.tx.find(t => t.description.startsWith('Efes')).id });
  assert.ok(!st.accounts.find(a => a.id === a2.id)); ok('ödenmemiş son kalem iptal edilince 102 hesabı “ödendi” olarak kapandı');
  store.run("INSERT INTO accounts(room,opened_day,opened_at) VALUES('103','2026-01-01','x')");
  svc = new Service(store, mkBackup(), { reportsDir, log: e => { throw e; } });
  assert.ok(!svc.getState().accounts.find(a => a.room === '103')); ok('açılışta takılı kalmış boş hesap temizlendi');

  // Para bozma, gider, Cengiz Bey
  let tl0 = st.balances.TL; e0 = st.balances.EUR;
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
  svc = new Service(store, mkBackup(), { reportsDir, log: e => { throw e; } });
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
  svc = new Service(store, mkBackup(), { reportsDir, log: e => { throw e; } });
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

  // Excel raporları: gün sonunda gün + ay dosyası kendiliğinden, elle de alınabilir
  svc.closeDay({ counts: svc.getState().balances });
  await svc.autoExport(svc.listClosedDays()[0]);
  const tX = svc.verifyPin('5555').token;
  const ExcelJS = require('exceljs');
  let lr = svc.listReports({ token: tX });
  assert.ok(lr.files.some(f => f.name.startsWith('Gün sonu - ')) && lr.files.some(f => f.name.startsWith('Aylık - ')), 'rapor dosyaları oluşmalı');
  const dayFile = (await svc.exportDay({ token: tX, date: svc.getState().day.date })).file;
  const wbx = new ExcelJS.Workbook(); await wbx.xlsx.readFile(dayFile);
  assert.deepStrictEqual(wbx.worksheets.map(w => w.name), ['Özet', 'İşlemler']);
  assert.strictEqual(wbx.getWorksheet('Özet').getCell('A1').value, 'Blue Heaven Apart — Gün sonu raporu');
  const mFile = (await svc.exportMonth({ token: tX, month: svc.getState().day.date.slice(0, 7) })).file;
  const wbm = new ExcelJS.Workbook(); await wbm.xlsx.readFile(mFile);
  assert.deepStrictEqual(wbm.worksheets.map(w => w.name), ['Günlük', 'Özet', 'Ürünler']);
  await assert.rejects(svc.exportDay({ token: 'x', date: '2026-01-01' }), /şifre/);
  ok(`Excel raporları (${svc.listReports({ token: tX }).files.length} dosya: gün sonu + aylık)`);

  // Müdür sayfası (yerel ağ): eşleştirme, şifre, sadece okuma, Excel indirme, hatalı denemede kilit
  {
    const { createLanServer } = require('../src/core/lanserver');
    const lan = createLanServer({ svc, staticDir: path.join(__dirname, '..', 'src', 'renderer') });
    lan.apply({ enabled: true, port: 18767 });
    await new Promise(r => setTimeout(r, 200));
    let cookie = '';
    const api = async (method, arg, tok) => {
      const r = await fetch('http://127.0.0.1:18767/api', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ method, arg, token: tok }) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return r.json();
    };
    assert.ok((await api('viewState')).unpaired);
    const tk = svc.verifyPin('5555').token, code = svc.lanNewCode({ token: tk }).code.code;
    assert.ok(!(await api('pair', '000000')).ok);
    assert.ok((await api('pair', code)).ok); assert.ok(cookie.startsWith('bhk_cihaz='));
    assert.ok(!(await api('pair', code)).ok, 'kod tek kullanımlık olmalı');
    assert.ok((await api('viewState')).needPin);
    const mt = (await api('verifyPin', '5555')).data.token;
    const vs = await api('viewState', null, mt); assert.ok(vs.ok && vs.data.balances);
    assert.ok((await api('report', { period: 'month' }, mt)).ok);
    assert.ok(Array.isArray((await api('closedAccounts', {}, mt)).data));
    assert.match((await api('addExpense', { category: 'Diğer', currency: 'TL', amount: 1 }, mt)).error, /yapılamaz/);
    assert.match((await api('resetAll', {}, mt)).error, /yapılamaz/);
    const fname = (await api('listReports', null, mt)).data.files[0].name;
    const dl = await fetch(`http://127.0.0.1:18767/excel?f=${encodeURIComponent(fname)}&t=${mt}`, { headers: { cookie } });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:18767/excel?f=${encodeURIComponent(fname)}&t=${mt}`)).status, 401);
    assert.strictEqual((await fetch(`http://127.0.0.1:18767/excel?f=..%2Fkasa.db&t=${mt}`, { headers: { cookie } })).status, 404);
    for (let i = 0; i < 5; i++) await api('verifyPin', '0000');
    assert.match((await api('verifyPin', '5555')).error, /15 dakika/);
    lan.close();
    ok('müdür sayfası: eşleştirme, şifre, sadece okuma, Excel indirme, kilit');
  }

  // Arayüz: ana ekrandaki kutular dengeli açılıp kapanmalı (fazla/eksik </div> düzeni bozar)
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const mainPart = html.slice(html.indexOf('<div class="wrap hidden" id="main">'), html.indexOf('<!-- Aynı misafir mi -->'));
  const depth = (mainPart.match(/<div\b/g) || []).length - (mainPart.match(/<\/div>/g) || []).length;
  assert.strictEqual(depth, 0, 'ana ekranda div açılış/kapanış dengesi bozuk');
  ok('ana ekran düzeni (div dengesi) sağlam');

  console.log(`\nTüm testler geçti (${step}).`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('\n✗ TEST HATASI:', e.message); console.error(e.stack); process.exit(1); });
