/**
 * Contract of transcript token accounting.
 *
 * ACP never carries usage, so this module is the only place the delegated run's
 * cost can come from. The sum rule matters: `prompt_tokens` is the whole context
 * of one request, not a delta, and every request is billed on its own context —
 * so requests add up rather than collapsing to the latest one.
 *
 * @module usage.spec
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatTokens, formatUsageNotice, readTranscriptUsage, tokensPerSecond } from '../src/usage.js'

const dirs: string[] = []

function transcript(rows: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-spec-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return file
}

function request(usage: Record<string, unknown>): unknown {
  return { type: 'function_call', providerData: { rawUsage: usage } }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readTranscriptUsage', () => {
  it('sums every request instead of collapsing to the latest context', async () => {
    const file = transcript([
      request({ prompt_tokens: 100, completion_tokens: 10 }),
      request({ prompt_tokens: 300, completion_tokens: 20 }),
    ])
    const usage = await readTranscriptUsage(file)
    expect(usage?.calls).toBe(2)
    expect(usage?.input).toBe(400)
    expect(usage?.output).toBe(30)
  })

  it('splits cache hits out of the prompt total', async () => {
    const file = transcript([
      request({
        prompt_tokens: 26_451,
        completion_tokens: 197,
        prompt_cache_hit_tokens: 25_856,
        prompt_cache_miss_tokens: 595,
        completion_tokens_details: { reasoning_tokens: 7 },
        credit: 0.05,
      }),
    ])
    const usage = await readTranscriptUsage(file)
    expect(usage?.input).toBe(595)
    expect(usage?.cacheRead).toBe(25_856)
    expect(usage?.output).toBe(197)
    expect(usage?.reasoning).toBe(7)
    expect(usage?.credit).toBeCloseTo(0.05)
  })

  it('derives the uncached remainder when the provider omits the miss count', async () => {
    const file = transcript([
      request({ prompt_tokens: 1_000, completion_tokens: 5, prompt_cache_hit_tokens: 400 }),
    ])
    expect((await readTranscriptUsage(file))?.input).toBe(600)
  })

  it('ignores rows without accounting and unparsable rows', async () => {
    const file = transcript([
      { type: 'message', message: 'hello' },
      request({ prompt_tokens: 10, completion_tokens: 1 }),
      { type: 'function_call', providerData: {} },
    ])
    const usage = await readTranscriptUsage(file)
    expect(usage?.calls).toBe(1)
    expect(usage?.input).toBe(10)
  })

  it('returns undefined when the transcript is missing', async () => {
    expect(await readTranscriptUsage(join(tmpdir(), 'does-not-exist-codebuddy.jsonl'))).toBeUndefined()
  })

  it('returns undefined when no request reported accounting', async () => {
    const file = transcript([{ type: 'message', message: 'hello' }])
    expect(await readTranscriptUsage(file)).toBeUndefined()
  })
})

describe('formatTokens', () => {
  it('keeps small counts exact and abbreviates large ones', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_234)).toBe('1.2k')
    expect(formatTokens(26_648)).toBe('26.6k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })
})

describe('formatUsageNotice', () => {
  it('leads with billed credits when the provider reports a price', () => {
    const notice = formatUsageNotice({
      calls: 3, input: 800, cacheRead: 20_000, cacheWrite: 0, output: 400, reasoning: 0, credit: 0.12,
    })
    expect(notice).toContain('用量 0.12 credit')
    expect(notice).toContain('3 次调用')
    expect(notice).toContain('输入 800')
    expect(notice).toContain('缓存 20k')
  })

  it('falls back to uncached tokens when no price is reported', () => {
    const notice = formatUsageNotice({
      calls: 1, input: 900, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0, credit: 0,
    })
    expect(notice).toContain('用量 1k tokens')
    expect(notice).not.toContain('缓存')
    expect(notice).toContain('1 次调用')
  })

  it('keeps cache reads out of the headline so a cheap run never looks ruinous', () => {
    const notice = formatUsageNotice({
      calls: 2, input: 1_000, cacheRead: 28_000_000, cacheWrite: 0, output: 500, reasoning: 0, credit: 0,
    })
    expect(notice).toContain('用量 1.5k tokens')
    expect(notice).toContain('缓存 28M')
  })

  it('returns undefined when nothing was recorded', () => {
    expect(formatUsageNotice(undefined)).toBeUndefined()
  })
})

describe('tokensPerSecond', () => {
  const base = { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, credit: 0 }

  it('reports output tokens over the whole run', () => {
    expect(tokensPerSecond({ ...base, output: 1_000 }, 2_000)).toBeCloseTo(500)
  })

  it('returns 0 instead of dividing by a zero clock or zero output', () => {
    expect(tokensPerSecond({ ...base, output: 1_000 }, 0)).toBe(0)
    expect(tokensPerSecond({ ...base, output: 0 }, 5_000)).toBe(0)
  })
})
