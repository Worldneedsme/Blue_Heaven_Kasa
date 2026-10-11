'use strict';
// Geliştirme sunucusu: arayüzü tarayıcıda, Electron olmadan aynı çekirdekle çalıştırır.
// Veriler uygulama/veri-dev klasörüne yazılır (gerçek kasa verisiyle karışmaz).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/db');
const { Service } = require('../src/core/service');
const { createBackup } = require('../src/core/backup');
const { makeRouter } = require('../src/core/router');

const PORT = Number(process.env.PORT || 8766);
const root = path.join(__dirname, '..', 'src', 'renderer');
const dataDir = path.join(__dirname, '..', 'veri-dev');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

(async () => {
  const dbFile = path.join(dataDir, 'kasa.db');
  const store = await new Store(dbFile).open();
  const svc = new Service(store, createBackup({ dbFile, primaryDir: path.join(dataDir, 'yedekler'), documentsDir: path.join(dataDir, 'Belgeler') }), { version: require('../package.json').version + '-dev' });
  const call = makeRouter(svc);

  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let out;
        try { const { method, arg } = JSON.parse(body); out = call(method, arg); } catch (e) { out = { ok: false, error: e.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end('yok'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT, () => console.log(`Geliştirme sunucusu: http://localhost:${PORT}`));
})();
