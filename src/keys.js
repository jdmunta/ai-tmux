const CSI = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/;
const NAMES = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };

export function decode(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const m = CSI.exec(s.slice(i));
      if (m) {
        const k = NAMES[m[2]];
        if (k) out.push(k);
        i += m[0].length;
      } else {
        out.push('esc');
        i += 1;
      }
      continue;
    }
    if (ch === '\r') {
      out.push('enter');
      i += s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') { out.push('enter'); i += 1; continue; }
    if (ch === '\x7f' || ch === '\b') { out.push('backspace'); i += 1; continue; }
    if (ch === '\t') { out.push('tab'); i += 1; continue; }
    if (ch === '\x03') { out.push('ctrl-c'); i += 1; continue; }
    const cp = s.codePointAt(i);
    const str = String.fromCodePoint(cp);
    i += str.length;
    if (cp >= 0x20) out.push(str);
  }
  return out;
}
