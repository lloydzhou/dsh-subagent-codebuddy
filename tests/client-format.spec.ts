/**
 * The header's clock and its hover explanation.
 *
 * The card can only observe two events — the handoff and the settlement — so
 * the one thing it must never do is look like proof of life. These cases pin
 * that: a live run counts up to the caller's clock, a settled run reports the
 * fixed duration even when the clock has moved on, and the tooltip names where
 * real liveness can be read.
 */

import { describe, expect, it } from 'vitest'
import type { CodebuddyRunData } from '../src/client/definition.ts'
import { formatDuration, isLiveStatus, liveHint, metaText, summarize } from '../src/client/format.ts'

const STARTED_AT = 1_000_000

/** The minimum node data the header reads. */
function data(over: Partial<CodebuddyRunData> = {}): CodebuddyRunData {
  return {
    task: 'migrate the build script',
    prompt: 'migrate the build script to esbuild',
    status: 'delegated',
    output: '',
    steps: [],
    steers: [],
    startedAt: STARTED_AT,
    durationMs: 1000,
    ...over,
  }
}

describe('durations', () => {
  it('rounds to the unit a header has room for', () => {
    expect(formatDuration(0)).toBe('<1s')
    expect(formatDuration(999)).toBe('<1s')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(42_400)).toBe('42s')
    expect(formatDuration(423_000)).toBe('7m03s')
  })
})

describe('task summaries', () => {
  it('takes the first non-empty line and shortens long ones', () => {
    expect(summarize('\n  fix the parser  \nand more')).toBe('fix the parser')
    expect(summarize('x'.repeat(80))).toBe(`${'x'.repeat(72)}…`)
    expect(summarize('')).toBe('')
  })
})

describe('header meta', () => {
  it('counts up while the run is outstanding', () => {
    expect(metaText(data({ status: 'delegated' }), STARTED_AT + 12_000)).toBe('12s · 后台运行中')
    expect(metaText(data({ status: 'running' }), STARTED_AT + 2000)).toBe('2s · 运行中')
  })

  it('freezes at the settled duration instead of drifting with the clock', () => {
    const settled = data({ status: 'done', durationMs: 42_000 })
    expect(metaText(settled, STARTED_AT + 42_000)).toBe('42s · 已完成')
    // A minute later the card says the same thing: the run is over.
    expect(metaText(settled, STARTED_AT + 102_000)).toBe('42s · 已完成')
  })

  it('names every terminal state', () => {
    expect(metaText(data({ status: 'stopped', durationMs: 5000 }), 0)).toContain('已停止')
    expect(metaText(data({ status: 'refused', durationMs: 5000 }), 0)).toContain('被拒绝')
    expect(metaText(data({ status: 'failed', durationMs: 5000 }), 0)).toContain('失败')
  })
})

describe('liveness wording', () => {
  it('treats only running and delegated as live', () => {
    expect(isLiveStatus('running')).toBe(true)
    expect(isLiveStatus('delegated')).toBe(true)
    for (const settled of ['done', 'stopped', 'refused', 'failed'] as const) {
      expect(isLiveStatus(settled)).toBe(false)
    }
  })

  it('says the clock is not proof of life, and where the proof is', () => {
    const hint = liveHint(data({ childId: 'child_abc' }))
    expect(hint).toContain('中途没有心跳')
    expect(hint).toContain('不证明它此刻还活着')
    expect(hint).toContain('codebuddy-runs')
    expect(hint).toContain('codebuddy-runs -f child_abc')
  })

  it('has nothing to explain once the run has a verdict', () => {
    expect(liveHint(data({ status: 'done' }))).toBeUndefined()
  })
})
