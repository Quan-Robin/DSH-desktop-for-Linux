'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  checkUpdate: () => ipcRenderer.invoke('settings:check-update'),
  updateDsh: () => ipcRenderer.invoke('settings:update-dsh'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  getBalance: () => ipcRenderer.invoke('settings:get-balance'),
  refreshBalance: () => ipcRenderer.invoke('settings:refresh-balance'),
  calibrateBalance: () => ipcRenderer.invoke('settings:calibrate-balance'),
  setCloseBehavior: (b) => ipcRenderer.invoke('settings:set-close-behavior', b),
  setNotify: (on) => ipcRenderer.invoke('settings:set-notify', on),
  setCurrentSession: (id) => ipcRenderer.invoke('settings:set-current-session', id),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),
  onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
});
