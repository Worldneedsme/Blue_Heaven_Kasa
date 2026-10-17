'use strict';
// Fişi yazıcıya gönderir. Blue Heaven Adisyon (restoran) programındaki yöntemin aynısı:
//  - hedef IP ise (192.168.1.100 ya da 192.168.1.100:9100) ağ üzerinden TCP 9100
//  - değilse Windows yazıcı adı (USB yazıcılar dahil): RAW olarak yazıcı kuyruğuna
//  - Mac/Linux'ta (geliştirme) fiş dosyaya yazılır

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const IP_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/;

// Ağ yazıcısına kağıt sensörünü sorar (DLE EOT 4). Cevap gelmezse null döner, basıma engel olmaz.
function paperStatus(socket) {
  return new Promise(resolve => {
    const onData = buf => { clearTimeout(timer); socket.removeListener('data', onData); resolve(buf[0]); };
    const timer = setTimeout(() => { socket.removeListener('data', onData); resolve(null); }, 800);
    socket.on('data', onData);
    socket.write(Buffer.from([0x10, 0x04, 0x04]));
  });
}

function sendTcp(host, port, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(5000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error(`Yazıcı cevap vermiyor (${host})`)); });
    socket.on('error', e => reject(new Error(`Yazıcıya bağlanılamadı (${host}): ${e.code || e.message}`)));
    socket.on('connect', async () => {
      const status = await paperStatus(socket);
      const valid = status !== null && (status & 0x93) === 0x12;
      if (valid && (status & 0x60) === 0x60) { socket.destroy(); reject(new Error('Yazıcıda kağıt bitti')); return; }
      socket.end(data, resolve);
    });
  });
}

// PowerShell betiği paketin (asar) içinden çalıştırılamaz; her basımda geçici klasöre yazılır.
const RAWPRINT_PS1 = fs.readFileSync(path.join(__dirname, 'rawprint.ps1'), 'utf8');

function runPs(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { timeout, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });
}

async function sendWindows(printerName, data) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const script = path.join(os.tmpdir(), 'bhk-rawprint.ps1');
  const tmp = path.join(os.tmpdir(), `bhk-fis-${id}.bin`);
  fs.writeFileSync(script, RAWPRINT_PS1);
  fs.writeFileSync(tmp, data);
  try { await runPs(['-File', script, '-Printer', printerName, '-Path', tmp]); }
  catch (e) { throw new Error(`Windows yazıcı hatası (${printerName}): ${e.message}`); }
  finally { fs.rm(tmp, { force: true }, () => {}); }
}

async function send(target, data, { outDir } = {}) {
  const t = String(target || '').trim();
  if (!t) throw new Error('Yazıcı seçilmemiş. Ayarlar → Adisyon yazıcısı bölümünden seçin.');
  const ip = t.match(IP_RE);
  if (ip) return sendTcp(ip[1], Number(ip[2] || 9100), data);
  if (process.platform === 'win32') return sendWindows(t, data);
  // Geliştirme ortamı: dosyaya yaz
  const dir = outDir || path.join(os.tmpdir(), 'bhk-print-out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.bin`);
  fs.writeFileSync(file, data);
  return file;
}

// Windows'ta kurulu yazıcıların adları (Ayarlar'daki seçim listesi için)
async function listPrinters() {
  if (process.platform !== 'win32') return [];
  try {
    const out = await runPs(['-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select-Object -ExpandProperty Name'], 15000);
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = { send, listPrinters, IP_RE };
