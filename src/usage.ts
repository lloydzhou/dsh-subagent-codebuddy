/**
 * Token accounting for one delegated run.
 *
 * ACP never carries usage, so the only truthful source is the CLI's own
 * transcript under `~/.codebuddy/projects/<slug>/<sessionId>.jsonl`: every model
 * request appends a record whose `providerData.rawUsage` holds that request's
 * accounting. `prompt_tokens` is the whole context for that request (not a
 * delta), so the totals here sum every request — each one is billed on its own
 * context — while cache hits are split out the way `TokenUsage` expects.
 *
 * Summing is deliberately additive rather than "latest prompt_tokens + total
 * completions": a run that thinks 18 times pays for 18 prompts.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export interface TranscriptUsage {
  /** Model requests that reported accounting. */
  calls: number
  /** Uncached prompt tokens. */
  input: number
  /** Prompt tokens served from cache. */
  cacheRead: number
  /** Prompt tokens written to cache. */
  cacheWrite: number
  /** Completion tokens. */
  output: number
  /** Reasoning tokens, a subset of output for most providers. */
  reasoning: number
  /** Provider-billed credits, when the CLI reports a price. */
  credit: number
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_cache_write_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  credit?: number
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rawUsageOf(record: unknown): RawUsage | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const provider = (record as { providerData?: unknown }).providerData
  if (typeof provider !== 'object' || provider === null) return undefined
  const usage = (provider as { rawUsage?: unknown }).rawUsage
  return typeof usage === 'object' && usage !== null ? usage as RawUsage : undefined
}

function accumulate(totals: TranscriptUsage, usage: RawUsage): void {
  const prompt = number(usage.prompt_tokens)
  const cacheRead = number(usage.prompt_cache_hit_tokens) + number(usage.cache_read_input_tokens)
  const cacheWrite = number(usage.prompt_cache_write_tokens) + number(usage.cache_creation_input_tokens)
  const uncached = usage.prompt_cache_miss_tokens === undefined
    ? Math.max(prompt - cacheRead, 0)
    : number(usage.prompt_cache_miss_tokens)
  totals.calls += 1
  totals.input += uncached
  totals.cacheRead += cacheRead
  totals.cacheWrite += cacheWrite
  totals.output += number(usage.completion_tokens)
  totals.reasoning += number(usage.completion_tokens_details?.reasoning_tokens)
  totals.credit += number(usage.credit)
}

/**
 * Read every accounting record the child has written so far.
 *
 * Rows without `rawUsage` are skipped by a substring test before parsing, which
 * keeps a multi-megabyte transcript cheap: only the request records cost JSON.
 * @param file - absolute transcript path.
 * @param timeoutMs - wall-clock budget; a partial result beats a stalled run.
 * @returns summed usage, or undefined when the transcript is missing or empty.
 */
export async function readTranscriptUsage(
  file: string,
  timeoutMs = 5000,
): Promise<TranscriptUsage | undefined> {
  const deadline = Date.now() + timeoutMs
  const totals: TranscriptUsage = {
    calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, credit: 0,
  }
  let lines = 0
  let stream
  try {
    stream = createReadStream(file, { encoding: 'utf8' })
  } catch {
    return undefined
  }
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      lines += 1
      // Checking the clock every row would dominate the scan; 512 rows is far
      // below one millisecond of work.
      if (lines % 512 === 0 && Date.now() > deadline) break
      if (!line.includes('"rawUsage"')) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const usage = rawUsageOf(record)
      if (usage !== undefined) accumulate(totals, usage)
    }
  } catch {
    // A half-written trailing row or a vanished file is not a delegation failure.
  } finally {
    reader.close()
    stream.destroy()
  }
  return totals.calls > 0 ? totals : undefined
}

/** Compact token count: 1234 → 1.2k, 1234567 → 1.2M. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * End-to-end output rate for one run.
 *
 * This is NOT the model's decode speed: the wall clock covers spawn, handshake,
 * every tool invocation, and every model turn. It answers "how fast did this
 * delegation produce its output", which is the number a person waiting on the
 * run actually feels. A pure decode rate would need per-chunk arrival stamps,
 * which ACP gives us but we do not currently record.
 * @param usage - summed transcript usage.
 * @param elapsedMs - wall clock from run start to settlement.
 * @returns output tokens per second, or 0 when nothing was produced.
 */
export function tokensPerSecond(usage: TranscriptUsage, elapsedMs: number): number {
  if (elapsedMs <= 0 || usage.output <= 0) return 0
  return usage.output / (elapsedMs / 1000)
}

/**
 * One-line accounting notice appended to the delegated run's result, so the
 * settlement message the parent receives states what the child cost.
 *
 * The headline is the billed credits when the CLI reports a price, because raw
 * tokens mislead: a long run is dominated by cache reads (one sample: 28.4M
 * cached against 155k uncached), and adding those into one number makes a cheap
 * run look ruinous. Without a price, the headline is input plus output, with
 * cache reads listed separately for the same reason.
 * @param usage - summed transcript usage.
 * @returns a notice starting with a blank line, or undefined when nothing ran.
 */
export function formatUsageNotice(usage: TranscriptUsage | undefined): string | undefined {
  if (usage === undefined) return undefined
  const consumed = usage.input + usage.cacheWrite
  const headline = usage.credit > 0
    ? `${usage.credit.toFixed(2)} credit`
    : `${formatTokens(consumed + usage.output)} tokens`
  const parts = [`输入 ${formatTokens(consumed)}`, `输出 ${formatTokens(usage.output)}`]
  if (usage.cacheRead > 0) parts.push(`缓存 ${formatTokens(usage.cacheRead)}`)
  return `\n\n用量 ${headline} · ${usage.calls} 次调用（${parts.join(' / ')}）`
}
