'use strict';

// Self-implemented StatusNotifierItem tray (Linux/Wayland).
//
// Why: Electron's built-in Tray on Wayland exports a fake IconName
// ("status_icon_0"), its IconPixmap property fails to read, and it lacks a
// working dbusmenu — desktop shells (GNOME + appindicator extension) then
// render a placeholder and clicks do nothing. Here we own the whole tray:
// a real SNI service (ARGB32 pixel data) plus a com.canonical.dbusmenu
// service, which the shell shows on left/right click.
//
// Callers keep the returned handle alive.

const dbus = require('dbus-next');
const { nativeImage } = require('electron');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bgriToArgb(bgra, w, h) {
  // nativeImage.toBitmap() yields BGRA; SNI expects big-endian ARGB32.
  const argb = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    argb[i * 4 + 0] = bgra[i * 4 + 2]; // R
    argb[i * 4 + 1] = bgra[i * 4 + 1]; // G
    argb[i * 4 + 2] = bgra[i * 4 + 0]; // B
    argb[i * 4 + 3] = bgra[i * 4 + 3]; // A
  }
  return argb;
}

function buildIconPixmap(iconPath) {
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) return [];
  const { width, height } = img.getSize();
  const argb = bgriToArgb(img.toBitmap(), width, height);
  return [[width, height, argb]];
}

// ---------- com.canonical.dbusmenu (the tray menu) ----------

class Dbmenu extends dbus.interface.Interface {
  constructor(items) {
    super('com.canonical.dbusmenu');
    // items: [{label, action} | {separator: true}]
    this._items = items;
    this._ids = new Map(); // id -> item
    let id = 1;
    for (const item of items) {
      if (item.separator) {
        this._ids.set(id, { separator: true });
      } else {
        this._ids.set(id, item);
      }
      item._id = id++;
    }
  }

  get Version() { return 3; }
  get Status() { return 'normal'; }
  get TextDirection() { return 'ltr'; }

  propsFor(item) {
    if (item.separator) {
      return { type: new dbus.Variant('s', 'separator'), visible: new dbus.Variant('b', true) };
    }
    return {
      label: new dbus.Variant('s', item.label),
      enabled: new dbus.Variant('b', true),
      visible: new dbus.Variant('b', true),
      type: new dbus.Variant('s', 'normal'),
    };
  }

  GetLayout() {
    // children is av: every child must be a Variant wrapping (ia{sv}av).
    const children = this._items.map((item) =>
      new dbus.Variant('(ia{sv}av)', [item._id, this.propsFor(item), []]));
    const root = [0, {
      type: new dbus.Variant('s', 'root'),
      'children-display': new dbus.Variant('s', 'submenu'),
    }, children];
    // Match the shell extension's contract: u revision + single (ia{sv}av) root.
    return [1, root];
  }

  GetGroupProperties(ids) {
    // Single return value: return the bare array (sendReply wraps it).
    return ids.map((id) => {
      const item = this._ids.get(id);
      return item ? [id, this.propsFor(item)] : [id, {}];
    });
  }

  Event(id, eventId) {
    if (eventId !== 'clicked') return;
    const item = this._ids.get(id);
    if (item && item.action) item.action();
  }

  AboutToShow() {
    // Single return value: return the bare boolean.
    return false;
  }
}

Dbmenu.configureMembers({
  properties: {
    Version: { signature: 'u' },
    Status: { signature: 's' },
    TextDirection: { signature: 's' },
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    Event: { inSignature: 'isvu', outSignature: '' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
  },
});

// ---------- org.kde.StatusNotifierItem ----------

class SniItem extends dbus.interface.Interface {
  constructor({ iconPath, title, onActivate, onSecondaryActivate }) {
    super('org.kde.StatusNotifierItem');
    this._pixmap = buildIconPixmap(iconPath);
    this._title = title;
    this._onActivate = onActivate;
    this._onSecondaryActivate = onSecondaryActivate;
  }

  // --- properties (read via iface[name] by dbus-next) ---
  get Category() { return 'ApplicationStatus'; }
  get Id() { return 'deepseek-harness-desktop'; }
  get Title() { return this._title; }
  get Status() { return 'Active'; }
  get IconName() { return ''; }
  get IconPixmap() { return this._pixmap; }
  get AttentionIconName() { return ''; }
  get AttentionIconPixmap() { return []; }
  get ItemIsMenu() { return false; }
  // The shell shows this menu on left/right click (see Dbmenu above).
  get Menu() { return '/MenuBar'; }
  get ToolTip() { return ['', [], this._title, 'DeepSeek Harness 桌面端']; }

  // --- methods ---
  Activate() { this._onActivate && this._onActivate(); }
  SecondaryActivate() { this._onSecondaryActivate && this._onSecondaryActivate(); }
  ContextMenu() { /* menu is served via dbusmenu (Menu property) */ }
  Scroll() { /* scroll wheel: not handled */ }
}

SniItem.configureMembers({
  properties: {
    Category: { signature: 's' },
    Id: { signature: 's' },
    Title: { signature: 's' },
    Status: { signature: 's' },
    IconName: { signature: 's' },
    IconPixmap: { signature: 'a(iiay)' },
    AttentionIconName: { signature: 's' },
    AttentionIconPixmap: { signature: 'a(iiay)' },
    ItemIsMenu: { signature: 'b' },
    Menu: { signature: 'o' },
    ToolTip: { signature: '(sa(iiay)ss)' },
  },
  methods: {
    Activate: { inSignature: 'ii', outSignature: '' },
    SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    ContextMenu: { inSignature: 'ii', outSignature: '' },
    Scroll: { inSignature: 'is', outSignature: '' },
  },
});

// ---------- setup ----------

async function createSniTray({ iconPath, title, menuItems, onActivate, onSecondaryActivate }) {
  const bus = dbus.sessionBus();
  const iface = new SniItem({ iconPath, title, onActivate, onSecondaryActivate });
  const menu = new Dbmenu(menuItems);

  const serviceName = `org.kde.StatusNotifierItem-${process.pid}-1`;
  await bus.requestName(serviceName);
  bus.export('/StatusNotifierItem', iface);
  bus.export('/MenuBar', menu);

  // Register with the desktop's StatusNotifierWatcher so the shell shows us.
  // The spec wants our unique bus name (GNOME's watcher tracks by unique name).
  // The shell probes the item right after registration; if it registers before
  // our service is fully settled it silently drops us and never retries, so
  // re-register until we actually appear in the watcher's list.
  const register = new dbus.Message({
    destination: 'org.kde.StatusNotifierWatcher',
    path: '/StatusNotifierWatcher',
    interface: 'org.kde.StatusNotifierWatcher',
    member: 'RegisterStatusNotifierItem',
    signature: 's',
    body: [bus.name],
  });
  const listItems = async () => {
    const get = new dbus.Message({
      destination: 'org.kde.StatusNotifierWatcher',
      path: '/StatusNotifierWatcher',
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: ['org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'],
    });
    const reply = await bus.call(get);
    return reply.body && reply.body[0] && reply.body[0].value ? reply.body[0].value : [];
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    await bus.call(register);
    await sleep(1500); // give the shell time to probe and record us
    try {
      // The watcher records items as "<unique-name>@<path>".
      if ((await listItems()).some((item) => item.startsWith(bus.name + '@'))) {
        return {
          serviceName,
          pixmap: iface._pixmap,
          destroy: () => {
            try { bus.unexport('/StatusNotifierItem', iface); } catch { /* ignore */ }
            try { bus.unexport('/MenuBar', menu); } catch { /* ignore */ }
            try { bus.disconnect(); } catch { /* ignore */ }
          },
        };
      }
    } catch { /* keep trying */ }
  }
  throw new Error('StatusNotifierWatcher did not record the item after 4 attempts');
}

module.exports = { createSniTray };
