// Degraded fallback: look only at the last lines of the pane. Text is never stored.
const WAITING = [
  /do you want to (proceed|make this edit|create|run|allow|continue)/i,
  /❯\s*1\.\s*yes/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /esc to cancel/i,
  /waiting for (your )?(permission|input|approval)/i,
  /allow (this|once)/i,
];
const RUNNING = [/esc to interrupt/i, /ctrl\+c to interrupt/i];
const IDLE = [/\?\s+for shortcuts/i, /^\s*[>❯]\s*$/m, /^[│|]\s*>\s*[│|]?\s*$/m];

export function lastLines(text, n = 40) {
  return String(text ?? '').split('\n').slice(-n).join('\n');
}

// Ambiguous matches (waiting plus running) resolve to waiting.
export function detect(text) {
  const t = lastLines(text, 40);
  if (WAITING.some((re) => re.test(t))) return { state: 'waiting' };
  if (RUNNING.some((re) => re.test(t))) return { state: 'running' };
  if (IDLE.some((re) => re.test(t))) return { state: 'idle' };
  return { state: 'unknown' };
}
