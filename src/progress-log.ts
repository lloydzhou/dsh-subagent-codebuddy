/**
 * Live, human-readable progress log for one out-of-process run.
 *
 * An ACP child runs in another process, so nothing it does reaches this
 * harness's session events: the parent session records the catalog entry at
 * start and the settlement notice at the end, and nothing in between. That
 * leaves a gap the delegation result cannot fill — while the child works, there
 * is nowhere to look. This module closes it from the provider side, where every
 * ACP update already arrives:
 *
 * - `~/.dsh/logs/subagent-codebuddy/<runId>.log` — one run, appended live, but
 *   only with the events this provider is the sole witness to: startup phases,
 *   handshake, session id and transcript path, permission answers, steer
 *   results, plan changes, failed tool calls, and the terminal outcome.
 *   The tool-by-tool detail deliberately stays out: the CLI writes its own
 *   transcript (see `codebuddyTranscriptPath`) and the console reads that
 *   directly, so copying it here would only duplicate a much better record.
 * - `~/.dsh/logs/subagent-codebuddy/index.log` — one line per run start and
 *   end, so `tail` shows what is running right now and how the last few ended.
 *
 * The id in the file name is the same id the settlement notice carries, so a
 * notice can always be traced back to its log.
 *
 * Logging is best-effort by construction: a failure to open, write, or close
 * must never affect the run, so every operation is contained.
 *
 * @module dsh-subagent-codebuddy/progress-log
 */

import { appendFileSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * How long a run may go without a heartbeat before `codebuddy-runs` treats it as
 * gone. Four beats of the interval below, so one delayed tick never flips a
 * healthy run to "lost". The viewer mirrors this value; keep them in step.
 */
export const HEARTBEAT_STALE_MS = 20_000

/** How often a live run refreshes its heartbeat file. */
const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * Directory holding per-run logs and the shared index.
 *
 * `DSH_SUBAGENT_CODEBUDDY_LOG_DIR` overrides it: the test suite uses that to
 * stay out of the operator's real log directory, and a deployment that keeps
 * logs elsewhere can set it without patching this package.
 */
export function progressLogDir(): string {
  const override = process.env.DSH_SUBAGENT_CODEBUDDY_LOG_DIR
  return override !== undefined && override !== ''
    ? override
    : join(homedir(), '.dsh', 'logs', 'subagent-codebuddy')
}

/** Chronological overview of every run: started, finished, failed. */
export function indexLogPath(): string {
  return join(progressLogDir(), 'index.log')
}

/**
 * The log file for one run, keyed by the id the settlement notice names.
 * @param runId - the child id assigned to this run.
 * @param dir - directory override, for tests.
 * @returns the absolute log path.
 */
export function progressLogPath(runId: string, dir: string = progressLogDir()): string {
  return join(dir, `${runId}.log`)
}

/** Append-only sink for one run's log. */
export interface RunLog {  /**
   * Append one event.
   * @param kind - short column label, e.g. `tool`, `permission`, `done`.
   * @param message - the event detail; newlines are folded onto one line.
   */
  line(kind: string, message: string): void
  /** Flush and release the file. Idempotent. */
  close(): void
}

/** A log that discards everything, for runs that opted out. */
export function disabledRunLog(): RunLog {
  return { line: () => {}, close: () => {} }
}

/**
 * Open one run's log in append mode.
 *
 * Writes are synchronous on purpose: a run emits a few dozen lines, and a log
 * that shows up late — or only after a flush nobody calls — defeats the point
 * of watching a run in `tail -f`. Each write is contained, so an unwritable
 * path degrades to a silent no-op instead of failing the delegation.
 * @param runId - the child id this run was published under.
 * @param header - context lines written before the first event.
 * @param dir - directory override, for tests.
 * @returns the sink.
 */
export function openRunLog(runId: string, header: readonly string[] = [], dir: string = progressLogDir()): RunLog {
  const path = progressLogPath(runId, dir)
  let prepared = false
  const write = (text: string): void => {
    try {
      if (!prepared) {
        mkdirSync(dir, { recursive: true })
        prepared = true
      }
      appendFileSync(path, text)
    } catch {
      // The child is more important than the log.
    }
  }
  write(`# run ${runId} started ${new Date().toISOString()}\n`)
  for (const line of header) write(`# ${line}\n`)
  return {
    line(kind: string, message: string): void {
      write(`${stamp()} ${kind.padEnd(10)} ${oneLine(message)}\n`)
    },
    close(): void {
      // Nothing is buffered: every line is already on disk.
    },
  }
}

/**
 * Path of one run's liveness beacon.
 * @param runId - the child id this run was published under.
 * @param dir - directory override, for tests.
 * @returns the beacon path (whether or not it exists).
 */
export function heartbeatPath(runId: string, dir: string = progressLogDir()): string {
  return join(dir, `${runId}.alive`)
}

/** A running beacon. `stop()` is idempotent and removes the file. */
export interface Heartbeat {
  /** Stop beating and remove the beacon. */
  stop(): void
}

/**
 * Start beaconing for a live run.
 * @param runId - the child id this run was published under.
 * @param dir - directory override, for tests.
 * @returns the beacon; `stop()` on every terminal path.
 */
export function startHeartbeat(runId: string, dir: string = progressLogDir()): Heartbeat {
  const path = heartbeatPath(runId, dir)
  let prepared = false
  const beat = (): void => {
    try {
      if (!prepared) {
        mkdirSync(dir, { recursive: true })
        prepared = true
      }
      writeFileSync(path, String(Date.now()))
    } catch {
      // A failed beat must never affect the run.
    }
  }
  beat()
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  // Never keep the harness process alive just to beat.
  timer.unref()
  return {
    stop(): void {
      clearInterval(timer)
      try {
        unlinkSync(path)
      } catch {
        // Already gone.
      }
    },
  }
}

/**
 * Append one line to the shared run index.
 * @param message - the line; newlines are folded onto one.
 */
export function appendIndex(message: string): void {
  try {
    const dir = progressLogDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'index.log'), `${new Date().toISOString()} ${oneLine(message)}\n`)
  } catch {
    // Diagnostics must never break delegation.
  }
}

/**
 * Render one `key="value"` field of an index line.
 *
 * A task label routinely contains quotes ("don't break the 'x' path"), so the
 * value is escaped rather than wrapped naively: the reader (`codebuddy-runs`)
 * splits fields by the escaped quotes, and a prompt containing `"` must not
 * shift every column after it. Backslash is escaped first, which makes the
 * round trip exact for both characters.
 * @param key - field name, e.g. `label` or `prompt`.
 * @param value - one-line text; newlines are folded onto one space.
 * @returns the field, ready to concatenate into an index line.
 */
export function indexField(key: string, value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return `${key}="${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The CodeBuddy CLI keeps its own full transcript for every session, and it is
 * far richer than this log: every child message, tool result, and file edit.
 * The path is derived from the workspace slug and the ACP session id.
 *
 * The slug is built from the *resolved* workspace, because that is what the CLI
 * does: a child started in `/tmp/work` writes to `private-tmp-work`, since macOS
 * `/tmp` is a symlink. Using the path as given produced a plausible-looking file
 * name that never existed, and every consumer of this path — the console's
 * timeline, the token usage reader — then reported "nothing there".
 * @param cwd - the workspace directory the child was started in.
 * @param sessionId - the ACP session id returned by `session/new`.
 * @returns the transcript path the CLI uses, whether or not it exists yet.
 */
export function codebuddyTranscriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.codebuddy', 'projects', workspaceSlug(cwd), `${sessionId}.jsonl`)
}

/**
 * The directory name the CLI derives from a workspace path.
 * @param cwd - the workspace, as the run was given it.
 * @returns the slug the CLI would use, symlinks resolved when possible.
 */
export function workspaceSlug(cwd: string): string {
  let resolved = cwd
  try {
    resolved = realpathSync(cwd)
  } catch {
    // A workspace that does not exist (yet) has no symlinks to follow.
  }
  return resolved.replace(/\/+$/, '').split('/').filter((part) => part !== '').join('-')
}

/** Local wall-clock stamp, which reads better than UTC in a tailed log. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

/** Fold every run of whitespace onto one space and bound the length. */
function oneLine(message: string, maxChars = 400): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}
