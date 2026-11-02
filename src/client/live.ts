/**
 * The card's live half: fetching and reading the host's progress feed.
 *
 * Everything here is deliberately pure except {@link fetchProgress}, so the
 * shape of what the card shows during a run can be asserted without a browser or
 * a host. The feed itself is produced by the provider (`src/progress.ts`) and
 * served on the host's own origin (`src/progress-route.ts`), which is what makes
 * a relative URL work in the web UI and in the desktop window alike.
 *
 * @module dsh-subagent-codebuddy/client/live
 */

/** Where the host serves the feed; mirrors `PROGRESS_PATH` on the provider side. */
export const PROGRESS_ENDPOINT = '/subagent-codebuddy/progress'

/**
 * Poll cadence while a run is live. A child's tool calls arrive at human pace,
 * so anything faster only spends requests; anything slower makes an edit look
 * like it landed after the fact.
 */
export const POLL_INTERVAL_MS = 1_500

/** Rows the card shows before it starts summarising the rest. */
export const VISIBLE_STEPS = 8

export type LiveState = 'running' | 'done' | 'failed' | 'stopped'

/** One row of the feed, as the provider recorded it. */
export interface LiveStep {
  readonly id: string
  readonly kind: 'tool' | 'plan'
  readonly label: string
  readonly detail?: string
  readonly state: LiveState
  readonly at: number
}

/** One run's feed. */
export interface LiveFeed {
  readonly steps: readonly LiveStep[]
  /**
   * Every call the run made, including the rows the provider's cap dropped.
   * The card counts with this; it lists with `steps`.
   */
  readonly total: number
  readonly updatedAt: number
  /** Present once the provider closed the feed. */
  readonly endedAt?: number
}

/**
 * Build the poll URL for one run.
 * @param childId - the child id from the activation notice.
 * @returns the relative URL, encoded so an odd id cannot break the query.
 */
export function progressUrl(childId: string): string {
  return `${PROGRESS_ENDPOINT}?ids=${encodeURIComponent(childId)}`
}

/**
 * Read one feed out of a response body, tolerating every way it can be wrong.
 *
 * The card is a viewer: a feed that arrives malformed, truncated, or for a
 * different run must degrade to "no live rows" rather than throw inside render.
 * @param payload - parsed JSON, or anything at all.
 * @param childId - the run that was asked for.
 * @returns the feed, or undefined when the body carries none for this run.
 */
export function readFeed(payload: unknown, childId: string): LiveFeed | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const runs = (payload as { runs?: unknown }).runs
  if (runs === null || typeof runs !== 'object') return undefined
  const raw = (runs as Record<string, unknown>)[childId]
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const listed = Array.isArray(record.steps) ? record.steps.length : 0
  const steps = Array.isArray(record.steps)
    ? record.steps.map(readStep).filter((step): step is LiveStep => step !== undefined)
    : []
  const dropped = typeof record.dropped === 'number' && record.dropped > 0 ? record.dropped : 0
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0
  const endedAt = typeof record.endedAt === 'number' ? record.endedAt : undefined
  // Counted from the rows that were sent, not the ones that parsed: a row this
  // client cannot read is still a call that happened.
  return { steps, total: listed + dropped, updatedAt, ...endedAt === undefined ? {} : { endedAt } }
}

/** One row, when it is shaped like one; undefined otherwise. */
function readStep(raw: unknown): LiveStep | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const step = raw as Record<string, unknown>
  if (typeof step.id !== 'string' || typeof step.label !== 'string') return undefined
  if (step.kind !== 'tool' && step.kind !== 'plan') return undefined
  const state = step.state
  if (state !== 'running' && state !== 'done' && state !== 'failed' && state !== 'stopped') return undefined
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    ...typeof step.detail === 'string' && step.detail !== '' ? { detail: step.detail } : {},
    state,
    at: typeof step.at === 'number' ? step.at : 0,
  }
}

/**
 * Narrow the feed to the rows worth painting.
 * @param steps - every row the feed holds, oldest first.
 * @param limit - how many rows fit.
 * @returns the newest `limit` rows, plus how many older ones were left out.
 */
export function visibleSteps(
  steps: readonly LiveStep[],
  limit: number = VISIBLE_STEPS,
): { shown: readonly LiveStep[], hidden: number } {
  if (steps.length <= limit) return { shown: steps, hidden: 0 }
  return { shown: steps.slice(steps.length - limit), hidden: steps.length - limit }
}

/**
 * The header's live sentence: how long ago the child last did something.
 *
 * It answers the question the elapsed clock cannot — "is it working, or is this
 * card just old?" — using the only evidence the browser can get.
 * @param feed - the run's feed.
 * @param now - current time in ms.
 * @returns e.g. `最后动作 12s 前`, or '' when the feed holds no rows yet.
 */
export function lastActionText(feed: LiveFeed | undefined, now: number): string {
  const last = feed?.steps[feed.steps.length - 1]
  if (last === undefined || last.at === 0) return ''
  const seconds = Math.max(0, Math.round((now - last.at) / 1000))
  return `最后动作 ${formatAgo(seconds)} 前`
}

/**
 * Render an age the way a person reads it.
 * @param seconds - whole seconds since the action.
 * @returns `<1s`, `Ns`, `Nm`, or `Nh`.
 */
export function formatAgo(seconds: number): string {
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m`
  return `${String(Math.floor(seconds / 3_600))}h`
}

/**
 * The last feed this page saw, per run.
 *
 * A card that remounts — a reconnect, a transcript that re-renders from the
 * session log, a conversation reopened while the feed is still inside its
 * ten-minute TTL — would otherwise lose the timeline and show only the final
 * message. Polling stops at settlement, so this cache is the only thing that
 * keeps a finished run's history visible; it costs no requests.
 */
const lastFeeds = new Map<string, LiveFeed>()

/** Runs the cache will hold before the oldest is dropped. */
const CACHE_LIMIT = 200

/**
 * Remember one run's feed.
 * @param childId - the run it belongs to.
 * @param feed - the newest snapshot.
 */
export function rememberFeed(childId: string, feed: LiveFeed): void {
  // Re-insert so the insertion order keeps working as an eviction queue.
  lastFeeds.delete(childId)
  lastFeeds.set(childId, feed)
  while (lastFeeds.size > CACHE_LIMIT) {
    const oldest = lastFeeds.keys().next()
    if (oldest.done === true) break
    lastFeeds.delete(oldest.value)
  }
}

/**
 * The newest feed already fetched for one run.
 * @param childId - the run to look up.
 * @returns the cached snapshot, or undefined when this page never fetched it.
 */
export function cachedFeed(childId: string): LiveFeed | undefined {
  return lastFeeds.get(childId)
}

/**
 * Ask the host for one run's feed.
 *
 * Never rejects: a viewer that cannot reach the feed (a headless host, a page
 * opened from a file, a reload mid-run) shows the card it already had.
 * @param childId - the run to ask about.
 * @param signal - aborts the request when the card unmounts or the run settles.
 * @returns the feed, or undefined when the host answered with nothing usable.
 */
export async function fetchProgress(childId: string, signal?: AbortSignal): Promise<LiveFeed | undefined> {
  try {
    const response = await fetch(progressUrl(childId), {
      ...signal === undefined ? {} : { signal },
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return readFeed(await response.json(), childId)
  } catch {
    return undefined
  }
}
