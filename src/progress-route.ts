/**
 * The HTTP face of the progress feed: one GET route the chat card polls while a
 * child runs.
 *
 * The card lives in the browser and cannot read the host's memory, so the
 * feed needs a transport. Three properties make this route the right one:
 *
 * - **Same origin.** The page is served by this very listener, so a relative
 *   `fetch('/subagent-codebuddy/progress?ids=…')` reaches it in the web UI and
 *   in the desktop window alike (the desktop forwards `dsh-app://app/…` to the
 *   host it owns, keeping the path).
 * - **Not the model's.** A progress tick does not belong in the parent's
 *   conversation: injecting it would put a heartbeat into the model's context
 *   and wake it for work it did not ask for.
 * - **Read-only and local.** The route only serves ids the caller already knows
 *   from its own transcript, and it never writes.
 *
 * @module dsh-subagent-codebuddy/progress-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readProgress, readProgressBySession } from './progress.js'

/** Where the card asks; one constant so both sides cannot drift. */
export const PROGRESS_PATH = '/subagent-codebuddy/progress'

/** Ids per request: the card tracks one run, so this is a sanity bound. */
const MAX_IDS = 20

/** Rows per session listing: a jump menu, not a report. */
const MAX_LISTED = 30

/**
 * The slice of `ctx.webServer` this module needs. Declared structurally rather
 * than imported: the web host is a peer of the composition, absent in a
 * headless profile, and importing it would make this package unloadable there.
 */
export interface RouteHost {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Answer one progress poll.
 *
 * Two shapes ride the same route because they answer the same question at two
 * grains: `?ids=` is one run's feed for a card already on screen, `?session=`
 * is every run one conversation started, for the header's jump list. Keeping
 * them together means one origin, one path, and one place to reason about what
 * a page can learn.
 * @param request - the incoming HTTP request.
 * @param response - its response.
 */
export function handleProgressRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    respond(response, 405, { error: 'read-only' }, request.method === 'HEAD')
    return
  }
  let url: URL
  try {
    url = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    // A malformed URL is the caller's problem, not a reason to fail the page.
    respond(response, 400, { error: 'bad request' }, false)
    return
  }
  const session = url.searchParams.get('session')
  if (session !== null && session !== '') {
    respond(
      response,
      200,
      { session, runs: readProgressBySession(session, MAX_LISTED) },
      request.method === 'HEAD',
    )
    return
  }
  const ids = (url.searchParams.get('ids') ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .slice(0, MAX_IDS)
  respond(response, 200, { runs: readProgress(ids) }, request.method === 'HEAD')
}

/**
 * Write one JSON response.
 * @param response - the response to write.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 * @param head - true for a HEAD request, which sends headers only.
 */
function respond(response: ServerResponse, status: number, body: unknown, head: boolean): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A progress feed is the definition of uncacheable.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(head ? undefined : text)
}

/**
 * Claim the route on the host's web server.
 * @param webServer - the host's web server service.
 * @returns the disposer removing the route (also runs when the fiber unloads).
 */
export function registerProgressRoute(webServer: RouteHost): () => void {
  return webServer.register({
    kind: 'exact',
    path: PROGRESS_PATH,
    handler: handleProgressRequest,
  })
}
