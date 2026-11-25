/**
 * App shortcuts. Inside a terminal only these keys are Atelier's; everything else belongs to the shell
 * (same model as RDMan: Ctrl+Shift combos, Ctrl+Tab, Ctrl+PgUp/PgDn and Ctrl+Alt+arrows).
 */
export type Shortcut =
  | 'palette'
  | 'new-terminal'
  | 'close-terminal'
  | 'next-terminal'
  | 'prev-terminal'
  | 'next-project'
  | 'prev-project'
  | 'split'
  | 'next-pane'
  | 'prev-pane'
  | 'settings'
  | 'add-project';

export function appShortcut(e: KeyboardEvent): Shortcut | null {
  const { ctrlKey: ctrl, shiftKey: shift, altKey: alt } = e;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (ctrl && shift && !alt) {
    switch (k) {
      case 'p':
      case 'k':
        return 'palette';
      case 't':
        return 'new-terminal';
      case 'w':
        return 'close-terminal';
      case 'o':
        return 'add-project';
      case 'Tab':
        return 'prev-terminal';
    }
    // Ctrl+Shift+5 (the key, whatever the layout prints on it), like Windows Terminal's split.
    if (e.code === 'Digit5') return 'split';
  }
  if (ctrl && !shift && !alt) {
    if (k === 'Tab') return 'next-terminal';
    if (k === 'PageDown') return 'next-project';
    if (k === 'PageUp') return 'prev-project';
    if (k === ',') return 'settings';
  }
  // Ctrl+Alt+arrows only: other Ctrl+Alt keys are AltGr characters (@, #, € on many layouts).
  if (ctrl && alt && !shift) {
    if (k === 'ArrowRight') return 'next-pane';
    if (k === 'ArrowLeft') return 'prev-pane';
  }
  return null;
}

type Runner = (s: Shortcut) => void;
let runner: Runner = () => undefined;

/** The app registers what each shortcut does (keeps terminal code free of UI imports). */
export function setShortcutRunner(r: Runner): void {
  runner = r;
}

export function runShortcut(s: Shortcut): void {
  runner(s);
}
