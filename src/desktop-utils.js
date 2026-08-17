'use strict';
// Pure helpers for the desktop shell — no Electron imports, so every function
// here is unit-testable on any machine (see test/desktop-utils.test.mjs).

// ── deep links: dsh://open | dsh://session/<id> ──────────────────────────

function parseDeepLink(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('dsh://')) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = (u.hostname || '').toLowerCase();
  if (host === 'open' || host === '' ) return { action: 'open' };
  if (host === 'session') {
    const id = decodeURIComponent(u.pathname.replace(/^\//, '')).trim();
    return id ? { action: 'session', id } : { action: 'open' };
  }
  return null;
}

// Extract the first dsh:// URL from a command line (argv from
// second-instance) — Electron passes the whole line, protocol included.
function deepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const link = parseDeepLink(a);
    if (link) return link;
  }
  return null;
}

// ── window state persistence ─────────────────────────────────────────────

// Validate saved window bounds against the current display layout: a window
// is usable when a decent part of its title area is on some display's
// workArea (screens get unplugged, resolutions change). Falls back to the
// provided defaults when not.
function clampWindowState(saved, workAreas, defaults) {
  const d = { ...defaults };
  if (!saved || typeof saved !== 'object') return d;
  const x = Number.isFinite(saved.x) ? saved.x : d.x;
  const y = Number.isFinite(saved.y) ? saved.y : d.y;
  const width = Math.min(Math.max(Number.isFinite(saved.width) ? saved.width : d.width, 320), 7680);
  const height = Math.min(Math.max(Number.isFinite(saved.height) ? saved.height : d.height, 240), 4320);
  for (const wa of workAreas || []) {
    const visibleX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const visibleY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    // At least 200x40 px of the title bar region on this display.
    if (visibleX >= 200 && visibleY >= 40) {
      return { x, y, width, height, maximized: !!saved.maximized };
    }
  }
  return d;
}

// ── multi-profile config ─────────────────────────────────────────────────
// config.profiles: [{ name, dshHome, port }]; config.activeProfile: name.
// Migration keeps the pre-profile dshHome/port as the "默认" profile.

function migrateProfiles(config) {
  if (Array.isArray(config.profiles) && config.profiles.length) {
    // sanitize: unique non-empty names, valid ports
    const seen = new Set();
    config.profiles = config.profiles.filter((p) => {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) return false;
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    }).map((p) => ({
      name: p.name,
      dshHome: typeof p.dshHome === 'string' ? p.dshHome : '',
      port: Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : null,
    }));
    if (!config.profiles.some((p) => p.name === config.activeProfile)) {
      config.activeProfile = config.profiles[0] ? config.profiles[0].name : '默认';
    }
    return config;
  }
  config.profiles = [{
    name: '默认',
    dshHome: typeof config.dshHome === 'string' ? config.dshHome : '',
    port: Number.isInteger(config.port) ? config.port : null,
  }];
  config.activeProfile = '默认';
  return config;
}

// Apply a profile onto the live config (port falls back to the current one
// when the profile doesn't pin one).
function applyProfile(config, profile) {
  if (!profile) return config;
  config.activeProfile = profile.name;
  config.dshHome = profile.dshHome || '';
  if (profile.port) config.port = profile.port;
  return config;
}

// ── pinned sessions ──────────────────────────────────────────────────────
// Pin state is DESKTOP-owned (config.json), never dsh state: dsh has no pin
// field, and we deliberately do not touch its sort mode or DOM order. A pin
// is { id, title }; title is a display cache only — the live title is read
// from the session service at render time.

const PINS_MAX = 20;

function togglePin(pins, session) {
  if (!session || typeof session.id !== 'string') return pins || [];
  const list = (pins || []).filter((p) => p && typeof p.id === 'string');
  const existing = list.findIndex((p) => p.id === session.id);
  if (existing >= 0) {
    // un-pin
    list.splice(existing, 1);
    return list;
  }
  // pin: newest first, capped
  list.unshift({ id: session.id, title: typeof session.title === 'string' ? session.title : '' });
  return list.slice(0, PINS_MAX);
}

// Drop pins whose sessions no longer exist (called with the live id set).
function prunePins(pins, liveIds) {
  const live = new Set(liveIds || []);
  return (pins || []).filter((p) => p && live.has(p.id));
}

module.exports = { parseDeepLink, deepLinkFromArgv, clampWindowState, migrateProfiles, applyProfile, togglePin, prunePins, PINS_MAX };
