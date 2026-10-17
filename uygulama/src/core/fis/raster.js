'use strict';
// Fişi 1-bit resim olarak çizer ve ESC/POS "GS v 0" komutuyla basar.
// Blue Heaven Adisyon (restoran) programından birebir alındı, adisyonlar aynı görünsün diye.
// Yazıcının kendi yazı tipinde Türkçe karakter ve ₺ olmadığı için Şefim de bu yöntemi kullanıyor.
const fs = require('fs');
const path = require('path');

const ATLAS = JSON.parse(fs.readFileSync(path.join(__dirname, "atlas.json"), "utf8"));
for (const font of Object.values(ATLAS)) {
  for (const [ch, g] of Object.entries(font.glyphs)) {
    font.glyphs[ch] = { adv: g[0], ox: g[1], oy: g[2], w: g[3], h: g[4], bits: Buffer.from(g[5], "base64") };
  }
}

const PAPER_WIDTH = 576; // 80mm yazıcı, 203 dpi
const MARGIN = 8;

function glyph(font, ch) {
  return font.glyphs[ch] ?? font.glyphs[ch.normalize("NFD")[0]] ?? font.glyphs["?"];
}

function measure(text, fontName) {
  const font = ATLAS[fontName];
  let w = 0;
  for (const ch of String(text)) w += glyph(font, ch).adv;
  return w;
}

function lineHeight(fontName) {
  const f = ATLAS[fontName];
  return f.ascent + f.descent;
}

/** Metni verilen genişliğe sığacak satırlara böler (kelime kelime; tek kelime sığmazsa harf harf). */
function wrap(text, fontName, width) {
  const lines = [];
  let cur = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next, fontName) <= width) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    cur = "";
    let piece = "";
    for (const ch of word) {
      if (measure(piece + ch, fontName) > width && piece) {
        lines.push(piece);
        piece = "";
      }
      piece += ch;
    }
    cur = piece;
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}

/** Aşağı doğru uzayan 1-bit tuval: her satır kendi yüksekliği kadar yer açar. */
class RasterDoc {
  constructor(width = PAPER_WIDTH) {
    this.width = width;
    this.rows = [];
  }

  get height() {
    return this.rows.length;
  }

  grow(h) {
    const top = this.rows.length;
    for (let i = 0; i < h; i++) this.rows.push(new Uint8Array(this.width));
    return top;
  }

  set(x, y, on) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.rows.length) return;
    this.rows[y][x] = on ? 1 : 0;
  }

  fill(x, y, w, h, on = true) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, on);
  }

  drawText(text, fontName, x, top, on = true) {
    const font = ATLAS[fontName];
    let cx = x;
    for (const ch of String(text)) {
      const g = glyph(font, ch);
      const stride = (g.w + 7) >> 3;
      for (let j = 0; j < g.h; j++) {
        for (let i = 0; i < g.w; i++) {
          if (g.bits[j * stride + (i >> 3)] & (0x80 >> (i & 7))) this.set(cx + g.ox + i, top + g.oy + j, on);
        }
      }
      cx += g.adv;
    }
    return cx;
  }

  // ---------------------------------------------------------- satır türleri

  space(px) {
    this.grow(px);
    return this;
  }

  /** Tek satır metin; sığmazsa alt satırlara kaydırılır. */
  text(text, { font = "normal", align = "left", invert = false, pad = 2, indent = 0 } = {}) {
    const inner = this.width - MARGIN * 2 - indent;
    for (const line of wrap(text, font, inner)) {
      const h = lineHeight(font) + pad * 2;
      const top = this.grow(h);
      if (invert) this.fill(0, top, this.width, h);
      const w = measure(line, font);
      const x = align === "center" ? (this.width - w) >> 1 : align === "right" ? this.width - MARGIN - w : MARGIN + indent;
      this.drawText(line, font, x, top + pad, !invert);
    }
    return this;
  }

  /**
   * Sütunlu satır. cols: [{ text, width (px), align, font }]. Uzun metin kendi sütununda alt satıra kayar.
   * invert: siyah zemin üstüne beyaz yazı (tablo başlığı gibi).
   */
  columns(cols, { font = "normal", invert = false, pad = 3 } = {}) {
    const inner = this.width - MARGIN * 2;
    const fixed = cols.reduce((s, c) => s + (c.width ?? 0), 0);
    const flexCount = cols.filter((c) => c.width === undefined).length || 1;
    const laid = cols.map((c) => {
      const f = c.font ?? font;
      const width = c.width ?? Math.floor((inner - fixed) / flexCount);
      return { ...c, font: f, width, lines: wrap(c.text ?? "", f, width - 6) };
    });
    const lh = Math.max(...laid.map((c) => lineHeight(c.font)));
    const rows = Math.max(...laid.map((c) => c.lines.length));
    const h = rows * lh + pad * 2;
    const top = this.grow(h);
    if (invert) this.fill(0, top, this.width, h);
    let x = MARGIN;
    for (const c of laid) {
      c.lines.forEach((line, i) => {
        const w = measure(line, c.font);
        const lx = c.align === "right" ? x + c.width - w : c.align === "center" ? x + ((c.width - w) >> 1) : x;
        this.drawText(line, c.font, lx, top + pad + i * lh, !invert);
      });
      x += c.width;
    }
    return this;
  }

  /**
   * Solda etiket, sağa yaslı değer. Sığmazsa bir küçük yazı tipine düşer (TOPLAM gibi büyük satırlar için).
   */
  pair(label, value, fonts = ["normal"], pad = 2) {
    const inner = this.width - MARGIN * 2;
    const font = fonts.find((f) => measure(label, f) + measure(value, f) + 20 <= inner) ?? fonts.at(-1);
    const lw = measure(label, font) + 10;
    return this.columns([{ text: label, width: lw }, { text: value, align: "right" }], { font, pad });
  }

  /** "Etiket  : değer" satırı (mutfak fişi başlığı gibi). */
  field(label, value, { font = "normal", labelWidth = 210 } = {}) {
    return this.columns([{ text: label, width: labelWidth }, { text: `: ${value}` }], { font, pad: 1 });
  }

  rule(style = "solid", thickness = 2) {
    const top = this.grow(thickness + 8);
    const y = top + 4;
    for (let x = MARGIN; x < this.width - MARGIN; x++) {
      const on = style === "solid" || (style === "dotted" ? x % 6 < 2 : x % 14 < 9);
      if (on) this.fill(x, y, 1, thickness);
    }
    return this;
  }

  /** Ortalanmış başlıklı ayraç: ----Mutfak Listesi---- */
  titledRule(title, font = "bold") {
    const h = lineHeight(font) + 4;
    const top = this.grow(h);
    const w = measure(title, font);
    const x = (this.width - w) >> 1;
    const y = top + (h >> 1);
    for (let xx = MARGIN; xx < this.width - MARGIN; xx++) {
      if ((xx < x - 10 || xx > x + w + 10) && xx % 14 < 9) this.fill(xx, y, 1, 2);
    }
    this.drawText(title, font, x, top + 2);
    return this;
  }

  /** ESC/POS raster (GS v 0) komutunu tuvale ortalanmış olarak çizer (logo için). */
  rasterImage(cmd) {
    if (!cmd || cmd.length < 8 || cmd[0] !== 0x1d || cmd[1] !== 0x76) return this;
    const bytesPerRow = cmd[4] | (cmd[5] << 8);
    const h = cmd[6] | (cmd[7] << 8);
    const w = bytesPerRow * 8;
    const left = Math.max(0, (this.width - w) >> 1);
    const top = this.grow(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cmd[8 + y * bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) this.set(left + x, top + y, true);
      }
    }
    return this;
  }

  /** Yazıcıya gidecek bayt dizisi: başlat + 255 satırlık şeritler + besle + kes. */
  // feed: kesmeden önce ek boş satır. 0 = yok; "GS V B" kesme komutu kâğıdı zaten kesme noktasına kadar ilerletir.
  toEscPos({ feed = 0, cut = true } = {}) {
    const bytesPerRow = this.width >> 3;
    const chunks = [Buffer.from([0x1b, 0x40])];
    for (let start = 0; start < this.rows.length; start += 255) {
      const h = Math.min(255, this.rows.length - start);
      const band = Buffer.alloc(8 + bytesPerRow * h);
      band.set([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, h & 0xff, h >> 8]);
      for (let y = 0; y < h; y++) {
        const row = this.rows[start + y];
        for (let x = 0; x < this.width; x++) {
          if (row[x]) band[8 + y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      chunks.push(band);
    }
    if (feed > 0) chunks.push(Buffer.from([0x1b, 0x64, feed]));
    if (cut) chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
    return Buffer.concat(chunks);
  }
}

module.exports = { RasterDoc, PAPER_WIDTH, measure, lineHeight, wrap };
