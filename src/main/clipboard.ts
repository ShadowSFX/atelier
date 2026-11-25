import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboard } from 'electron';
import type Koffi from 'koffi';
import { PASTE_IMAGE_TTL_DAYS } from '@shared/constants';
import type { PasteContent } from '@shared/ipc';
import { log } from './log';

/** Windows: CF_HDROP (what Explorer's Copy puts on the clipboard), read through koffi. */
function windowsFileReader(): (() => string[]) | null {
  try {
    // Loaded lazily: a missing native binary must only disable this feature.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof Koffi;
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    const OpenClipboard = user32.func('bool __stdcall OpenClipboard(void *hWnd)');
    const CloseClipboard = user32.func('bool __stdcall CloseClipboard()');
    const GetClipboardData = user32.func('void * __stdcall GetClipboardData(uint32 fmt)');
    const IsClipboardFormatAvailable = user32.func('bool __stdcall IsClipboardFormatAvailable(uint32 fmt)');
    const DragQueryFileW = shell32.func(
      'uint32 __stdcall DragQueryFileW(void *hDrop, uint32 i, _Out_ uint16 *buf, uint32 cch)',
    );
    const CF_HDROP = 15;
    return () => {
      if (!IsClipboardFormatAvailable(CF_HDROP)) return [];
      // Another app may hold the clipboard for a moment.
      let opened = false;
      for (let i = 0; i < 5 && !opened; i++) opened = OpenClipboard(null);
      if (!opened) return [];
      try {
        const drop = GetClipboardData(CF_HDROP);
        if (!drop) return [];
        const count = DragQueryFileW(drop, 0xffffffff, null, 0);
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          const len = DragQueryFileW(drop, i, null, 0);
          const buf = new Uint16Array(len + 1);
          DragQueryFileW(drop, i, buf, len + 1);
          out.push(Buffer.from(buf.buffer, 0, len * 2).toString('utf16le'));
        }
        return out;
      } finally {
        CloseClipboard();
      }
    };
  } catch (err) {
    log.warn('clipboard file reader unavailable', err);
    return null;
  }
}

/** Linux: file managers put file:// URIs in text/uri-list. */
async function linuxFiles(items: Electron.ClipboardItem[]): Promise<string[]> {
  const item = items.find((i) => i.types.includes('text/uri-list'));
  if (!item) return [];
  const raw = await (await item.getType('text/uri-list')).text();
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .flatMap((l) => {
      try {
        return [fileURLToPath(l)];
      } catch {
        return [];
      }
    });
}

export class ClipboardService {
  private readonly windowsFiles = process.platform === 'win32' ? windowsFileReader() : null;
  private counter = 0;

  constructor(private readonly pastesDir: string) {}

  /** Files win (their paths are pasted), then text, then an image (saved as PNG; its path is pasted). */
  async read(): Promise<PasteContent> {
    let items: Electron.ClipboardItem[] = [];
    try {
      items = await clipboard.read();
    } catch (err) {
      log.warn('clipboard read failed', err);
    }
    try {
      const files = this.windowsFiles ? this.windowsFiles() : await linuxFiles(items);
      if (files.length > 0) return { kind: 'files', paths: files };
    } catch (err) {
      log.warn('clipboard files failed', err);
    }
    const text = await clipboard.readText().catch(() => '');
    if (text) return { kind: 'text', text };
    const image = items.find((i) => i.types.includes('image/png'));
    if (image) {
      const png = Buffer.from(await (await image.getType('image/png')).arrayBuffer());
      if (png.length > 0) {
        mkdirSync(this.pastesDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const path = join(this.pastesDir, `paste-${stamp}-${++this.counter}.png`);
        writeFileSync(path, png);
        return { kind: 'image', path };
      }
    }
    return { kind: 'empty' };
  }

  async writeText(text: string): Promise<void> {
    await clipboard.writeText(text);
  }

  /** Deletes pasted images older than PASTE_IMAGE_TTL_DAYS. */
  cleanup(): void {
    const limit = Date.now() - PASTE_IMAGE_TTL_DAYS * 86_400_000;
    let names: string[];
    try {
      names = readdirSync(this.pastesDir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(this.pastesDir, n);
      try {
        if (statSync(p).mtimeMs < limit) rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
