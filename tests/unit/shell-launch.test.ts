import { describe, expect, it } from 'vitest';
import { CODE_MODE_ENV } from '@shared/launchers';
import type { Profile } from '@shared/shell';
import { buildLaunch, type ShellScripts } from '../../src/main/shell/integration';

const scripts: ShellScripts = {
  dir: 'C:\\data\\shell',
  bash: 'C:\\data\\shell\\atelier.bash',
  powershell: 'C:\\data\\shell\\atelier.ps1',
  zshDir: 'C:\\data\\shell\\zsh',
};
const wsl: Profile = {
  id: 'wsl:Ubuntu',
  name: 'Ubuntu',
  kind: 'wsl',
  file: 'C:\\Windows\\System32\\wsl.exe',
  args: [],
  distro: 'Ubuntu',
} as Profile;

describe('buildLaunch: launcher variables', () => {
  it('hands Code Mode to a WSL shell through WSLENV', () => {
    const l = buildLaunch({
      profile: wsl,
      cwd: 'C:\\work',
      scripts,
      powerline: false,
      env: { [CODE_MODE_ENV]: '1' },
      claudeExe: null,
      launchEnv: [CODE_MODE_ENV],
    });
    expect(l.env[CODE_MODE_ENV]).toBe('1');
    expect(l.env.WSLENV!.split(':')).toContain(CODE_MODE_ENV);
  });

  it('adds nothing to WSLENV without a launcher variable', () => {
    const l = buildLaunch({
      profile: wsl,
      cwd: 'C:\\work',
      scripts,
      powerline: false,
      env: {},
      claudeExe: null,
    });
    expect(l.env.WSLENV!.split(':')).not.toContain(CODE_MODE_ENV);
  });
});
