/**
 * The two cost-line renderings.
 *
 * The header may only spend one line on cost, so the compact form is what
 * readers actually see; these cases pin the folding rules (a single call is
 * implied, tokens read as arrows) and make sure the hover title still spells
 * everything out.
 */

import { describe, expect, it } from 'vitest'
import { formatUsageCompact, formatUsageFull } from '../src/client/usage.ts'

const FULL = { credit: '0.01', calls: '1', input: '181', output: '3', cached: '23.9k' }

describe('usage formatting', () => {
  it('spells the line out for the hover title', () => {
    expect(formatUsageFull(FULL)).toBe('用量 0.01 credit · 1 次调用 · 输入 181 / 输出 3 · 缓存 23.9k')
  })

  it('folds the line down to what the header can hold', () => {
    expect(formatUsageCompact(FULL)).toBe('0.01 credit · ↑181 ↓3 · 缓存 23.9k')
  })

  it('keeps the call count only when it is worth mentioning', () => {
    expect(formatUsageCompact({ ...FULL, calls: '3' })).toContain('3 次')
    expect(formatUsageCompact({ ...FULL, calls: '1' })).not.toContain('次')
  })

  it('never invents a field the CLI did not print', () => {
    expect(formatUsageCompact({ credit: '0.02' })).toBe('0.02 credit')
    expect(formatUsageCompact({ input: '10' })).toBe('↑10')
    expect(formatUsageCompact({})).toBe('')
  })
})
