import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Profile } from '@shared/shell';

/** Finds an executable on PATH (Windows: also tries PATHEXT extensions). */
export function which(name: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const firstExisting = (paths: (string | undefined)[]) =>
  paths.find((p): p is string => !!p && existsSync(p)) ?? null;

/** WSL distributions (docker-desktop's internal ones are not shells). */
function wslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { encoding: 'buffer', timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        // wsl.exe writes UTF-16LE.
        const text = stdout.toString('utf16le').replace(/\0/g, '');
        resolve(
          text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s && !/^docker-desktop/i.test(s)),
        );
      },
    );
  });
}

async function windowsProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pwsh = firstExisting([join(pf, 'PowerShell', '7', 'pwsh.exe')]) ?? which('pwsh');
  if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell 7', kind: 'powershell', file: pwsh, args: [] });
  out.push({
    id: 'powershell',
    name: 'Windows PowerShell',
    kind: 'powershell',
    file: join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [],
  });
  out.push({
    id: 'cmd',
    name: 'Command Prompt',
    kind: 'cmd',
    file: process.env.ComSpec ?? join(sys, 'System32', 'cmd.exe'),
    args: [],
  });
  const gitBash = firstExisting([
    join(pf, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)']!, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]);
  if (gitBash) out.push({ id: 'gitbash', name: 'Git Bash', kind: 'gitbash', file: gitBash, args: [] });
  if (existsSync(join(sys, 'System32', 'wsl.exe'))) {
    for (const distro of await wslDistros()) {
      out.push({
        id: `wsl:${distro}`,
        name: `WSL · ${distro}`,
        kind: 'wsl',
        file: join(sys, 'System32', 'wsl.exe'),
        args: [],
        distro,
      });
    }
  }
  return out;
}

function unixProfiles(): Profile[] {
  let shells: string[];
  try {
    shells = readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('/') && existsSync(s));
  } catch {
    shells = ['/bin/bash', '/bin/sh'].filter((s) => existsSync(s));
  }
  const byName = new Map<string, string>();
  for (const s of shells) {
    const name = s.split('/').pop()!;
    if (!byName.has(name)) byName.set(name, s); // /etc/shells lists /bin before /usr/bin
  }
  const out: Profile[] = [];
  for (const [name, file] of byName) {
    if (name === 'bash') out.push({ id: 'bash', name: 'bash', kind: 'bash', file, args: [] });
    else if (name === 'zsh') out.push({ id: 'zsh', name: 'zsh', kind: 'zsh', file, args: [] });
    else if (name === 'fish') out.push({ id: 'fish', name: 'fish', kind: 'fish', file, args: [] });
  }
  if (out.length === 0) out.push({ id: 'sh', name: 'sh', kind: 'other', file: '/bin/sh', args: [] });
  return out;
}

/** Detected once (WSL listing takes ~100 ms) and cached; `refresh` re-detects. */
export class ProfileRegistry {
  private cache: Promise<Profile[]> | null = null;

  list(): Promise<Profile[]> {
    this.cache ??= process.platform === 'win32' ? windowsProfiles() : Promise.resolve(unixProfiles());
    return this.cache;
  }

  refresh(): Promise<Profile[]> {
    this.cache = null;
    return this.list();
  }

  /** The configured default if it still exists, else the platform default. */
  async defaultId(configured: string): Promise<string> {
    const profiles = await this.list();
    if (configured && profiles.some((p) => p.id === configured)) return configured;
    if (process.platform === 'win32') return profiles.some((p) => p.id === 'pwsh') ? 'pwsh' : 'powershell';
    const login = (process.env.SHELL ?? '').split('/').pop();
    return profiles.find((p) => p.id === login)?.id ?? profiles[0]!.id;
  }

  async get(id: string): Promise<Profile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }
}
