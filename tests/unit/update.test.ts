import { describe, expect, it } from 'vitest';
import { installerLeftovers, regValue, resolveDataDir, swapScript, type SwapPlan } from '@shared/portable';
import { psQuote } from '@shared/shell';
import {
  CHECKSUM_ASSET,
  compareVersions,
  EXE_ASSET,
  parseChecksum,
  parseRelease,
  parseVersion,
  planUpdate,
  type ReleaseInfo,
} from '@shared/update';

const HEX = 'a'.repeat(64);

function release(over: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: 'v1.2.0',
    version: '1.2.0',
    htmlUrl: 'https://github.com/ShadowSFX/atelier/releases/tag/v1.2.0',
    draft: false,
    prerelease: false,
    assets: [
      { name: EXE_ASSET, url: 'https://x/Atelier.exe', size: 100 },
      { name: CHECKSUM_ASSET, url: 'https://x/Atelier.exe.sha256', size: 80 },
    ],
    ...over,
  };
}

describe('versions', () => {
  it('parses with or without v, prerelease and build metadata', () => {
    expect(parseVersion('v1.2.3')?.nums).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta.1')?.pre).toBe('beta.1');
    expect(parseVersion('1.2.3+abc')?.pre).toBe('');
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, a final release above its prereleases', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('nope', '0.0.1')).toBeLessThan(0);
  });
});

describe('parseRelease', () => {
  it('reads a GitHub release', () => {
    const r = parseRelease(
      JSON.stringify({
        tag_name: 'v0.2.0',
        html_url: 'https://h',
        draft: false,
        prerelease: false,
        assets: [
          { name: 'Atelier.exe', browser_download_url: 'https://a', size: 5 },
          { name: '', browser_download_url: 'https://b' },
          { name: 'x', size: 1 },
          null,
        ],
      }),
    );
    expect(r).toMatchObject({ tag: 'v0.2.0', version: '0.2.0', htmlUrl: 'https://h' });
    expect(r?.assets).toEqual([{ name: 'Atelier.exe', url: 'https://a', size: 5 }]);
  });

  it('rejects broken JSON, non-objects and tags that are not versions', () => {
    expect(parseRelease('{')).toBeNull();
    expect(parseRelease('[]')).toBeNull();
    expect(parseRelease('null')).toBeNull();
    expect(parseRelease(JSON.stringify({ tag_name: 'latest' }))).toBeNull();
    expect(parseRelease(JSON.stringify({ assets: [] }))).toBeNull();
  });
});

describe('planUpdate', () => {
  it('plans a newer final release with both assets', () => {
    const p = planUpdate('1.1.0', release());
    expect(p?.exe.name).toBe(EXE_ASSET);
    expect(p?.checksum.name).toBe(CHECKSUM_ASSET);
  });

  it('matches asset names case-insensitively', () => {
    const r = release({
      assets: [
        { name: 'atelier.EXE', url: 'u', size: 1 },
        { name: 'ATELIER.exe.sha256', url: 'v', size: 1 },
      ],
    });
    expect(planUpdate('1.1.0', r)).not.toBeNull();
  });

  it('skips drafts, prereleases, same or older versions and missing assets', () => {
    expect(planUpdate('1.1.0', null)).toBeNull();
    expect(planUpdate('1.1.0', release({ draft: true }))).toBeNull();
    expect(planUpdate('1.1.0', release({ prerelease: true }))).toBeNull();
    expect(planUpdate('1.1.0', release({ version: '1.2.0-rc.1' }))).toBeNull();
    expect(planUpdate('1.2.0', release())).toBeNull();
    expect(planUpdate('1.3.0', release())).toBeNull();
    expect(planUpdate('garbage', release())).toBeNull();
    expect(planUpdate('1.1.0', release({ assets: [release().assets[0]!] }))).toBeNull();
    expect(planUpdate('1.1.0', release({ assets: [release().assets[1]!] }))).toBeNull();
  });

  it('takes the same version when an installed copy moves to the portable exe', () => {
    expect(planUpdate('1.2.0', release(), true)?.exe.name).toBe(EXE_ASSET);
    expect(planUpdate('1.1.0', release(), true)).not.toBeNull();
    expect(planUpdate('1.3.0', release(), true)).toBeNull();
    expect(planUpdate('1.2.0', release({ prerelease: true }), true)).toBeNull();
  });
});

describe('old NSIS install', () => {
  it("picks Electron's files and keeps the portable exe, its updates, its data and the uninstaller", () => {
    const listing = [
      'Atelier.exe',
      'Atelier.exe.old',
      'Atelier.exe.new',
      'Atelier.exe.new.version',
      'Atelier.data',
      'Uninstall Atelier.exe',
      'LICENSE.electron.txt',
      'LICENSES.chromium.html',
      'chrome_100_percent.pak',
      'resources.pak',
      'd3dcompiler_47.dll',
      'ffmpeg.dll',
      'icudtl.dat',
      'snapshot_blob.bin',
      'v8_context_snapshot.bin',
      'vk_swiftshader_icd.json',
      'locales',
      'resources',
      'notes.txt',
    ];
    expect(installerLeftovers(listing).sort()).toEqual(
      [
        'LICENSE.electron.txt',
        'LICENSES.chromium.html',
        'chrome_100_percent.pak',
        'resources.pak',
        'd3dcompiler_47.dll',
        'ffmpeg.dll',
        'icudtl.dat',
        'snapshot_blob.bin',
        'v8_context_snapshot.bin',
        'vk_swiftshader_icd.json',
        'locales',
        'resources',
      ].sort(),
    );
  });

  it('reads a value from reg query output', () => {
    const value = String.raw`"C:\Users\x\AppData\Local\Programs\atelier\Uninstall Atelier.exe" /currentuser`;
    const out = [
      '',
      String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\cddcd890-f17a-5c91-ad60-14a0f658b8ee`,
      `    UninstallString    REG_SZ    ${value}`,
      '',
    ].join('\r\n');
    expect(regValue(out, 'UninstallString')).toBe(value);
    expect(regValue(out, 'DisplayName')).toBeNull();
  });
});

describe('parseChecksum', () => {
  it('accepts a bare digest or sha256sum output', () => {
    expect(parseChecksum(HEX)).toBe(HEX);
    expect(parseChecksum(`${HEX.toUpperCase()}  Atelier.exe\r\n`)).toBe(HEX);
    expect(parseChecksum(`\n${HEX} *Atelier.exe`)).toBe(HEX);
  });

  it('rejects anything else', () => {
    expect(parseChecksum('')).toBeNull();
    expect(parseChecksum('   ')).toBeNull();
    expect(parseChecksum('abc')).toBeNull();
    expect(parseChecksum('g'.repeat(64))).toBeNull();
    expect(parseChecksum('a'.repeat(65))).toBeNull();
  });
});

describe('resolveDataDir', () => {
  it('uses the default profile when not running as the portable exe', () => {
    expect(
      resolveDataDir({ portableDir: null, fallbackDir: 'C:\\AppData\\Atelier', canWrite: () => true }),
    ).toEqual({
      dir: 'C:\\AppData\\Atelier',
      portable: false,
      fallback: false,
    });
  });

  it('uses the folder next to the exe when it can be written', () => {
    const r = resolveDataDir({
      portableDir: 'D:\\Tools\\Atelier.data',
      fallbackDir: 'C:\\A',
      canWrite: () => true,
    });
    expect(r).toEqual({ dir: 'D:\\Tools\\Atelier.data', portable: true, fallback: false });
  });

  it('falls back to AppData when that folder is read-only', () => {
    const probed: string[] = [];
    const r = resolveDataDir({
      portableDir: 'C:\\Program Files\\Atelier.data',
      fallbackDir: 'C:\\A',
      canWrite: (d) => (probed.push(d), false),
    });
    expect(probed).toEqual(['C:\\Program Files\\Atelier.data']);
    expect(r).toEqual({ dir: 'C:\\A', portable: false, fallback: true });
  });
});

describe('swapScript', () => {
  const plan: SwapPlan = {
    exe: "C:\\Users\\O'Neil\\Atelier.exe",
    staged: "C:\\Users\\O'Neil\\Atelier.exe.new",
    stagedVersion: "C:\\Users\\O'Neil\\Atelier.exe.new.version",
    old: "C:\\Users\\O'Neil\\Atelier.exe.old",
    version: '0.3.1',
    waitPid: 4242,
    relaunch: true,
    logFile: 'C:\\data\\logs\\main.log',
  };

  it('quotes every path as a PowerShell literal', () => {
    const s = swapScript(plan);
    expect(s).toContain(`$exe = 'C:\\Users\\O''Neil\\Atelier.exe'`);
    expect(s).toContain(`$new = 'C:\\Users\\O''Neil\\Atelier.exe.new'`);
    expect(s).toContain(`$log = 'C:\\data\\logs\\main.log'`);
    expect(s).not.toMatch(/O'Neil/);
  });

  it('waits for the stub, kills what still holds the exe, and relaunches when asked', () => {
    const s = swapScript(plan);
    expect(s).toContain('$waitPid = 4242');
    expect(s).toContain('$relaunch = $true');
    expect(s).toMatch(/taskkill/);
    expect(swapScript({ ...plan, relaunch: false })).toContain('$relaunch = $false');
    expect(swapScript({ ...plan, waitPid: null })).toContain('$waitPid = 0');
    expect(swapScript({ ...plan, logFile: null })).toContain(`$log = ''`);
    // Only a relaunch: nothing is renamed.
    expect(swapScript({ ...plan, staged: null })).toContain(`$new = ''`);
    expect(swapScript(plan)).toContain('if ($new -and [IO.File]::Exists($new))');
  });
});

describe('psQuote', () => {
  it('always quotes and doubles plain and typographic single quotes', () => {
    expect(psQuote('C:\\a')).toBe(`'C:\\a'`);
    expect(psQuote(`it's`)).toBe(`'it''s'`);
    expect(psQuote('a\u2019b')).toBe(`'a\u2019\u2019b'`);
  });
});
