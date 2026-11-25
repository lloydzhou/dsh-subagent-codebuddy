/**
 * The header's run list: reading a session listing that may be wrong.
 *
 * The failure that matters here is silent — a run the parser drops simply never
 * appears in the jump list, and the reader concludes the run is gone. So the
 * tests are about what survives parsing and how a row is named.
 *
 * @module client-runs.spec
 */

import { describe, expect, it } from 'vitest'
import { PROGRESS_ENDPOINT } from '../src/client/live.ts'
import {
  aggregateState,
  fetchSessionRuns,
  readSessionRuns,
  rowElapsed,
  rowTitle,
  sessionRunsUrl,
} from '../src/client/runs.ts'

const SESSION = 'aaaa1111-2222'

/** One run as the provider serializes it. */
function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childId: 'b084f8d4-0915',
    sessionId: SESSION,
    label: 'fix the CSP header',
    steps: [{ id: 'c1' }, { id: 'c2' }],
    dropped: 0,
    startedAt: 1_000,
    updatedAt: 2_000,
    ...extra,
  }
}

describe('readSessionRuns', () => {
  it('reads the rows the provider ranked, in order', () => {
    const rows = readSessionRuns({
      session: SESSION,
      runs: [
        row({ childId: 'live-1' }),
        row({ childId: 'done-1', endedAt: 3_000 }),
      ],
    }, SESSION)
    expect(rows.map(entry => entry.childId)).toEqual(['live-1', 'done-1'])
    expect(rows[0]).toEqual({
      childId: 'live-1',
      label: 'fix the CSP header',
      steps: 2,
      running: true,
      // A listed live run has already been handed off to the background, which
      // is the state the card paints amber.
      state: 'delegated',
      startedAt: 1_000,
      updatedAt: 2_000,
    })
    expect(rows[1]?.endedAt).toBe(3_000)
    expect(rows[1]?.running).toBe(false)
  })

  it('counts the rows the provider cap dropped, not just the ones it sent', () => {
    const [only] = readSessionRuns({ runs: [row({ dropped: 47 })] }, SESSION)
    expect(only?.steps).toBe(49)
  })

  it('carries the pinned model through, and only a real non-empty id', () => {
    const [named] = readSessionRuns({ runs: [row({ model: 'deepseek-v4.1-flash' })] }, SESSION)
    expect(named?.model).toBe('deepseek-v4.1-flash')
    // Absent, empty, and non-string values all read as "no model": an older
    // provider build never recorded one, and the row hides the line instead.
    for (const bad of [undefined, '', 42]) {
      const [clean] = readSessionRuns({ runs: [row({ model: bad })] }, SESSION)
      expect(clean?.model).toBeUndefined()
    }
  })

  it('ignores rows from another session', () => {
    const rows = readSessionRuns({ runs: [row({ sessionId: 'other' })] }, SESSION)
    expect(rows).toEqual([])
  })

  it('drops a row without an id and keeps the rest', () => {
    const rows = readSessionRuns({ runs: [{ label: 'nameless' }, row()] }, SESSION)
    expect(rows).toHaveLength(1)
  })

  it('reads anything unreadable as no runs rather than throwing', () => {
    expect(readSessionRuns(null, SESSION)).toEqual([])
    expect(readSessionRuns('nope', SESSION)).toEqual([])
    expect(readSessionRuns({ runs: 'nope' }, SESSION)).toEqual([])
    expect(readSessionRuns({ runs: [null, 7] }, SESSION)).toEqual([])
  })

  it('keeps a row whose numbers are missing, defaulting them to zero', () => {
    const [only] = readSessionRuns({ runs: [{ childId: 'x' }] }, SESSION)
    expect(only).toEqual({
      childId: 'x', label: '', steps: 0, running: true, state: 'delegated', startedAt: 0, updatedAt: 0,
    })
  })
})

/**
 * The dot's state has to match the card's, because both draw the same run: a
 * row that said "running" in blue while its card said "后台运行中" in amber was
 * the bug these assertions exist to prevent.
 */
describe('the state a row paints', () => {
  it('maps every recorded ending onto the card vocabulary', () => {
    const cases = [
      ['completed', 'done'],
      ['stopped', 'stopped'],
      ['refused', 'refused'],
      ['failed', 'failed'],
    ] as const
    for (const [outcome, state] of cases) {
      const [only] = readSessionRuns({ runs: [row({ endedAt: 3_000, outcome })] }, SESSION)
      expect(only?.state).toBe(state)
      expect(only?.running).toBe(false)
    }
  })

  it('does not claim an ending it was not told', () => {
    // A feed that predates the outcome field (or one whose process died between
    // the two writes) must not read as success: `stopped` is the one state that
    // makes no claim either way.
    const [only] = readSessionRuns({ runs: [row({ endedAt: 3_000 })] }, SESSION)
    expect(only?.state).toBe('stopped')
  })

  it('ignores an outcome on a run that has not ended', () => {
    const [only] = readSessionRuns({ runs: [row({ outcome: 'completed' })] }, SESSION)
    expect(only?.state).toBe('delegated')
  })
})

describe('aggregateState', () => {
  /** A row with only the fields the summary reads. */
  function shaped(state: 'delegated' | 'done' | 'failed' | 'stopped'): {
    childId: string, label: string, steps: number, running: boolean, state: typeof state, startedAt: number, updatedAt: number
  } {
    return {
      childId: state, label: '', steps: 0, running: state === 'delegated', state, startedAt: 0, updatedAt: 0,
    }
  }

  it('lets anything still going outrank a verdict', () => {
    expect(aggregateState([shaped('failed'), shaped('delegated')])).toBe('delegated')
  })

  it('reports a failure among finished runs', () => {
    expect(aggregateState([shaped('done'), shaped('failed')])).toBe('failed')
  })

  it('reports a clean set as done', () => {
    expect(aggregateState([shaped('done'), shaped('done')])).toBe('done')
  })

  it('reports a mixed set that did not fail as stopped', () => {
    expect(aggregateState([shaped('done'), shaped('stopped')])).toBe('stopped')
    expect(aggregateState([])).toBe('stopped')
  })
})

describe('row naming and ageing', () => {
  it('falls back to the short id when the caller supplied no label', () => {
    const [labelled, bare] = readSessionRuns({
      runs: [row(), row({ childId: 'c9f1a2b3-4444', label: undefined })],
    }, SESSION)
    expect(rowTitle(labelled!)).toBe('fix the CSP header')
    expect(rowTitle(bare!)).toBe('c9f1a2b3')
  })

  it('counts a running run up to now and freezes a finished one', () => {
    const [live, done] = readSessionRuns({
      runs: [row(), row({ childId: 'done', endedAt: 4_000 })],
    }, SESSION)
    expect(rowElapsed(live!, 61_000)).toBe(60_000)
    expect(rowElapsed(done!, 61_000)).toBe(3_000)
  })
})

describe('the listing request', () => {
  it('addresses the session on the same route the card polls', () => {
    expect(sessionRunsUrl(SESSION)).toBe(`${PROGRESS_ENDPOINT}?session=${encodeURIComponent(SESSION)}`)
  })

  it('tells "no runs" apart from "the host did not answer"', async () => {
    // A host without the route (or one that errored) must not blank the list
    // that is already on screen; an empty answer may.
    const original = globalThis.fetch
    try {
      globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch
      expect(await fetchSessionRuns(SESSION)).toEqual([])
      globalThis.fetch = (() => Promise.resolve(new Response('', { status: 500 }))) as typeof fetch
      expect(await fetchSessionRuns(SESSION)).toBeUndefined()
      globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
      expect(await fetchSessionRuns(SESSION)).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})
