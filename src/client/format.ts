/**
 * Pure text formatting for the CodeBuddy card.
 *
 * Kept out of the component for two reasons: the header's wording is where the
 * card makes a claim about a run, so it has to be assertable without rendering
 * React; and a ticking clock needs a pure function of `now` rather than a
 * value frozen at node-build time.
 *
 * @module dsh-subagent-codebuddy/client/format
 */

import type { CodebuddyRunData, RunStatus } from './definition.ts'

/** The one-word state label, also the accessible reading of the status dot. */
export const STATUS_TEXT: Record<RunStatus, string> = {
  running: '运行中',
  delegated: '后台运行中',
  done: '已完成',
  stopped: '已停止',
  refused: '被拒绝',
  failed: '失败',
}

/**
 * Is this a state whose end the card has not been told about yet?
 *
 * These are the only states where the clock keeps counting: once the
 * settlement notice lands, the duration is a fact about a finished run and
 * must stop moving.
 * @param status - the node's state.
 * @returns true while the run is still outstanding.
 */
export function isLiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'delegated'
}

/**
 * A duration in the compact form the header has room for.
 * @param ms - elapsed milliseconds.
 * @returns `<1s`, `42s`, or `7m03s`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * The first meaningful line of the task, shortened for the header.
 * @param task - the delegated task text.
 * @param limit - maximum characters before the ellipsis.
 * @returns the summary, or '' when the task is empty.
 */
export function summarize(task: string, limit = 72): string {
  const firstLine = task.split('\n').find(line => line.trim() !== '') ?? ''
  const trimmed = firstLine.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/**
 * The right-hand header meta: elapsed time and state.
 *
 * An outstanding run counts up to `now`, because the card genuinely does not
 * know when it will end; a settled one reports the duration the settlement
 * notice fixed. That difference is why this takes a clock instead of reading
 * one.
 * @param data - the node's data.
 * @param now - the current wall clock, supplied by the caller's ticker.
 * @returns the meta text.
 */
export function metaText(data: CodebuddyRunData, now: number): string {
  const elapsed = isLiveStatus(data.status) ? now - data.startedAt : data.durationMs
  return `${formatDuration(elapsed)} · ${STATUS_TEXT[data.status]}`
}

/**
 * The hover explanation for an outstanding run.
 *
 * This is the honest part of the card: a tool result only proves the child was
 * handed the task, and the next thing this conversation hears is the
 * settlement notice — there is no heartbeat between them. The clock therefore
 * measures how long the card has been waiting, not proof of life, and the
 * place that *can* tell the difference is the run monitor, which reads the
 * provider's beacon files.
 * @param data - the node's data, for the child id.
 * @returns the tooltip text, or undefined once the run has a verdict.
 */
export function liveHint(data: CodebuddyRunData): string | undefined {
  if (!isLiveStatus(data.status)) return undefined
  const id = data.childId
  return [
    '子进程在后台独立运行：对话里只有「开始」和「结束」两次通知，中途没有心跳。',
    '这里的计时是已等待多久，不证明它此刻还活着。',
    `要确认是否仍在运行：codebuddy-runs（面板，心跳与失联）或 codebuddy-runs -f ${id ?? '<id>'}（跟这个 run 的日志）。`,
  ].join('')
}
