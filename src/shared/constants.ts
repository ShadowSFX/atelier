/** Tunables shared by main and renderer. Change them here only. */

/** PTY output is merged for this long before it is sent to the renderer. */
export const PTY_BATCH_MS = 8;
/** Main pauses the PTY when this many characters are written but not yet acknowledged by xterm. */
export const FLOW_HIGH_WATER = 100_000;
/** ...and resumes it when the backlog drops below this. */
export const FLOW_LOW_WATER = 5_000;
/** The renderer acknowledges written characters at most this often. */
export const ACK_INTERVAL_MS = 8;
/** Input is written to the PTY in chunks of this size (large pastes). */
export const INPUT_CHUNK = 16 * 1024;

/** At most this many terminals are shown side by side. */
export const MAX_COLUMNS = 3;
/** Smallest column weight (fraction of the content width) a splitter drag can leave. */
export const MIN_COLUMN_WEIGHT = 0.15;

/** WebGL contexts kept alive: the visible terminals plus this many recently shown ones. */
export const WEBGL_LRU_EXTRA = 3;

/** Snapshot of a terminal's screen kept for restore (characters). */
export const SNAPSHOT_MAX_CHARS = 2_000_000;
export const SNAPSHOT_INTERVAL_MS = 60_000;

export const STATS_INTERVAL_MS = 2_000;

/** Claude hub limits. */
export const HUB_MAX_MESSAGE = 8_000;
export const HUB_RATE_PER_MINUTE = 20;
export const HUB_MAX_QUEUE = 50;
export const HUB_MAX_READ_LINES = 500;
/** A title Claude gives its terminal (atelier_set_title), in characters. */
export const HUB_MAX_TITLE = 48;

/** Pasted clipboard images are deleted after this many days. */
export const PASTE_IMAGE_TTL_DAYS = 7;
