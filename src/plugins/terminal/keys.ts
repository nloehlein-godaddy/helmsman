export type TerminalKeyIntent = { kind: 'key'; token: string } | { kind: 'text'; text: string } | { kind: 'ignore' };

export interface TerminalKeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const NAMED_TERMINAL_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Enter: 'enter',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

export function mapKeyEvent(e: TerminalKeyEventLike): TerminalKeyIntent {
  if (e.metaKey) return { kind: 'ignore' };
  if (e.ctrlKey && e.key.length === 1 && /^[a-zA-Z]$/.test(e.key)) {
    return { kind: 'key', token: `ctrl+${e.key.toLowerCase()}` };
  }
  const named: string | undefined = NAMED_TERMINAL_KEYS[e.key];
  if (named) return { kind: 'key', token: named };
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return { kind: 'text', text: e.key };
  return { kind: 'ignore' };
}
