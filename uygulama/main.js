'use strict';
// Electron ana süreci: pencereyi açar, veritabanını yükler, arayüz çağrılarını servise iletir.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./src/core/db');
const { Service } = require('./src/core/service');
const { createBackup } = require('./src/core/backup');
const { makeRouter } = require('./src/core/router');

let win = null;

// Otomatik kontrol modu (KASA_SMOKE=1): geçici klasörde, pencere göstermeden açılır, arayüzün yüklendiğini doğrular ve kapanır.
const SMOKE = !!process.env.KASA_SMOKE;
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'bhkasa-smoke-')));

// Program iki kez açılırsa iki pencere aynı dosyaya yazmasın: ikinci açılış ilk pencereyi öne getirir.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const dataDir = path.join(app.getPath('userData'), 'veri');
    const dbFile = path.join(dataDir, 'kasa.db');
    const logFile = path.join(dataDir, 'hata-kaydi.txt');
    const log = e => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${e && e.stack || e}\n`); } catch (_) { /* yoksay */ } };

    let svc;
    try {
      const store = await new Store(dbFile).open();
      const backup = createBackup({ dbFile, primaryDir: path.join(dataDir, 'yedekler'), documentsDir: app.getPath('documents') });
      svc = new Service(store, backup, { version: app.getVersion() });
      try { svc.makeBackup('acilis'); } catch (e) { log(e); }
    } catch (e) {
      log(e);
      dialog.showErrorBox('Blue Heaven Kasa açılamadı', `Veritabanı yüklenemedi:\n${e.message}\n\nVeri klasörü: ${dataDir}`);
      app.quit();
      return;
    }

    const call = makeRouter(svc, log);
    ipcMain.handle('api', (_e, method, arg) => call(method, arg));
    ipcMain.handle('pickDir', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'İkinci yedek klasörünü seçin', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });

    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 1000, minHeight: 640,
      title: 'Blue Heaven Kasa', backgroundColor: '#f4f6f9', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (SMOKE) {
      win.webContents.once('did-finish-load', async () => {
        await new Promise(r => setTimeout(r, 1000));
        const res = await win.webContents.executeJavaScript(`({ setup: !document.getElementById('setup').classList.contains('hidden'), title: document.title, hasApi: !!window.kasa })`);
        console.log('SMOKE', JSON.stringify(res), 'userData=' + app.getPath('userData'));
        app.exit(res.setup && res.hasApi ? 0 : 1);
      });
    } else {
      win.once('ready-to-show', () => { win.maximize(); win.show(); });
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

    if (app.isPackaged && !SMOKE) setupUpdates(log);
    else {
      ipcMain.handle('updateStatus', () => ({ state: 'dev', version: app.getVersion() }));
      ipcMain.handle('checkUpdate', () => ({ state: 'dev', version: app.getVersion() }));
    }
  });

  app.on('window-all-closed', () => app.quit());
}

// Otomatik güncelleme (GitHub Releases). İnternet yoksa sessizce atlanır; program normal çalışır.
// Yeni sürüm arka planda iner; ekranda "yeniden başlat" düğmesi çıkar, basılmazsa program kapanırken kurulur.
// Veriler (%APPDATA%\Blue Heaven Kasa\veri) güncellemeden etkilenmez.
function setupUpdates(log) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info() {}, warn() {}, debug() {}, error: e => log('güncelleme: ' + (e && e.message || e)) };

  // Ayarlar ekranında gösterilen durum
  let status = { state: 'idle', version: app.getVersion() };
  const set = s => { status = { ...status, ...s, at: new Date().toISOString() }; };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('update-available', info => set({ state: 'downloading', next: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', info => {
    set({ state: 'ready', next: info.version });
    if (win) win.webContents.send('update-ready', info.version);
  });
  autoUpdater.on('error', e => { set({ state: 'error', error: 'İnternete ulaşılamadı veya güncelleme sunucusuna bağlanılamadı.' }); log('güncelleme: ' + (e && e.message || e)); });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* çevrimdışı: durum 'error' olarak işaretlenir */ });
  ipcMain.handle('installUpdate', () => autoUpdater.quitAndInstall(false, true));
  ipcMain.handle('updateStatus', () => status);
  ipcMain.handle('checkUpdate', async () => {
    if (status.state === 'downloading' || status.state === 'ready') return status;
    await check();
    return status;
  });
  setTimeout(check, 10 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
}
