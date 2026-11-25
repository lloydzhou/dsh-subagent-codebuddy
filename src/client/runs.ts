/**
 * The session's own run list: what the header button shows and what it jumps to.
 *
 * A card only exists where the message that carries it was rendered, so a run
 * that started forty turns ago is, in practice, unreachable: the reader has to
 * scroll back through collapsed messages and hope. The provider keeps every run
 * it started in memory regardless (`src/progress.ts`), so the header can ask
 * "which runs does this conversation have" and offer a jump list.
 *
 * Parsing lives here, apart from the component, because a wrong reading of the
 * feed would show up as a missing run rather than as an error — the one failure
 * mode a jump list must not have silently.
 *
 * @module dsh-subagent-codebuddy/client/runs
 */

import { PROGRESS_ENDPOINT } from './live.ts'
import type { RunStatus } from './definition.ts'

/** One row the header can offer. */
export interface RunRow {
  readonly childId: string
  /** The caller's label, or '' when the run was started without one. */
  readonly label: string
  /** Every call the run made: retained rows plus the ones the cap dropped. */
  readonly steps: number
  /** True until the provider closed the feed. */
  readonly running: boolean
  /**
   * What the row's dot means, in the card's own vocabulary.
   *
   * Deliberately the card's `RunStatus` and not a local enum: the two surfaces
   * draw the same run, so they have to agree on what "amber" means. A listed
   * live run is `delegated` — the tool call has returned and the child is
   * working in the background, which is exactly when this list is worth
   * opening.
   */
  readonly state: RunStatus
  readonly startedAt: number
  /** When it settled; absent while it still runs. */
  readonly endedAt?: number
  /** Last time anything happened, used to age the row. */
  readonly updatedAt: number
  /** The model the child was pinned to; absent when the run recorded none. */
  readonly model?: string
}

/** How long a run's row says it has been going, or took. */
export function rowElapsed(row: RunRow, now: number): number {
  return Math.max(0, (row.endedAt ?? now) - row.startedAt)
}

/** What a row is called: the label, else the id's short form. */
export function rowTitle(row: RunRow): string {
  if (row.label !== '') return row.label
  return row.childId.length > 8 ? row.childId.slice(0, 8) : row.childId
}

/**
 * One state standing for the whole list, for the button's own dot.
 *
 * The ranking is by how much the reader needs to know: anything still going
 * outranks a verdict, a failure outranks a tidy set, and a list that ended
 * without failures or without errors is simply done. Mixed outcomes that
 * include a refusal or a stop fall back to `stopped`, because "some of these
 * did not finish cleanly" is the one true summary of that set.
 * @param rows - the runs the button lists.
 * @returns the state whose colour the button's dot uses.
 */
export function aggregateState(rows: readonly RunRow[]): RunStatus {
  if (rows.length === 0) return 'stopped'
  if (rows.some(row => row.running)) return 'delegated'
  if (rows.some(row => row.state === 'failed')) return 'failed'
  if (rows.every(row => row.state === 'done')) return 'done'
  return 'stopped'
}

/**
 * Read one row's state out of what the provider sent.
 *
 * A live row is `delegated`: the list exists to find runs that are still going,
 * and by the time one is worth listing the handoff has already returned. A
 * settled row reads its recorded ending; an ending this build does not know
 * (a feed that predates the field) is `stopped`, because claiming success or
 * failure would both be a guess about a run nobody can re-open.
 * @param ended - whether the feed reported an end time.
 * @param outcome - the recorded ending, if any.
 * @returns the state whose colour the row's dot uses.
 */
function readRowState(ended: boolean, outcome: unknown): RunStatus {
  if (!ended) return 'delegated'
  if (outcome === 'completed') return 'done'
  if (outcome === 'stopped') return 'stopped'
  if (outcome === 'refused') return 'refused'
  if (outcome === 'failed') return 'failed'
  return 'stopped'
}

/**
 * Read one session listing out of a response body.
 *
 * Tolerant by design: a row this build cannot understand is dropped, and a body
 * that is not a listing at all reads as "no runs" — the button then shows
 * nothing rather than breaking the session header it sits in.
 * @param payload - parsed JSON, or anything at all.
 * @param sessionId - the session that was asked for; rows for anyone else are ignored.
 * @returns the rows, in the order the provider ranked them.
 */
export function readSessionRuns(payload: unknown, sessionId: string): RunRow[] {
  if (payload === null || typeof payload !== 'object') return []
  const listed = (payload as { runs?: unknown }).runs
  if (!Array.isArray(listed)) return []
  const rows: RunRow[] = []
  for (const raw of listed) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    if (typeof record.childId !== 'string' || record.childId === '') continue
    // The provider filters by session already; this guards against a stale
    // response arriving after the reader switched conversations.
    if (typeof record.sessionId === 'string' && record.sessionId !== sessionId) continue
    const steps = Array.isArray(record.steps) ? record.steps.length : 0
    const dropped = typeof record.dropped === 'number' && record.dropped > 0 ? record.dropped : 0
    const endedAt = typeof record.endedAt === 'number' ? record.endedAt : undefined
    rows.push({
      childId: record.childId,
      label: typeof record.label === 'string' ? record.label : '',
      steps: steps + dropped,
      running: endedAt === undefined,
      state: readRowState(endedAt !== undefined, record.outcome),
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      ...endedAt === undefined ? {} : { endedAt },
      ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
    })
  }
  return rows
}

/** The listing URL for one session. */
export function sessionRunsUrl(sessionId: string): string {
  return `${PROGRESS_ENDPOINT}?session=${encodeURIComponent(sessionId)}`
}

/**
 * Ask the host for one session's runs.
 *
 * Never rejects. The two empty answers are deliberately different: an empty
 * array is "this session has no runs", while `undefined` is "the host did not
 * answer" — and the header keeps showing the rows it already had for the second
 * one, because blanking a live list on a single dropped request is worse than
 * being three seconds stale.
 * @param sessionId - the conversation to list.
 * @param signal - aborts the request when the header unmounts.
 * @returns the rows, an empty list, or undefined when the host did not answer.
 */
export async function fetchSessionRuns(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RunRow[] | undefined> {
  try {
    const response = await fetch(sessionRunsUrl(sessionId), {
      ...signal === undefined ? {} : { signal },
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return readSessionRuns(await response.json(), sessionId)
  } catch {
    return undefined
  }
}
