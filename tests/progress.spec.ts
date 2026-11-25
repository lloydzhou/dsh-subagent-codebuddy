/**
 * The provider-side progress feed: what the card reads while a child runs.
 *
 * These are unit tests over the feed itself — the merge rule that turns three
 * ACP status updates into one timeline row, the plan row that changes in place,
 * the cap that keeps a chatty run from growing without bound, and the TTL that
 * lets a settled feed answer a poll that was already in flight.
 *
 * @module progress.spec
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_STEPS,
  beginProgress,
  finishProgress,
  pruneProgress,
  readProgress,
  readProgressBySession,
  recordProgress,
  runOutcome,
  stepState,
} from '../src/progress.ts'

/**
 * The store is process-global, so each test takes its own child id rather than
 * clearing state another test might be relying on.
 */
let counter = 0
function freshChild(): string {
  counter += 1
  return `child-${String(counter)}`
}

describe('stepState', () => {
  it('maps ACP words onto the four states a row can show', () => {
    expect(stepState('pending')).toBe('running')
    expect(stepState('in_progress')).toBe('running')
    expect(stepState('completed')).toBe('done')
    expect(stepState('failed')).toBe('failed')
    expect(stepState('cancelled')).toBe('stopped')
    // An unrecognized status is not a failure; the row stays live.
    expect(stepState('reticulating')).toBe('running')
  })
})

describe('the progress feed', () => {
  it('keeps one row per tool call as its status advances', () => {
    const child = freshChild()
    beginProgress(child, 1_000)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Edit src/a.ts', toolKind: 'edit', status: 'pending' }, 1_100)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Edit src/a.ts', status: 'in_progress' }, 1_200)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Edit src/a.ts', status: 'completed' }, 1_300)

    const run = readProgress([child])[child]
    expect(run?.steps).toHaveLength(1)
    expect(run?.steps[0]).toMatchObject({
      id: 't1',
      kind: 'tool',
      label: 'Edit src/a.ts',
      detail: 'edit',
      state: 'done',
      // The row keeps the time it first appeared: a timeline sorts on when the
      // action started, not when its last status landed.
      at: 1_100,
    })
    expect(run?.updatedAt).toBe(1_300)
  })

  it('keeps a later status visible on the same row', () => {
    const child = freshChild()
    beginProgress(child, 1_000)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Run tests', toolKind: 'execute', status: 'pending' }, 1_100)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Run tests', status: 'failed' }, 1_200)
    expect(readProgress([child])[child]?.steps[0]).toMatchObject({ label: 'Run tests', state: 'failed' })
  })

  it('replaces the plan row instead of appending one per update', () => {
    const child = freshChild()
    beginProgress(child, 1_000)
    recordProgress(child, { kind: 'plan', done: 0, total: 3, current: 'read the config' }, 1_100)
    recordProgress(child, { kind: 'plan', done: 1, total: 3, current: 'patch it' }, 1_200)
    recordProgress(child, { kind: 'plan', done: 3, total: 3 }, 1_300)

    const steps = readProgress([child])[child]?.steps ?? []
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ id: 'plan', kind: 'plan', label: '3/3 步', state: 'done', at: 1_100 })
  })

  it('ignores actions for a child it never opened a feed for', () => {
    // A run that started before this module existed, or one whose start failed
    // before the feed opened: recording must not conjure a run.
    recordProgress('never-opened', { kind: 'tool', toolCallId: 't9', title: 'x', status: 'pending' }, 1_000)
    expect(readProgress(['never-opened'])).toEqual({})
  })

  it('bounds a chatty run and keeps the newest rows', () => {
    const child = freshChild()
    beginProgress(child, 1_000)
    for (let index = 0; index < MAX_STEPS + 12; index += 1) {
      recordProgress(child, { kind: 'tool', toolCallId: `t${String(index)}`, title: `step ${String(index)}`, status: 'completed' }, 2_000 + index)
    }
    const steps = readProgress([child])[child]?.steps ?? []
    expect(steps).toHaveLength(MAX_STEPS)
    expect(steps[0]?.label).toBe('step 12')
    expect(steps[steps.length - 1]?.label).toBe(`step ${String(MAX_STEPS + 11)}`)
    // The dropped rows are still counted: the card says "72 步", not "60 步".
    expect(readProgress([child])[child]?.dropped).toBe(12)
  })

  it('keeps a settled feed readable for a while, then drops it', () => {
    const child = freshChild()
    beginProgress(child, 1_000)
    recordProgress(child, { kind: 'tool', toolCallId: 't1', title: 'Edit', status: 'completed' }, 1_100)
    finishProgress(child, 2_000)
    expect(readProgress([child])[child]?.endedAt).toBe(2_000)
    // Nine minutes on: a poll that was in flight when the child settled still
    // finds its rows.
    pruneProgress(2_000 + 9 * 60_000)
    expect(readProgress([child])[child]).toBeDefined()
    // Past the TTL the entry is gone rather than stale forever.
    pruneProgress(2_000 + 11 * 60_000)
    expect(readProgress([child])[child]).toBeUndefined()
  })

  it('evicts settled runs before live ones', () => {
    const live = freshChild()
    beginProgress(live, 1_000, 1_000)
    // Fill past the cap with settled runs; the live one must survive them all.
    let firstSettled = ''
    for (let index = 0; index < 60; index += 1) {
      const settled = freshChild()
      if (index === 0) firstSettled = settled
      beginProgress(settled, 1_000, 1_000 + index)
      finishProgress(settled, 1_000 + index)
    }
    pruneProgress(1_000 + 60)
    expect(readProgress([live])[live]).toBeDefined()
    // The oldest settled run is the one that went.
    expect(readProgress([firstSettled])[firstSettled]).toBeUndefined()
  })
})

describe('session listings', () => {
  it('carries the conversation and label a run was started with', () => {
    const child = freshChild()
    beginProgress(child, 1_000, 1_000, { sessionId: 'session-a', label: 'fix the CSP header' })
    const [row] = readProgressBySession('session-a')
    expect(row?.childId).toBe(child)
    expect(row?.label).toBe('fix the CSP header')
    expect(row?.sessionId).toBe('session-a')
  })

  it('carries the pinned model a run was started with, and only when there is one', () => {
    const pinned = freshChild()
    const bare = freshChild()
    beginProgress(pinned, 1_000, 1_000, { sessionId: 'session-model', model: 'deepseek-v4.1-flash' })
    beginProgress(bare, 1_000, 1_000, { sessionId: 'session-model' })
    const rows = readProgressBySession('session-model')
    const found = Object.fromEntries(rows.map(row => [row.childId, row.model]))
    expect(found[pinned]).toBe('deepseek-v4.1-flash')
    expect(found[bare]).toBeUndefined()
  })

  it('lists only the runs of the session asked for', () => {
    const mine = freshChild()
    const other = freshChild()
    beginProgress(mine, 1_000, 1_000, { sessionId: 'session-b' })
    beginProgress(other, 1_000, 1_000, { sessionId: 'session-c' })
    expect(readProgressBySession('session-b').map(row => row.childId)).toEqual([mine])
    expect(readProgressBySession('session-nobody')).toEqual([])
  })

  it('puts still-running runs first, then the most recently active', () => {
    const oldDone = freshChild()
    const freshDone = freshChild()
    const live = freshChild()
    beginProgress(oldDone, 1_000, 1_000, { sessionId: 'session-d' })
    finishProgress(oldDone, 2_000)
    beginProgress(freshDone, 3_000, 3_000, { sessionId: 'session-d' })
    finishProgress(freshDone, 9_000)
    beginProgress(live, 4_000, 4_000, { sessionId: 'session-d' })
    expect(readProgressBySession('session-d').map(row => row.childId)).toEqual([live, freshDone, oldDone])
  })

  it('bounds the list: the header is a jump menu, not a report', () => {
    for (let index = 0; index < 5; index += 1) {
      beginProgress(freshChild(), 1_000, 1_000 + index, { sessionId: 'session-e' })
    }
    expect(readProgressBySession('session-e', 3)).toHaveLength(3)
  })
})

/**
 * The ending is recorded, not inferred. A reader looking at a finished row in
 * the header's jump list has no settlement notice in front of them — the feed is
 * the only place the success/failure distinction can come from.
 */
describe('the recorded ending', () => {
  it('maps harness stop reasons onto the four endings a dot distinguishes', () => {
    expect(runOutcome('completed')).toBe('completed')
    expect(runOutcome('aborted')).toBe('stopped')
    expect(runOutcome('refusal')).toBe('refused')
    expect(runOutcome('error')).toBe('failed')
    // A child that ran out of room stopped short of finishing: the settlement
    // notice calls that a failure, and so does this.
    expect(runOutcome('max-tokens')).toBe('failed')
    expect(runOutcome('something-new')).toBe('failed')
  })

  it('survives the bare close that teardown performs afterwards', () => {
    const child = freshChild()
    beginProgress(child, 1_000, 1_000)
    finishProgress(child, 2_000, 'failed')
    // Teardown closes again, without a reason; the verdict must not be erased.
    finishProgress(child, 2_500)
    const run = readProgress([child])[child]
    expect(run?.outcome).toBe('failed')
    expect(run?.endedAt).toBe(2_000)
  })

  it('has no ending while the run is still going', () => {
    const child = freshChild()
    beginProgress(child, 1_000, 1_000)
    expect(readProgress([child])[child]?.outcome).toBeUndefined()
  })
})
