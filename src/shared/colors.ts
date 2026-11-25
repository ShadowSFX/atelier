/** Identification colors for projects and terminals (same set as RDMan's server tags). */
export const TAG_COLORS = [
  { key: 'blue', hex: '#4C8DF6' },
  { key: 'teal', hex: '#22A699' },
  { key: 'green', hex: '#4CAF50' },
  { key: 'amber', hex: '#E0A526' },
  { key: 'orange', hex: '#E8743B' },
  { key: 'red', hex: '#E5484D' },
  { key: 'pink', hex: '#D6409F' },
  { key: 'violet', hex: '#8E6CEF' },
  { key: 'slate', hex: '#7A8699' },
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** A color as stored: '#RRGGBB' or null (no color). Anything else becomes null. */
export function normalizeColor(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : null;
}

/** Mixes `fg` into `bg` by `amount` (0-1). Both '#RRGGBB'. */
export function blend(bg: string, fg: string, amount: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const mix = (i: number) => Math.round(p(bg, i) * (1 - amount) + p(fg, i) * amount);
  return '#' + [1, 3, 5].map((i) => mix(i).toString(16).padStart(2, '0')).join('').toUpperCase();
}
