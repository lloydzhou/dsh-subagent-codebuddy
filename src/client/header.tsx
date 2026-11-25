/**
 * The session header's CodeBuddy button: a jump list of this conversation's
 * runs.
 *
 * Why this exists at all: a card lives inside the message that produced it, and
 * a long delegation pushes that message out of view — behind collapsed turns and
 * behind history the chat has not even loaded. The host's own subagent dropdown
 * lists these runs, but its click opens the *child session*, which an
 * out-of-process child does not have; so this plugin contributes its own entry
 * beside it, and its click takes you to the card instead.
 *
 * It is additive and self-contained: one `conversation.session.header.actions`
 * entry, one same-origin GET every few seconds, and no host API beyond
 * `sessions.scope(id).conversation.loadOlder()` for the paging fallback.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { focusCard, revealCard, MAX_PAGES } from './focus.ts'
import type { RevealOutcome } from './focus.ts'
import { formatDuration, STATUS_TEXT } from './format.ts'
import { aggregateState, fetchSessionRuns, rowElapsed, rowTitle } from './runs.ts'
import type { RunRow } from './runs.ts'
import { STATUS_COLOR } from './status.ts'
import type { RunStatus } from './definition.ts'

/** Props the conversation framework hands every header action. */
export interface HeaderActionProps {
  /** The conversation this header belongs to. */
  readonly sessionId?: string
  /**
   * Pull one older page of this session's history. Supplied by the plugin body,
   * which is the only place that can reach the sessions service.
   */
  readonly loadOlder?: () => Promise<unknown> | unknown
}

/** Stable id so the outside-click handler can tell the popover from the page. */
const POPOVER_ID = 'subagent-codebuddy-jump-menu'

/** How often the list refreshes while the session is open. */
const POLL_MS = 3_000

/** Popover width: wide enough for a label, narrow enough not to cover the chat. */
const POPOVER_WIDTH = 360

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

/** One row of the popover. */
function RunLine({
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

/**
 * Render the header button and its popover.
 * @param props - the session id and the paging hook, both optional so a bare
 * render (an older host, a test) degrades to "no button" instead of throwing.
 */
export function RunsHeaderAction({ sessionId, loadOlder }: HeaderActionProps) {
  const [rows, setRows] = useState<readonly RunRow[]>([])
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | undefined>(undefined)

  // One poll loop for both the badge and, when open, the rows. It keeps asking
  // while closed too: the badge is how the reader learns a run is happening at
  // all, which is exactly when the popover is shut.
  useEffect(() => {
    if (sessionId === undefined) return undefined
    const controller = new AbortController()
    let alive = true
    const poll = (): void => {
      void fetchSessionRuns(sessionId, controller.signal).then((next) => {
        // `undefined` is "could not ask" — keep the last rows rather than
        // blanking the list on one dropped request.
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

  // The popover is fixed-positioned and anchored to the trigger: the header row
  // clips its overflow, so an absolutely positioned child would be cut off.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(undefined)
      return undefined
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Outside click and Escape close it; a popover that traps a header is worse
  // than no popover.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (document.getElementById(POPOVER_ID)?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = useCallback((childId: string): void => {
    setNotice('')
    // A mounted card answers immediately, so the common case shows no spinner.
    if (focusCard(childId)) {
      setOpen(false)
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
        setOpen(false)
        return
      }
      setNotice(outcome === 'failed'
        ? '翻页失败了，先手动往上翻一段再试。'
        : '这张卡片不在已加载的历史里，先往上翻一段再试。')
    })
  }, [loadOlder])

  if (sessionId === undefined || rows.length === 0) return null
  const running = rows.filter(row => row.running).length
  const summary = aggregateState(rows)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        title={`本会话的 CodeBuddy 子代理：${String(running)} 个在跑，共 ${String(rows.length)} 个。点开可跳到对应卡片。`}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '2px 7px', border: BORDER, borderRadius: 6,
          background: 'none', color: 'inherit', font: 'inherit', fontSize: 12,
          cursor: 'pointer', whiteSpace: 'nowrap', opacity: 0.85,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[summary] }} />
        CodeBuddy
        <span style={{ opacity: 0.55 }}>{running > 0 ? `${String(running)} 运行中` : `${String(rows.length)} 个`}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true" style={{ opacity: 0.55 }}>
          <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && anchor !== undefined
        ? <div
          id={POPOVER_ID}
          role="menu"
          style={{
            position: 'fixed',
            top: anchor.top,
            right: anchor.right,
            width: POPOVER_WIDTH,
            maxHeight: 'min(60vh, 420px)',
            overflowY: 'auto',
            padding: 4,
            borderRadius: 10,
            border: BORDER,
            background: 'var(--dsw-alias-bg-base, Canvas)',
            color: 'inherit',
            boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
            zIndex: 1000,
          }}
        >
          <div style={{ padding: '4px 10px 6px', fontSize: 11.5, opacity: 0.5 }}>
            本会话的 CodeBuddy 子代理 · 点一行跳到卡片
          </div>
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
            ? <div style={{ padding: '6px 10px', fontSize: 11.5, opacity: 0.7 }}>{notice}</div>
            : null}
          <div style={{ padding: '6px 10px 4px', fontSize: 11, opacity: 0.4, borderTop: BORDER, marginTop: 4 }}>
            只列本进程启动、仍在内存里的 run（结束后保留约 10 分钟）。
          </div>
        </div>
        : null}
    </>
  )
}
