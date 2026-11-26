import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blend, normalizeColor } from '@shared/colors';
import { HUB_MAX_TITLE } from '@shared/constants';
import { cleanTitle, splitLines } from '@shared/hub';
import { resolveLang, STRINGS, translate } from '@shared/i18n';
import { SCHEMES, resolveScheme } from '@shared/schemes';
import { parseSettings } from '@shared/settings';

describe('i18n', () => {
  it('has both languages with the same placeholders for every string', () => {
    for (const [key, pair] of Object.entries(STRINGS)) {
      const [es, en] = pair as readonly [string, string];
      expect(es, key).toBeTruthy();
      expect(en, key).toBeTruthy();
      const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
      expect(ph(es), key).toBe(ph(en));
    }
  });

  it('formats and resolves the system language', () => {
    expect(translate('en', 'term.exited', 3)).toBe('The process exited with code 3.');
    expect(resolveLang('system', 'es-MX')).toBe('es');
    expect(resolveLang('system', 'en-US')).toBe('en');
    expect(resolveLang('en', 'es-ES')).toBe('en');
  });
});

describe('terminal titles from Claude', () => {
  it('removes control characters and collapses whitespace', () => {
    expect(cleanTitle('  Login\tform\r\n\x1b]0;evil\x07 fix  ')).toBe('Login form ]0;evil fix');
    expect(cleanTitle('a\x9bb')).toBe('a b');
  });

  it('is empty for nothing usable', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle(' \x00\x1b ')).toBe('');
    expect(cleanTitle(undefined)).toBe('');
    expect(cleanTitle(42)).toBe('');
  });

  it(`cuts at ${HUB_MAX_TITLE} characters without splitting an emoji`, () => {
    expect(Array.from(cleanTitle('x'.repeat(100)))).toHaveLength(HUB_MAX_TITLE);
    const emoji = cleanTitle('🚀'.repeat(60));
    expect(Array.from(emoji)).toHaveLength(HUB_MAX_TITLE);
    expect(emoji).toBe('🚀'.repeat(HUB_MAX_TITLE));
    expect(cleanTitle('a'.repeat(HUB_MAX_TITLE - 1) + ' tail')).toBe('a'.repeat(HUB_MAX_TITLE - 1));
  });
});

describe('settings', () => {
  it('fills defaults and clamps out-of-range values', () => {
    const s = parseSettings({
      fontSize: 99,
      lineHeight: 'x',
      cursor: 'beam',
      scrollback: -5,
      fontWeight: 450,
    });
    expect(s.fontSize).toBe(32);
    expect(s.lineHeight).toBe(1.15);
    expect(s.cursor).toBe('bar');
    expect(s.scrollback).toBe(0);
    expect(s.fontWeight).toBe(400);
    expect(parseSettings(null).renderer).toBe('gpu');
  });
});

describe('colors and schemes', () => {
  it('normalizes colors', () => {
    expect(normalizeColor('#4c8df6')).toBe('#4C8DF6');
    expect(normalizeColor('red')).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
  });

  it('blends', () => {
    expect(blend('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(blend('#1B1F26', '#4C8DF6', 0)).toBe('#1B1F26');
  });

  it('every scheme has 16 valid ANSI colors; auto follows the app theme', () => {
    for (const s of SCHEMES) {
      expect(s.ansi, s.id).toHaveLength(16);
      for (const c of [s.background, s.foreground, s.cursor, ...s.ansi])
        expect(normalizeColor(c), `${s.id} ${c}`).not.toBeNull();
    }
    expect(resolveScheme('auto', true).id).toBe('atelier-night');
    expect(resolveScheme('nope', false).id).toBe('atelier-day');
  });
});

describe('hub framing', () => {
  it('splits lines and keeps the unfinished tail', () => {
    const lines: string[] = [];
    const tail = splitLines('{"a":1}\n\n{"b":2}\n{"c"', (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(tail).toBe('{"c"');
  });
});

describe('shell scripts', () => {
  const dir = join(__dirname, '../../src/main/shell/scripts');

  it('PowerShell script is ASCII only (PowerShell 5.1 reads BOM-less files in the ANSI code page)', () => {
    const ps = readFileSync(join(dir, 'atelier.ps1'), 'utf8');
    expect([...ps].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('every script emits prompt marks, the directory and the git branch, and wraps claude', () => {
    for (const f of ['atelier.bash', 'atelier.ps1', 'zsh/.zshrc']) {
      const s = readFileSync(join(dir, f), 'utf8');
      expect(s, f).toMatch(/133;A/);
      expect(s, f).toMatch(/133;B/);
      expect(s, f).toMatch(/133;D/);
      expect(s, f).toMatch(/\]7;/);
      expect(s, f).toMatch(/633;P;GitBranch=/);
      expect(s, f).toMatch(/ATELIER_CLAUDE_SETTINGS/);
      // --mcp-config is variadic: --settings must follow it, or `claude attach <id>` / `claude "prompt"` become
      // more config files.
      expect(s, f).toMatch(/--mcp-config \S+ --settings \S+ /);
      expect(s, f).not.toMatch(/--settings \S+ --mcp-config/);
    }
  });
});
