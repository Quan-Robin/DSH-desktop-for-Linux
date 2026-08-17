'use strict';
// Bridge between the dsh Web UI page and the desktop shell.
//
// The injected session-menu script runs in the PAGE world (via
// executeJavaScript); this preload runs in the isolated world. CustomEvent
// .detail does not reliably cross isolated worlds, so all payloads go through
// a hidden DOM "mailbox" node as JSON strings (DOM strings are world-agnostic)
// and only payload-less Events signal availability:
//
//   page → main : mailbox.textContent = JSON; dispatch 'dsh-desktop-to-main'
//   main → page : ipc 'pins-changed'/'jump' → mailbox.textContent = JSON;
//                 dispatch 'dsh-desktop-to-page'

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_ID = '__dsh_desktop_bridge__';
const PAYLOAD_ATTR = 'data-payload';

function mailbox() {
  let node = document.getElementById(BRIDGE_ID);
  if (!node) {
    node = document.createElement('div');
    node.id = BRIDGE_ID;
    node.style.display = 'none';
    document.documentElement.appendChild(node);
  }
  return node;
}

function sendToPage(kind, payload) {
  const box = mailbox();
  box.dataset.kind = kind;
  box.dataset.payload = JSON.stringify(payload);
  window.dispatchEvent(new Event('dsh-desktop-to-page'));
}

// page → main (the injected script sets kind/payload then dispatches)
window.addEventListener('dsh-desktop-to-main', () => {
  const box = document.getElementById(BRIDGE_ID);
  if (!box || !box.dataset.kind) return;
  let payload = null;
  try { payload = JSON.parse(box.dataset.payload || 'null'); } catch { /* ignore */ }
  ipcRenderer.send(box.dataset.kind, payload);
});

ipcRenderer.on('pins-changed', (_e, pins) => sendToPage('pins', pins));
ipcRenderer.on('jump', (_e, sessionId) => sendToPage('jump', sessionId));
ipcRenderer.on('insert', (_e, payload) => sendToPage('insert-composer', payload));

// Create the mailbox eagerly: the injected script greets the shell at load
// time ('pins:hello') — before any main→page event would have created it.
if (document.documentElement) mailbox();
else document.addEventListener('DOMContentLoaded', () => mailbox());

contextBridge.exposeInMainWorld('dshDesktopBridge', {
  // For debugging from devtools: fetch current pins.
  pins: () => ipcRenderer.invoke('pins:get'),
});
