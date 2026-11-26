import { TAG_COLORS } from './colors';
import type { LanguageShare, ProjectKind } from './library';

/**
 * Local project analysis, the pure part: what a folder's manifests, top-level names and file extensions say about
 * its stack and kind. main/library/analyze.ts gathers the inputs (bounded reads) and stores the result as LocalFacts.
 */

export interface FolderProbe {
  /** Top-level entry names (files and folders). */
  names: string[];
  /** Names of the top-level entries that are folders. */
  dirs: string[];
  /** Contents of the manifests found (key: lower-case file name, or "sub/file" one level down). */
  manifests: Record<string, string>;
  /** Code files per extension (lower case, no dot), from a bounded walk. */
  extensions: Record<string, number>;
  readme: string | null;
}

export interface StackResult {
  stack: string[];
  languages: LanguageShare[];
  kind: ProjectKind | null;
  summary: string | null;
  isCode: boolean;
}

/** Extension → language. Only code counts (documents, data and binaries don't). */
export const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  pyw: 'Python',
  ipynb: 'Jupyter',
  cs: 'C#',
  vb: 'Visual Basic',
  fs: 'F#',
  c: 'C',
  h: 'C/C++',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hh: 'C++',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  php: 'PHP',
  rb: 'Ruby',
  gd: 'GDScript',
  lua: 'Lua',
  dart: 'Dart',
  scala: 'Scala',
  sql: 'SQL',
  vue: 'Vue',
  svelte: 'Svelte',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'SCSS',
  less: 'CSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  prg: 'Visual FoxPro',
  scx: 'Visual FoxPro',
  mq4: 'MQL',
  mq5: 'MQL',
  mqh: 'MQL',
  r: 'R',
  xaml: 'XAML',
  glsl: 'GLSL',
  hlsl: 'HLSL',
  shader: 'ShaderLab',
  zig: 'Zig',
  ex: 'Elixir',
  exs: 'Elixir',
  hs: 'Haskell',
  pas: 'Pascal',
  asm: 'Assembly',
};

/** Languages that only style or glue: they never decide the "main" language when real code exists. */
const MINOR = new Set(['HTML', 'CSS', 'SCSS', 'Shell', 'Batch', 'PowerShell', 'SQL']);

/** A stable identification color per language (from the shared tag palette). */
const LANGUAGE_COLORS: Record<string, (typeof TAG_COLORS)[number]['key']> = {
  TypeScript: 'blue',
  JavaScript: 'amber',
  Python: 'teal',
  'C#': 'violet',
  'C++': 'pink',
  C: 'slate',
  'C/C++': 'pink',
  Rust: 'orange',
  Go: 'teal',
  Java: 'red',
  Kotlin: 'violet',
  PHP: 'violet',
  Ruby: 'red',
  GDScript: 'blue',
  Lua: 'blue',
  Dart: 'teal',
  Vue: 'green',
  Svelte: 'orange',
  HTML: 'orange',
  CSS: 'violet',
  SCSS: 'pink',
  SQL: 'amber',
  Shell: 'green',
  PowerShell: 'blue',
  Batch: 'slate',
  'Visual FoxPro': 'amber',
  MQL: 'green',
  Jupyter: 'orange',
};

export function languageColor(name: string): string {
  const key = LANGUAGE_COLORS[name];
  const found = key ? TAG_COLORS.find((c) => c.key === key) : undefined;
  if (found) return found.hex;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length]!.hex;
}

interface Rule {
  /** Dependency names (package.json, requirements, pyproject, Cargo, composer…) or prefixes ending in "*". */
  deps: string[];
  label: string;
  kind?: ProjectKind;
}

/** Libraries worth naming, checked against every dependency list found. Order = display order. */
const DEP_RULES: Rule[] = [
  { deps: ['next'], label: 'Next.js', kind: 'web' },
  { deps: ['nuxt'], label: 'Nuxt', kind: 'web' },
  { deps: ['@angular/core'], label: 'Angular', kind: 'web' },
  { deps: ['react'], label: 'React', kind: 'web' },
  { deps: ['vue'], label: 'Vue', kind: 'web' },
  { deps: ['svelte', '@sveltejs/kit'], label: 'Svelte', kind: 'web' },
  { deps: ['electron'], label: 'Electron', kind: 'app' },
  { deps: ['@tauri-apps/api', 'tauri'], label: 'Tauri', kind: 'app' },
  { deps: ['react-native', 'expo'], label: 'React Native', kind: 'app' },
  { deps: ['@nestjs/core'], label: 'NestJS', kind: 'api' },
  { deps: ['express'], label: 'Express', kind: 'api' },
  { deps: ['fastify'], label: 'Fastify', kind: 'api' },
  { deps: ['koa'], label: 'Koa', kind: 'api' },
  { deps: ['hono'], label: 'Hono', kind: 'api' },
  { deps: ['socket.io', 'ws'], label: 'WebSockets' },
  { deps: ['vite'], label: 'Vite' },
  { deps: ['tailwindcss'], label: 'Tailwind' },
  { deps: ['three'], label: 'three.js', kind: 'game' },
  { deps: ['phaser'], label: 'Phaser', kind: 'game' },
  { deps: ['pixi.js'], label: 'PixiJS', kind: 'game' },
  { deps: ['prisma', '@prisma/client'], label: 'Prisma' },
  { deps: ['drizzle-orm'], label: 'Drizzle' },
  { deps: ['typeorm'], label: 'TypeORM' },
  { deps: ['sequelize'], label: 'Sequelize' },
  { deps: ['mongoose', 'mongodb'], label: 'MongoDB' },
  { deps: ['mysql', 'mysql2', 'pymysql', 'mysqlclient', 'mysql-connector-python'], label: 'MySQL' },
  { deps: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg'], label: 'PostgreSQL' },
  { deps: ['sqlite3', 'better-sqlite3'], label: 'SQLite' },
  { deps: ['redis', 'ioredis'], label: 'Redis' },
  { deps: ['discord.js', 'discord.py'], label: 'Discord' },
  {
    deps: ['telegraf', 'node-telegram-bot-api', 'python-telegram-bot', 'telethon', 'pyrogram', 'aiogram'],
    label: 'Telegram',
  },
  { deps: ['playwright', '@playwright/test', 'puppeteer', 'selenium'], label: 'Browser automation' },
  { deps: ['vitest'], label: 'Vitest' },
  { deps: ['jest'], label: 'Jest' },
  { deps: ['pytest'], label: 'pytest' },
  { deps: ['django'], label: 'Django', kind: 'web' },
  { deps: ['flask'], label: 'Flask', kind: 'api' },
  { deps: ['fastapi'], label: 'FastAPI', kind: 'api' },
  { deps: ['streamlit'], label: 'Streamlit', kind: 'app' },
  { deps: ['pyqt5', 'pyqt6', 'pyside6', 'pyside2'], label: 'Qt', kind: 'app' },
  { deps: ['tkinter', 'customtkinter'], label: 'Tkinter', kind: 'app' },
  { deps: ['pygame'], label: 'Pygame', kind: 'game' },
  { deps: ['pandas'], label: 'pandas', kind: 'data' },
  { deps: ['numpy'], label: 'NumPy' },
  { deps: ['openpyxl', 'xlsxwriter'], label: 'Excel' },
  { deps: ['torch', 'tensorflow', 'scikit-learn', 'sklearn'], label: 'Machine learning', kind: 'data' },
  { deps: ['anthropic', '@anthropic-ai/sdk', 'openai'], label: 'LLM API' },
  { deps: ['pyinstaller'], label: 'PyInstaller', kind: 'app' },
  { deps: ['tokio'], label: 'Tokio' },
  { deps: ['axum', 'actix-web', 'rocket'], label: 'Rust web', kind: 'api' },
  { deps: ['bevy'], label: 'Bevy', kind: 'game' },
  { deps: ['laravel/framework'], label: 'Laravel', kind: 'web' },
];

/** Files or folders at the top level that name a tool or engine on their own. */
const FILE_RULES: { test: (names: Set<string>) => boolean; label: string; kind?: ProjectKind }[] = [
  { test: (n) => n.has('project.godot'), label: 'Godot', kind: 'game' },
  { test: (n) => n.has('projectsettings') && n.has('assets'), label: 'Unity', kind: 'game' },
  { test: (n) => [...n].some((x) => x.endsWith('.uproject')), label: 'Unreal', kind: 'game' },
  { test: (n) => n.has('sconstruct'), label: 'SCons' },
  { test: (n) => n.has('cmakelists.txt'), label: 'CMake' },
  { test: (n) => n.has('makefile'), label: 'Make' },
  {
    test: (n) =>
      n.has('dockerfile') ||
      n.has('docker-compose.yml') ||
      n.has('compose.yml') ||
      n.has('docker-compose.yaml'),
    label: 'Docker',
  },
  { test: (n) => n.has('pubspec.yaml'), label: 'Flutter', kind: 'app' },
  { test: (n) => [...n].some((x) => x.endsWith('.sln')), label: '.NET' },
  { test: (n) => n.has('angular.json'), label: 'Angular', kind: 'web' },
  { test: (n) => n.has('conf.py') || n.has('mkdocs.yml'), label: 'Docs site', kind: 'docs' },
];

/** Language of a manifest, when the manifest alone says it. */
const MANIFEST_LANGUAGE: Record<string, string> = {
  'cargo.toml': 'Rust',
  'go.mod': 'Go',
  'pyproject.toml': 'Python',
  'requirements.txt': 'Python',
  pipfile: 'Python',
  'setup.py': 'Python',
  'composer.json': 'PHP',
  gemfile: 'Ruby',
  'pom.xml': 'Java',
  'build.gradle': 'Java',
  'build.gradle.kts': 'Kotlin',
  'pubspec.yaml': 'Dart',
};

/** Dependency names of every manifest found (lower case). */
export function dependencies(manifests: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [name, text] of Object.entries(manifests)) {
    const base = name.split('/').pop()!;
    if (base === 'package.json' || base === 'composer.json') {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'require', 'require-dev'])
          if (j[key] && typeof j[key] === 'object')
            for (const d of Object.keys(j[key] as object)) out.add(d.toLowerCase());
      } catch {
        /* a broken manifest says nothing */
      }
    } else if (base === 'requirements.txt' || base.startsWith('requirements')) {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.-]+)/.exec(line);
        if (m && !line.trim().startsWith('#') && !line.trim().startsWith('-')) out.add(m[1]!.toLowerCase());
      }
    } else if (base === 'pyproject.toml' || base === 'cargo.toml' || base === 'pipfile') {
      // Names in dependency arrays ("fastapi>=0.1") and tables (tokio = "1").
      for (const m of text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=/gm)) out.add(m[1]!.toLowerCase());
      for (const m of text.matchAll(/"([A-Za-z0-9_.-]+)\s*(?:[<>=!~;[]|")/g)) out.add(m[1]!.toLowerCase());
    } else if (base === 'go.mod') {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gm))
        out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

/** A manifest's own one-line description (package.json, Cargo.toml, pyproject.toml, composer.json). */
function manifestDescription(manifests: Record<string, string>): string | null {
  for (const [name, text] of Object.entries(manifests)) {
    if (name.includes('/')) continue; // top level only
    if (name === 'package.json' || name === 'composer.json') {
      try {
        const d = (JSON.parse(text) as { description?: unknown }).description;
        if (typeof d === 'string' && d.trim()) return d.trim();
      } catch {
        /* ignore */
      }
    } else if (name === 'cargo.toml' || name === 'pyproject.toml') {
      const m = /^\s*description\s*=\s*"([^"]+)"/m.exec(text);
      if (m) return m[1]!.trim();
    }
  }
  return null;
}

/** The README's first real paragraph as plain text (headings, badges, images, HTML and code skipped). */
export function readmeSummary(readme: string | null, max = 280): string | null {
  if (!readme) return null;
  const text = readme
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '');
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(#|!\[|\[!\[|<|>?\s*\||---|===|\*\*\*|-\s*\[)/.test(l));
    if (lines.length === 0) continue;
    const plain = lines
      .join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length < 12) continue;
    const chars = Array.from(plain);
    return chars.length > max
      ? chars
          .slice(0, max - 1)
          .join('')
          .trimEnd() + '…'
      : plain;
  }
  return null;
}

export function analyzeProbe(p: FolderProbe): StackResult {
  const names = new Set(p.names.map((n) => n.toLowerCase()));
  const deps = dependencies(p.manifests);
  const stack: string[] = [];
  const kinds: ProjectKind[] = [];
  const add = (label: string, kind?: ProjectKind) => {
    if (!stack.includes(label)) stack.push(label);
    if (kind) kinds.push(kind);
  };

  // Languages by file count; a manifest's language counts even when the walk found few files.
  const counts = new Map<string, number>();
  for (const [ext, n] of Object.entries(p.extensions)) {
    const lang = LANGUAGES[ext];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + n);
  }
  for (const m of Object.keys(p.manifests)) {
    const lang = MANIFEST_LANGUAGE[m.split('/').pop()!];
    if (lang && !counts.has(lang)) counts.set(lang, 1);
  }
  if ('package.json' in p.manifests && !counts.has('TypeScript') && !counts.has('JavaScript'))
    counts.set(deps.has('typescript') ? 'TypeScript' : 'JavaScript', 1);
  // "C/C++" headers join C++ when there is C++ code, else C.
  const headers = counts.get('C/C++');
  if (headers) {
    counts.delete('C/C++');
    const target = counts.has('C++') || !counts.has('C') ? 'C++' : 'C';
    counts.set(target, (counts.get(target) ?? 0) + headers);
  }
  const languages = [...counts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 8);

  const main = languages.find((l) => !MINOR.has(l.name)) ?? languages[0];
  if (main) add(main.name);
  for (const l of languages)
    if (l !== main && !MINOR.has(l.name) && l.files >= Math.max(3, (main?.files ?? 0) * 0.15)) add(l.name);

  for (const r of FILE_RULES) if (r.test(names)) add(r.label, r.kind);
  for (const r of DEP_RULES) if (r.deps.some((d) => deps.has(d))) add(r.label, r.kind);
  if (names.has('.mq4') || counts.has('MQL')) add('MetaTrader', 'tool');
  if (counts.has('Jupyter')) kinds.push('data');
  if (counts.has('Visual FoxPro')) kinds.push('app');

  const isCode =
    languages.some((l) => !MINOR.has(l.name) || l.files >= 3) || Object.keys(p.manifests).length > 0;
  let kind: ProjectKind | null = kinds[0] ?? null;
  if (!kind && isCode) {
    if (names.has('docs') && languages.length === 0) kind = 'docs';
    else if (
      languages.every((l) => ['Shell', 'PowerShell', 'Batch', 'Python'].includes(l.name)) &&
      languages.reduce((a, l) => a + l.files, 0) <= 5
    )
      kind = 'scripts';
    else kind = 'other';
  }

  return {
    stack: stack.slice(0, 10),
    languages,
    kind: isCode ? kind : null,
    summary: manifestDescription(p.manifests) ?? readmeSummary(p.readme),
    isCode,
  };
}
