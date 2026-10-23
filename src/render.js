import { sanitize } from './sanitize.js';
import { MSG } from './errors.js';

export const STATES = ['waiting', 'running', 'idle', 'done', 'unknown'];
const ORDER = { waiting: 0, running: 1, idle: 2, done: 3, unknown: 4 };
const LABEL = { waiting: 'WAITING', running: 'RUNNING', idle: 'IDLE', done: 'DONE', unknown: 'UNKNOWN' };
const ICONS = {
  unicode: { waiting: '●', running: '◐', idle: '○', done: '✓', unknown: '?' },
  ascii: { waiting: '!', running: '*', idle: '-', done: 'x', unknown: '?' },
};

// Waiting first (oldest wait first), then running, idle, done. The id column is never renumbered.
export function sortSessions(list) {
  return [...list].sort((a, b) => {
    const d = (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9);
    if (d) return d;
    if (a.state === 'waiting') {
      const s = a.since - b.since;
      if (s) return s;
    }
    return a.id - b.id;
  });
}

export function counts(list) {
  const c = { waiting: 0, running: 0, idle: 0, done: 0, unknown: 0 };
  for (const s of list) if (Object.hasOwn(c, s.state)) c[s.state] += 1;
  return c;
}

export function fmtSince(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function shortenDir(dir, home) {
  if (home && dir === home) return '~';
  if (home && dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return dir;
}

export function truncMiddle(s, n, ell = '…') {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  if (n === 1) return ell;
  const keep = n - 1;
  const left = Math.ceil(keep / 2);
  const right = keep - left;
  return s.slice(0, left) + ell + s.slice(s.length - right);
}

export function useAscii(env = process.env) {
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return !/utf-?8/i.test(loc);
}

const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const fill = (s, n, ch) => (s.length >= n ? s.slice(0, n) : s + ch.repeat(n - s.length));

function styler(noColor) {
  const wrap = (codes, s) => `\x1b[${codes}m${s}\x1b[0m`;
  return {
    bold: (s) => wrap('1', s),
    dim: (s) => wrap('2', s),
    red: (s) => (noColor ? s : wrap('31', s)),
    row(state, selected, text) {
      const c = [];
      if (selected) c.push('7');
      if (state === 'waiting') { c.push('1'); if (!noColor) c.push('33'); }
      else if (state === 'running') { if (!noColor) c.push('32'); }
      else c.push('2');
      return c.length ? wrap(c.join(';'), text) : text;
    },
  };
}

function boxLines(d, cols, ascii) {
  const asc = (s) => (ascii ? s.replace(/…/g, '...').replace(/×/g, 'x').replace(/·/g, '|').replace(/→/g, '->') : s);
  const w = Math.min(56, cols - 4);
  const inner = w - 4;
  const [tl, tr, bl, br, h, v] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['┌', '┐', '└', '┘', '─', '│'];
  const margin = ' '.repeat(Math.max(0, Math.floor((cols - w) / 2)));
  const out = [];
  out.push(margin + tl + fill(`${h} ${asc(sanitize(d.title))} `, w - 2, h) + tr);
  for (const line of d.lines) out.push(`${margin}${v} ${pad(asc(sanitize(line)), inner)} ${v}`);
  out.push(margin + bl + h.repeat(w - 2) + br);
  return out;
}

export function dialogFor(ui) {
  const cur = '_';
  switch (ui.mode) {
    case 'new':
      return {
        title: 'New Claude Code session',
        lines: [
          `Name       [${ui.fields.name}${ui.field === 0 ? cur : ''}]`,
          `Directory  [${ui.fields.dir}${ui.field === 1 ? cur : ''}]`,
          ui.error ? `! ${ui.error}` : '',
          'Enter launch · Tab next field · Esc cancel',
        ],
      };
    case 'rename':
      return {
        title: 'Rename session',
        lines: [`New name  [${ui.fields.name}${cur}]`, ui.error ? `! ${ui.error}` : '', 'Enter rename · Esc cancel'],
      };
    case 'kill':
      if (ui.target && ui.target.state === 'done') {
        return { title: 'Remove session?', lines: [`Remove "${ui.target.name}" from the list?`, '', 'y remove · n or Esc keep'] };
      }
      return {
        title: 'Kill session?',
        lines: [
          `Kill "${ui.target ? ui.target.name : ''}"? This stops Claude immediately;`,
          'files it was editing may be partly changed.',
          '',
          'y kill · n or Esc keep',
        ],
      };
    case 'hooks':
      return {
        title: 'Project hooks',
        lines: ['This folder has project hooks that will run', 'with your permissions.', '', 'y continue · n or Esc cancel'],
      };
    case 'help':
      return {
        title: 'Help',
        lines: [
          'Up/Down j/k move · g/G first/last',
          'Enter open · 1-9 open by number',
          'w next waiting · n new · r rename',
          'x kill (needs y) · q quit',
          'In a session: <prefix> Tab returns here',
          'States: waiting, running, idle, done',
          'States are inferred from Claude hooks.',
          'Sessions keep running after you quit.',
        ],
      };
    default:
      return null;
  }
}

export function lines(model, opts) {
  const { cols, rows, ascii = false, noColor = false, home = '', now = Date.now() } = opts;
  if (cols < 60 || rows < 15) return ['Terminal too small. Need at least 60×15.'];
  const asc = (s) => (ascii ? s.replace(/…/g, '...').replace(/×/g, 'x').replace(/·/g, '|').replace(/→/g, '->') : s);
  const dot = ascii ? '|' : '·';
  const ruleCh = ascii ? '-' : '─';
  const ell = ascii ? '~' : '…';
  const icons = ascii ? ICONS.ascii : ICONS.unicode;
  const st = styler(noColor);
  const sess = model.sessions || [];
  const c = counts(sess);
  const summary = ['waiting', 'running', 'idle', 'done'].filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`).join(` ${dot} `);
  const left = ` AI tmux${model.stale ? '  [stale]' : ''}`;
  const right = summary ? `${summary} ` : '';
  const out = [];
  out.push(st.bold(pad(left, cols - right.length) + right));
  out.push(ruleCh.repeat(cols));

  const showSince = cols >= 80;
  const nameW = 16;
  const stateW = 10;
  const sinceW = showSince ? 7 : 0;
  const dirW = Math.max(8, cols - (2 + 3 + 1 + stateW + 1 + nameW + 1 + sinceW));
  out.push(st.dim(pad(`  ${'#'.padStart(3)} ${pad('STATE', stateW)} ${pad('NAME', nameW)} ${pad('PROJECT', dirW)}${showSince ? pad(' SINCE', sinceW) : ''}`, cols)));

  const tableRows = rows - 6;
  const idx = sess.findIndex((s) => s.name === model.selected);
  const top = idx >= tableRows ? idx - tableRows + 1 : 0;
  const vis = sess.slice(top, top + tableRows);
  const below = sess.length - (top + vis.length);
  const centre = (s) => (' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s).slice(0, cols);
  const body = [];
  if (!sess.length) {
    if (model.loading) body.push('', centre('Looking for sessions…'));
    else body.push('', centre('No sessions yet.'), centre('Press n to launch one, or run: ait new <name> <dir>'));
  }
  for (const s of vis) {
    const sel = s.name === model.selected;
    const state = Object.hasOwn(LABEL, s.state) ? s.state : 'unknown';
    const label = pad(`${icons[state]} ${LABEL[state]}`, stateW);
    const name = pad(truncMiddle(sanitize(s.name), nameW, ell), nameW);
    let ex = '';
    if (state === 'done' && s.exit && Number.isInteger(s.exit.code)) {
      if (s.exit.code === -1) ex = ' (gone)';
      else if (s.exit.code > 0) ex = ` (exit ${s.exit.code})`;
    }
    const proj = truncMiddle(shortenDir(sanitize(s.dir), home), Math.max(1, dirW - ex.length), ell) + ex;
    const since = showSince ? pad(` ${fmtSince(s.since, now)}`, sinceW) : '';
    const marker = sel ? (ascii ? '>' : '▶') : ' ';
    const text = `${marker} ${String(s.id).padStart(3).slice(-3)} ${label} ${name} ${pad(proj, dirW)}${since}`;
    body.push(st.row(state, sel, text));
  }
  while (body.length < tableRows) body.push('');
  for (const b of body.slice(0, tableRows)) out.push(b);

  const more = below > 0 ? ` ${ascii ? 'v' : '↓'} ${below} more` : '';
  out.push(ruleCh.repeat(Math.max(0, cols - more.length)) + more);

  const statusText = asc(sanitize(model.banner || model.status || (model.degraded ? MSG.fallback : ''))).slice(0, cols);
  out.push(model.banner ? st.red(statusText) : statusText);
  const hints = sess.length
    ? `Enter open ${dot} n new ${dot} x kill ${dot} r rename ${dot} ? help ${dot} q quit`
    : `n new ${dot} ? help ${dot} q quit`;
  out.push(hints.slice(0, cols));

  if (model.dialog) {
    const box = boxLines(model.dialog, cols, ascii);
    box.forEach((b, i) => {
      const r = 3 + i;
      if (r < 3 + tableRows) out[r] = b;
    });
  }
  return out;
}
