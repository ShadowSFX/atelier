import { join } from 'node:path';
import { shellPathToNative } from '@shared/shell';

/** What Atelier's statusLine script needs from Claude Code's statusLine input. */
export interface StatusInput {
  cwd?: unknown;
  workspace?: { project_dir?: unknown; current_dir?: unknown };
}

/**
 * The Claude Code settings files that can define the user's own statusLine, highest precedence first:
 * project local, project, user (managed settings would override Atelier's statusLine altogether).
 *
 * Claude in WSL reports Linux paths and its $HOME (ATELIER_STATUS_HOME); this script runs as Atelier.exe, which
 * reaches them through \\wsl.localhost\<distro>. Git Bash may hand over /c/… paths.
 */
export function statusLineSources(
  input: StatusInput,
  env: NodeJS.ProcessEnv,
  platform: string,
  home: string,
): string[] {
  const wsl = env.ATELIER_STATUS_KIND === 'wsl';
  const distro = env.WSL_DISTRO_NAME || undefined;
  const native = (p: string) => shellPathToNative(p, wsl ? 'wsl' : 'gitbash', platform, distro);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

  const out: string[] = [];
  const project = str(input.workspace?.project_dir) ?? str(input.cwd);
  if (project) {
    const dir = native(project);
    out.push(join(dir, '.claude', 'settings.local.json'), join(dir, '.claude', 'settings.json'));
  }
  const configDir = str(env.CLAUDE_CONFIG_DIR);
  const userHome = wsl ? str(env.ATELIER_STATUS_HOME) : home;
  if (configDir) out.push(join(native(configDir), 'settings.json'));
  else if (userHome) out.push(join(wsl ? native(userHome) : userHome, '.claude', 'settings.json'));
  return out;
}
