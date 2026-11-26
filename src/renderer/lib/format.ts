/** 1536 → "1.5 KB"; binary units, one decimal under 10. */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Status bar levels, from RDMan's server stats: warn at 85%, danger at 95%. */
export function levelOf(fraction: number): 'danger' | 'warn' | 'ok' {
  return fraction >= 0.95 ? 'danger' : fraction >= 0.85 ? 'warn' : 'ok';
}

/** Shortens a directory for a one-line caption: home → ~, long paths keep the last segments. */
export function shortPath(path: string, home?: string): string {
  let p = path;
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) p = '~' + p.slice(home.length);
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return p;
  return ['…', ...parts.slice(-2)].join(sep);
}
