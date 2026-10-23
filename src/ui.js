import path from 'node:path';
import * as vd from './validate.js';
import { MSG } from './errors.js';

export function deriveName(dir) {
  return path.basename(String(dir || '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

export function createUi(cwd = process.cwd()) {
  return { mode: 'list', selected: null, fields: { name: '', dir: '' }, field: 0, error: '', target: null, pending: null, status: '', statusAt: 0, cwd };
}

export function setStatus(ui, text, now = Date.now()) {
  ui.status = text;
  ui.statusAt = now;
}

export function syncSelection(ui, sessions) {
  if (!sessions.length) ui.selected = null;
  else if (!sessions.some((s) => s.name === ui.selected)) ui.selected = sessions[0].name;
}

const indexOf = (ui, sessions) => sessions.findIndex((s) => s.name === ui.selected);

function select(ui, sessions, i) {
  if (!sessions.length) { ui.selected = null; return; }
  ui.selected = sessions[Math.max(0, Math.min(sessions.length - 1, i))].name;
}

function submitNew(ui, sessions) {
  const dir = ui.fields.dir.trim();
  let name = ui.fields.name.trim();
  if (!name) name = deriveName(dir);
  const r = vd.name(name);
  if (!r.ok) { ui.error = r.error; ui.field = 0; return null; }
  if (sessions.some((s) => s.name === name)) { ui.error = MSG.taken(name); ui.field = 0; return null; }
  ui.mode = 'list';
  ui.error = '';
  return { type: 'new', name, dir };
}

function submitRename(ui, sessions) {
  const newName = ui.fields.name.trim();
  const r = vd.name(newName);
  if (!r.ok) { ui.error = r.error; return null; }
  if (newName === ui.target.name) { ui.mode = 'list'; ui.error = ''; return null; }
  if (sessions.some((s) => s.name === newName)) { ui.error = MSG.taken(newName); return null; }
  ui.mode = 'list';
  ui.error = '';
  return { type: 'rename', name: ui.target.name, id: ui.target.id, newName };
}

function keyForm(ui, key, sessions, names) {
  if (key === 'esc' || key === 'ctrl-c') { ui.mode = 'list'; ui.error = ''; return null; }
  if (key === 'tab') { if (names.length > 1) ui.field = (ui.field + 1) % names.length; return null; }
  const f = names[ui.field];
  if (key === 'backspace') { ui.fields[f] = ui.fields[f].slice(0, -1); ui.error = ''; return null; }
  if (key === 'enter') return ui.mode === 'new' ? submitNew(ui, sessions) : submitRename(ui, sessions);
  if ([...key].length === 1 && key >= ' ') {
    if (ui.fields[f].length < 256) ui.fields[f] += key;
    ui.error = '';
  }
  return null;
}

// Returns a command object or null. `sessions` is the sorted list currently shown.
// While a dialog is open, keys never reach the list.
export function handleKey(ui, key, sessions) {
  switch (ui.mode) {
    case 'new':
      return keyForm(ui, key, sessions, ['name', 'dir']);
    case 'rename':
      return keyForm(ui, key, sessions, ['name']);
    case 'kill': {
      const t = ui.target;
      ui.mode = 'list';
      if (key === 'y' && t) return { type: t.state === 'done' ? 'remove' : 'kill', name: t.name, id: t.id };
      setStatus(ui, 'Kept.');
      return null;
    }
    case 'hooks': {
      const p = ui.pending;
      ui.mode = 'list';
      ui.pending = null;
      if (key === 'y' && p) return { ...p, confirm: true };
      return null;
    }
    case 'help':
      ui.mode = 'list';
      return null;
    default:
      break;
  }

  const i = indexOf(ui, sessions);
  const cur = sessions[i] || null;
  if (/^[1-9]$/.test(key)) {
    const s = sessions.find((x) => x.id === Number(key));
    if (s) { ui.selected = s.name; return { type: 'open', name: s.name, id: s.id }; }
    setStatus(ui, `No session number ${key}.`);
    return null;
  }
  switch (key) {
    case 'up': case 'k': select(ui, sessions, Math.max(0, i) - 1); return null;
    case 'down': case 'j': select(ui, sessions, i + 1); return null;
    case 'g': select(ui, sessions, 0); return null;
    case 'G': select(ui, sessions, sessions.length - 1); return null;
    case 'enter': return cur ? { type: 'open', name: cur.name, id: cur.id } : null;
    case 'w': {
      const n = sessions.length;
      for (let k = 1; k <= n; k++) {
        const s = sessions[(i + k + n) % n];
        if (s.state === 'waiting') { ui.selected = s.name; return null; }
      }
      setStatus(ui, 'No sessions are waiting.');
      return null;
    }
    case 'n':
      ui.mode = 'new';
      ui.fields = { name: '', dir: ui.cwd };
      ui.field = 0;
      ui.error = '';
      return null;
    case 'r':
      if (cur) {
        ui.mode = 'rename';
        ui.target = cur;
        ui.fields = { name: cur.name, dir: '' };
        ui.field = 0;
        ui.error = '';
      }
      return null;
    case 'x':
      if (cur) { ui.mode = 'kill'; ui.target = cur; }
      return null;
    case '?':
      ui.mode = 'help';
      return null;
    case 'q': case 'ctrl-c':
      return { type: 'quit' };
    default:
      return null;
  }
}
