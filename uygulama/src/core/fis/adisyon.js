'use strict';
// Oda hesabı adisyonu. Düzen Blue Heaven Adisyon (restoran) programındaki adisyonla aynı:
// büyük başlık, Number / Oda No, Ürün·Adet·Fiyat·Tutar tablosu, büyük TOPLAM, döviz karşılıkları.

const { RasterDoc } = require('./raster');

const BUSINESS = 'BLUE HEAVEN APART HOTEL';
const FOOTER = ['Thank you for choosing us.', 'Danke, daß Sie uns gewählt haben.', 'Kiitos kun valitsitte meidät.'];
const METHOD = { EUR: 'Nakit €', TL: 'Nakit TL', KART: 'Kart', SPLIT: 'Bölünmüş' };

const nf = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = v => nf.format(v || 0);
const sym = c => (c === 'EUR' ? '€' : '₺');
const upperTr = s => String(s == null ? '' : s).toLocaleUpperCase('tr-TR');

function dateTime(d = new Date()) {
  return {
    date: d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
  };
}

// Hesap kalemini adisyon satırına çevirir: ad, adet, birim fiyat, tutar (kendi para biriminde)
function lineOf(i) {
  const name = i.item_name || (i.kind === 'avans' ? i.description.replace(/^Misafir adına: /, 'Avans: ') : i.description);
  if (i.kind === 'acik') return { name: `${name} (açık)`, qty: i.nights, price: i.unit_price, total: i.amount, cur: i.currency };
  const qty = i.qty || 1;
  return { name, qty, price: i.unit_price != null && i.qty ? i.unit_price : i.amount / qty, total: i.amount, cur: i.currency };
}

/**
 * account: hesap (kalemler accountView'daki gibi; açık kalemlerde nights/amount hesaplanmış)
 * rates: { EUR:{satis}, USD:{satis}, GBP:{satis} }
 * payments: kapanan hesapta tahsilatlar (adisyonun altında "Ödenen" olarak yazılır)
 */
function roomBill({ account, rates, payments = [], copy = false, now = new Date() }) {
  const { date, time } = dateTime(now);
  const toTL = (v, c) => (c === 'EUR' ? v * rates.EUR.satis : v);
  const closed = account.status === 'closed';
  // Açık hesapta sadece ödenmemiş kalemler; kapanmış hesapta hepsi
  const items = account.items.filter(i => closed || !i.paid_tx_id);

  const doc = new RasterDoc();
  doc.text(BUSINESS, { font: 'xl', align: 'center' }).space(4);
  doc.columns([{ text: 'Number', width: 210 }, { text: `: ${account.id}` }], { font: 'large', pad: 2 });
  doc.columns([{ text: 'Oda No', width: 210 }, { text: `: ${account.room}` }], { font: 'large', pad: 2 });
  doc.text(`${date}  ${time}${copy ? '   (KOPYA)' : ''}`, { align: 'center' });
  doc.rule('dotted');

  const cols = (name, qty, price, total, opts) => doc.columns([
    { text: name },
    { text: qty, width: 76, align: 'center' },
    { text: price, width: 134, align: 'right' },
    { text: total, width: 150, align: 'right' },
  ], opts);
  cols('Ürün', 'Adet', 'Fiyat', 'Tutar', { font: 'bold', pad: 3 });
  doc.rule('solid', 1).space(2);

  let tl = 0;
  for (const i of items) {
    if (i.kind === 'not') { doc.text(`» ${i.description}`, { font: 'small', indent: 10 }); continue; }
    const l = lineOf(i);
    tl += toTL(l.total, l.cur);
    cols(upperTr(l.name), String(Math.round(l.qty * 100) / 100), amount(l.price) + sym(l.cur), amount(l.total) + sym(l.cur), { pad: 2 });
  }
  tl = Math.round(tl * 100) / 100;

  doc.rule('dotted').space(4);
  doc.pair('Ara Toplam:', amount(tl) + '₺', ['bold']);
  doc.rule('dashed', 1);
  doc.pair('TOPLAM:', amount(tl) + '₺', ['xl', 'large'], 4);
  doc.rule('dashed', 1);
  let due = tl;
  if (closed) {
    const paid = Math.round(payments.reduce((s, p) => s + (p.tlEq || 0), 0) * 100) / 100;
    for (const p of payments) doc.pair(`Ödeme - ${METHOD[p.method] || 'Ödemesiz'}`, `-${amount(p.tlEq)}`, ['small']);
    doc.pair('Ödenen:', amount(paid) + '₺', ['bold']);
    due = Math.max(0, Math.round((tl - paid) * 100) / 100);
    doc.pair('KALAN:', amount(due) + '₺', ['large', 'bold']);
  }
  for (const [c, s] of [['USD', '$'], ['EUR', '€'], ['GBP', '£']]) {
    const r = rates[c] && rates[c].satis;
    if (r > 0 && due > 0) doc.pair(`Grand Total ${s}:`, amount(Math.ceil((due / r) * 100) / 100), ['bold'], 1);
  }
  doc.space(4);
  for (const line of FOOTER) doc.text(line, { font: 'small', align: 'center', pad: 1 });
  doc.text('Mali değeri yoktur', { font: 'small', align: 'center', pad: 1 });
  return doc.space(2).toEscPos();
}

// Yazıcı ayarını denemek için kısa fiş
function testSlip(target) {
  const { date, time } = dateTime();
  const doc = new RasterDoc();
  doc.text(BUSINESS, { font: 'xl', align: 'center' }).space(4);
  doc.text('YAZICI TESTİ', { font: 'large', align: 'center' });
  doc.text(`${date}  ${time}`, { align: 'center' }).rule('dotted');
  doc.text(`Yazıcı: ${target}`, { font: 'small' });
  doc.text('Türkçe: ÇĞİÖŞÜ çğıöşü ₺ € $ £', { font: 'bold' });
  return doc.space(2).toEscPos();
}

module.exports = { roomBill, testSlip };
