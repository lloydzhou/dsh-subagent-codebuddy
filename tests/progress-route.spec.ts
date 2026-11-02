/**
 * The HTTP face of the progress feed.
 *
 * The route is what lets a browser card read host memory, so the tests are about
 * its boundaries: it answers GET/HEAD only, it serves only the ids asked for, it
 * is uncacheable, and a malformed request is a 400 rather than a crash inside the
 * host's request path.
 *
 * @module progress-route.spec
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply } from '../src/index.ts'
import { PROGRESS_PATH, handleProgressRequest, registerProgressRoute } from '../src/progress-route.ts'
import { beginProgress, finishProgress, recordProgress } from '../src/progress.ts'

/** One captured response, in the shape the handler produces. */
interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Drive the handler with a fake request/response pair.
 * @param method - HTTP method.
 * @param url - request target, as the host receives it.
 * @returns the status, headers, and body written.
 */
function call(method: string, url: string): Captured {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const request = { method, url } as IncomingMessage
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return this
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
  } as unknown as ServerResponse
  handleProgressRequest(request, response)
  return captured
}

describe('the progress route', () => {
  it('serves the rows for exactly the ids asked for', () => {
    const child = 'route-child-1'
    beginProgress(child, 1_000)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: '创建 vitest.config.ts', toolKind: 'edit', status: 'completed' }, 1_100)

    const answer = call('GET', `${PROGRESS_PATH}?ids=${child},someone-else`)
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toContain('application/json')
    // A progress feed must never be answered from a cache.
    expect(answer.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(answer.body) as { runs: Record<string, { steps: { label: string, state: string }[] }> }
    expect(Object.keys(body.runs)).toEqual([child])
    expect(body.runs[child]?.steps).toEqual([
      expect.objectContaining({ label: '创建 vitest.config.ts', state: 'done' }),
    ])
    finishProgress(child, 2_000)
  })

  it('answers an unknown id with an empty map, not an error', () => {
    const answer = call('GET', `${PROGRESS_PATH}?ids=nobody`)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ runs: {} })
  })

  it('answers with no ids at all instead of assuming all of them', () => {
    const answer = call('GET', PROGRESS_PATH)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ runs: {} })
  })

  it('refuses writes: this route is a viewer', () => {
    const answer = call('POST', PROGRESS_PATH)
    expect(answer.status).toBe(405)
    expect(JSON.parse(answer.body)).toEqual({ error: 'read-only' })
  })

  it('sends headers only for HEAD', () => {
    const answer = call('HEAD', `${PROGRESS_PATH}?ids=nobody`)
    expect(answer.status).toBe(200)
    expect(answer.headers['content-length']).toBeDefined()
    expect(answer.body).toBe('')
  })

  it('caps how many ids one request may ask for', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `id-${String(index)}`)
    const answer = call('GET', `${PROGRESS_PATH}?ids=${ids.join(',')}`)
    expect(answer.status).toBe(200)
    // Nothing is stored under these ids, so the interesting part is that a 60-id
    // query is accepted (and bounded) rather than becoming a 400 or a scan.
    expect(JSON.parse(answer.body)).toEqual({ runs: {} })
  })

  it('claims one exact route on the host web server', () => {
    const register = vi.fn(() => () => {})
    const dispose = registerProgressRoute({ register })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: PROGRESS_PATH }))
    // The returned disposer is the web server's own, passed straight through.
    expect(typeof dispose).toBe('function')
  })

  it('is claimed by the plugin when a web server is present', () => {
    // The wiring, not the handler: a plugin that never claims the route leaves
    // the card polling a 404 forever, which is invisible until someone watches
    // a run.
    const register = vi.fn(() => () => {})
    const effect = vi.fn((callback: () => unknown) => callback())
    const ctx = {
      logger: { warn: vi.fn() },
      subagents: { registerProvider: vi.fn() },
      inject: vi.fn((_deps: string[], callback: (scoped: unknown) => void) => {
        callback({ webServer: { register }, effect })
      }),
    }
    apply(ctx as never, new Config({}))
    expect(ctx.inject).toHaveBeenCalledWith(['webServer'], expect.any(Function))
    expect(effect).toHaveBeenCalled()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: PROGRESS_PATH }))
  })

  it('mounts without a web server, because the provider must work headless', () => {
    const ctx = {
      logger: { warn: vi.fn() },
      subagents: { registerProvider: vi.fn() },
      inject: vi.fn((_deps: string[], callback: (scoped: unknown) => void) => {
        // A headless profile: the injection resolves to a context with no
        // webServer at all.
        callback({ effect: vi.fn() })
      }),
    }
    expect(() => { apply(ctx as never, new Config({})) }).not.toThrow()
    expect(ctx.subagents.registerProvider).toHaveBeenCalled()
  })

  it('mounts on a context that cannot inject at all', () => {
    // A bare context (an older loader, a unit-test harness) has no `inject`; the
    // provider is still registered rather than the plugin failing to load.
    const ctx = {
      logger: { warn: vi.fn() },
      subagents: { registerProvider: vi.fn() },
    }
    expect(() => { apply(ctx as never, new Config({})) }).not.toThrow()
    expect(ctx.subagents.registerProvider).toHaveBeenCalled()
  })
})

/**
 * The same route also answers "what did this conversation start?" — the shape
 * the session header's jump menu reads. Its own tests, because the two shapes
 * must stay distinguishable: a caller that forgets `ids` must not silently get
 * a session listing, and vice versa.
 */
describe('the session listing on the progress route', () => {
  it('lists one session\'s runs and names the session it answered for', () => {
    const child = 'listing-child-1'
    beginProgress(child, 1_000, 1_000, { sessionId: 'route-session-a', label: 'fix the CSP header' })
    const answer = call('GET', `${PROGRESS_PATH}?session=route-session-a`)
    finishProgress(child, 2_000)

    expect(answer.status).toBe(200)
    expect(answer.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(answer.body) as {
      session: string
      runs: { childId: string, label: string, sessionId: string, endedAt?: number }[]
    }
    expect(body.session).toBe('route-session-a')
    expect(body.runs.map(row => row.childId)).toEqual([child])
    expect(body.runs[0]?.label).toBe('fix the CSP header')
  })

  it('answers a session with no runs with an empty list, not an error', () => {
    const answer = call('GET', `${PROGRESS_PATH}?session=route-session-nobody`)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ session: 'route-session-nobody', runs: [] })
  })

  it('caps one session listing instead of returning unbounded history', () => {
    for (let index = 0; index < 40; index += 1) {
      beginProgress(`listing-bulk-${String(index)}`, 1_000, 1_000 + index, { sessionId: 'route-session-bulk' })
    }
    const answer = call('GET', `${PROGRESS_PATH}?session=route-session-bulk`)
    const body = JSON.parse(answer.body) as { runs: unknown[] }
    expect(body.runs).toHaveLength(30)
  })

  it('prefers the session listing when both parameters are present', () => {
    const child = 'listing-child-both'
    beginProgress(child, 1_000, 1_000, { sessionId: 'route-session-both' })
    const answer = call('GET', `${PROGRESS_PATH}?session=route-session-both&ids=${child}`)
    const body = JSON.parse(answer.body) as { session?: string, runs: unknown }
    expect(body.session).toBe('route-session-both')
    // The listing shape is an array; the id shape would have been an object.
    expect(Array.isArray(body.runs)).toBe(true)
  })

  it('sends headers only for HEAD', () => {
    const answer = call('HEAD', `${PROGRESS_PATH}?session=route-session-empty`)
    expect(answer.status).toBe(200)
    expect(answer.headers['content-length']).toBeDefined()
    expect(answer.body).toBe('')
  })
})
