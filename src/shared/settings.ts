import { z } from 'zod';

/**
 * App settings. Defaults and ranges follow RDMan's TerminalSettings. Loading is tolerant: an invalid or missing
 * value falls back to its default instead of discarding the whole file.
 */
const num = (def: number, min: number, max: number) =>
  z.number().catch(def).default(def).transform((v) => Math.min(max, Math.max(min, v)));
const oneOf = <T extends string>(values: readonly [T, ...T[]], def: T) => z.enum(values).catch(def).default(def);
const bool = (def: boolean) => z.boolean().catch(def).default(def);
const str = (def: string) => z.string().catch(def).default(def);

export const SettingsSchema = z.object({
  language: oneOf(['system', 'es', 'en'], 'system'),
  theme: oneOf(['system', 'dark', 'light'], 'system'),
  fontFamily: str('Cascadia Code NF'),
  fontSize: num(13, 8, 32),
  lineHeight: num(1.15, 1, 2),
  letterSpacing: num(0, -2, 4),
  fontWeight: num(400, 100, 900).transform((v) => Math.floor(v / 100) * 100),
  fontWeightBold: num(700, 100, 900).transform((v) => Math.floor(v / 100) * 100),
  /** gpu = WebGL (grayscale antialiasing), subpixel = DOM renderer (ClearType-style). */
  renderer: oneOf(['gpu', 'subpixel'], 'gpu'),
  cursor: oneOf(['bar', 'block', 'underline'], 'bar'),
  cursorBlink: bool(true),
  scrollback: num(10000, 0, 200000).transform(Math.round),
  colorScheme: str('auto'),
  minimumContrast: num(1, 1, 7),
  /** Tint each terminal's background with its color. */
  tintWithColor: bool(true),
  copyOnSelect: bool(false),
  smartCtrlC: bool(true),
  rightClick: oneOf(['menu', 'copypaste'], 'menu'),
  warnMultilinePaste: bool(true),
  bell: oneOf(['visual', 'sound', 'off'], 'visual'),
  wordSeparators: str(' ()[]{}\',"`|;:<>'),
  /** Profile id used by "+"; empty = platform default. */
  defaultProfile: str(''),
  /** Replace the shell prompt with Atelier's powerline prompt (shell integration stays on either way). */
  powerlinePrompt: bool(true),
  /** Make `claude` inside Atelier use the project-scoped hub. */
  claudeHub: bool(true),
  sidebarWidth: num(272, 200, 480).transform(Math.round),
  confirmCloseRunning: bool(true),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = Partial<Settings>;

export function parseSettings(raw: unknown): Settings {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return SettingsSchema.parse(obj);
}

export const DEFAULT_SETTINGS: Settings = parseSettings({});
