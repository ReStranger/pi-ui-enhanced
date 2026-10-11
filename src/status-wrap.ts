import { homedir, tmpdir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";

/**
 * Custom footer component for pi-coding-agent.
 *
 * It renders working directory, git branch, token statistics, and extension
 * status lines. Extensions register status line transforms with
 * `registerStatusRewrite(key, rewrite)`.
 */

/** Helpers passed to every rewrite. `theme` is undefined in unit tests. */
export interface RewriteHelpers {
  theme: FooterTheme | undefined;
}

/**
 * Transforms a status line string, or returns `undefined` to hide it.
 * Colors come from `helpers.theme.fg(...)`.
 */
export type StatusRewrite = (
  raw: string | undefined,
  helpers: RewriteHelpers,
) => string | undefined;

const rewrites = new Map<string, StatusRewrite[]>();

/** Register a rewrite for a status key. Returns an unsubscribe function. */
export function registerStatusRewrite(
  key: string,
  rewrite: StatusRewrite,
): () => void {
  const list = rewrites.get(key) ?? [];
  list.push(rewrite);
  rewrites.set(key, list);
  return () => unregisterStatusRewrite(key, rewrite);
}

export function unregisterStatusRewrite(
  key: string,
  rewrite: StatusRewrite,
): void {
  const list = rewrites.get(key);
  if (!list) return;
  const index = list.indexOf(rewrite);
  if (index >= 0) list.splice(index, 1);
  if (list.length === 0) rewrites.delete(key);
}

/** Test helper: drop all registered rewrites. */
export function clearStatusRewrites(): void {
  rewrites.clear();
}

/** Run every rewrite chained for `key`. A throwing rewrite is skipped. */
export function applyStatusRewrite(
  key: string,
  raw: string | undefined,
  theme?: FooterTheme,
): string | undefined {
  const list = rewrites.get(key);
  if (!list) return raw;
  const helpers: RewriteHelpers = { theme };
  let current = raw;
  for (const rewrite of list) {
    try {
      current = rewrite(current, helpers);
    } catch {
      // A rewrite must never break the footer.
    }
  }
  return current;
}

/**
 * Formats text with ANSI strikethrough (SGR 9 to SGR 29).
 * Stripping terminal sequences leaves width calculations unaffected.
 */
export function strike(text: string): string {
  return `\x1b[9m${text}\x1b[29m`;
}

/** Formats text with ANSI dim (SGR 2 to SGR 22). */
export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

/**
 * Whether this context renders the interactive editor UI. Subagent children
 * load these extensions too, but run headless (print mode, no UI), so every
 * UI write is gated on this.
 *
 * Total by construction: a context invalidated by a session replacement or
 * reload throws from every getter (`assertActive`), and this is the one place
 * that reads them, so it must not propagate — a status refresh may lose its
 * race with the teardown and there is no UI left to write to anyway.
 */
export function rendersEditorUi(
  ctx: Pick<ExtensionContext, "mode" | "hasUI">,
): boolean {
  try {
    return ctx.mode === "tui" && ctx.hasUI === true;
  } catch {
    return false;
  }
}
/** Stock sanitize that keeps statuses on one line and preserves ANSI. */
export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Stock token formatter, copied from `FooterComponent`. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Nerd Font folder icon (fa-folder, U+F07B). */
export const FOLDER_ICON = "\uF07B";

/** Color slot for folder icon and path. */
export const FOLDER_COLOR: ThemeColor = "thinkingLow";

/** Nerd Font fork icon (fa-code-fork, U+F126, one cell in NF builds). */
export const BRANCH_ICON = "\uF126";

/**
 * Diff icon after the branch (user-supplied codepoint U+F07C, one cell in NF
 * builds). Written as an escape for transport safety.
 */
export const DIFF_ICON = "\uF07C";

/**
 * How long a git result is reused. The footer renders far more often than git
 * state changes, so without a TTL every render would spawn git.
 */
export const GIT_DIRTY_TTL_MS = 5000;

/**
 * How long a failed git spawn (not a repository, no git binary) is reused
 * before another attempt. Without this backoff a non-git cwd would spawn a
 * doomed `git` process on every TTL expiry, forever.
 */
export const GIT_MISS_TTL_MS = GIT_DIRTY_TTL_MS * 10;

/** Per-cwd worktree numbers: `main* \uF07C +19 ~48 -2`. */
export interface WorktreeStats {
  dirty: boolean;
  /** Added lines (`git diff HEAD --numstat`). */
  added: number;
  /** Deleted lines. */
  deleted: number;
  /** Untracked files (`??` in porcelain). */
  untracked: number;
}

const CLEAN_STATS: WorktreeStats = {
  dirty: false,
  added: 0,
  deleted: 0,
  untracked: 0,
};

export interface GitStatusCacheEntry {
  branch?: string;
  stats: WorktreeStats;
  /** Epoch ms of the last successful git read for this cwd. */
  lastCheck: number;
  /**
   * True when the last git read failed (not a repo, no binary). A missed entry
   * is re-checked every `GIT_MISS_TTL_MS` instead of `GIT_DIRTY_TTL_MS`.
   */
  missed?: boolean;
}

const gitStatsCache = new Map<string, GitStatusCacheEntry>();
const refreshingCwds = new Set<string>();

let gitRenderCallback: (() => void) | undefined;
let activeContext: ExtensionContext | undefined;

export function setGitRenderCallback(
  callback: (() => void) | undefined,
): void {
  gitRenderCallback = callback;
}

function notifyGitChanged(): void {
  // `gitRenderCallback` is `tui.requestRender` (with a `ctx.ui` fallback wired
  // by `installWrappedFooter`), so one call covers both render paths.
  try {
    gitRenderCallback?.();
  } catch {
    try {
      (activeContext?.ui as { requestRender?: () => void })?.requestRender?.();
    } catch {
      // Context requestRender must not throw
    }
  }
}

/** Check if background git check is in progress. */
export function isGitRefreshing(cwd?: string): boolean {
  return cwd ? refreshingCwds.has(cwd) : refreshingCwds.size > 0;
}

/** Test helper: drop cached git results. */
export function clearGitDirtyCache(): void {
  gitStatsCache.clear();
  refreshingCwds.clear();
}

/** Pure: any output from `git status --porcelain` means uncommitted changes. */
export function porcelainIsDirty(output: string): boolean {
  return output.trim().length > 0;
}

/** Pure: count `??` entries in porcelain output. */
export function countUntracked(porcelain: string): number {
  let count = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("??")) count++;
  }
  return count;
}

/** Pure: parse branch name from porcelain v1 branch line (`## <branch>...<upstream>`). */
export function parsePorcelainBranch(line: string): string | undefined {
  if (!line.startsWith("## ")) return undefined;
  const content = line.slice(3).trim();
  if (!content) return undefined;
  if (
    content.startsWith("HEAD (no branch)") ||
    content.startsWith("(detached")
  ) {
    return "HEAD";
  }
  if (content.startsWith("No commits yet on ")) {
    return content.slice("No commits yet on ".length).trim();
  }
  if (content.startsWith("Initial commit on ")) {
    return content.slice("Initial commit on ".length).trim();
  }
  const dotIndex = content.indexOf("...");
  if (dotIndex >= 0) {
    return content.slice(0, dotIndex).trim();
  }
  const spaceIndex = content.indexOf(" ");
  return spaceIndex >= 0 ? content.slice(0, spaceIndex).trim() : content;
}

/** Pure: sum added/deleted lines from `git diff --numstat` (`- -` means binary). */
export function parseNumstat(output: string): {
  added: number;
  deleted: number;
} {
  let added = 0;
  let deleted = 0;
  for (const line of output.split("\n")) {
    const match = line.match(/^(\d+)\s+(\d+)\s+/);
    if (match?.[1] && match?.[2]) {
      added += Number(match[1]);
      deleted += Number(match[2]);
    }
  }
  return { added, deleted };
}

/** Git output readers; injectable for synchronous unit tests. */
export interface GitReaders {
  porcelain: (cwd: string) => string | undefined;
  numstat: (cwd: string) => string | undefined;
}

export type AsyncGitRunner = (
  cwd: string,
  args: string[],
) => Promise<string | undefined>;

let customGitRunner: AsyncGitRunner | undefined;

/** Test helper: set custom async git runner. */
export function setCustomGitRunner(runner: AsyncGitRunner | undefined): void {
  customGitRunner = runner;
}

function execGitAsync(
  cwd: string,
  args: string[],
  timeoutMs: number = 3000,
): Promise<string | undefined> {
  if (customGitRunner) {
    return customGitRunner(cwd, args);
  }
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
          } else {
            resolve(typeof stdout === "string" ? stdout : undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Trigger an asynchronous background git status refresh for `cwd`.
 * Guarded against concurrent runs for the same cwd.
 */
export function triggerGitRefresh(cwd: unknown): Promise<void> {
  if (typeof cwd !== "string" || cwd.length === 0) return Promise.resolve();
  if (refreshingCwds.has(cwd)) return Promise.resolve();
  refreshingCwds.add(cwd);

  return (async () => {
    try {
      const rawStatus = await execGitAsync(cwd, [
        "status",
        "--porcelain=v1",
        "-b",
        "--untracked-files=normal",
      ]);
      const now = Date.now();
      if (rawStatus === undefined) {
        // A failed spawn means this cwd is not a worktree (or git is missing).
        // Cache it as a miss so the backoff suppresses the next doomed spawn.
        const previous = gitStatsCache.get(cwd);
        const changed =
          previous !== undefined &&
          (previous.branch !== undefined || previous.stats.dirty);
        gitStatsCache.set(cwd, {
          stats: { ...CLEAN_STATS },
          branch: undefined,
          lastCheck: now,
          missed: true,
        });
        if (changed) {
          notifyGitChanged();
        }
        return;
      }

      const lines = rawStatus.split("\n");
      const firstLine = lines[0] ?? "";
      const branch = parsePorcelainBranch(firstLine);
      const porcelainBody = lines.slice(1).join("\n");
      const isDirty = porcelainIsDirty(porcelainBody);
      const untracked = countUntracked(porcelainBody);

      let added = 0;
      let deleted = 0;
      if (isDirty) {
        const numstatOut = await execGitAsync(cwd, [
          "diff",
          "HEAD",
          "--numstat",
        ]);
        if (numstatOut !== undefined) {
          const parsed = parseNumstat(numstatOut);
          added = parsed.added;
          deleted = parsed.deleted;
        }
      }

      const newStats: WorktreeStats = {
        dirty: isDirty,
        added,
        deleted,
        untracked,
      };

      const previous = gitStatsCache.get(cwd);
      const changed =
        !previous ||
        previous.branch !== branch ||
        previous.stats.dirty !== newStats.dirty ||
        previous.stats.added !== newStats.added ||
        previous.stats.deleted !== newStats.deleted ||
        previous.stats.untracked !== newStats.untracked;

      gitStatsCache.set(cwd, {
        branch,
        stats: newStats,
        lastCheck: now,
      });

      if (changed) {
        notifyGitChanged();
      }
    } catch {
      // Background git check must never throw or break caller
    } finally {
      refreshingCwds.delete(cwd);
    }
  })();
}

/**
 * Pure staleness test for a cache entry: a failed git read (not a repository,
 * missing binary) re-checks on the longer miss backoff, a good result on the
 * regular TTL. No side effects, so render-path callers can call it freely.
 */
export function isGitStaleAt(
  cached: GitStatusCacheEntry,
  cwdChanged: boolean,
  now: number,
): boolean {
  const ttl = cached.missed ? GIT_MISS_TTL_MS : GIT_DIRTY_TTL_MS;
  return cwdChanged || now - cached.lastCheck >= ttl;
}

/**
 * Return cached git status info immediately without blocking.
 * Triggers a background refresh if the cache is stale (GIT_DIRTY_TTL_MS, or
 * GIT_MISS_TTL_MS after a failed git spawn) or the cwd changed.
 */
export function getCachedGitInfo(
  cwd: unknown,
  now: number = Date.now(),
): GitStatusCacheEntry {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return {
      stats: { ...CLEAN_STATS },
      branch: undefined,
      lastCheck: 0,
    };
  }
  const cached = gitStatsCache.get(cwd);
  if (!cached || isGitStaleAt(cached, false, now)) {
    void triggerGitRefresh(cwd);
  }
  return cached ?? { stats: { ...CLEAN_STATS }, branch: undefined, lastCheck: 0 };
}

/**
 * Return cached branch name immediately, or empty string if not yet loaded.
 * Triggers background refresh asynchronously if needed.
 */
export function getCachedGitBranch(
  cwd: unknown,
  now: number = Date.now(),
): string {
  return getCachedGitInfo(cwd, now).branch ?? "";
}

/**
 * Worktree numbers for `cwd`, cached per cwd for GIT_DIRTY_TTL_MS because the
 * footer renders far more often than git state changes. Never blocks the render
 * loop with synchronous git execution; background refresh runs asynchronously.
 * `readers` is injectable for synchronous unit tests.
 */
export function getWorktreeStats(
  cwd: unknown,
  now: number = Date.now(),
  readers?: GitReaders,
): WorktreeStats {
  if (typeof cwd !== "string" || cwd.length === 0) return { ...CLEAN_STATS };
  if (readers) {
    const cached = gitStatsCache.get(cwd);
    if (cached && now - cached.lastCheck < GIT_DIRTY_TTL_MS) {
      return cached.stats;
    }
    let stats: WorktreeStats = { ...CLEAN_STATS };
    try {
      const porcelain = readers.porcelain(cwd);
      if (porcelain !== undefined) {
        stats = {
          dirty: porcelainIsDirty(porcelain),
          added: 0,
          deleted: 0,
          untracked: countUntracked(porcelain),
        };
        const numstat = readers.numstat(cwd);
        if (numstat !== undefined) {
          const { added, deleted } = parseNumstat(numstat);
          stats.added = added;
          stats.deleted = deleted;
        }
      }
    } catch {
      stats = { ...CLEAN_STATS };
    }
    gitStatsCache.set(cwd, {
      stats,
      branch: cached?.branch,
      lastCheck: now,
    });
    return stats;
  }

  return getCachedGitInfo(cwd, now).stats;
}

/**
 * True when `cwd` has uncommitted changes (staged, unstaged, untracked).
 * Thin wrapper over getWorktreeStats (kept for the older call sites/tests).
 */
export function isWorktreeDirty(
  cwd: unknown,
  now: number = Date.now(),
  readers?: GitReaders,
): boolean {
  return getWorktreeStats(cwd, now, readers).dirty;
}

/**
 * Branch icon and name color, which is the orange slot (`thinkingMax` maps to
 * stylix `orange` #ff9c6a). This is deliberately not the `accent` token,
 * because stylix resolves `accent` to pink (#f17ac6). Use `"accent"` here if
 * that is what you want.
 */
export const BRANCH_COLOR: ThemeColor = "thinkingMax";

/**
 * Basename of the cwd for the footer, so only the folder name appears and never
 * the full path (`/a/b/proj` gives `proj`). Non-string or empty input, which a
 * half-initialized context at `session_start` produces, yields `"?"` instead of
 * throwing, because a throwing footer render blanks the whole footer area.
 */
export function folderNameForFooter(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0) return "?";
  // `basename` follows the host path semantics, so a Windows cwd
  // (`C:\a\b`) also resolves to its last segment. `split("/")` would not.
  const name = basename(cwd);
  return name.length > 0 ? name : cwd;
}

/** The only theme API the footer render needs. A real `Theme` satisfies it. */
export type FooterTheme = Pick<Theme, "fg">;

/** Live footer data, rebuilt per render from `ExtensionContext` and the provider. */
export interface WrappedFooterSource {
  getCwd(): string;
  getSessionName(): string | undefined;
  getBranch(): string | null;
  getProviderCount(): number;
  getModelId(): string;
  getModelProvider(): string | undefined;
  /** e.g. "high"; `undefined` hides the thinking suffix (no reasoning support). */
  getThinkingLabel(): string | undefined;
  /**
   * Left stats cell (tokens + context). It may contain ANSI: the context
   * percentage is colored at the stock error/warning thresholds. The theme is
   * passed in so it can colorize without reaching for the global theme.
   */
  getStatsLeft(theme: FooterTheme): string;
  getStatuses(): ReadonlyMap<string, string>;
}

/** Test hooks for deterministic time and injectable git readers. */
export interface FooterRenderOptions {
  now?: number;
  readers?: GitReaders;
}

/**
 * Status keys pinned to the front of the statuses line, in this order.
 * Everything else keeps the stock alphabetical order after them. `plan-mode`
 * belongs to @hank-warren/pi-plan-mode.
 */
export const STATUS_PIN_FIRST: string[] = ["plan-mode"];

/** Pinned keys first in the listed order, then the rest alphabetically. */
export function sortStatusKeys(keys: Iterable<string>): string[] {
  const all = [...keys];
  const pinned = STATUS_PIN_FIRST.filter((key) => all.includes(key));
  const rest = all
    .filter((key) => !STATUS_PIN_FIRST.includes(key))
    .sort((a, b) => a.localeCompare(b));
  return [...pinned, ...rest];
}

/**
 * Render the wrapped footer. The stock pwd and stats lines come first, then the
 * statuses line with every registered rewrite applied and sorted by key, like
 * stock. This never throws, because a throwing footer render blanks the whole
 * footer area. Failures are logged to `footerLogPath()` and a one-line
 * placeholder is returned.
 */
export function renderWrappedFooter(
  width: number,
  theme: FooterTheme,
  source: WrappedFooterSource,
  options: FooterRenderOptions = {},
): string[] {
  try {
    return renderWrappedFooterUnsafe(width, theme, source, options);
  } catch (error) {
    logFooterError("render failed", error);
    // The fallback stays inside the frame width, since an over-wide line would
    // wrap and shove the whole footer area around.
    return [
      truncateToWidth(
        `[footer error: ${footerLogPath()}]`,
        width,
        theme.fg("dim", "..."),
      ),
    ];
  }
}

/** Debug log for footer failures (see `renderWrappedFooter`). Safe per-user path. */
export function footerLogPath(): string {
  try {
    if (process.env.XDG_STATE_HOME) {
      return join(
        process.env.XDG_STATE_HOME,
        "pi",
        "pi-ui-enhanced-footer.log",
      );
    }
    const home = homedir();
    if (home) {
      return join(home, ".pi", "logs", "pi-ui-enhanced-footer.log");
    }
  } catch {
    // homedir() or env might fail in restricted environments
  }
  const user =
    (typeof process.getuid === "function" ? process.getuid() : undefined) ??
    process.env.USER ??
    process.env.USERNAME ??
    "user";
  return join(tmpdir(), `pi-ui-enhanced-footer-${user}.log`);
}

/** Entries of the same kind are logged at most once per window; the log has no rotation. */
const LOG_THROTTLE_MS = 60000;

/** Clock per message kind for the throttle above. */
const lastLoggedAt = new Map<string, number>();

/**
 * Log a footer failure. A persistent render failure fires on every frame, and
 * the log has no rotation, so errors of the same kind are written at most once
 * per `LOG_THROTTLE_MS`.
 */
function logFooterError(message: string, error: unknown): void {
  try {
    const now = Date.now();
    const last = lastLoggedAt.get(message) ?? -Infinity;
    if (now - last < LOG_THROTTLE_MS) return;
    lastLoggedAt.set(message, now);
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    const line = `${new Date().toISOString()} ${message}: ${detail}\n`;
    const logPath = footerLogPath();
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, { mode: 0o600 });
      return;
    } catch {
      // Primary log path failed (e.g. read-only filesystem or permissions)
    }
    const user =
      (typeof process.getuid === "function" ? process.getuid() : undefined) ??
      process.env.USER ??
      process.env.USERNAME ??
      "user";
    const fallbackPath = join(tmpdir(), `pi-ui-enhanced-footer-${user}.log`);
    appendFileSync(fallbackPath, line, { mode: 0o600 });
  } catch {
    // Logging must never break the footer either.
  }
}

function renderWrappedFooterUnsafe(
  width: number,
  theme: FooterTheme,
  source: WrappedFooterSource,
  options: FooterRenderOptions,
): string[] {
  // The left line shows the folder icon and the basename only, never the full
  // path: `~/project (main) • session` becomes
  // `\uF07B project (main) • session`.
  let pwd = theme.fg(
    FOLDER_COLOR,
    `${FOLDER_ICON} ${folderNameForFooter(source.getCwd())}`,
  );
  const branch = source.getBranch();
  if (branch) {
    // The dirty marker (`*`) and the diff numbers come from the
    // GIT_DIRTY_TTL_MS cache, so git subprocesses do not run on every render.
    // The result looks like `main* \uF07C +19 ~48 -2`, and components that
    // equal zero are left out.
    const stats = getWorktreeStats(
      source.getCwd(),
      options.now,
      options.readers,
    );
    const star = stats.dirty ? "*" : "";
    pwd += ` ${theme.fg(BRANCH_COLOR, `${BRANCH_ICON} ${branch}${star}`)}`;
    if (stats.added + stats.deleted + stats.untracked > 0) {
      const parts: string[] = [];
      if (stats.added > 0) parts.push(theme.fg("success", `+${stats.added}`));
      if (stats.deleted > 0) parts.push(theme.fg("error", `-${stats.deleted}`));
      if (stats.untracked > 0) {
        parts.push(theme.fg(BRANCH_COLOR, `~${stats.untracked}`));
      }
      // The same `dim` that the secondary footer text uses (tokens, context,
      // model).
      pwd += ` ${theme.fg("muted", DIFF_ICON)} ${parts.join(" ")}`;
    }
  }
  const sessionName = source.getSessionName();
  if (sessionName) pwd += ` • ${sessionName}`;

  const statsLeft = source.getStatsLeft(theme);
  let rightSide = source.getModelId();
  const thinking = source.getThinkingLabel();
  if (thinking !== undefined) {
    rightSide =
      thinking === "off"
        ? `${rightSide} • thinking off`
        : `${rightSide} • ${thinking}`;
  }
  if (source.getProviderCount() > 1 && source.getModelProvider()) {
    const withProvider = `(${source.getModelProvider()}) ${rightSide}`;
    if (
      visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width &&
      width > 0
    ) {
      rightSide = withProvider;
    }
  }

  const statsLeftWidth = visibleWidth(statsLeft);
  const rightWidth = visibleWidth(rightSide);
  let statsLine: string;
  if (statsLeftWidth + 2 + rightWidth <= width) {
    statsLine =
      statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - rightWidth)) + rightSide;
  } else if (width - statsLeftWidth - 2 > 0) {
    const truncated = truncateToWidth(rightSide, width - statsLeftWidth - 2, "");
    statsLine =
      statsLeft +
      " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) +
      truncated;
  } else {
    statsLine = truncateToWidth(statsLeft, width, "...");
  }

  // Stock dims the stats parts separately so that an inner reset (the colored
  // context percentage) cannot clear the outer dim.
  const dimmedStatsLeft = theme.fg("dim", statsLeft);
  // Slice by the raw length. `statsLeft` may carry ANSI, and slicing by its
  // visible length would leave a tail of the status text duplicated below.
  const remainder = statsLine.slice(statsLeft.length);
  const lines = [
    truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
    dimmedStatsLeft + theme.fg("dim", remainder),
  ];

  const rewritten: string[] = [];
  const statuses = source.getStatuses();
  const keys = sortStatusKeys(statuses.keys());
  for (const key of keys) {
    const out = applyStatusRewrite(key, statuses.get(key), theme);
    if (out !== undefined) rewritten.push(sanitizeStatusText(out));
  }
  if (rewritten.length > 0) {
    lines.push(
      truncateToWidth(rewritten.join(" "), width, theme.fg("dim", "...")),
    );
  }
  return lines;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Cumulative token totals plus the cache hit rate of the newest assistant message, like stock. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate in percent for the newest assistant message, set only when it had prompt tokens. */
  latestCacheHitRate?: number;
}

/** Best-effort token totals, mirroring the stock footer entry walk. */
function sumEntryUsage(entries: readonly unknown[]): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const add = (usage: unknown) => {
    if (typeof usage !== "object" || usage === null) return;
    const record = usage as Record<string, unknown>;
    totals.input += readNumber(record.input);
    totals.output += readNumber(record.output);
    totals.cacheRead += readNumber(record.cacheRead);
    totals.cacheWrite += readNumber(record.cacheWrite);
    totals.cost += readNumber(record.cost);
  };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "usage") {
      add(record.usage);
    } else if (record.type === "message") {
      const message = record.message as Record<string, unknown> | undefined;
      if (
        message &&
        (message.role === "assistant" || message.role === "toolResult") &&
        message.usage !== undefined
      ) {
        add(message.usage);
        if (message.role === "assistant") {
          const usage = message.usage as Record<string, unknown>;
          const promptTokens =
            readNumber(usage.input) +
            readNumber(usage.cacheRead) +
            readNumber(usage.cacheWrite);
          totals.latestCacheHitRate =
            promptTokens > 0
              ? (readNumber(usage.cacheRead) / promptTokens) * 100
              : undefined;
        }
      }
    } else if (
      record.type === "branch_summary" ||
      record.type === "compaction"
    ) {
      add(record.usage);
    }
  }
  return totals;
}

/** Token sums are reused for this long because the footer renders far more often than they change. */
export const USAGE_CACHE_MS = 100;

let usageCache:
  | { length: number; last: unknown; totals: UsageTotals; at: number }
  | undefined;

/** Test helper: drop the cached token totals. */
export function clearUsageCache(): void {
  usageCache = undefined;
}

/**
 * Token totals for `entries`, memoized briefly. `sessionManager.getEntries()`
 * returns a fresh array on every call, so the cache keys on its length and its
 * last entry object. Appends and compactions invalidate it, and the short TTL
 * keeps a message that streaming mutates in place from going stale.
 */
export function readUsageTotals(
  entries: readonly unknown[],
  now: number = Date.now(),
): UsageTotals {
  const cached = usageCache;
  if (
    cached &&
    cached.length === entries.length &&
    entries[entries.length - 1] === cached.last &&
    now - cached.at < USAGE_CACHE_MS
  ) {
    return cached.totals;
  }
  const totals = sumEntryUsage(entries);
  usageCache = {
    length: entries.length,
    last: entries[entries.length - 1],
    totals,
    at: now,
  };
  return totals;
}

/** Build the live source from the current extension context. */
export function createFooterSourceFromContext(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): WrappedFooterSource {
  return {
    getCwd: () => {
      try {
        return ctx.sessionManager.getCwd() || ctx.cwd;
      } catch {
        return ctx.cwd;
      }
    },
    getSessionName: () => {
      try {
        return ctx.sessionManager.getSessionName();
      } catch {
        return undefined;
      }
    },
    getBranch: () => {
      try {
        const fromFooter = footerData.getGitBranch();
        if (
          fromFooter !== null &&
          fromFooter !== undefined &&
          fromFooter !== ""
        ) {
          return fromFooter;
        }
      } catch {
        // ignore
      }
      try {
        const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd;
        return getCachedGitBranch(cwd) || null;
      } catch {
        return null;
      }
    },
    getProviderCount: () => {
      try {
        return footerData.getAvailableProviderCount();
      } catch {
        return 0;
      }
    },
    getModelId: () =>
      (ctx.model as { id?: unknown } | undefined)?.id as string || "no-model",
    getModelProvider: () => {
      const provider = (ctx.model as { provider?: unknown } | undefined)
        ?.provider;
      return typeof provider === "string" ? provider : undefined;
    },
    getThinkingLabel: () => {
      const model = ctx.model as
        | { reasoning?: unknown; id?: unknown }
        | undefined;
      if (!model || !model.reasoning) return undefined;
      return ctx.thinkingLevel || "off";
    },
    getStatsLeft: (theme) => {
      let totals: UsageTotals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      };
      try {
        totals = readUsageTotals(ctx.sessionManager.getEntries());
      } catch {
        // Best effort. An empty stats cell still renders a valid footer.
      }
      const parts: string[] = [];
      if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
      if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
      if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
      if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
      if (
        (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
        totals.latestCacheHitRate !== undefined
      ) {
        parts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
      }
      if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
      let contextWindow = 0;
      let contextPercent: number | null = null;
      try {
        const usage = ctx.getContextUsage();
        contextWindow = usage?.contextWindow || 0;
        contextPercent = usage?.percent ?? null;
      } catch {
        contextWindow = 0;
        contextPercent = null;
      }
      if (contextPercent === null) {
        parts.push(`?/${formatTokens(contextWindow)}`);
      } else {
        const display = `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
        parts.push(
          contextPercent > 90
            ? theme.fg("error", display)
            : contextPercent > 70
              ? theme.fg("warning", display)
              : display,
        );
      }
      return parts.join(" ");
    },
    getStatuses: () => {
      try {
        return footerData.getExtensionStatuses();
      } catch {
        return new Map<string, string>();
      }
    },
  };
}

/** Install our footer with its rewrites. Call it again with a fresh `ctx` to refresh. */
export function installWrappedFooter(ctx: ExtensionContext): void {
  activeContext = ctx;
  ctx.ui.setFooter((tui, theme, footerData) => {
    setGitRenderCallback(() => {
      try {
        tui.requestRender();
      } catch {
        try {
          (ctx.ui as { requestRender?: () => void }).requestRender?.();
        } catch {
          // ignore
        }
      }
    });

    const component: Component = {
      render: (width: number) =>
        renderWrappedFooter(
          width,
          theme,
          createFooterSourceFromContext(ctx, footerData),
        ),
      invalidate() {},
    };
    return component;
  });
}

/** Restore the stock footer. */
export function restoreDefaultFooter(ctx: ExtensionContext): void {
  setGitRenderCallback(undefined);
  activeContext = undefined;
  ctx.ui.setFooter(undefined);
}

/**
 * Coordinates UI ownership between multiple loaded instances.
 *
 * When loading both a local copy and an installed package, two module
 * instances run simultaneously. Each instance creates an ownership object.
 * Calling `claim()` sets the active token on `globalThis`. Only the instance
 * holding the active token performs UI writes.
 */
export function createInstanceOwnership(key: string): {
  claim: () => void;
  isOwner: () => boolean;
  release: () => void;
} {
  const token = {};
  // SAFETY: globalThis is really a string-keyed record at runtime. The cast only
  // gives typed access to our own namespaced ownership key.
  const store = globalThis as unknown as Record<string, unknown>;
  return {
    claim: () => {
      store[key] = token;
    },
    isOwner: () => store[key] === token,
    release: () => {
      if (store[key] === token) delete store[key];
    },
  };
}
