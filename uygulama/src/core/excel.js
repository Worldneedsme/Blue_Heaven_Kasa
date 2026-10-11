'use strict';
// Excel raporları: gün sonu raporu ve aylık rapor. A4'e sığacak şekilde yazdırmaya hazır.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const SYM = { TL: 'TL', EUR: '€', USD: '$', GBP: '£' };
const CURS = ['TL', 'EUR', 'USD', 'GBP'];
const TYPE = { satis: 'Satış', doviz: 'Para bozma', gider: 'Gider', patron: 'Cengiz Bey', avans: 'Oda avansı', tahsilat: 'Oda tahsilatı' };
const BLUE = 'FF17699E', LIGHT = 'FFE6F1F8', GREY = 'FF6B7385';
const NUM = '#,##0.##;[Red]-#,##0.##';
const trDate = k => { const [y, m, d] = k.split('-'); return `${d}.${m}.${y}`; };
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const monthName = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };

function sheet(wb, name, landscape) {
  const ws = wb.addWorksheet(name, {
    pageSetup: { paperSize: 9, orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: '&LBlue Heaven Kasa&RSayfa &P / &N' },
  });
  return ws;
}
function title(ws, text, sub, cols) {
  ws.mergeCells(1, 1, 1, cols); ws.getCell(1, 1).value = text;
  ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: BLUE } };
  ws.mergeCells(2, 1, 2, cols); ws.getCell(2, 1).value = sub;
  ws.getCell(2, 1).font = { size: 10, color: { argb: GREY } };
  return 4;
}
// Başlıklı tablo yazar, bir sonraki boş satırı döndürür
function table(ws, row, heading, headers, rows, opts = {}) {
  if (heading) { ws.getCell(row, 1).value = heading; ws.getCell(row, 1).font = { bold: true, size: 12 }; row++; }
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1); c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    c.alignment = { horizontal: i === 0 || opts.textCols && opts.textCols.includes(i) ? 'left' : 'right', vertical: 'middle', wrapText: true };
  });
  row++;
  if (!rows.length) { ws.getCell(row, 1).value = 'Kayıt yok'; ws.getCell(row, 1).font = { italic: true, color: { argb: GREY } }; return row + 2; }
  rows.forEach((r, ri) => {
    r.forEach((v, i) => {
      const c = ws.getCell(row, i + 1); c.value = v;
      if (typeof v === 'number') c.numFmt = NUM;
      c.alignment = { horizontal: typeof v === 'number' ? 'right' : 'left', vertical: 'top', wrapText: true };
      if (ri % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FB' } };
      c.border = { bottom: { style: 'hair', color: { argb: 'FFDFE3EA' } } };
    });
    if (opts.boldLast && ri === rows.length - 1) ws.getRow(row).font = { bold: true };
    row++;
  });
  return row + 1;
}
const r2 = x => Math.round((x || 0) * 100) / 100;
const sortDesc = obj => Object.entries(obj).map(([k, v]) => typeof v === 'number' ? [k, v] : [k, v.q, v.e]).sort((a, b) => (b[b.length - 1]) - (a[a.length - 1]));

// ---- Gün sonu raporu ----
async function dayReport(svc, date, outDir) {
  const d = svc.getDayDetail(date);
  const A = svc.aggregate([date], date);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Blue Heaven Kasa'; wb.created = new Date();

  const ws = sheet(wb, 'Özet');
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 14 }];
  let row = title(ws, `Blue Heaven Apart — Gün sonu raporu`, `${trDate(date)}${d.closed ? '' : ' (gün henüz kapatılmadı)'} · oluşturma: ${new Date().toLocaleString('tr-TR')}`, 7);
  const used = CURS.filter(k => k === 'TL' || k === 'EUR' || d.devir[k] || d.inn[k] || d.out[k] || (d.kapanis && d.kapanis[k]));
  const kap = d.kapanis || d.expected;
  row = table(ws, row, 'Kasa', ['Para birimi', 'Devir', 'Giren', 'Çıkan', 'Olması gereken', 'Sayılan (kapanış)', 'Fark'],
    used.map(k => [SYM[k], d.devir[k], d.inn[k], -d.out[k], d.expected[k], d.kapanis ? kap[k] : '—', d.kapanis ? r2(kap[k] - d.expected[k]) : '—']));
  row = table(ws, row, 'Genel', ['', 'Tutar'], [
    ['Toplam satış (€)', r2(A.sale)], ['Satış sayısı', A.cnt], ['Kartla gelen (TL)', r2(d.card)],
    ['İndirimler (€)', r2(A.disc)], ['Misafir adına ödemeler (TL karşılığı)', r2(A.avans)],
    ['Cengiz Bey getirdi (TL)', A.owner.TL], ['Cengiz Bey getirdi (€)', A.owner.EURIN], ['Cengiz Bey aldı (TL)', A.owner.TLOUT],
    ['Cengiz Bey aldı (€)', A.owner.EUR], ['Cengiz Bey aldı ($)', A.owner.USD], ['Cengiz Bey aldı (£)', A.owner.GBP],
  ].filter(r => r[1] !== 0 || ['Toplam satış (€)', 'Satış sayısı', 'Kartla gelen (TL)'].includes(r[0])));
  row = table(ws, row, 'Satışlar (kategoriye göre)', ['Kategori', '€'], sortDesc(A.cat).map(([k, v]) => [k, r2(v)]));
  row = table(ws, row, 'Ödeme şekli (€ karşılığı)', ['', '€'], [['Nakit €', r2(A.pay.EUR)], ['Nakit TL', r2(A.pay.TL)], ['Kart', r2(A.pay.KART)], ['Oda hesabına', r2(A.pay.ODA)]]);
  row = table(ws, row, 'Giderler', ['Kategori', 'TL karşılığı'], sortDesc(A.gider).map(([k, v]) => [k, r2(v)]));
  row = table(ws, row, 'Para bozma', ['Para birimi', 'Bozulan döviz', 'Ödenen TL', 'Ters bozma döviz', 'Alınan TL', 'İşlem'],
    Object.entries(A.dx).map(([c, x]) => [SYM[c], x.al, x.alTL, x.sa, x.saTL, x.n]));
  const accs = svc.openAccounts();
  table(ws, row, 'Açık oda hesapları (rapor anında)', ['Oda', 'Açılış', 'Kalem', 'Kalan €', 'Kalan TL'],
    accs.map(a => [a.room, trDate(a.opened_day), a.items.filter(i => i.kind !== 'not' && !i.paid_tx_id).length, a.eurEq, a.tlEq]));

  const wt = sheet(wb, 'İşlemler', true);
  wt.columns = [{ width: 8 }, { width: 14 }, { width: 7 }, { width: 70 }, { width: 13 }, { width: 11 }, { width: 9 }, { width: 9 }, { width: 12 }, { width: 8 }];
  let r = title(wt, `İşlemler — ${trDate(date)}`, `${d.tx.length} işlem${d.nVoid ? `, ${d.nVoid} iptal` : ''}`, 10);
  table(wt, r, null, ['Saat', 'Tür', 'Oda', 'Açıklama', 'TL', '€', '$', '£', 'Kart TL', 'Durum'],
    d.tx.map(t => [t.created_at.slice(11, 16), TYPE[t.type] || t.type, t.room || '', t.description, t.tl || null, t.eur || null, t.usd || null, t.gbp || null, t.card_tl || null, t.void ? 'İPTAL' : '']),
    { textCols: [1, 2, 3, 9] });

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `Gün sonu - ${date}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

// ---- Aylık rapor ----
async function monthReport(svc, ym, outDir) {
  const dates = svc.monthDates(ym);
  const A = svc.aggregate(dates, ym);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Blue Heaven Kasa'; wb.created = new Date();

  const wg = sheet(wb, 'Günlük', true);
  wg.columns = [{ width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 11 }, { width: 11 }];
  let row = title(wg, `Blue Heaven Apart — ${monthName(ym)} günlük özet`, `${dates.length} gün · oluşturma: ${new Date().toLocaleString('tr-TR')}`, 12);
  const rows = dates.map(date => {
    const d = svc.getDayDetail(date), g = svc.aggregate([date], date);
    const kap = d.kapanis;
    return [trDate(date), r2(g.sale), r2(d.card), r2(g.giderTL), (g.dx.EUR && g.dx.EUR.al) || 0, g.owner.TL - g.owner.TLOUT, g.owner.EUR - g.owner.EURIN,
      d.devir.TL, kap ? kap.TL : '—', d.devir.EUR, kap ? kap.EUR : '—', kap ? r2(kap.TL - d.expected.TL) : '—'];
  });
  const sum = i => r2(rows.reduce((s, r) => s + (typeof r[i] === 'number' ? r[i] : 0), 0));
  if (rows.length) rows.push(['TOPLAM', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), '', '', '', '', sum(11)]);
  table(wg, row, null, ['Tarih', 'Satış €', 'Kart TL', 'Gider TL', 'Bozulan €', 'Cengiz net TL', 'Cengiz net € (aldı)', 'Devir TL', 'Kapanış TL', 'Devir €', 'Kapanış €', 'Sayım farkı TL'], rows, { boldLast: true });

  const ws = sheet(wb, 'Özet');
  ws.columns = [{ width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 10 }];
  row = title(ws, `Blue Heaven Apart — ${monthName(ym)} özeti`, `${dates.length} gün`, 6);
  row = table(ws, row, 'Genel', ['', 'Tutar'], [['Toplam satış (€)', r2(A.sale)], ['Satış sayısı', A.cnt], ['Kartla gelen (TL)', r2(A.cardTL)], ['Giderler (TL karşılığı)', r2(A.giderTL)],
    ['İndirimler (€)', r2(A.disc)], ['Cengiz Bey getirdi (TL)', A.owner.TL], ['Cengiz Bey getirdi (€)', A.owner.EURIN], ['Cengiz Bey aldı (TL)', A.owner.TLOUT], ['Cengiz Bey aldı (€)', A.owner.EUR],
    ['Cengiz Bey aldı ($)', A.owner.USD], ['Cengiz Bey aldı (£)', A.owner.GBP]]);
  row = table(ws, row, 'Satışlar (kategoriye göre)', ['Kategori', '€'], sortDesc(A.cat).map(([k, v]) => [k, r2(v)]));
  row = table(ws, row, 'Ödeme şekli (€ karşılığı)', ['', '€'], [['Nakit €', r2(A.pay.EUR)], ['Nakit TL', r2(A.pay.TL)], ['Kart', r2(A.pay.KART)], ['Oda hesabına', r2(A.pay.ODA)]]);
  row = table(ws, row, 'Giderler', ['Kategori', 'TL karşılığı'], sortDesc(A.gider).map(([k, v]) => [k, r2(v)]));
  table(ws, row, 'Para bozma', ['Para birimi', 'Bozulan döviz', 'Ödenen TL', 'Ters bozma döviz', 'Alınan TL', 'İşlem'], Object.entries(A.dx).map(([c, x]) => [SYM[c], x.al, x.alTL, x.sa, x.saTL, x.n]));

  const wp = sheet(wb, 'Ürünler');
  wp.columns = [{ width: 40 }, { width: 12 }, { width: 14 }];
  row = title(wp, `${monthName(ym)} — ürün satışları`, '', 3);
  table(wp, row, null, ['Ürün', 'Adet', '€'], sortDesc(A.prod).map(([k, q, e]) => [k, q, r2(e)]));

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `Aylık - ${ym}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

module.exports = { dayReport, monthReport };
