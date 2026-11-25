/**
 * Conversation node definition for one `codebuddy_task` call.
 *
 * The node is anchored on the ordinary `tool/call` event (no custom session
 * event type is written, so the session log stays readable by every runtime),
 * and folds the matching `tool/result` into completion state.
 */

/**
 * The model-facing tool name is configurable (`config.toolName`), so the node
 * matches any tool whose name mentions codebuddy rather than one literal.
 */
export const TOOL_NAME_PATTERN = /codebuddy/i

/**
 * The view-node kind, which is also the renderer's slot key: the chat flow
 * looks a node up by `kind`, so these two strings have to be the same one.
 */
export const CODEBUDDY_NODE_KIND = 'codebuddy-run'

/**
 * Render order inside one event's seq neighborhood. The built-in `tool-call`
 * node sits exactly at the call's seq, so a small positive offset puts this
 * card immediately after the tool row it belongs to instead of racing it.
 */
const ANCHOR_OFFSET = 0.1

/**
 * What the node can honestly claim. The tool returns the moment the child
 * starts, so the matching `tool/result` means "handed off", never "finished" —
 * the closing message arrives later as a separate settlement notice, which is
 * what turns the same card into `done` or a terminal failure state.
 *
 * The runtime's notice distinguishes four endings, and collapsing them into
 * "done" would tell the reader a stopped or refused child had succeeded.
 */
export type RunStatus = 'running' | 'delegated' | 'done' | 'stopped' | 'refused' | 'failed'

/** How a settled child ended, read from the settlement notice's own wording. */
export type SettleOutcome = 'completed' | 'stopped' | 'refused' | 'failed'

export interface CodebuddyStep {
  readonly label: string
  readonly detail?: string
  readonly status: 'done' | 'failed' | 'ongoing'
}

/**
 * One message delivered into a run that was already going.
 *
 * It is not a step: the child never reports it as work it did, and it does not
 * change the run's status. It is kept because a card that silently ignored a
 * mid-run instruction would misrepresent the run it summarises.
 */
export interface CodebuddySteer {
  readonly message: string
  readonly at: number
}

/**
 * The CLI prints its own accounting line under the reply. It is a fact about
 * the run, not part of what the child said, so it is lifted out of the body and
 * into the card's header instead of sitting in the transcript text.
 */
export interface CodebuddyUsage {
  /** Charge as printed, e.g. `0.01`. Kept as text so `0.10` stays `0.10`. */
  readonly credit?: string
  readonly calls?: string
  readonly input?: string
  readonly output?: string
  readonly cached?: string
}

export interface CodebuddyRunData {
  /** Header label: the short `description` the caller supplied, never the task. */
  readonly task: string
  /**
   * The task text the child actually read.
   *
   * Kept apart from `task` because the two answer different questions: the
   * label has to fit on one header line, and the prompt is the only thing that
   * says what this run was asked to do. A card that showed just the label left
   * the reader guessing, and made the run look like it had no instructions at
   * all once the label was elided.
   */
  readonly prompt: string
  readonly status: RunStatus
  /**
   * The child's closing words (or the diagnostic, when it ended badly). It is
   * shown *after* the task and the timeline, never in place of them: a run is
   * its whole history, and replacing that history with the last message would
   * delete the only record of what happened in between.
   */
  readonly output: string
  readonly steps: readonly CodebuddyStep[]
  /** Messages delivered into the run while it was going, oldest first. */
  readonly steers: readonly CodebuddySteer[]
  readonly startedAt: number
  readonly durationMs: number
  /** Child session id, read out of the activation notice when the result carries one. */
  readonly childId?: string
  /** The model the child was pinned to, read from the same notice; absent when unset. */
  readonly model?: string
  /** Cost line lifted out of the body; absent when the CLI printed none. */
  readonly usage?: CodebuddyUsage
}

interface RunState {
  readonly task: string
  /** The full task text, as opposed to the short label kept in `task`. */
  readonly prompt?: string
  readonly startedAt: number
  readonly output?: string
  readonly failed?: boolean
  readonly finishedAt?: number
  /** The child's own closing message, taken from its settlement notice. */
  readonly closing?: string
  readonly settled?: boolean
  /** How it ended, when the notice said so. */
  readonly outcome?: SettleOutcome
  /** Messages steered into this run, in arrival order. */
  readonly steers?: readonly CodebuddySteer[]
}

interface EventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  /** Present on surface events only; a replacement copy must not move a card. */
  readonly surfaceOp?: string
  readonly data?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * The call id a `tool/result` answers.
 *
 * The message carries it twice — as `toolCallId` and inside `source.callId` —
 * and neither is guaranteed to survive a producer change alone, so both are
 * read, with the event-level field as a last resort.
 * @param rawEventData - `tool/result` event data.
 * @returns the call id, or undefined when the event carries none.
 */
export function readResultCallId(rawEventData: unknown): string | undefined {
  const data = asRecord(rawEventData)
  const message = asRecord(data?.['message'])
  const source = asRecord(message?.['source'])
  for (const candidate of [message?.['toolCallId'], source?.['callId'], data?.['toolCallId']]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}


/** Join the text blocks of one message's content array. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('\n').trim()
}

/** Raw call arguments as an object; undefined when they are not JSON object text. */
function readArguments(rawArguments: unknown): Record<string, unknown> | undefined {
  if (typeof rawArguments !== 'string') return asRecord(rawArguments)
  try {
    return asRecord(JSON.parse(rawArguments))
  } catch {
    return undefined
  }
}

/**
 * The child a call addresses, when it addresses one instead of starting one.
 *
 * Steering is an ordinary tool call in this transcript, with the same shape as
 * a delegation except that it names a `childId`. That field is what tells the
 * two apart: a card is a run, and a call that names a run is a message into it,
 * not the start of a second one.
 * @param rawArguments - the call's `arguments` (JSON text or an object).
 * @returns the addressed child id, or undefined for a call that starts a child.
 */
export function readAddressedChild(rawArguments: unknown): string | undefined {
  const value = readArguments(rawArguments)?.['childId']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The text a steering call carries into the run.
 * @param rawArguments - the call's `arguments`.
 * @returns the message, or undefined when the call carries none.
 */
export function readSteerText(rawArguments: unknown): string | undefined {
  const args = readArguments(rawArguments)
  for (const key of ['message', 'prompt']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Pull the human-readable task text out of the raw call arguments. */
export function readTask(rawArguments: unknown): string {
  const args = readArguments(rawArguments)
  // A non-JSON argument string is the task itself: there are no keys to read.
  if (args === undefined) return typeof rawArguments === 'string' ? rawArguments : ''
  // `description` first: this tool's own shape names the short display label
  // that way, and the prompt is never a card title. The other keys are shapes
  // other callers use, kept so the card still titles itself sensibly.
  for (const key of ['description', 'task', 'prompt']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * The complete task text the child was handed.
 *
 * `description` is a 3–5 word label and `prompt` is the whole instruction; the
 * card needs both, because the label is what the header can fit and the prompt
 * is what the run was actually about. This one reads `prompt` first, which is
 * the opposite of {@link readTask}: the two functions exist precisely because
 * one field cannot serve both roles.
 * @param rawArguments - the call's `arguments` (JSON text or an object).
 * @returns the prompt, `''` when the call carries none.
 */
export function readPrompt(rawArguments: unknown): string {
  const args = readArguments(rawArguments)
  if (args === undefined) return typeof rawArguments === 'string' ? rawArguments.trim() : ''
  for (const key of ['prompt', 'task', 'description']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** Flatten a tool result message into plain text plus a failure flag. */
export function readResult(rawData: unknown): { output: string; failed: boolean } {
  const data = asRecord(rawData)
  const message = asRecord(data?.['message'])
  return { output: textOfContent(message?.['content']), failed: message?.['isError'] === true }
}

/**
 * Read the child id a settlement notice names.
 *
 * The notice is an ordinary `user/message` whose source is
 * `{kind:'subagent-settled', senderSessionId}`; the same id the activation
 * notice printed, which is what links it back to the call that started it.
 * @param rawEventData - `user/message` event data (the message itself).
 * @returns the settled child's session id, or undefined for any other message.
 */
export function readSettledChild(rawEventData: unknown): string | undefined {
  const message = asRecord(rawEventData)
  const source = asRecord(message?.['source'])
  if (source?.['kind'] !== 'subagent-settled') return undefined
  const sender = source?.['senderSessionId']
  return typeof sender === 'string' && sender !== '' ? sender : undefined
}

/**
 * The closing text of a settlement notice: the summary line is first, then the
 * child's own words, so the card shows both without the panel re-deriving it.
 * @param rawEventData - `user/message` event data.
 * @returns the notice's plain text.
 */
export function readSettledText(rawEventData: unknown): string {
  return textOfContent(asRecord(rawEventData)?.['content'])
}

/** Split the tool output into the coarse steps this node lists. */
export function readSteps(output: string): readonly CodebuddyStep[] {
  const steps: CodebuddyStep[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    const match = /^[-*]\s+\[(done|failed|ongoing)\]\s+(.*)$/.exec(trimmed)
    if (match === null) continue
    steps.push({ label: match[2] ?? '', status: match[1] as CodebuddyStep['status'] })
  }
  return steps
}

/**
 * The activation notice names the child ("… is RUNNING as <id> …"); the id is
 * what the later settlement notice will be titled with, so the panel can tell
 * the reader which notice to watch for.
 * @param output - rendered tool result.
 * @returns the child id, or undefined when the text is not an activation notice.
 */
export function readChildId(output: string): string | undefined {
  return /RUNNING as (\S+)/.exec(output)?.[1]
}

/**
 * The activation notice names the run's model ("… pinned to model <id>."), so
 * the card's header meta can show which model the child was pinned to. The
 * sentence-ending period is what bounds the capture — model ids carry internal
 * dots, so the reader cannot stop at whitespace alone.
 * @param output - rendered tool result.
 * @returns the model id, or undefined when the notice says nothing about one.
 */
export function readModel(output: string): string | undefined {
  return /pinned to model (\S+)\./.exec(output)?.[1]
}

/**
 * Read the ending out of the settlement notice's first line.
 *
 * The runtime writes that line per stop reason (`completed`, `aborted`,
 * `refusal`, `error`, and unknown variants), and the wording is the only place
 * the parent can learn which one happened: the notice itself is an ordinary
 * user message with no status field.
 * @param sentence - the notice's first line.
 * @returns the outcome, or undefined when the line is not a settlement summary.
 */
export function readSettleOutcome(sentence: string): SettleOutcome | undefined {
  const line = sentence.trim()
  if (!/^Background subagent /i.test(line)) return undefined
  // Order matters: every non-completed wording also contains "finished"
  // ("was stopped before it finished"), so the specific endings come first.
  if (/was stopped/i.test(line)) return 'stopped'
  if (/declined the task/i.test(line)) return 'refused'
  if (/failed before it finished|ran out of room|ended abnormally/i.test(line)) return 'failed'
  if (/finished/i.test(line)) return 'completed'
  return undefined
}

/**
 * Split a settlement notice into its ending and the text worth reading.
 *
 * A completed run's summary line is pure ceremony — the card header already
 * says 已完成 — so it is dropped. Every other ending carries the only
 * explanation the reader gets, so the notice is kept whole.
 * @param text - raw settlement notice text.
 * @returns the outcome (absent when the text is not a notice) and the body copy.
 */
export function parseSettlement(text: string): { outcome?: SettleOutcome, body: string } {
  const lines = text.split('\n')
  const head = lines[0]?.trim() ?? ''
  const outcome = readSettleOutcome(head)
  if (outcome === undefined) return { body: text }
  if (outcome !== 'completed') return { outcome, body: text.trim() }
  const rest = lines.slice(1).join('\n').trim().replace(/^Its closing message:\s*/i, '')
  return { outcome, body: rest === '' ? text.trim() : rest }
}

/**
 * Is this the CLI's accounting line rather than something the child wrote?
 *
 * The line always pairs a charge with a call count ("0.01 credit · 1 次调用"
 * or "0.01 credits · 1 call"); requiring both is what keeps ordinary prose
 * that happens to mention credits from being swallowed.
 * @param line - one line of the child's output.
 * @returns true when the line is the usage summary.
 */
function isUsageLine(line: string): boolean {
  return /credit|积分/i.test(line) && /次调用|\bcalls?\b/i.test(line)
}

/**
 * Split the CLI's accounting line off the child's reply.
 *
 * The panel shows this line in the card header, so leaving it in the body would
 * print the same numbers twice — and, worse, make a one-word answer look like
 * a two-part message.
 * @param text - the child's closing message or failure text.
 * @returns the body without the usage line, plus whatever the line carried.
 */
export function splitUsage(text: string): { text: string; usage?: CodebuddyUsage } {
  const lines = text.split('\n')
  const kept: string[] = []
  let usage: CodebuddyUsage | undefined
  for (const line of lines) {
    if (!isUsageLine(line)) {
      kept.push(line)
      continue
    }
    const credit = /([\d.]+)\s*(?:credits?|积分)/i.exec(line)?.[1]
    const calls = /(\d+)\s*(?:次调用|calls?\b)/i.exec(line)?.[1]
    const input = /(?:输入|input)\s*[:：]?\s*([\d.,]+\s*[kKmM]?)/i.exec(line)?.[1]
    const output = /(?:输出|output)\s*[:：]?\s*([\d.,]+\s*[kKmM]?)/i.exec(line)?.[1]
    const cached = /(?:缓存|cached?)\s*[:：]?\s*([\d.,]+\s*[kKmM]?)/i.exec(line)?.[1]
    usage = {
      ...(credit === undefined ? {} : { credit }),
      ...(calls === undefined ? {} : { calls }),
      ...(input === undefined ? {} : { input: input.trim() }),
      ...(output === undefined ? {} : { output: output.trim() }),
      ...(cached === undefined ? {} : { cached: cached.trim() }),
    }
  }
  if (usage === undefined) return { text }
  // Drop the blank line the accounting line used to sit behind.
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  return { text: body, usage }
}

/**
 * Call ids this page has actually opened a card for.
 *
 * `tool/result` carries no tool name, so a Definition keyed by call id cannot
 * tell its own results from anyone else's. Recording the ids that started here
 * keeps every unrelated result out of this Definition: without it the node
 * registry would carry one start-less context per tool call in the session.
 */
const startedCalls = new Set<string>()

/**
 * Child session id → the call that started it.
 *
 * The settlement notice names only the child, so this is the bridge that lets
 * one call's card be updated by a message arriving minutes later.
 */
const childToCall = new Map<string, string>()

export const codebuddyRunDefinition = {
  kind: CODEBUDDY_NODE_KIND,
  target: 'chat',
  match(event: EventLike) {
    const data = asRecord(event.data)
    if (event.type === 'tool/call') {
      const id = data?.['callId']
      if (typeof id !== 'string' || id === '') return null
      // A call that names a child is a message into a run this card already
      // shows (`codebuddy_steer` and anything shaped like it), not a new
      // delegation: it folds into the card that started that child, and into
      // nothing at all when this page never saw that card — the ordinary tool
      // row still reports the call either way.
      const addressed = readAddressedChild(data?.['arguments'])
      if (addressed !== undefined) {
        const owner = childToCall.get(addressed)
        return owner === undefined ? null : { id: owner, role: 'update' }
      }
      if (!TOOL_NAME_PATTERN.test(String(data?.['name'] ?? ''))) return null
      startedCalls.add(id)
      return { id, role: 'start' }
    }
    if (event.type === 'tool/result') {
      // A replacement copy belongs to the model surface, not this transcript.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null
      const id = readResultCallId(event.data)
      if (id === undefined || !startedCalls.has(id)) return null
      // The activation notice is the only place the child id appears; record
      // the link here, where the assembler replays it before the notice lands.
      const childId = readChildId(readResult(event.data).output)
      if (childId !== undefined) childToCall.set(childId, id)
      return { id, role: 'update' }
    }
    if (event.type === 'user/message') {
      // The settlement notice is an ordinary user message; only its source
      // says it belongs to a child this node started.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null
      const childId = readSettledChild(event.data)
      const id = childId === undefined ? undefined : childToCall.get(childId)
      return id === undefined ? null : { id, role: 'update' }
    }
    return null
  },
  start(_context: unknown, match: { event: EventLike }): RunState {
    const data = asRecord(match.event.data)
    const args = data?.['arguments']
    return {
      task: readTask(args),
      prompt: readPrompt(args),
      startedAt: match.event.time,
    } satisfies RunState
  },
  update(context: { state: RunState }, match: { event: EventLike }): RunState {
    const state = context.state
    if (match.event.type === 'tool/call') {
      // The steering call itself. Nothing about the run changed — it is still
      // going, and its own settlement notice is still the only thing that can
      // end the card — so this only records that the message went in.
      const message = readSteerText(asRecord(match.event.data)?.['arguments'])
      if (message === undefined) return state
      return {
        ...state,
        steers: [...(state.steers ?? []), { message, at: match.event.time }],
      } satisfies RunState
    }
    if (match.event.type === 'user/message') {
      const notice = parseSettlement(readSettledText(match.event.data))
      return {
        ...state,
        closing: notice.body,
        ...(notice.outcome === undefined ? {} : { outcome: notice.outcome }),
        settled: true,
        finishedAt: match.event.time,
      } satisfies RunState
    }
    const { output, failed } = readResult(match.event.data)
    return { ...state, output, failed, finishedAt: match.event.time } satisfies RunState
  },
  buildViewNode(context: {
    key: string
    id: string
    start?: { event: EventLike; location: unknown }
    state: RunState
  }) {
    if (context.start === undefined) return null
    const state = context.state
    const finished = state.finishedAt !== undefined
    const failed = state.failed === true
    const settled = state.settled === true
    const output = state.output ?? ''
    const childId = readChildId(output)
    const model = readModel(output)
    const settledStatus: RunStatus = state.outcome === 'stopped'
      ? 'stopped'
      : state.outcome === 'refused' ? 'refused' : state.outcome === 'failed' ? 'failed' : 'done'
    const status: RunStatus = settled
      ? settledStatus
      : finished ? (failed ? 'failed' : 'delegated') : 'running'
    // Body copy only where there is something to read: a failure message, or
    // the child's own closing words once it settled. A handoff notice stays
    // out — the panel has a shorter sentence for that state — and a completed
    // run's summary line is dropped by `parseSettlement`.
    const { text: body, usage } = splitUsage(failed ? output : settled ? (state.closing ?? '') : '')
    const data: CodebuddyRunData = {
      task: state.task,
      prompt: state.prompt ?? '',
      status,
      output: body,
      // Any closing text may carry `- [done] …` rows, so they are read whatever
      // the outcome: for a card opened after the run ended (no feed) they are
      // the only steps left, and a successful child can list them too.
      steps: readSteps(body),
      steers: state.steers ?? [],
      startedAt: state.startedAt,
      durationMs: (state.finishedAt ?? Date.now()) - state.startedAt,
      ...(childId === undefined ? {} : { childId }),
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
    }
    return {
      key: context.key,
      kind: CODEBUDDY_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq + ANCHOR_OFFSET,
      location: context.start.location,
      visibility: 'visible',
      data,
    }
  },
}
