import type { ITheme } from '@xterm/xterm';
import { blend } from '@shared/colors';
import { recommendedContrast, resolveScheme } from '@shared/schemes';

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export interface TerminalTheme {
  xterm: ITheme;
  minimumContrast: number;
  dark: boolean;
}

/**
 * xterm theme for a terminal: its color scheme, with the terminal's identification color blended into the
 * background (6% on dark schemes, 4% on light ones, like RDMan's server tint).
 */
export function terminalTheme(schemeId: string, appDark: boolean, color: string | null, tint: boolean): TerminalTheme {
  const s = resolveScheme(schemeId, appDark);
  const background = tint && color ? blend(s.background, color, s.dark ? 0.06 : 0.04) : s.background;
  const selection = s.selection.slice(0, 7);
  const slider = s.dark ? ['#FFFFFF1F', '#FFFFFF38', '#FFFFFF4D'] : ['#00000024', '#0000003D', '#00000052'];
  const xterm: ITheme = {
    background,
    foreground: s.foreground,
    cursor: s.cursor,
    cursorAccent: background,
    selectionBackground: s.selection,
    selectionInactiveBackground: selection + '33',
    scrollbarSliderBackground: slider[0],
    scrollbarSliderHoverBackground: slider[1],
    scrollbarSliderActiveBackground: slider[2],
    overviewRulerBorder: 'transparent',
  };
  ANSI_KEYS.forEach((k, i) => (xterm[k] = s.ansi[i]));
  return { xterm, minimumContrast: recommendedContrast(s), dark: s.dark };
}
