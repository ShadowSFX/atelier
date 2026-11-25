/** Terminal color schemes (ported from RDMan's TerminalSchemes.cs). */
export interface Scheme {
  id: string;
  name: string;
  dark: boolean;
  background: string;
  foreground: string;
  cursor: string;
  /** #RRGGBBAA */
  selection: string;
  /** ANSI 0-15 */
  ansi: readonly string[];
}

const s = (
  id: string,
  name: string,
  dark: boolean,
  [background, foreground, cursor, selection]: [string, string, string, string],
  ansi: string,
): Scheme => ({ id, name, dark, background, foreground, cursor, selection, ansi: ansi.split(' ') });

export const SCHEMES: readonly Scheme[] = [
  s('atelier-night', 'Atelier Night', true, ['#1B1F26', '#E0E4EB', '#7480FF', '#7480FF4D'],
    '#2A303A #F0605D #4CC777 #E0AE45 #6E9BFF #C38BF5 #3EC6D6 #C9CFD9 #4A5262 #FF7A77 #6FDC92 #F2C462 #8FB2FF #D6A6FF #6ADBE8 #F4F6FA'),
  s('atelier-day', 'Atelier Day', false, ['#FFFFFF', '#1F2430', '#4F5BD5', '#4F5BD540'],
    '#191D25 #C8323A #1E8A46 #9A6A12 #2F5FD0 #8E44C4 #0E7F92 #E4E7EC #4E5767 #D63C3C #23A055 #B7791F #4F5BD5 #A35AD8 #138FA5 #FFFFFF'),
  s('tokyo-night', 'Tokyo Night', true, ['#1A1B26', '#C0CAF5', '#C0CAF5', '#33467C4D'],
    '#15161E #F7768E #9ECE6A #E0AF68 #7AA2F7 #BB9AF7 #7DCFFF #A9B1D6 #414868 #F7768E #9ECE6A #E0AF68 #7AA2F7 #BB9AF7 #7DCFFF #C0CAF5'),
  s('catppuccin-mocha', 'Catppuccin Mocha', true, ['#1E1E2E', '#CDD6F4', '#F5E0DC', '#585B7066'],
    '#45475A #F38BA8 #A6E3A1 #F9E2AF #89B4FA #F5C2E7 #94E2D5 #BAC2DE #585B70 #F38BA8 #A6E3A1 #F9E2AF #89B4FA #F5C2E7 #94E2D5 #A6ADC8'),
  s('catppuccin-latte', 'Catppuccin Latte', false, ['#EFF1F5', '#4C4F69', '#DC8A78', '#ACB0BE66'],
    '#5C5F77 #D20F39 #40A02B #DF8E1D #1E66F5 #EA76CB #179299 #ACB0BE #6C6F85 #D20F39 #40A02B #DF8E1D #1E66F5 #EA76CB #179299 #BCC0CC'),
  s('dracula', 'Dracula', true, ['#282A36', '#F8F8F2', '#F8F8F2', '#44475A66'],
    '#21222C #FF5555 #50FA7B #F1FA8C #BD93F9 #FF79C6 #8BE9FD #F8F8F2 #6272A4 #FF6E6E #69FF94 #FFFFA5 #D6ACFF #FF92DF #A4FFFF #FFFFFF'),
  s('nord', 'Nord', true, ['#2E3440', '#D8DEE9', '#D8DEE9', '#434C5E66'],
    '#3B4252 #BF616A #A3BE8C #EBCB8B #81A1C1 #B48EAD #88C0D0 #E5E9F0 #4C566A #BF616A #A3BE8C #EBCB8B #81A1C1 #B48EAD #8FBCBB #ECEFF4'),
  s('gruvbox-dark', 'Gruvbox Dark', true, ['#282828', '#EBDBB2', '#EBDBB2', '#50494566'],
    '#282828 #CC241D #98971A #D79921 #458588 #B16286 #689D6A #A89984 #928374 #FB4934 #B8BB26 #FABD2F #83A598 #D3869B #8EC07C #EBDBB2'),
  s('solarized-dark', 'Solarized Dark', true, ['#002B36', '#839496', '#93A1A1', '#07364266'],
    '#073642 #DC322F #859900 #B58900 #268BD2 #D33682 #2AA198 #EEE8D5 #002B36 #CB4B16 #586E75 #657B83 #839496 #6C71C4 #93A1A1 #FDF6E3'),
  s('solarized-light', 'Solarized Light', false, ['#FDF6E3', '#657B83', '#586E75', '#EEE8D566'],
    '#073642 #DC322F #859900 #B58900 #268BD2 #D33682 #2AA198 #EEE8D5 #002B36 #CB4B16 #586E75 #657B83 #839496 #6C71C4 #93A1A1 #FDF6E3'),
  s('one-half-dark', 'One Half Dark', true, ['#282C34', '#DCDFE4', '#A3B3CC', '#474E5D66'],
    '#282C34 #E06C75 #98C379 #E5C07B #61AFEF #C678DD #56B6C2 #DCDFE4 #5D677A #E06C75 #98C379 #E5C07B #61AFEF #C678DD #56B6C2 #DCDFE4'),
  s('one-half-light', 'One Half Light', false, ['#FAFAFA', '#383A42', '#BFCEFF', '#BFCEFF66'],
    '#383A42 #E45649 #50A14F #C18401 #0184BC #A626A4 #0997B3 #FAFAFA #4F525E #E06C75 #98C379 #E5C07B #61AFEF #C678DD #56B6C2 #FFFFFF'),
];

/** 'auto' (or an unknown id) follows the app theme. */
export function resolveScheme(id: string, appDark: boolean): Scheme {
  const found = SCHEMES.find((x) => x.id === id);
  if (found) return found;
  return SCHEMES.find((x) => x.id === (appDark ? 'atelier-night' : 'atelier-day'))!;
}

/** Light schemes need a contrast floor so dim ANSI colors stay readable (RDMan's recommendation). */
export function recommendedContrast(scheme: Scheme): number {
  return scheme.dark ? 1 : 4.5;
}
