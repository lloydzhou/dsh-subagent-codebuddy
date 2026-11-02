/**
 * The card's live half, as pure functions: reading a feed that may be wrong,
 * narrowing it to the rows that fit, and ageing the last action.
 *
 * The polling itself is browser plumbing; what deserves assertions is the
 * contract with the host, because a viewer must degrade instead of throwing
 * inside render.
 *
 * @module client-live.spec
 */

import { describe, expect, it } from 'vitest'
import {
  POLL_INTERVAL_MS,
  PROGRESS_ENDPOINT,
  VISIBLE_STEPS,
  cachedFeed,
  formatAgo,
  lastActionText,
  progressUrl,
  readFeed,
  rememberFeed,
  visibleSteps,
} from '../src/client/live.ts'

const CHILD = 'b084f8d4-0915'

/** One well-formed host response. */
function bodyWith(steps: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { runs: { [CHILD]: { startedAt: 1_000, updatedAt: 2_000, steps, ...extra } } }
}

describe('progressUrl', () => {
  it('asks the host on this page origin', () => {
    // Relative on purpose: the web UI is served by the host, and the desktop
    // window forwards `dsh-app://app/…` to the host it owns, so one URL works in
    // both without knowing a port.
    expect(progressUrl(CHILD)).toBe(`${PROGRESS_ENDPOINT}?ids=${CHILD}`)
    expect(progressUrl('a b&c')).toBe(`${PROGRESS_ENDPOINT}?ids=a%20b%26c`)
  })
})

describe('readFeed', () => {
  it('reads a well-formed feed', () => {
    const feed = readFeed(bodyWith([
      { id: 'plan', kind: 'plan', label: '1/3 步', state: 'running', at: 1_100 },
      { id: 't1', kind: 'tool', label: '创建 vitest.config.ts', detail: 'edit', state: 'done', at: 1_200 },
    ]), CHILD)
    expect(feed?.updatedAt).toBe(2_000)
    expect(feed?.endedAt).toBeUndefined()
    expect(feed?.steps.map(step => step.label)).toEqual(['1/3 步', '创建 vitest.config.ts'])
    expect(feed?.steps[1]?.detail).toBe('edit')
  })

  it('keeps the settled marker when the host closed the feed', () => {
    const feed = readFeed(bodyWith([], { endedAt: 2_500 }), CHILD)
    expect(feed?.endedAt).toBe(2_500)
    expect(feed?.steps).toEqual([])
  })

  it('counts the rows the host had to drop, not just the ones it sent', () => {
    // The host keeps the last 60 rows and reports the rest as `dropped`; the
    // card must say 185 步, not 60 步, even though it can only list 60.
    const rows = Array.from({ length: 60 }, (_, index) => ({ id: `t${index}`, kind: 'tool', label: `s${index}`, state: 'done', at: index }))
    const feed = readFeed(bodyWith(rows, { dropped: 125 }), CHILD)
    expect(feed?.steps).toHaveLength(60)
    expect(feed?.total).toBe(185)
    // A host that predates the field still counts what it sent.
    expect(readFeed(bodyWith(rows), CHILD)?.total).toBe(60)
  })

  it('drops rows it cannot draw instead of failing the whole feed', () => {
    const feed = readFeed(bodyWith([
      { id: 't1', kind: 'tool', label: 'good', state: 'running', at: 1 },
      { id: 't2', kind: 'wat', label: 'unknown kind', state: 'running', at: 2 },
      { id: 't3', kind: 'tool', label: 'unknown state', state: 'zombie', at: 3 },
      { id: 't4', kind: 'tool', state: 'running', at: 4 },
      null,
      'nonsense',
    ]), CHILD)
    expect(feed?.steps.map(step => step.id)).toEqual(['t1'])
  })

  it('treats every malformed payload as "no feed"', () => {
    for (const payload of [null, undefined, 42, 'text', [], {}, { runs: null }, { runs: { [CHILD]: 7 } }]) {
      expect(readFeed(payload, CHILD)).toBeUndefined()
    }
  })

  it('never hands one run its rows under another child id', () => {
    expect(readFeed(bodyWith([{ id: 't1', kind: 'tool', label: 'x', state: 'done', at: 1 }]), 'other-child')).toBeUndefined()
  })
})

describe('visibleSteps', () => {
  const steps = Array.from({ length: VISIBLE_STEPS + 5 }, (_, index) => ({
    id: `t${String(index)}`,
    kind: 'tool' as const,
    label: `step ${String(index)}`,
    state: 'done' as const,
    at: index,
  }))

  it('shows everything when it fits', () => {
    expect(visibleSteps(steps.slice(0, 3))).toEqual({ shown: steps.slice(0, 3), hidden: 0 })
  })

  it('keeps the newest rows and counts the rest', () => {
    const { shown, hidden } = visibleSteps(steps)
    // The newest row is what the child is doing; the oldest are history.
    expect(hidden).toBe(5)
    expect(shown[shown.length - 1]?.label).toBe(`step ${String(steps.length - 1)}`)
    expect(shown).toHaveLength(VISIBLE_STEPS)
  })
})

describe('lastActionText', () => {
  const feed = {
    steps: [{ id: 't1', kind: 'tool' as const, label: 'x', state: 'done' as const, at: 10_000 }],
    total: 1,
    updatedAt: 10_000,
  }

  it('reports the age of the last row', () => {
    const recent = {
      steps: [{ id: 't1', kind: 'tool' as const, label: 'x', state: 'done' as const, at: 10_000_000 }],
      total: 1,
      updatedAt: 10_000_000,
    }
    expect(lastActionText(recent, 10_012_000)).toBe('最后动作 12s 前')
  })

  it('says nothing when there is nothing to age', () => {
    expect(lastActionText(undefined, 10_000)).toBe('')
    expect(lastActionText({ steps: [], total: 0, updatedAt: 1 }, 10_000)).toBe('')
  })

  it('formats ages the way a person reads them', () => {
    expect(formatAgo(0)).toBe('<1s')
    expect(formatAgo(59)).toBe('59s')
    expect(formatAgo(60)).toBe('1m')
    expect(formatAgo(3_600)).toBe('1h')
  })
})

describe('the poll cadence', () => {
  it('is slow enough to be free and fast enough to look live', () => {
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000)
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(3_000)
  })
})

describe('the page cache', () => {
  it('hands a remounted card the timeline it already fetched', () => {
    // Polling stops at settlement, so without this the finished card would show
    // only its closing message — the run's history would vanish exactly when the
    // reader wants to review it.
    const feed = { steps: [], total: 0, updatedAt: 5_000, endedAt: 6_000 }
    rememberFeed('child_cache_a', feed)
    expect(cachedFeed('child_cache_a')).toEqual(feed)
    expect(cachedFeed('child_cache_never')).toBeUndefined()
  })

  it('keeps the newest snapshot for a run, not the first', () => {
    rememberFeed('child_cache_b', { steps: [], total: 0, updatedAt: 1 })
    const newest = { steps: [], total: 0, updatedAt: 9 }
    rememberFeed('child_cache_b', newest)
    expect(cachedFeed('child_cache_b')).toEqual(newest)
  })
})
