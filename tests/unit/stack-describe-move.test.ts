import { describe, expect, it } from 'vitest';
import {
  cleanText,
  describePrompt,
  firstJsonObject,
  parseDescription,
  parseEnvelope,
  DESCRIBE_ARGS,
} from '@shared/describe';
import { isValidFolderName, joinPath, parentOf, pathBlockers, sameVolume } from '@shared/move';
import { analyzeProbe, dependencies, readmeSummary, type FolderProbe } from '@shared/stack';

const probe = (over: Partial<FolderProbe>): FolderProbe => ({
  names: [],
  dirs: [],
  manifests: {},
  extensions: {},
  readme: null,
  ...over,
});

describe('stack detection', () => {
  it('reads an Angular + Express monorepo', () => {
    const r = analyzeProbe(
      probe({
        names: ['angular.json', 'package.json', 'backend', 'src'],
        manifests: {
          'package.json': JSON.stringify({
            dependencies: { '@angular/core': '19' },
            devDependencies: { typescript: '5' },
          }),
          'backend/package.json': JSON.stringify({ dependencies: { express: '4', mysql2: '3' } }),
        },
        extensions: { ts: 120, html: 40, scss: 30, js: 4 },
      }),
    );
    expect(r.stack.slice(0, 4)).toEqual(['TypeScript', 'Angular', 'Express', 'MySQL']);
    expect(r.kind).toBe('web');
    expect(r.isCode).toBe(true);
    expect(r.languages[0]).toEqual({ name: 'TypeScript', files: 120 });
  });

  it('reads Python requirements, Godot and C++ engines', () => {
    expect(
      analyzeProbe(
        probe({
          manifests: { 'requirements.txt': '# x\nfastapi>=0.1\npandas==2\n-r other.txt' },
          extensions: { py: 10 },
        }),
      ).stack,
    ).toEqual(['Python', 'FastAPI', 'pandas']);
    expect(analyzeProbe(probe({ names: ['project.godot'], extensions: { gd: 30 } })).kind).toBe('game');
    const engine = analyzeProbe(
      probe({ names: ['SConstruct'], extensions: { cpp: 300, h: 280, py: 120, sh: 2 } }),
    );
    // A second language counts when it is a real share of the code (a few build scripts don't).
    expect(engine.stack.slice(0, 3)).toEqual(['C++', 'Python', 'SCons']);
    expect(analyzeProbe(probe({ extensions: { cpp: 300, py: 4 } })).stack).toEqual(['C++']);
    expect(engine.languages[0]).toEqual({ name: 'C++', files: 580 }); // headers join C++
  });

  it('knows a folder of shortcuts and documents is not code', () => {
    const r = analyzeProbe(
      probe({ names: ['IDOL FAC.rdp', 'hamachi.msi', 'REGADD.bat'], extensions: { bat: 1 } }),
    );
    expect(r.isCode).toBe(false);
    expect(r.kind).toBeNull();
  });

  it('parses dependency lists tolerantly', () => {
    expect([...dependencies({ 'package.json': '{ broken' })]).toEqual([]);
    expect(
      dependencies({ 'cargo.toml': '[dependencies]\ntokio = "1"\nserde = { version = "1" }' }).has('tokio'),
    ).toBe(true);
    expect(
      dependencies({ 'pyproject.toml': 'dependencies = ["fastapi>=0.1", "uvicorn[standard]"]' }).has(
        'uvicorn',
      ),
    ).toBe(true);
  });

  it("takes the README's first real paragraph", () => {
    const md =
      '# Title\n\n[![build](x)](y)\n\n<p align="center">logo</p>\n\nA **credit** and [payroll](http://x) system for cooperatives.\n\nMore.';
    expect(readmeSummary(md)).toBe('A credit and payroll system for cooperatives.');
    expect(readmeSummary('# Only a title')).toBeNull();
  });
});

describe('Claude descriptions', () => {
  it('never puts the prompt on the command line', () => {
    expect(DESCRIBE_ARGS).toContain('--safe-mode');
    expect(DESCRIBE_ARGS).toContain('--no-session-persistence');
    expect(DESCRIBE_ARGS.every((a) => /^[\w.,-]+$/.test(a))).toBe(true); // fixed words: safe through cmd.exe
    expect(describePrompt('es', null)).toContain('Spanish');
  });

  it('takes the JSON object even when wrapped in prose or a fence', () => {
    const fence = '```';
    const text =
      'Here it is:\n' +
      fence +
      'json\n{"description": "An app {with braces}", "stack": ["TypeScript"], "kind": "app"}\n' +
      fence;
    expect(parseDescription(text)).toEqual({
      text: 'An app {with braces}',
      stack: ['TypeScript'],
      kind: 'app',
    });
    expect(firstJsonObject('no object')).toBeNull();
  });

  it('cleans untrusted answers: controls, bidi, markdown, URLs, length, odd stack items', () => {
    const d = parseDescription(
      JSON.stringify({
        description:
          '\x1b[31mEvil\x1b[0m \u{202E}text\u{202C} with **bold** https://phish.example/x ' + 'x'.repeat(600),
        stack: ['TypeScript', 'typescript', '<script>', 'a'.repeat(40), 7],
        kind: 'rootkit',
      }),
    )!;
    expect(d.text.startsWith('Evil text with bold')).toBe(true);
    expect(d.text).not.toContain('http');
    expect(Array.from(d.text).length).toBeLessThanOrEqual(400);
    expect(d.stack).toEqual(['TypeScript']);
    expect(d.kind).toBe('other');
    expect(parseDescription('{"stack": []}')).toBeNull();
    expect(cleanText('a\tb\nc', 10)).toBe('a b c');
  });

  it('reads a real Claude Code answer (claude -p --output-format json)', () => {
    const env = parseEnvelope(
      '{"type":"result","subtype":"success","is_error":false,"num_turns":9,"total_cost_usd":0.09,"result":"{\\"description\\": \\"Tres en raya multijugador para la red local (LAN): un servidor central y clientes web para móvil. Los jugadores entran con un nickname, ven quién está conectado en un lobby y se retan a partidas. Las puntuaciones se guardan en un JSON y se detectan las desconexiones.\\", \\"stack\\": [\\"JavaScript\\", \\"Node.js\\", \\"Express\\", \\"Socket.IO\\", \\"HTML\\", \\"CSS\\"], \\"kind\\": \\"game\\"}"}',
    );
    expect(env.ok).toBe(true);
    const d = parseDescription((env as { result: string }).result)!;
    expect(d.kind).toBe('game');
    expect(d.stack).toContain('Socket.IO');
    expect(d.text).toMatch(/^Tres en raya/);
  });

  it('reads the envelope and tells sign-in problems apart', () => {
    expect(parseEnvelope('{"type":"result","subtype":"success","is_error":false,"result":"{}"}')).toEqual({
      ok: true,
      result: '{}',
    });
    const auth = parseEnvelope(
      '{"type":"result","is_error":true,"result":"Invalid API key. Please run /login"}',
    );
    expect(auth).toMatchObject({ ok: false, failure: 'auth' });
    expect(parseEnvelope('{"type":"result","subtype":"error_max_turns","result":""}')).toMatchObject({
      ok: false,
      failure: 'error',
    });
    expect(parseEnvelope('not json')).toMatchObject({ ok: false });
  });
});

describe('move checks', () => {
  const base = {
    source: 'C:\\Users\\me\\Desktop\\apex',
    destination: 'D:\\Projects\\apex',
    sourceExists: true,
    destinationExists: false,
    protectedPaths: ['C:\\Users\\me', 'C:\\Users\\me\\Desktop\\Atelier-exe\\Atelier.data'],
  };

  it('allows a plain move and a case-only rename', () => {
    expect(pathBlockers(base)).toEqual([]);
    expect(
      pathBlockers({ ...base, destination: 'C:\\Users\\me\\Desktop\\Apex', destinationExists: true }),
    ).toEqual([]);
  });

  it('blocks the dangerous ones', () => {
    expect(pathBlockers({ ...base, destination: base.source, destinationExists: true })).toContain('same');
    expect(pathBlockers({ ...base, destinationExists: true })).toContain('dest-exists');
    expect(pathBlockers({ ...base, destination: base.source + '\\inner' })).toContain('dest-inside-source');
    expect(pathBlockers({ ...base, source: 'C:\\Users\\me\\Desktop\\Atelier-exe' })).toContain(
      'source-protected',
    );
    expect(pathBlockers({ ...base, source: 'C:\\Users\\me' })).toContain('source-protected');
    expect(pathBlockers({ ...base, source: 'D:\\' })).toContain('source-protected');
    expect(pathBlockers({ ...base, destination: 'D:\\Projects\\con' })).toContain('invalid-name');
    expect(pathBlockers({ ...base, source: '\\\\wsl.localhost\\Ubuntu\\home\\me\\x' })).toContain(
      'unsupported-path',
    );
    expect(pathBlockers({ ...base, sourceExists: false })).toContain('source-missing');
  });

  it('builds paths', () => {
    expect(joinPath('D:\\Projects\\', 'apex')).toBe('D:\\Projects\\apex');
    expect(parentOf('D:\\Projects\\apex')).toBe('D:\\Projects');
    expect(parentOf('D:\\apex')).toBe('D:\\');
    expect(isValidFolderName('my app')).toBe(true);
    expect(isValidFolderName('bad:name')).toBe(false);
    expect(isValidFolderName('trailing.')).toBe(false);
    expect(sameVolume('C:\\a', 'c:\\b')).toBe(true);
    expect(sameVolume('C:\\a', 'D:\\b')).toBe(false);
  });
});
