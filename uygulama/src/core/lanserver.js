'use strict';
// Müdür sayfası: otelin yerel ağından tarayıcıyla açılan, sadece görüntüleme yapan rapor sayfası.
// Güvenlik: (1) cihaz eşleştirme (resepsiyon ekranındaki tek seferlik kod), (2) rapor şifresi,
// (3) 5 hatalı denemede 15 dakika kilit, (4) sadece okuma yapan işlemler.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const READ_METHODS = ['viewState', 'report', 'listClosedDays', 'getDayDetail', 'listReports', 'closedAccounts', 'closedAccountDays'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const STATIC = { '/': 'mudur.html', '/mudur.html': 'mudur.html', '/mudur.js': 'mudur.js', '/style.css': 'style.css', '/logo.png': 'logo.png', '/kapanan.js': 'kapanan.js' };
const COOKIE = 'bhk_cihaz';

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

function createLanServer({ svc, staticDir, log = () => {} }) {
  let server = null, port = null;
  const fails = new Map(); // ip → { n, until }

  const locked = ip => { const f = fails.get(ip); return f && f.until > Date.now(); };
  const fail = ip => {
    const f = fails.get(ip) || { n: 0, until: 0 };
    f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
    fails.set(ip, f);
  };
  const cookieOf = req => { const m = (req.headers.cookie || '').match(new RegExp(`${COOKIE}=([a-f0-9]+)`)); return m ? m[1] : null; };
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };

  async function handleApi(req, res, ip, body) {
    let msg; try { msg = JSON.parse(body); } catch (_) { return send(res, 400, { ok: false, error: 'Geçersiz istek.' }); }
    const { method, arg, token } = msg || {};
    if (locked(ip)) return send(res, 429, { ok: false, error: 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.' });
    const paired = svc.lanCheckDevice(cookieOf(req), ip);

    if (method === 'hello') return send(res, 200, { ok: true, data: { paired } });
    if (method === 'pair') {
      const key = svc.lanPair(arg, ip);
      if (!key) { fail(ip); return send(res, 200, { ok: false, error: 'Kod yanlış veya süresi dolmuş. Resepsiyon ekranından yeni kod alın.' }); }
      return send(res, 200, { ok: true, data: { paired: true } }, { 'Set-Cookie': `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000` });
    }
    if (!paired) return send(res, 401, { ok: false, error: 'Bu cihaz eşleştirilmemiş.', unpaired: true });
    if (method === 'verifyPin') {
      const r = svc.verifyPin(arg);
      if (!r.ok) { fail(ip); return send(res, 200, { ok: false, error: 'Şifre yanlış' }); }
      return send(res, 200, { ok: true, data: { token: r.token } });
    }
    if (!READ_METHODS.includes(method)) return send(res, 403, { ok: false, error: 'Bu işlem müdür sayfasında yapılamaz.' });
    if (!svc.tokens.has(token)) return send(res, 401, { ok: false, error: 'Şifre gerekli.', needPin: true });
    try {
      const a = (method === 'report' || method === 'listReports') ? { ...(arg || {}), token } : arg;
      return send(res, 200, { ok: true, data: await svc[method](a) });
    } catch (e) {
      log(e);
      return send(res, 200, { ok: false, error: e.message });
    }
  }

  function handle(req, res) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => { handleApi(req, res, ip, body).catch(e => { log(e); send(res, 500, { ok: false, error: 'Sunucu hatası.' }); }); });
      return;
    }
    // Excel indirme: eşleştirilmiş cihaz + geçerli şifre oturumu
    if (req.method === 'GET' && url.pathname === '/excel') {
      if (!svc.lanCheckDevice(cookieOf(req), ip) || !svc.tokens.has(url.searchParams.get('t'))) { res.writeHead(401); return res.end('Yetkisiz'); }
      const name = path.basename(url.searchParams.get('f') || '');
      const file = svc.reportsDir && path.join(svc.reportsDir, name);
      if (!name.endsWith('.xlsx') || !file || !fs.existsSync(file)) { res.writeHead(404); return res.end('Dosya yok'); }
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    const rel = STATIC[url.pathname];
    if (req.method === 'GET' && rel) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)], 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      return fs.createReadStream(path.join(staticDir, rel)).pipe(res);
    }
    res.writeHead(404); res.end('Bulunamadı');
  }

  return {
    // Ayara göre başlatır/durdurur
    apply(cfg) {
      if (!cfg.enabled) { if (server) { server.close(); server = null; port = null; } return; }
      if (server && port === cfg.port) return;
      if (server) server.close();
      port = cfg.port;
      server = http.createServer(handle);
      server.on('error', e => { log(e); server = null; port = null; });
      server.listen(cfg.port, '0.0.0.0');
    },
    running: () => !!server,
    addresses: () => (server ? lanAddresses(port) : []),
    close() { if (server) server.close(); server = null; },
  };
}

module.exports = { createLanServer, lanAddresses };
