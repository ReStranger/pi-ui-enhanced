import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
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
 * Plugin-status wrapper scaffold.
 *
 * Other pi extensions publish one-line statuses via `ctx.ui.setStatus(key,
 * text)`. Stock pi renders them verbatim in the footer. This module lets us
 * rewrite any key at render time:
 *
 *   registerStatusRewrite("mcp", rewriteMcpStatus);
 *
 * Render-time rewriting (inside our own footer component) has no race with
 * the owning plugin — unlike overwriting the key via `setStatus`, which the
 * owner would clobber on its next `updateStatusBar()`.
 *
 * NOTE: `setFooter()` replaces the stock footer wholesale, so this component
 * re-renders the stock lines (pwd, token stats, statuses) from the public
 * extension API. Ported from the stock `FooterComponent` (pi-coding-agent
 * 0.87.x); only the statuses line is modified by rewrites.
 */

/** Helpers passed to every rewrite. `theme` is undefined in unit tests. */
export interface RewriteHelpers {
  theme: FooterTheme | undefined;
}

/**
 * Rewrite one status line. Return `undefined` to hide it.
 *
 * Rewrites receive the footer theme so they can colorize via
 * `helpers.theme.fg(...)` (theme colors, not hardcoded ANSI). The MCP rewrite
 * paints itself `accent`; the LSP rewrite paints itself `thinkingLow`.
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
 * ANSI strikethrough (SGR 9 … SGR 29). `stripTerminalSequences`/`visibleWidth`
 * ignore it, so footer width math is unaffected. Terminals without
 * strikethrough support render plain text — pair with `dim` for fallback.
 */
export function strike(text: string): string {
  return `\x1b[9m${text}\x1b[29m`;
}

/**
 * ANSI dim (SGR 2 … SGR 22). Hardcoded rather than themed: use it for
 * theme-independent effects (e.g. struck-through suffixes); for themed
 * coloring use `helpers.theme.fg(...)` inside a rewrite. Pairs with `strike` for terminals that
 * cannot render strikethrough.
 */
export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

/**
 * Whether this context renders the interactive editor UI. Subagent children
 * load these extensions too, but run headless (print mode, no UI), so every
 * UI write is gated on this.
 */
export function rendersEditorUi(
  ctx: Pick<ExtensionContext, "mode" | "hasUI">,
): boolean {
  return ctx.mode === "tui" && ctx.hasUI === true;
}

/** Stock sanitize: single-line statuses only (ANSI is preserved). */
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

/**
 * Nerd Font folder icon (fa-folder, U+F07B — one cell in NF builds).
 * Written as an escape: literal PUA glyphs do not survive chat transport.
 */
export const FOLDER_ICON = "\uF07B";

/**
 * Folder icon + name color: the visually-blue slot (`thinkingLow` →
 * stylix `cyan` #7aaaff; stock dark #5f87af; stock light `blue`).
 */
export const FOLDER_COLOR: ThemeColor = "thinkingLow";

/**
 * Nerd Font fork icon (fa-code-fork, U+F126 — one cell in NF builds).
 */
export const BRANCH_ICON = "\uF126";

/**
 * Diff icon after the branch (user-supplied codepoint U+F07C).
 * One cell in NF builds; written as an escape for transport safety.
 */
export const DIFF_ICON = "\uF07C";

/** How long a git result is reused (footer renders often). */
export const GIT_DIRTY_TTL_MS = 2000;

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

const gitStatsCache = new Map<
  string,
  { stats: WorktreeStats; at: number }
>();

/** Test helper: drop cached git results. */
export function clearGitDirtyCache(): void {
  gitStatsCache.clear();
}

/** Pure: any `git status --porcelain` output means uncommitted changes. */
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

/** Pure: sum added/deleted lines from `git diff --numstat` (`- -` = binary). */
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

/** Git output readers; injectable for tests. */
export interface GitReaders {
  porcelain: (cwd: string) => string | undefined;
  numstat: (cwd: string) => string | undefined;
}

function readGit(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    return typeof out === "string" ? out : undefined;
  } catch {
    // Not a repo, no git binary, timeout — treat as clean, never throw.
    return undefined;
  }
}

function readPorcelain(cwd: string): string | undefined {
  return readGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
}

function readNumstat(cwd: string): string | undefined {
  return readGit(cwd, ["diff", "HEAD", "--numstat"]);
}

/**
 * Worktree numbers for `cwd`, cached per cwd for GIT_DIRTY_TTL_MS — the
 * footer renders far more often than git state changes. Non-string cwd /
 * git failure → zeros. `readers` is injectable for tests.
 */
export function getWorktreeStats(
  cwd: unknown,
  now: number = Date.now(),
  readers?: GitReaders,
): WorktreeStats {
  if (typeof cwd !== "string" || cwd.length === 0) return { ...CLEAN_STATS };
  const cached = gitStatsCache.get(cwd);
  if (cached && now - cached.at < GIT_DIRTY_TTL_MS) return cached.stats;
  let stats: WorktreeStats = { ...CLEAN_STATS };
  try {
    const porcelain = (readers?.porcelain ?? readPorcelain)(cwd);
    if (porcelain !== undefined) {
      stats = {
        dirty: porcelainIsDirty(porcelain),
        added: 0,
        deleted: 0,
        untracked: countUntracked(porcelain),
      };
      const numstat = (readers?.numstat ?? readNumstat)(cwd);
      if (numstat !== undefined) {
        const { added, deleted } = parseNumstat(numstat);
        stats.added = added;
        stats.deleted = deleted;
      }
    }
  } catch {
    stats = { ...CLEAN_STATS };
  }
  gitStatsCache.set(cwd, { stats, at: now });
  return stats;
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
 * Branch icon + name color: the orange slot (`thinkingMax` → stylix
 * `orange` #ff9c6a). NOTE: this is NOT the `accent` token — in stylix
 * `accent` resolves to pink (#f17ac6). If you literally want accent,
 * change this to `"accent"`.
 */
export const BRANCH_COLOR: ThemeColor = "thinkingMax";

/**
 * Basename of the cwd for the footer right side: just the folder name,
 * never the full path (`/a/b/proj` → `proj`). Non-string/empty input
 * (a half-initialized context at `session_start`) yields `"?"` instead of
 * throwing — a throwing footer render blanks the whole footer area.
 */
export function folderNameForFooter(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0) return "?";
  // `basename` follows the host path semantics, so a Windows cwd
  // (`C:\a\b`) also resolves to its last segment — `split("/")` would not.
  const name = basename(cwd);
  return name.length > 0 ? name : cwd;
}

/** Minimal theme surface the footer render needs (real `Theme` satisfies it). */
export type FooterTheme = Pick<Theme, "fg">;

/** Live footer data. Built per-render from `ExtensionContext` + provider. */
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

/** Test hooks: deterministic time and injectable git readers. */
export interface FooterRenderOptions {
  now?: number;
  readers?: GitReaders;
}

/**
 * Status keys pinned to the front of the statuses line, in order.
 * Everything else keeps the stock alphabetical order after them.
 * (`plan-mode` = @hank-warren/pi-plan-mode.)
 */
export const STATUS_PIN_FIRST: string[] = ["plan-mode"];

/** Pinned keys first (in listed order), the rest alphabetically. */
export function sortStatusKeys(keys: Iterable<string>): string[] {
  const all = [...keys];
  const pinned = STATUS_PIN_FIRST.filter((key) => all.includes(key));
  const rest = all
    .filter((key) => !STATUS_PIN_FIRST.includes(key))
    .sort((a, b) => a.localeCompare(b));
  return [...pinned, ...rest];
}

/**
 * Render the wrapped footer: stock pwd + stats lines, then the statuses line
 * with every registered rewrite applied (sorted by key, like stock).
 *
 * Never throws: a throwing footer render blanks the whole footer area, so
 * failures are logged to `footerLogPath()` and a one-line placeholder is
 * returned instead.
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
    // Keep the fallback inside the frame width: an over-wide line would wrap
    // and shove the whole footer area around.
    return [
      truncateToWidth(
        `[footer error — ${footerLogPath()}]`,
        width,
        theme.fg("dim", "..."),
      ),
    ];
  }
}

/** Debug log for footer failures (see `renderWrappedFooter`). */
export function footerLogPath(): string {
  return join(tmpdir(), "pi-ui-enhanced-footer.log");
}

function logFooterError(message: string, error: unknown): void {
  try {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(
      footerLogPath(),
      `${new Date().toISOString()} ${message}: ${detail}\n`,
    );
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
  // Left line: folder icon + basename only, never the full path.
  // (`~/project (main) • session` → `\uF07B project (main) • session`.)
  let pwd = theme.fg(
    FOLDER_COLOR,
    `${FOLDER_ICON} ${folderNameForFooter(source.getCwd())}`,
  );
  const branch = source.getBranch();
  if (branch) {
    // Dirty worktree (`*`) + diff numbers, cached (see GIT_DIRTY_TTL_MS)
    // so git subprocesses do not run on every footer render.
    // `main* \uF07C +19 ~48 -2` — zero components are hidden.
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
      // Same `dim` as the secondary footer text (tokens/context/model).
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

  // Stock dims stats parts separately so an inner reset (colored context %)
  // cannot clear the outer dim.
  const dimmedStatsLeft = theme.fg("dim", statsLeft);
  // Slice by the *raw* length: `statsLeft` may carry ANSI, and slicing by its
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

/** Cumulative token totals plus the newest assistant cache hit rate, like stock. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate (%) of the newest assistant message, when it had prompt tokens. */
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

/** Token sums are reused for this long (the footer renders far more often than they change). */
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
 * returns a fresh array each call, so the cache keys on its length and last
 * entry object — appends and compactions invalidate it, and the short TTL keeps
 * a message being mutated in place during streaming from going stale.
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
        return footerData.getGitBranch();
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
        // Best effort; an empty stats cell still renders a valid footer.
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

/** Install our footer (with rewrites). Re-call with a fresh `ctx` to refresh. */
export function installWrappedFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((_tui, theme, footerData) => {
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
  ctx.ui.setFooter(undefined);
}

/**
 * Single-owner guard for double-loaded copies.
 *
 * `pi -e ./local-copy` loads alongside the installed package: two module
 * instances, two sets of handlers. Footer/editor setters are last-writer-
 * wins and CLI `-e` paths load after discovery, so the last-loaded instance
 * must win deterministically. Each instance creates its own ownership object
 * and claims the shared key at setup; every UI write is then gated on
 * `isOwner()`, so the stale (installed) copy stays silent.
 *
 * `release()` exists for tests; production copies keep the claim for the whole
 * pi process (releasing on session_shutdown would leave nobody owning the UI).
 */
export function createInstanceOwnership(key: string): {
  claim: () => void;
  isOwner: () => boolean;
  release: () => void;
} {
  const token = {};
  // SAFETY: globalThis is really a string-keyed record at runtime; the cast
  // only gives us typed access to our own namespaced ownership key.
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
