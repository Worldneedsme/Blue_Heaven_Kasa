'use strict';
// Örnek oda adisyonunu PNG olarak kaydeder (kağıda basmadan görmek için).
// Kullanım: node tools/adisyon-onizleme.js <çıktı.png>
const fs = require('fs');
const zlib = require('zlib');
const { roomBill } = require('../src/core/fis/adisyon');

// GS v 0 şeritlerini tek bir 1-bit PNG'ye çevirir
function toPng(buf) {
  const rows = []; let bpr = 0;
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      bpr = buf[i + 4] | (buf[i + 5] << 8); const h = buf[i + 6] | (buf[i + 7] << 8);
      for (let y = 0; y < h; y++) rows.push(Buffer.from(buf.subarray(i + 8 + y * bpr, i + 8 + (y + 1) * bpr)).map(b => ~b & 0xff));
      i += 7 + bpr * h;
    }
  }
  const raw = Buffer.concat(rows.map(r => Buffer.concat([Buffer.from([0]), r])));
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(bpr * 8, 0); ihdr.writeUInt32BE(rows.length, 4); ihdr[8] = 1; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const rates = { EUR: { satis: 55 }, USD: { satis: 47 }, GBP: { satis: 63 } };
const account = {
  id: 42, room: '205', status: 'open',
  items: [
    { kind: 'satis', item_name: 'Klima (A/C)', description: 'Klima (A/C) 3 gece', qty: 3, unit_price: 9, amount: 27, currency: 'EUR' },
    { kind: 'satis', item_name: 'Efes', description: 'Efes ×2', qty: 2, unit_price: 240, amount: 480, currency: 'TL' },
    { kind: 'satis', item_name: 'Kahvaltı', description: 'Kahvaltı ×2', qty: 2, unit_price: 10, amount: 20, currency: 'EUR' },
    { kind: 'avans', description: 'Misafir adına: Eczane ilaç', amount: 300, currency: 'TL' },
    { kind: 'acik', item_name: 'Kasa (Safe)', description: 'Kasa (Safe)', nights: 2, unit_price: 2, amount: 4, currency: 'EUR' },
  ],
};
fs.writeFileSync(process.argv[2] || 'adisyon.png', toPng(roomBill({ account, rates, now: new Date(2026, 9, 17, 14, 10) })));
console.log('tamam');
