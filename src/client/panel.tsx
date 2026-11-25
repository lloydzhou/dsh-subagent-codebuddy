/**
 * Chat node panel for one CodeBuddy delegation: a header row plus the step
 * list and the CLI's final output. Styling follows the host theme through
 * `currentColor`, so it reads correctly in light and dark alike.
 *
 * While a run is outstanding the header clock keeps counting, because the node
 * has no end time to report; the wording that explains what that clock does and
 * does not prove lives in `format.ts`, next to the tests that pin it.
 */

import { useEffect, useRef, useState } from 'react'
import type { CodebuddyRunData, CodebuddyStep, RunStatus } from './definition.ts'
import { isLiveStatus, liveHint, metaText, summarize } from './format.ts'
import { fetchProgress, lastActionText, visibleSteps, POLL_INTERVAL_MS, cachedFeed, rememberFeed } from './live.ts'
import type { LiveFeed, LiveStep } from './live.ts'
import { registerCard } from './focus.ts'
import { STATUS_COLOR } from './status.ts'
import { formatUsageCompact, formatUsageFull } from './usage.ts'

interface PanelProps {
  readonly node: { readonly data: CodebuddyRunData }
}

const HAIRLINE = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
const SOFT = 'color-mix(in srgb, currentColor 6%, transparent)'

/**
 * The dot reads its colour from the shared palette, because the session
 * header's jump list draws the same run and must not disagree with this card
 * about what "running" or "failed" looks like.
 */

const STEP_MARK: Record<CodebuddyStep['status'], { color: string; glyph: string }> = {
  done: { color: '#1D9E75', glyph: '✓' },
  ongoing: { color: '#378ADD', glyph: '·' },
  failed: { color: '#E24B4A', glyph: '×' },
}

/**
 * Glyphs for the live feed's rows. They follow the same vocabulary as the
 * settled steps above — a tick means done, a blue dot means working — and add
 * two states a live run can reach that a settle-time parse cannot: stopped, and
 * the child's own plan (which is one row that keeps being replaced).
 */
const LIVE_MARK: Record<LiveStep['state'], { color: string; glyph: string }> = {
  running: { color: '#378ADD', glyph: '·' },
  done: { color: '#1D9E75', glyph: '✓' },
  failed: { color: '#E24B4A', glyph: '×' },
  stopped: { color: '#888780', glyph: '–' },
}

/**
 * How much of the task text shows before the reader asks for the rest. Four
 * lines is enough to recognise the job, and short enough that a long brief does
 * not push the timeline off the card.
 */
const PROMPT_PREVIEW_LINES = 4

/**
 * What the closing block is called, per ending. A failure and a refusal are not
 * "output": naming them correctly is the difference between a result and a
 * diagnosis.
 */
const BODY_LABEL: Record<RunStatus, string> = {
  running: '输出',
  delegated: '输出',
  done: '输出',
  stopped: '停止说明',
  refused: '拒绝说明',
  failed: '失败详情',
}

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"
      style={{
        flex: 'none',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 120ms ease',
      }}
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.65"
      />
    </svg>
  )
}

function StepRow({ step }: { readonly step: CodebuddyStep }) {
  const mark = STEP_MARK[step.status]
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ color: mark.color, width: 12, flex: 'none', textAlign: 'center' }}>{mark.glyph}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{step.label}</span>
      {step.detail !== undefined
        ? <span style={{ opacity: 0.55, fontSize: 12 }}>{step.detail}</span>
        : null}
    </div>
  )
}

/**
 * One row of the live timeline. A finished row recedes — the eye belongs on
 * what is happening now — while the row still running keeps full contrast.
 * @param props - the feed row to draw.
 */
function LiveRow({ step }: { readonly step: LiveStep }) {
  const mark = LIVE_MARK[step.state]
  const receded = step.state !== 'running'
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '3px 0',
        opacity: receded ? 0.72 : 1,
      }}
    >
      <span style={{ color: mark.color, width: 12, flex: 'none', textAlign: 'center' }}>{mark.glyph}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
        {step.kind === 'plan' ? <span style={{ opacity: 0.6 }}>计划 </span> : null}
        {step.label}
      </span>
      {step.detail !== undefined
        ? <span style={{ opacity: 0.45, fontSize: 11.5 }}>{step.detail}</span>
        : null}
    </div>
  )
}

/**
 * The task the child was handed, at the top of the body.
 *
 * Everything below it is a record of *how* the run went, which reads as noise
 * unless the reader can first see *what it was for*. The header carries the
 * caller's 3–5 word label; this carries the instruction itself. Clamped to four
 * lines so a long brief cannot bury the timeline — the expansion is local state,
 * so reading the full text never touches the card's own status.
 * @param props - the prompt text.
 */
function PromptBlock({ text }: { readonly text: string }) {
  const [full, setFull] = useState(false)
  const lines = text.split('\n')
  const clipped = lines.length > PROMPT_PREVIEW_LINES || text.length > 220
  const shown = full || !clipped
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 11.5, opacity: 0.5 }}>任务</span>
        {clipped
          ? <button
            type="button"
            onClick={() => setFull(value => !value)}
            aria-expanded={full}
            style={{
              border: 'none', background: 'none', color: 'inherit', font: 'inherit',
              fontSize: 11.5, opacity: 0.5, padding: 0, cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            {full ? '收起' : `展开全文（${String(lines.length)} 行）`}
          </button>
          : null}
      </div>
      <div
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 12.5,
          opacity: 0.82,
          ...(shown
            ? {}
            : {
              display: '-webkit-box',
              WebkitLineClamp: PROMPT_PREVIEW_LINES,
              WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden',
            }),
        }}
      >
        {text}
      </div>
    </div>
  )
}

/**
 * The CLI's styling for the closing block, shared by every ending so a failure
 * reads like a result instead of a different kind of card.
 */
const BODY_BOX = {
  margin: 0,
  padding: '8px 10px',
  background: SOFT,
  borderRadius: 6,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace)',
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  maxHeight: 320,
  overflow: 'auto',
}

export function CodebuddyRunPanel({ node }: PanelProps) {
  const data = node.data
  const [open, setOpen] = useState(false)
  // An outstanding run has no end time to report, so its clock is re-read from
  // the wall and re-rendered once a second; a settled run reports the duration
  // the settlement notice fixed and never ticks again.
  const live = isLiveStatus(data.status)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  /*
   * Live progress. The child's tool calls never reach this conversation, so the
   * card asks the host's own origin for them (see `live.ts`) — a request that
   * costs one small JSON body and rides the same origin as the page, so it works
   * in the web UI and the desktop window alike.
   *
   * Polling stops for good at settlement (nothing left to learn) and after three
   * consecutive failures (a host with no such route, a page opened from a file),
   * so an unreachable feed degrades to the card this plugin shipped before
   * instead of a request loop.
   */
  const childId = data.childId
  const sectionRef = useRef<HTMLElement | null>(null)
  const [flash, setFlash] = useState(false)
  /*
   * The session header's jump list needs to reach this card, and the two are
   * rendered by different parts of the tree, so the link is a registry rather
   * than props: while mounted, this card advertises what the header may do to
   * it (expand, scroll to, mark). Unmounting withdraws it.
   */
  useEffect(() => {
    if (childId === undefined) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = registerCard(childId, {
      expand: () => setOpen(true),
      reveal: () => {
        // The scroll must wait for the expansion this jump just asked for: on
        // a collapsed card the body renders only after React commits, and a
        // same-tick scrollIntoView measures the collapsed shell — the layout
        // change then cancels the smooth scroll and the card never moves
        // (observed on the sidebar's jump list). Two frames: one for the
        // commit, one for the layout it produces.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            sectionRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          })
        })
      },
      flash: () => {
        setFlash(true)
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => setFlash(false), 1_400)
      },
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      dispose()
    }
  }, [childId])
  // Seeded from the page's cache: a card that remounts after settlement gets
  // its timeline back without asking the host again (polling has stopped).
  const [feed, setFeed] = useState<LiveFeed | undefined>(
    () => childId === undefined ? undefined : cachedFeed(childId),
  )
  const failedPolls = useRef(0)
  useEffect(() => {
    if (!live || childId === undefined) return undefined
    failedPolls.current = 0
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const poll = (): void => {
      void fetchProgress(childId, controller.signal).then((next) => {
        if (next === undefined) {
          failedPolls.current += 1
          if (failedPolls.current >= 3) stop()
          return
        }
        failedPolls.current = 0
        rememberFeed(childId, next)
        setFeed(next)
        if (next.endedAt !== undefined) stop()
      })
    }
    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      controller.abort()
      stop()
    }
  }, [live, childId])
  // Body text is already trimmed by the definition: notice header gone, usage
  // line lifted into the header.
  const body = data.output
  const usage = data.usage === undefined ? '' : formatUsageCompact(data.usage)
  const usageTitle = data.usage === undefined ? undefined : formatUsageFull(data.usage)
  // The live rows win when the host answered with any: they are what the child
  // did, where the settle-time steps are text the closing message happened to
  // contain. With no feed, the card falls back to those rows and then to the
  // handoff notice.
  const liveRows = feed === undefined || feed.steps.length === 0
    ? undefined
    : visibleSteps(feed.steps)
  // The count is the run's real total, not the rows still in memory: the feed
  // keeps the last 60, so counting those made every long run claim "60 步".
  const stepCount = liveRows === undefined ? data.steps.length : feed!.total
  const lastSeen = live ? lastActionText(feed, now) : ''
  const hasBody = data.prompt !== '' || stepCount > 0 || data.steers.length > 0 || body !== '' || data.status === 'delegated'
  return (
    <section
      ref={sectionRef}
      {...childId === undefined ? {} : { 'data-codebuddy-child': childId }}
      style={{
        border: HAIRLINE,
        borderRadius: 10,
        margin: '10px 0',
        overflow: 'hidden',
        fontSize: 13,
        lineHeight: 1.6,
        // The jump from the header lands here; a brief ring is what tells the
        // eye which of several similar cards was asked for.
        outline: flash ? '2px solid #378ADD' : '2px solid transparent',
        outlineOffset: 2,
        transition: 'outline-color 220ms ease',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minWidth: 0,
          padding: '7px 10px',
          background: SOFT,
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: hasBody ? 'pointer' : 'default',
        }}
      >
        <Chevron open={open} />
        <span
          style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: STATUS_COLOR[data.status],
          }}
        />
        <span style={{ fontWeight: 500, flex: 'none' }}>CodeBuddy</span>
        <span
          style={{
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', opacity: 0.72,
          }}
        >
          {/*
            The label is what a caller wrote for the header, so it wins; a call
            shaped without one still gets a title from its prompt's first line.
          */}
          {summarize(data.task !== '' ? data.task : data.prompt)}
        </span>
        {/*
          One row, so the cost rides along with the duration instead of taking
          a line of its own. It may shrink — the task text yields first — and
          the spelled-out reading stays available on hover.
        */}
        <span
          style={{
            marginLeft: 'auto',
            flex: '0 1 auto',
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            minWidth: 0,
            whiteSpace: 'nowrap',
            fontSize: 12,
            opacity: 0.55,
          }}
        >
          <span style={{ flex: 'none' }} title={lastSeen === '' ? liveHint(data) : `${liveHint(data)}\n${lastSeen}`}>
            {stepCount > 0 ? `${stepCount} 步 · ` : ''}
            {metaText(data, now)}
          </span>
          {usage !== ''
            ? <span
              title={usageTitle}
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                paddingLeft: 8,
                borderLeft: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
                fontSize: 11.5,
              }}
            >
              {usage}
            </span>
            : null}
        </span>
      </button>

      {open && hasBody
        ? <div
          style={{
            padding: '8px 12px 10px 30px',
            borderTop: HAIRLINE,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {/*
            The body reads in the order the run lived: what was asked, what was
            said while it ran, what the child did, and only then how it ended.
            The closing block is appended, never substituted — a finished card
            keeps its task and its timeline, because that history is the only
            record of the work that produced the answer.
          */}
          {data.prompt !== '' ? <PromptBlock text={data.prompt} /> : null}
          {/*
            Mid-run messages belong to this run, not to a card of their own: they
            are the reader's own words arriving inside work already in progress,
            so they read as an aside in the same body, dimmer than the steps the
            child reported for itself.
          */}
          {data.steers.length > 0
            ? <div>
              {data.steers.map((steer, index) => (
                <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', opacity: 0.75 }}>
                  <span style={{ color: '#378ADD', width: 12, flex: 'none', textAlign: 'center' }}>↪</span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                    <span style={{ opacity: 0.6 }}>插话</span> {steer.message}
                  </span>
                </div>
              ))}
            </div>
            : null}
          {liveRows !== undefined
            ? <div>
              {liveRows.hidden > 0
                ? <div style={{ opacity: 0.45, fontSize: 11.5, padding: '2px 0 2px 20px' }}>
                  更早的 {liveRows.hidden} 步已省略
                </div>
                : null}
              {liveRows.shown.map(step => <LiveRow key={step.id} step={step} />)}
              {/*
                The rows say what happened; this says whether it is still
                happening. It re-renders on the same one-second clock as the
                header, which is the only reason a quiet run still looks alive.
              */}
              {lastSeen !== ''
                ? <div style={{ opacity: 0.45, fontSize: 11.5, padding: '2px 0 0 20px' }}>{lastSeen}</div>
                : null}
            </div>
            : null}
          {data.steps.length > 0 && liveRows === undefined
            ? <div>
              {data.steps.map((step, index) => <StepRow key={index} step={step} />)}
            </div>
            : null}
          {/*
            The handoff sentence is a footnote to the run, not a preface: it says
            what the reader can check *while* nothing has happened yet, so it
            belongs after the task and below whatever the child has done.
          */}
          {data.status === 'delegated' && liveRows === undefined
            ? <div style={{ opacity: 0.7 }}>
              子进程已在后台运行，结束时这里会自动变成完成态。
              <span style={{ opacity: 0.8 }}>
                {' '}在此之前，codebuddy-runs 能看到它是真在跑（心跳）还是已经失联；
                {data.childId === undefined ? '' : ` 日志：~/.dsh/logs/subagent-codebuddy/${data.childId}.log`}
              </span>
            </div>
            : null}
          {body !== ''
            ? <div>
              <div style={{ fontSize: 11.5, opacity: 0.5, marginBottom: 2 }}>{BODY_LABEL[data.status]}</div>
              <pre style={BODY_BOX}>{body}</pre>
            </div>
            : null}
        </div>
        : null}
    </section>
  )
}
