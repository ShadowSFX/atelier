import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile, ShellKind } from '@shared/shell';
import { toWslPath } from '@shared/shell';
import bashRc from './scripts/atelier.bash?raw';
import pwshScript from './scripts/atelier.ps1?raw';
import zshEnv from './scripts/zsh/.zshenv?raw';
import zshProfile from './scripts/zsh/.zprofile?raw';
import zshRc from './scripts/zsh/.zshrc?raw';

/** Where the integration scripts live on disk (written at startup, only when their content changed). */
export interface ShellScripts {
  dir: string;
  bash: string;
  powershell: string;
  zshDir: string;
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    /* missing: write it */
  }
  writeFileSync(path, content, 'utf8');
}

export function installShellScripts(dir: string): ShellScripts {
  const zshDir = join(dir, 'zsh');
  mkdirSync(zshDir, { recursive: true });
  // bash and zsh need LF line endings even on Windows (Git Bash, WSL).
  const lf = (s: string) => s.replace(/\r\n/g, '\n');
  const scripts: ShellScripts = {
    dir,
    bash: join(dir, 'atelier.bash'),
    powershell: join(dir, 'atelier.ps1'),
    zshDir,
  };
  writeIfChanged(scripts.bash, lf(bashRc));
  writeIfChanged(scripts.powershell, pwshScript.replace(/\r?\n/g, '\r\n'));
  writeIfChanged(join(zshDir, '.zshenv'), lf(zshEnv));
  writeIfChanged(join(zshDir, '.zprofile'), lf(zshProfile));
  writeIfChanged(join(zshDir, '.zshrc'), lf(zshRc));
  return scripts;
}

export interface LaunchOptions {
  profile: Profile;
  cwd: string;
  scripts: ShellScripts;
  powerline: boolean;
  /** Variables every Atelier terminal gets (hub identity, claude wrapper paths…). */
  env: Record<string, string>;
  /** Paths of the claude wrapper files as WSL sees them are derived through WSLENV /p. */
  claudeExe: string | null;
  /** Variables set by a launcher (Code Mode): WSL shells receive them through WSLENV too. */
  launchEnv?: readonly string[];
}

export interface Launch {
  file: string;
  /** A string is passed to node-pty verbatim as the Windows command line (needed by cmd's /k). */
  args: string[] | string;
  cwd: string;
  env: Record<string, string>;
}

/** The powerline prompt of cmd: only the directory (cmd can't run code per prompt). Codes from RDMan's palette. */
function cmdPrompt(powerline: boolean): string {
  const markers = '$e]133;D$e\\$e]7;file://localhost/$P$e\\$e]133;A$e\\';
  if (!powerline) return `${markers}$P$G$e]133;B$e\\`;
  // segment: directory (bg 4, fg 0), then the arrow in color 4 on the default background.
  return `${markers}$e[30;44m $P $e[0;34m$e[0m $e]133;B$e\\`;
}

const WSL_SHARED = [
  'ATELIER',
  'ATELIER_POWERLINE',
  'ATELIER_LOGIN',
  'ATELIER_CWD',
  'ATELIER_HUB',
  'ATELIER_PROJECT',
  'ATELIER_TERMINAL',
  'ATELIER_TOKEN',
  'ATELIER_CLAUDE_SETTINGS/p',
  'ATELIER_CLAUDE_MCP/p',
  'TERM_PROGRAM',
  'COLORTERM',
];

/** Builds the command line, directory and environment that start a shell with Atelier's integration. */
export function buildLaunch(o: LaunchOptions): Launch {
  const { profile, scripts } = o;
  const env: Record<string, string> = { ...o.env };
  if (o.powerline) env.ATELIER_POWERLINE = '1';
  env.ATELIER_CWD = o.cwd;
  const kind: ShellKind = profile.kind;

  switch (kind) {
    case 'powershell': {
      const script = scripts.powershell.replace(/'/g, "''");
      return {
        file: profile.file,
        args: [
          '-NoLogo',
          '-NoExit',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `. '${script}'`,
          ...profile.args,
        ],
        cwd: o.cwd,
        env,
      };
    }
    case 'cmd': {
      env.PROMPT = cmdPrompt(o.powerline);
      delete env.ATELIER_CWD;
      let cmdline = '';
      if (o.claudeExe && env.ATELIER_CLAUDE_SETTINGS) {
        cmdline = `/k doskey claude="${o.claudeExe}" --settings "${env.ATELIER_CLAUDE_SETTINGS}" --mcp-config "${env.ATELIER_CLAUDE_MCP}" $*`;
      }
      const extra = profile.args.join(' ');
      return { file: profile.file, args: [cmdline, extra].filter(Boolean).join(' '), cwd: o.cwd, env };
    }
    case 'gitbash':
      env.ATELIER_LOGIN = '1';
      env.CHERE_INVOKING = '1'; // keeps Git Bash's /etc/profile from changing to $HOME
      return {
        file: profile.file,
        args: ['--rcfile', scripts.bash.replace(/\\/g, '/'), '-i', ...profile.args],
        cwd: o.cwd,
        env,
      };
    case 'wsl': {
      env.ATELIER_LOGIN = '1';
      const linuxCwd = toWslPath(o.cwd, profile.distro);
      env.ATELIER_CWD = linuxCwd ?? '';
      const rc = toWslPath(scripts.bash, profile.distro) ?? scripts.bash;
      const prev = process.env.WSLENV ? process.env.WSLENV + ':' : '';
      env.WSLENV = prev + [...WSL_SHARED, ...(o.launchEnv ?? [])].join(':');
      const args = ['-d', profile.distro ?? '', ...(linuxCwd ? ['--cd', linuxCwd] : ['--cd', '~'])];
      return {
        file: profile.file,
        args: [...args, '--', 'bash', '--rcfile', rc, '-i', ...profile.args],
        cwd: o.cwd,
        env,
      };
    }
    case 'bash':
      return { file: profile.file, args: ['--rcfile', scripts.bash, '-i', ...profile.args], cwd: o.cwd, env };
    case 'zsh':
      env.ATELIER_USER_ZDOTDIR = process.env.ZDOTDIR ?? process.env.HOME ?? '';
      env.ZDOTDIR = scripts.zshDir;
      return { file: profile.file, args: ['-i', ...profile.args], cwd: o.cwd, env };
    default:
      delete env.ATELIER_CWD;
      return { file: profile.file, args: profile.args, cwd: o.cwd, env };
  }
}
