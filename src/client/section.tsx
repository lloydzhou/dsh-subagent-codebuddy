/**
 * The right sidebar's CodeBuddy section: this conversation's runs, listed
 * beside the host's own Subagents section.
 *
 * Why a separate section instead of rows inside the host's list: that list
 * renders catalog children, and an out-of-process run has no child session to
 * open — the host marks such rows read-only. Our rows answer a different
 * question ("which card did this run produce?"), so the plugin registers its
 * own section through the same public slot the host uses for `environment`
 * (order 0) and `subagents` (order 200), and its rows jump to cards.
 *
 * @module dsh-subagent-codebuddy/client/section
 */

import { useRunPick, useSessionRunRows, RunLine } from './header.tsx'

/** What the session panel hands a section component, plus our paging closure. */
export interface RunsSectionProps {
  /** The conversation whose runs to list. */
  readonly sessionId?: string
  /** Close the sidebar overlay after a row lands on its card. */
  readonly dismissOverlay?: () => void
  /**
   * Pull one older page of this session's history. Supplied by the plugin body,
   * which is the only place that can reach the sessions service.
   */
  readonly loadOlder?: () => Promise<unknown> | unknown
}

/**
 * The section body: one row per run, newest activity first, still-running on
 * top. With no runs (or no session) it stays legible rather than vanishing —
 * the panel has no hide predicate for sections, so an empty body reads as a
 * hint instead of a blank title.
 * @param props - session id, overlay dismissal, and the paging closure.
 * @returns the section body.
 */
export function CodebuddyRunsSection({ sessionId, dismissOverlay, loadOlder }: RunsSectionProps) {
  const { rows, now } = useSessionRunRows(sessionId)
  const { pick, busyId, notice } = useRunPick({
    ...sessionId === undefined ? {} : { sessionId },
    ...loadOlder === undefined ? {} : { loadOlder },
    ...dismissOverlay === undefined ? {} : { onPicked: dismissOverlay },
  })
  if (sessionId === undefined) return null
  if (rows.length === 0) {
    return (
      <div style={{ padding: '4px 10px 6px', fontSize: 11.5, opacity: 0.5 }}>
        还没有 CodeBuddy 运行记录。
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 }}>
      {rows.map(row => (
        <RunLine
          key={row.childId}
          row={row}
          now={now}
          busy={busyId === row.childId}
          onPick={pick}
        />
      ))}
      {notice !== ''
        ? <div style={{ padding: '4px 10px', fontSize: 11.5, opacity: 0.7 }}>{notice}</div>
        : null}
    </div>
  )
}
