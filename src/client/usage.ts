/**
 * Two renderings of one run's cost line.
 *
 * The header has room for exactly one line next to the duration, so the card
 * shows the compact form and keeps the spelled-out version in the hover title.
 * Both are derived from the same parsed fields, so they can never disagree.
 */

import type { CodebuddyUsage } from './definition.ts'

/**
 * The spelled-out reading, used as the hover title.
 * @param usage - parsed accounting fields.
 * @returns e.g. `用量 0.01 credit · 1 次调用 · 输入 181 / 输出 3 / 缓存 23.9k`.
 */
export function formatUsageFull(usage: CodebuddyUsage): string {
  const parts: string[] = []
  if (usage.credit !== undefined) parts.push(`用量 ${usage.credit} credit`)
  if (usage.calls !== undefined) parts.push(`${usage.calls} 次调用`)
  const tokens: string[] = []
  if (usage.input !== undefined) tokens.push(`输入 ${usage.input}`)
  if (usage.output !== undefined) tokens.push(`输出 ${usage.output}`)
  if (tokens.length > 0) parts.push(tokens.join(' / '))
  if (usage.cached !== undefined) parts.push(`缓存 ${usage.cached}`)
  return parts.join(' · ')
}

/**
 * The one-line form for the header.
 *
 * Drops what the reader can infer: a single call is the normal case, and the
 * token pair reads faster as arrows than as two labels. Cached tokens stay —
 * they are the reason a cheap-looking run is cheap.
 * @param usage - parsed accounting fields.
 * @returns e.g. `0.01 credit · ↑181 ↓3 · 缓存 23.9k`.
 */
export function formatUsageCompact(usage: CodebuddyUsage): string {
  const parts: string[] = []
  if (usage.credit !== undefined) parts.push(`${usage.credit} credit`)
  if (usage.calls !== undefined && usage.calls !== '1') parts.push(`${usage.calls} 次`)
  const tokens: string[] = []
  if (usage.input !== undefined) tokens.push(`↑${usage.input}`)
  if (usage.output !== undefined) tokens.push(`↓${usage.output}`)
  if (tokens.length > 0) parts.push(tokens.join(' '))
  if (usage.cached !== undefined) parts.push(`缓存 ${usage.cached}`)
  return parts.join(' · ')
}
