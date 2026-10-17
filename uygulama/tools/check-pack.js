'use strict';
// Paket kontrolü: Windows paketindeki app.asar'ı açar ve paketin içindeki çekirdekle gerçek bir deneme yapar:
// veritabanı açılır, kurulum + satış + adisyon + gün sonu yapılır, Excel raporu üretilir; güncelleme modülleri de aranır.
// Eksik modül veya hata varsa yayın durdurulur.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const asar = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) { console.error('Paket bulunamadı:', asar); process.exit(1); }
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bhk-pack-'));
execFileSync(process.execPath, [require.resolve('@electron/asar/bin/asar.js'), 'extract', asar, out]);
const code = `
  const path = require('path'), fs = require('fs'), root = ${JSON.stringify(out)};
  for (const m of ['builder-util-runtime', 'fs-extra', 'js-yaml', 'semver', 'lazy-val', 'lodash.isequal']) require.resolve(m, { paths: [path.join(root, 'node_modules/electron-updater')] });
  const { Store } = require(path.join(root, 'src/core/db'));
  const { Service } = require(path.join(root, 'src/core/service'));
  const { createBackup } = require(path.join(root, 'src/core/backup'));
  require(path.join(root, 'src/core/lanserver'));
  (async () => {
    const dir = path.join(root, '_deneme'), dbFile = path.join(dir, 'kasa.db');
    const svc = new Service(await new Store(dbFile).open(), createBackup({ dbFile, primaryDir: path.join(dir, 'y') }), { reportsDir: path.join(dir, 'R'), log: e => { throw e; } });
    svc.setup({ devir: { TL: 1000, EUR: 10 }, pin: '4321' });
    const p = svc.getState().products.find(x => x.name === 'Damacana');
    svc.addSale({ lines: [{ productId: p.id }], payment: { method: 'EUR' } });
    // Adisyon: yazı tipi (atlas.json) ve yazdırma betiği pakette olmalı; fiş dosyaya yazdırılır
    svc.addSale({ room: '205', lines: [{ productId: p.id, qty: 2 }], payment: { method: 'ODA' }, account: { mode: 'new' } });
    if (!fs.existsSync(path.join(root, 'src/core/fis/rawprint.ps1'))) throw new Error('rawprint.ps1 pakette yok');
    svc.setSetting('printer', 'KASA'); await svc.printAccount({ accountId: svc.getState().accounts[0].id });
    if (!fs.readdirSync(path.join(dir, 'BlueHeavenKasa-Fisler')).length) throw new Error('Adisyon üretilemedi');
    const d = svc.getState().day.date; svc.closeDay({ counts: svc.getState().balances });
    await svc.autoExport(d);
    const files = fs.readdirSync(path.join(dir, 'R'));
    if (files.length < 2) throw new Error('Excel dosyaları oluşmadı: ' + files.join(', '));
    console.log('Paket kontrolü: tamam (adisyon, ' + files.join(', ') + ')');
  })().catch(e => { console.error(e); process.exit(1); });
`;
try {
  execFileSync(process.execPath, ['-e', code], { stdio: 'inherit', cwd: os.tmpdir() });
} catch (_) {
  console.error('\n✗ Paket kontrolü BAŞARISIZ: pakette eksik modül veya hata var, yayın durduruldu.');
  process.exitCode = 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
