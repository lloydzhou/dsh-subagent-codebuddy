/**
 * The live-run registry: the one place that knows which CodeBuddy children are
 * still running, and can reach into them.
 *
 * The subagent service mints the child id and hands the parent a one-way
 * "started" notice; nothing in the runtime exposes a handle back to the child
 * process. Steering needs exactly that handle — a live ACP session — so the
 * provider publishes it here when the session is created and removes it when
 * the run settles. The registry is process-local and intentionally tiny: an
 * entry exists only between `session/new` and the child's last word.
 *
 * @module dsh-subagent-codebuddy/steer
 */

/** One running child the agent can still talk to. */
export interface LiveRun {
  /** Child session id, the same id the settlement notice is titled with. */
  readonly childId: string
  /** Wall-clock start, so a caller can tell a long run from a stale entry. */
  readonly startedAt: number
  /**
   * Deliver one message into the running turn.
   * @param message - plain text the child should see at its next step boundary.
   * @returns whether the child accepted it, and why not when it did not.
   */
  steer(message: string): Promise<{ steered: boolean, reason?: string }>
}

/**
 * The registry itself lives on the global object, not in this module's scope.
 *
 * `index.js` (the provider) and `tool.js` (the tools) are separate entry
 * modules that share this chunk. Sharing usually resolves to one module
 * instance, but the two rows are mounted independently and a loader that
 * evaluates them twice would leave the provider writing into one map while the
 * tool reads from another — a failure that looks exactly like "no run is live".
 * A registered symbol removes the question.
 */
const LIVE_RUNS_KEY = Symbol.for('dsh-subagent-codebuddy/live-runs')

function registry(): Map<string, LiveRun> {
  const holder = globalThis as unknown as Record<symbol, Map<string, LiveRun> | undefined>
  return (holder[LIVE_RUNS_KEY] ??= new Map())
}

/**
 * Publish a running child.
 * @param run - the live handle.
 * @returns an idempotent unregister function; removing the entry twice is safe.
 */
export function registerLiveRun(run: LiveRun): () => void {
  registry().set(run.childId, run)
  return () => {
    // Only drop the entry this registration owns: a recycled child id must not
    // lose its new entry to an old run's teardown.
    if (registry().get(run.childId) === run) registry().delete(run.childId)
  }
}

/**
 * Look one child up without throwing.
 * @param childId - the id from the activation notice.
 * @returns the live handle, or undefined when the run already settled.
 */
export function findLiveRun(childId: string): LiveRun | undefined {
  return registry().get(childId)
}

/**
 * The ids of every child that can still accept a message.
 * @returns the live ids, in insertion order, for a "which run did you mean" hint.
 */
export function liveRunIds(): readonly string[] {
  return [...registry().keys()]
}
