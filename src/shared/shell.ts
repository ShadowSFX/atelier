/** Shell profiles and per-shell path handling (pure: used by main, renderer and tests). */

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'gitbash' | 'wsl' | 'zsh' | 'fish' | 'other';

export interface Profile {
  id: string;
  name: string;
  kind: ShellKind;
  /** Executable (absolute path or a name on PATH). */
  file: string;
  /** Extra arguments from the user (integration arguments are added by Atelier). */
  args: string[];
  /** WSL distribution name. */
  distro?: string;
}

// ───────────── Path conversion ─────────────

/** C:\Users\me → /c/Users/me (MSYS form understood by Git Bash). UNC \\srv\share → //srv/share. */
export function toGitBashPath(win: string): string {
  const drive = /^([a-z]):[\\/]?(.*)$/i.exec(win);
  if (drive) return `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/';
  return win.replace(/\\/g, '/');
}

/**
 * C:\x → /mnt/c/x; \\wsl.localhost\<distro>\home\u (or \\wsl$\…) → /home/u when it is the same distro.
 * Returns null for paths WSL can't reach (other UNC shares, another distro).
 */
export function toWslPath(win: string, distro?: string): string | null {
  const drive = /^([a-z]):[\\/]?(.*)$/i.exec(win);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/+$/, '');
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(win);
  if (unc && (!distro || unc[1]!.toLowerCase() === distro.toLowerCase()))
    return (unc[2] ?? '\\').replace(/\\/g, '/');
  return null;
}

/**
 * A directory reported by a shell (OSC 7 path, already decoded) → the path Atelier stores.
 * Windows shells report /C:/x or C:/x; Git Bash reports /c/x; WSL reports Linux paths.
 */
export function shellPathToNative(path: string, kind: ShellKind, platform: string, distro?: string): string {
  if (platform !== 'win32') return path;
  let m = /^\/?([a-z]):(?:[\\/](.*))?$/i.exec(path);
  if (m) return `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  if (kind === 'gitbash') {
    m = /^\/([a-z])(?:\/(.*))?$/i.exec(path);
    if (m) return `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  }
  if (kind === 'wsl' && path.startsWith('/')) {
    m = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path);
    if (m) return `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
    if (distro) return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`;
  }
  if (path.startsWith('//')) return path.replace(/\//g, '\\'); // UNC from a POSIX-style shell
  return path;
}

/**
 * Parses an OSC 7 payload (file://host/path, percent-encoded). Atelier's own scripts write UNC paths as
 * file://host//server/share/x, so the decoded path keeps the leading '//'.
 */
export function parseOsc7(data: string): { host: string; path: string } | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(data.trim());
  if (!m) return null;
  let path = m[2]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a shell that didn't encode '%': keep it as written */
  }
  return { host: m[1]!, path };
}

/**
 * Only directories of this machine count: an ssh session inside the terminal reports the remote host,
 * whose paths mean nothing here.
 */
export function isLocalOscHost(host: string, localHost: string): boolean {
  const h = host.toLowerCase();
  return (
    h === '' ||
    h === 'localhost' ||
    h === localHost.toLowerCase() ||
    h.split('.')[0] === localHost.toLowerCase()
  );
}

// ───────────── Quoting for paste/drop ─────────────

const SAFE_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SAFE_WIN = /^[A-Za-z0-9_@+=:,.\\/-]+$/;

/** Quotes one path for a shell, converting it to that shell's form first. Only quotes when needed. */
export function quotePath(path: string, kind: ShellKind, distro?: string): string {
  switch (kind) {
    case 'powershell':
      // PowerShell also treats the typographic quotes ‘ ’ ‚ ‛ as single quotes: double them too.
      return SAFE_WIN.test(path) ? path : `'${path.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
    case 'cmd':
      return SAFE_WIN.test(path) ? path : `"${path}"`;
    case 'gitbash':
      return posixQuote(/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? toGitBashPath(path) : path);
    case 'wsl': {
      const p =
        /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? (toWslPath(path, distro) ?? path) : path;
      return posixQuote(p);
    }
    default:
      return posixQuote(path);
  }
}

export function posixQuote(s: string): string {
  return SAFE_POSIX.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function quotePaths(paths: readonly string[], kind: ShellKind, distro?: string): string {
  return paths.map((p) => quotePath(p, kind, distro)).join(' ');
}
