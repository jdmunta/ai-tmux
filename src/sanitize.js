const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC2 = /\x1b[@-Z\\-_]/g;
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;
const FORMAT = /[\p{Cf}\u2028\u2029]/gu;

// Single choke point: removes escape sequences, control characters and
// bidi/format characters from any externally derived string before
// render, status line or notification.
export function sanitize(value) {
  return String(value ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC2, '')
    .replace(CTRL, '')
    .replace(FORMAT, '');
}
