'use strict';
// Otomatik yedek: veritabanı dosyasının kopyası birkaç yere yazılır, her yerde son 30 yedek tutulur.
//  1) Program klasörü içinde "yedekler"
//  2) Belgeler\BlueHeavenKasa-Yedek
//  3) Ayarlardan seçilen ikinci klasör (varsa)
//  4) Takılı bir USB bellekte kök dizinde "KasaYedek" klasörü varsa oraya da

const fs = require('fs');
const path = require('path');

const KEEP = 30;
const PREFIX = 'kasa-';
const pad = n => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function usbDirs() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 68; c <= 90; c++) { // D: … Z:
    const dir = String.fromCharCode(c) + ':\\KasaYedek';
    try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch (_) { /* sürücü yok */ }
  }
  return out;
}

function createBackup({ dbFile, primaryDir, documentsDir }) {
  const docDir = documentsDir ? path.join(documentsDir, 'BlueHeavenKasa-Yedek') : null;

  const dirs = extra => {
    const list = [primaryDir];
    if (docDir) list.push(docDir);
    if (extra) list.push(extra);
    return [...new Set(list.concat(usbDirs()))];
  };

  const prune = dir => {
    const files = fs.readdirSync(dir).filter(f => f.startsWith(PREFIX) && f.endsWith('.db')).sort().reverse();
    for (const f of files.slice(KEEP)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* yoksay */ } }
  };

  return {
    dirs,
    make(reason, extra) {
      const name = `${PREFIX}${stamp()}-${reason}.db`;
      const ok = [], failed = [];
      for (const dir of dirs(extra)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.copyFileSync(dbFile, path.join(dir, name));
          prune(dir);
          ok.push(dir);
        } catch (e) { failed.push({ dir, error: e.message }); }
      }
      return { name, at: new Date().toISOString(), ok, failed };
    },
    list() {
      try {
        return fs.readdirSync(primaryDir).filter(f => f.startsWith(PREFIX) && f.endsWith('.db')).sort().reverse()
          .map(f => ({ name: f, size: fs.statSync(path.join(primaryDir, f)).size }));
      } catch (_) { return []; }
    },
    read(name) {
      if (!/^kasa-[\w.-]+\.db$/.test(name)) throw new Error('Geçersiz yedek adı.');
      return fs.readFileSync(path.join(primaryDir, name));
    },
  };
}

module.exports = { createBackup };
