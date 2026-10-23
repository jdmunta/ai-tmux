export class AitError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'AitError';
    this.code = code;
    this.status = status;
    this.needsConfirm = false;
  }
}

export const MSG = {
  nameEmpty: 'Give the session a name.',
  nameInvalid: 'Use letters, numbers, - and _ only.',
  nameReserved: 'That name is reserved. Pick another name.',
  taken: (n) => `A session called ${n} already exists. Pick another name.`,
  dirMissing: "That folder doesn't exist. Check the path.",
  dirFile: 'That path is a file, not a folder.',
  noClaude: "Couldn't start Claude Code: `claude` isn't on your PATH.",
  tmuxMissing: 'AI tmux needs tmux 3.2 or newer. Install it with `brew install tmux` or your package manager.',
  tmuxUnreachable: "Can't reach tmux. Sessions may still be running. Retrying…",
  gone: (n) => `${n} is no longer running.`,
  fallback: 'State detection: fallback mode. Status may be less precise.',
  projectHooks: 'This folder has project hooks that will run with your permissions. Confirm to continue.',
  dangerousArgs: 'These Claude options remove permission prompts or add tools. Confirm to continue.',
};
