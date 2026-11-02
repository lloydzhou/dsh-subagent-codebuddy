/**
 * Per-run action feed: what a child is doing *while* it does it.
 *
 * An external child produces exactly two moments the transcript can fold — the
 * activation result and the settlement notice — so a chat card would otherwise
 * sit on one unchanging line for the whole run. The child's ACP updates are the
 * missing middle: they arrive in this process, and this module keeps the last
 * few dozen of them in memory, keyed by child id, for the card to read.
 *
 * It is deliberately not durable and not model-facing: a feed that outlived the
 * process would become a second source of truth about run state, and the parent
 * model has no business reading a progress ticker. Only the operator-facing
 * transport (`GET /subagent-codebuddy/progress`) reads it.
 *
 * @module dsh-subagent-codebuddy/progress
 */

/** How one row reads at a glance: still working, finished, or gave up. */
export type StepState = 'running' | 'done' | 'failed' | 'stopped'

/** One thing worth showing: a tool call, or the child's own plan. */
export interface ProgressStep {
  /** Stable row identity — a tool call keeps one row as its status advances. */
  readonly id: string
  readonly kind: 'tool' | 'plan'
  /** The human line, e.g. `创建 vitest.config.ts` or `2/5 步 · 正在跑测试`. */
  readonly label: string
  /** Secondary text, e.g. the ACP tool kind (`edit`, `execute`). */
  readonly detail?: string
  readonly state: StepState
  /** When this row first appeared; a status change keeps the original time. */
  readonly at: number
}

/**
 * How a settled run ended, in the vocabulary the card's status dot uses.
 *
 * It is recorded, not inferred: only the settlement path knows the stop reason,
 * and a reader looking at a finished row has nothing else to tell a success from
 * a failure — the notice that carries it is a message the reader may never have
 * scrolled to.
 */
export type RunOutcome = 'completed' | 'stopped' | 'refused' | 'failed'

/** Everything known about one run's mid-flight activity. */
export interface RunProgress {
  readonly startedAt: number
  updatedAt: number
  readonly steps: ProgressStep[]
  /**
   * How many rows `MAX_STEPS` pushed out of `steps`.
   *
   * Kept because the two numbers answer different questions: `steps` is what a
   * card can list, this is how much work the run actually did. Without it every
   * long run reports the same "60 步" and the number stops meaning anything.
   */
  dropped: number
  /** Set once the run settled; a poller uses it to stop asking. */
  endedAt?: number
  /** How it settled. Absent while it runs, and on feeds that predate this. */
  outcome?: RunOutcome
  /**
   * The conversation that started this run, so a header list can show only the
   * runs belonging to the session the reader is looking at.
   */
  readonly sessionId?: string
  /** The caller's short label, so the list can name a run no card rendered. */
  readonly label?: string
}

/**
 * What the provider knows about a run at start that the feed itself cannot
 * infer: whose conversation it belongs to and what the caller called it.
 */
export interface RunMeta {
  readonly sessionId?: string
  readonly label?: string
}

/**
 * One raw ACP fact, in the shape `wire.ts` can hand over without knowing what a
 * card looks like.
 */
export type ChildAction =
  | {
    readonly kind: 'tool'
    readonly toolCallId: string
    readonly title: string
    readonly toolKind?: string
    readonly status: string
  }
  | {
    readonly kind: 'plan'
    readonly done: number
    readonly total: number
    readonly current?: string
  }

/**
 * Rows kept per run. A long task can call tools hundreds of times; the card
 * shows a timeline, not a log, so the oldest rows are dropped and the count of
 * dropped rows is reported instead of pretending the feed is complete.
 */
export const MAX_STEPS = 60

/** Runs kept in memory at once; the oldest settled entries go first. */
const MAX_RUNS = 40

/** How long a settled run's feed stays readable, so a late poll still paints. */
const SETTLED_TTL_MS = 10 * 60_000

/**
 * The store lives on the global object for the same reason the live-run
 * registry does: `index.js` and `tool.js` are separate entry modules, and a
 * loader that evaluates the shared chunk twice would otherwise split the feed
 * from its readers.
 */
const PROGRESS_KEY = Symbol.for('dsh-subagent-codebuddy/progress')

function store(): Map<string, RunProgress> {
  const holder = globalThis as unknown as Record<symbol, Map<string, RunProgress> | undefined>
  return (holder[PROGRESS_KEY] ??= new Map())
}

/**
 * Map one ACP status onto the four states a row can show.
 * @param status - the raw ACP `status` value.
 * @returns the display state; unknown words read as still running.
 */
export function stepState(status: string): StepState {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'canceled') return 'stopped'
  return 'running'
}

/**
 * Open a run's feed. Called once the child session exists, so the card never
 * sees a run that failed before there was anything to report.
 * @param childId - the durable child id the settlement notice will name.
 * @param startedAt - wall-clock start, used to age a row set.
 * @param now - clock, injectable for tests.
 * @param meta - the owning conversation and the caller's label.
 */
export function beginProgress(
  childId: string,
  startedAt: number,
  now: number = Date.now(),
  meta: RunMeta = {},
): void {
  const runs = store()
  runs.set(childId, {
    startedAt,
    updatedAt: startedAt,
    steps: [],
    dropped: 0,
    ...meta.sessionId === undefined ? {} : { sessionId: meta.sessionId },
    ...meta.label === undefined ? {} : { label: meta.label },
  })
  pruneProgress(now)
}

/**
 * Record one child action: a tool call appearing or advancing, or its plan.
 *
 * A tool call gets exactly one row. ACP reports it once as `tool_call` and again
 * as `tool_call_update` per status change; appending per update would turn one
 * edit into three timeline rows that all describe the same file.
 * @param childId - the child the action belongs to.
 * @param action - the normalized action.
 * @param now - clock, injectable for tests.
 */
export function recordProgress(childId: string, action: ChildAction, now: number = Date.now()): void {
  const run = store().get(childId)
  // No feed for an unknown child: a run that never opened one (an older run,
  // or one whose start predates this module) has nothing to append to.
  if (run === undefined) return
  run.updatedAt = now
  if (action.kind === 'tool') {
    if (action.toolCallId === '') return
    const next: ProgressStep = {
      id: action.toolCallId,
      kind: 'tool',
      label: action.title === '' ? '(未命名工具调用)' : action.title,
      ...(action.toolKind === undefined ? {} : { detail: action.toolKind }),
      state: stepState(action.status),
      at: now,
    }
    const at = run.steps.findIndex(step => step.id === action.toolCallId)
    if (at === -1) {
      run.steps.push(next)
    } else {
      // A status-only update carries no kind; keeping the row's known kind stops
      // one bare `tool_call_update` from erasing what the call is.
      const before = run.steps[at]!
      run.steps[at] = {
        ...next,
        ...next.detail === undefined && before.detail !== undefined ? { detail: before.detail } : {},
        at: before.at,
      }
    }
    if (run.steps.length > MAX_STEPS) {
      const removed = run.steps.length - MAX_STEPS
      run.steps.splice(0, removed)
      run.dropped += removed
    }
    return
  }
  // The plan is one row that keeps being replaced: it describes the shape of
  // the work, not a step that happens once.
  const label = `${action.done}/${action.total} 步${action.current === undefined ? '' : ` · ${action.current}`}`
  const step: ProgressStep = {
    id: 'plan',
    kind: 'plan',
    label,
    state: action.total > 0 && action.done >= action.total ? 'done' : 'running',
    at: now,
  }
  const at = run.steps.findIndex(candidate => candidate.id === 'plan')
  if (at === -1) run.steps.push(step)
  else run.steps[at] = { ...step, at: run.steps[at]!.at }
}

/**
 * Map one harness stop reason onto the four endings a dot distinguishes.
 *
 * `max-tokens` and `error` both mean the child stopped short of finishing, so
 * they read as a failure rather than as a partial success — the same choice the
 * settlement notice makes when it says it "ran out of room".
 * @param stopReason - the run's terminal reason.
 * @returns the ending to record.
 */
export function runOutcome(stopReason: string): RunOutcome {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'stopped'
  if (stopReason === 'refusal') return 'refused'
  return 'failed'
}

/**
 * Close a run's feed. The rows stay readable for a while, because a browser tab
 * that was mid-poll when the child settled still asks once more.
 * @param childId - the settled child.
 * @param now - clock, injectable for tests.
 * @param outcome - how it ended, when the caller knows; omitted on the paths
 * that only tear the child down (startup failure, disposal).
 */
export function finishProgress(childId: string, now: number = Date.now(), outcome?: RunOutcome): void {
  const run = store().get(childId)
  if (run === undefined) return
  run.updatedAt = now
  if (run.endedAt === undefined) run.endedAt = now
  // Written before any later `finishProgress` without a reason (teardown runs
  // after settlement too), so the verdict is never overwritten by a bare close.
  if (outcome !== undefined) run.outcome = outcome
  pruneProgress(now)
}

/**
 * Drop feeds nobody can still be reading: settled ones past their TTL, then the
 * oldest entries once the map is over its cap.
 * @param now - clock, injectable for tests.
 */
export function pruneProgress(now: number = Date.now()): void {
  const runs = store()
  for (const [id, run] of runs) {
    if (run.endedAt !== undefined && now - run.endedAt > SETTLED_TTL_MS) runs.delete(id)
  }
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.entries()]
      .filter(([, run]) => run.endedAt !== undefined)
      .sort((left, right) => (left[1].endedAt ?? 0) - (right[1].endedAt ?? 0))[0]
    // Every entry is live: nothing is safe to drop, so the cap yields to the
    // runs actually happening.
    if (oldest === undefined) return
    runs.delete(oldest[0])
  }
}

/**
 * Read the feeds a viewer asked for.
 * @param childIds - ids from the request, in the order they were asked for.
 * @returns one entry per id that has a feed; unknown ids are simply absent.
 */
export function readProgress(childIds: readonly string[]): Record<string, RunProgress> {
  const runs = store()
  const out: Record<string, RunProgress> = {}
  for (const id of childIds) {
    const run = runs.get(id)
    if (run !== undefined) out[id] = run
  }
  return out
}

/** One row of a session's run list: the feed plus the id it is keyed by. */
export interface RunListing extends RunProgress {
  readonly childId: string
}

/**
 * Every run one conversation started, newest activity first, still-running ones
 * on top.
 *
 * The header list needs this because a card only exists where the message that
 * carries it was rendered; the runs themselves live here, in the host's memory,
 * whether or not the browser ever painted them. Ordering puts what the reader
 * most likely wants — the run that is happening now — at the top.
 * @param sessionId - the conversation whose runs to list.
 * @param limit - rows to return; the header list is a jump menu, not a report.
 * @returns the matching runs, running-first then most recently active.
 */
export function readProgressBySession(sessionId: string, limit = 20): RunListing[] {
  const rows: RunListing[] = []
  for (const [childId, run] of store()) {
    if (run.sessionId !== sessionId) continue
    rows.push({ ...run, childId })
  }
  rows.sort((left, right) => {
    const leftLive = left.endedAt === undefined ? 1 : 0
    const rightLive = right.endedAt === undefined ? 1 : 0
    if (leftLive !== rightLive) return rightLive - leftLive
    return right.updatedAt - left.updatedAt
  })
  return rows.slice(0, limit)
}
