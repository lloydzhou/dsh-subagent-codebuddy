/**
 * The shared half of every run-list surface: the row renderer and the two hooks
 * (poll, pick-to-card) that feed it.
 *
 * Why this exists at all: a card lives inside the message that produced it, and
 * a long delegation pushes that message out of view — behind collapsed turns
 * and behind history the chat has not even loaded. The host's own Subagents
 * section lists these runs too, but its click on an external row is a no-op
 * (`if (external) return` — an out-of-process child has no session to open);
 * our rows take you to the card instead. Today the only surface is the sidebar
 * section (`section.tsx`); the header popover this file used to render was
 * retired when the host moved its catalog into the sidebar.
 *
 * It is additive and self-contained: one same-origin GET every few seconds, and
 * no host API beyond `sessions.scope(id).conversation.loadOlder()` for the
 * paging fallback.
 */

import { useCallback, useEffect, useState } from 'react'
import { focusCard, revealCard, MAX_PAGES } from './focus.ts'
import type { RevealOutcome } from './focus.ts'
import { formatDuration, STATUS_TEXT } from './format.ts'
import { fetchSessionRuns, rowElapsed, rowTitle } from './runs.ts'
import type { RunRow } from './runs.ts'
import { STATUS_COLOR } from './status.ts'
import type { RunStatus } from './definition.ts'

/** How often the list refreshes while the session is open. */
const POLL_MS = 3_000


const BORDER = '1px solid var(--dsw-alias-border-l, color-mix(in srgb, currentColor 16%, transparent))'
const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent))'

/**
 * The conversation's scrollport: the element whose height grows when a page of
 * history is prepended.
 *
 * `data-chat-flow` marks the chat column; its parent is the scrolling box. This
 * is the one piece of host markup read here, and it is read only as a *signal*
 * ("did a page arrive"), never to render anything.
 * @returns the scrollport, or null when the chat is not on screen.
 */
function scrollport(): HTMLElement | null {
  const flow = document.querySelector('[data-chat-flow]')
  return flow instanceof HTMLElement ? flow.parentElement : null
}

/**
 * Wait for one page to render: a beat for React to commit, then for layout.
 * @param ms - milliseconds to wait.
 * @returns a promise resolved after that delay.
 */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Poll one conversation's runs, and keep a clock for the elapsed columns.
 *
 * Shared by the sidebar section and (until it is retired) the header popover:
 * both surfaces answer the same question, so both read the same feed the same
 * way. `undefined` is "could not ask" — the last rows are kept rather than
 * blanking the list on one dropped request.
 * @param sessionId - the conversation whose runs to poll.
 * @returns the rows, newest-activity first, and the wall clock for the rows.
 */
export function useSessionRunRows(sessionId?: string): { rows: readonly RunRow[], now: number } {
  const [rows, setRows] = useState<readonly RunRow[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (sessionId === undefined) return undefined
    const controller = new AbortController()
    let alive = true
    const poll = (): void => {
      void fetchSessionRuns(sessionId, controller.signal).then((next) => {
        if (!alive || next === undefined) return
        setRows(next)
        setNow(Date.now())
      })
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      controller.abort()
      clearInterval(timer)
    }
  }, [sessionId])
  return { rows, now }
}

/**
 * Jump to a run's card, paging history when the card is not loaded yet.
 *
 * Shared by every surface that lists runs. `onPicked` runs when the card is on
 * screen — the popover closes itself; the sidebar section dismisses its
 * overlay — and a failure leaves the surface open with a readable notice.
 * @param options - the session, its paging closure, and what to do on a hit.
 * @returns the pick handler, the row currently paging, and the last notice.
 */
export function useRunPick(options: {
  readonly sessionId?: string
  readonly loadOlder?: () => Promise<unknown> | unknown
  readonly onPicked?: () => void
}): { pick: (childId: string) => void, busyId: string | undefined, notice: string } {
  const { sessionId, loadOlder, onPicked } = options
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const pick = useCallback((childId: string): void => {
    setNotice('')
    // A mounted card answers immediately, so the common case shows no spinner.
    if (focusCard(childId)) {
      onPicked?.()
      return
    }
    // Registry miss, mounted anyway: the feed's run id and the card's
    // registered id are the same string in practice, but a card that mounted
    // between polls (or whose handle is mid-swap) would fall through here —
    // find it by the attribute the panel paints on its root and treat the
    // jump as done. A card with no id (a start-up failure never registered
    // one) has no attribute and stays unfound, which is correct: it has no
    // record to show.
    const orphan = document.querySelector(`[data-codebuddy-child="${CSS.escape(childId)}"]`)
    if (orphan !== null) {
      orphan.scrollIntoView({ block: 'center', behavior: 'smooth' })
      onPicked?.()
      return
    }
    // Paging history only means something while the chat is the view on
    // screen; from the trajectory tab there is no scrollport to grow, and
    // pulling twelve pages would spend requests on nothing.
    if (scrollport() === null) {
      setNotice('先切回对话视图再试。')
      return
    }
    setBusyId(childId)
    void revealCard(childId, {
      focus: focusCard,
      loadOlder: () => loadOlder?.() ?? Promise.resolve(),
      measure: () => scrollport()?.scrollHeight ?? null,
      wait: settle,
    }, MAX_PAGES).then((outcome: RevealOutcome) => {
      setBusyId(undefined)
      if (outcome === 'found') {
        onPicked?.()
        return
      }
      setNotice(outcome === 'failed'
        ? '翻页失败了，先手动往上翻一段再试。'
        : '这张卡片不在已加载的历史里，先往上翻一段再试。')
    })
  }, [loadOlder, onPicked])
  return { pick, busyId, notice }
}

/** One row of a run list — the popover's lines and the sidebar section share it. */
export function RunLine({
  row, now, busy, onPick,
}: {
  readonly row: RunRow
  readonly now: number
  readonly busy: boolean
  readonly onPick: (childId: string) => void
}) {
  const [hover, setHover] = useState(false)
  const detail = row.steps > 0
    ? `${String(row.steps)} 步 · ${formatDuration(rowElapsed(row, now))}`
    : formatDuration(rowElapsed(row, now))
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={() => onPick(row.childId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The dot is six pixels; the state is spelled out for the pointer, which
      // is also the only place the wording appears in this list.
      title={`${rowTitle(row)} · ${STATUS_TEXT[row.state]}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 6,
        background: hover ? HOVER_BG : 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12.5,
        textAlign: 'left',
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.55 : 1,
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%', flex: 'none',
          background: STATUS_COLOR[row.state],
        }}
      />
      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {rowTitle(row)}
      </span>
      {row.model === undefined ? null : (
        // The pinned model, muted so it reads as metadata. Capped with its own
        // ellipsis: a long id squeezes the title, which is the expendable half.
        <span style={{
          flex: 'none',
          maxWidth: 130,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11,
          opacity: 0.45,
        }}>
          {row.model}
        </span>
      )}
      <span style={{ flex: 'none', fontSize: 11.5, opacity: 0.55 }}>
        {busy ? '查找中…' : detail}
      </span>
    </button>
  )
}
