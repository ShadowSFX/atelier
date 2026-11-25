/**
 * Self-update planning for the portable Windows exe (port of RDMan's UpdatePlanner): a GitHub release is used only
 * when it is a newer, final version that carries both `Atelier.exe` and `Atelier.exe.sha256`.
 */

export const UPDATE_OWNER = 'ShadowSFX';
export const UPDATE_REPO = 'atelier';
export const RELEASES_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;

export const EXE_ASSET = 'Atelier.exe';
export const CHECKSUM_ASSET = 'Atelier.exe.sha256';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  htmlUrl: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdatePlan {
  release: ReleaseInfo;
  exe: ReleaseAsset;
  checksum: ReleaseAsset;
}

interface Version {
  nums: [number, number, number];
  pre: string;
}

/** `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, `1.2.3+build` → parts; null when it isn't a version. */
export function parseVersion(text: string | null | undefined): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec((text ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/** Negative when a < b, 0 when equal, positive when a > b. Unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return (va ? 1 : 0) - (vb ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const d = va.nums[i]! - vb.nums[i]!;
    if (d !== 0) return d;
  }
  // A final release is newer than its prereleases.
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  return va.pre < vb.pre ? -1 : 1;
}

/** A GitHub "release" object (from /releases/latest); null when it isn't usable. */
export function parseRelease(json: string): ReleaseInfo | null {
  let r: unknown;
  try {
    r = JSON.parse(json);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const tag = typeof o.tag_name === 'string' ? o.tag_name : null;
  const v = parseVersion(tag);
  if (!tag || !v) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(o.assets)) {
    for (const a of o.assets as unknown[]) {
      if (!a || typeof a !== 'object') continue;
      const x = a as Record<string, unknown>;
      if (
        typeof x.name === 'string' &&
        x.name &&
        typeof x.browser_download_url === 'string' &&
        x.browser_download_url
      )
        assets.push({
          name: x.name,
          url: x.browser_download_url,
          size: typeof x.size === 'number' && x.size > 0 ? x.size : 0,
        });
    }
  }
  return {
    tag,
    version: tag.replace(/^v/, ''),
    htmlUrl: typeof o.html_url === 'string' ? o.html_url : RELEASES_URL,
    draft: o.draft === true,
    prerelease: o.prerelease === true,
    assets,
  };
}

/**
 * The update to install, or null (draft, prerelease, not newer, or a missing asset). `allowSame` also takes the
 * current version: an installed copy (old NSIS setup) replaces itself with the portable exe of its own version.
 */
export function planUpdate(current: string, release: ReleaseInfo | null, allowSame = false): UpdatePlan | null {
  if (!release || release.draft || release.prerelease) return null;
  if (parseVersion(release.version)?.pre) return null;
  if (!parseVersion(current)) return null;
  const cmp = compareVersions(release.version, current);
  if (cmp < 0 || (cmp === 0 && !allowSame)) return null;
  const find = (name: string) => release.assets.find((a) => a.name.toLowerCase() === name.toLowerCase());
  const exe = find(EXE_ASSET);
  const checksum = find(CHECKSUM_ASSET);
  if (!exe || !checksum) return null;
  return { release, exe, checksum };
}

/** The hex digest of a sha256 file (`<hex>` or `<hex>  Atelier.exe`), lower case; null when invalid. */
export function parseChecksum(content: string): string | null {
  const token = content
    .trim()
    .split(/[\s*]+/)
    .find((s) => s.length > 0);
  return token && /^[0-9a-fA-F]{64}$/.test(token) ? token.toLowerCase() : null;
}
