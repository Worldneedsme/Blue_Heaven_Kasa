'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kasa', {
  call: (method, arg) => ipcRenderer.invoke('api', method, arg),
  pickDir: () => ipcRenderer.invoke('pickDir'),
  onUpdateReady: cb => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  updateStatus: () => ipcRenderer.invoke('updateStatus'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
});
