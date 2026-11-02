/**
 * Minimal ACP client wire for one CodeBuddy child session, over the shared
 * JSON-RPC line transport. The transport owns framing, request correlation,
 * and the `-32601` error response for unhandled server requests; this module
 * owns the ACP handshake, the optional authenticate step, the ephemeral
 * session, unattended permission answers, streamed assistant text, and the
 * terminal stop reason.
 *
 * Child notifications the provider does not model (CodeBuddy's own
 * `_codebuddy.ai/*` extensions, tool-call and plan updates) are consumed and
 * dropped: an unknown notification is not a protocol failure.
 *
 * @module dsh-subagent-codebuddy/wire
 */

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { ChildAction } from './progress.js'
import type { ContentBlock } from './types.js'

/** ACP protocol revision this client speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** How the provider answers the child's `session/request_permission` prompts. */
export type PermissionPolicy = 'allow' | 'reject'

/** One authentication method the child advertises in its `initialize` result. */
export interface AcpAuthMethod {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

/**
 * Provider-side event sink. Everything the wire learns on the child's behalf
 * goes here so the run can be followed from outside (see `progress-log.ts`);
 * the sink is best-effort and must never influence the run.
 */
export type AcpTrace = (kind: string, text: string) => void

/**
 * Structured counterpart of {@link AcpTrace}: the same moments, but typed, for
 * readers that render them (the chat card's progress feed) instead of writing a
 * line of text. Best-effort in the same way — a throw here is contained.
 */
export type AcpProgress = (action: ChildAction) => void

/** The parts of the child's `initialize` result this client keeps. */
export interface AcpHandshake {
  readonly protocolVersion: number | undefined
  readonly authMethods: readonly AcpAuthMethod[]
}

/** The terminal reason ACP returns from `session/prompt`. */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'max_turn_requests' | (string & {})

/** One ACP text content block. */
export interface AcpTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Map an ACP stop reason to the harness stop reason. Unknown variants are failures. */
export function acpStopReason(reason: AcpStopReason): 'completed' | 'max-tokens' | 'refusal' | 'aborted' | 'error' {
  switch (reason) {
    case 'end_turn': return 'completed'
    case 'max_tokens': return 'max-tokens'
    case 'refusal': return 'refusal'
    case 'cancelled': return 'aborted'
    // `max_turn_requests` means the child stopped short of finishing; report a
    // failure instead of presenting a partial answer as completed.
    default: return 'error'
  }
}

/** Translate the harness prompt into ACP text blocks (non-text blocks are dropped). */
export function toAcpPrompt(prompt: readonly ContentBlock[]): AcpTextBlock[] {
  const blocks: AcpTextBlock[] = []
  for (const block of prompt) {
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/**
 * The operator-facing hint a missing credential deserves: which method ids
 * this child actually offers, so setting `authMethodId` (or logging the CLI in)
 * replaces guessing.
 * @param methods - methods advertised during the handshake.
 * @returns one sentence naming them, or undefined when the child offers none.
 */
export function describeAuthMethods(methods: readonly AcpAuthMethod[]): string | undefined {
  if (methods.length === 0) return undefined
  const ids = methods.map((method) => (method.name === undefined ? method.id : `${method.id} (${method.name})`))
  return `subagent-codebuddy: the child offers auth methods [${ids.join(', ')}]; set ` +
    '`authMethodId` in this provider\'s config, or run `codebuddy` once and log in, or supply `envFile`'
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Bound one await by a deadline. A non-positive or non-finite bound disables
 * the deadline, because the caller owns that policy.
 * @param pending - the work to bound.
 * @param ms - deadline in milliseconds, or `0` to wait indefinitely.
 * @param message - the diagnostic thrown when the deadline fires.
 * @returns the pending value, or the deadline rejection.
 */
async function withDeadline<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return pending
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(message)) }, ms)
  })
  // Both arms are observed by the race, so a late settlement cannot surface as
  // an unhandled rejection after the deadline already won.
  try {
    return await Promise.race([pending, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * One ACP connection and its single child session. Deliberately no generic
 * request surface: supporting another ACP method must first become part of the
 * provider contract.
 */
export class CodebuddyAcpWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal: Promise<never>
  private readonly rejectFatal: (error: Error) => void
  private readonly chunks: string[] = []
  private readonly wholeMessages: string[] = []
  /** Latest known title and kind per tool call, so a status-only update still reads. */
  private readonly toolCalls = new Map<string, { title?: string; kind?: string; at?: number }>()
  private handshake: AcpHandshake = { protocolVersion: undefined, authMethods: [] }
  private sessionId: string | undefined
  private closed = false

  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    private readonly permission: PermissionPolicy,
    private readonly trace?: AcpTrace,
    private readonly progress?: AcpProgress,
  ) {
    this.transport = new JsonRpcLineTransport(input as never, output as never)
    let rejectFatal: (error: Error) => void = () => {}
    this.fatal = new Promise<never>((_, reject) => { rejectFatal = reject })
    this.rejectFatal = rejectFatal
    // Every guarded await races this rejection; the standing catch keeps it
    // observed on paths that never await again.
    this.fatal.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error) {
        this.rejectFatal(thrown(error))
      }
    })
    input.on('error', (error: Error) => { this.rejectFatal(error) })
    input.on('end', () => {
      this.rejectFatal(new Error('subagent-codebuddy: the ACP protocol stream closed'))
    })
    output.on('error', (error: Error) => { this.rejectFatal(error) })
  }

  /** Start reading ACP frames. */
  start(): void {
    this.transport.start()
  }

  /** The child's advertised authentication methods, from the handshake. */
  authMethods(): readonly AcpAuthMethod[] {
    return this.handshake.authMethods
  }

  /**
   * Perform the required ACP initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   * @param timeoutMs - handshake deadline; `0` waits indefinitely.
   * @returns the handshake facts this client retains.
   */
  async initialize(signal: AbortSignal, timeoutMs = 0): Promise<AcpHandshake> {
    const result = await this.guarded(withDeadline(this.transport.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Advertise NO optional client capabilities (no fs, no terminal): the
      // child self-serves in its own process.
      clientCapabilities: {},
    }, signal), timeoutMs, `subagent-codebuddy: the ACP child did not answer initialize within ${timeoutMs}ms`), signal) as {
      protocolVersion?: unknown
      authMethods?: unknown
    }
    this.transport.notify('initialized')
    this.handshake = {
      protocolVersion: typeof result?.protocolVersion === 'number' ? result.protocolVersion : undefined,
      authMethods: authMethodsOf(result?.authMethods),
    }
    await this.guarded(this.transport.flush(), signal)
    return this.handshake
  }

  /**
   * Select one advertised authentication method. Only ever called with an
   * operator-configured method id: choosing one on the child's behalf could
   * open a browser or adopt an account the operator did not pick.
   * @param methodId - the advertised method id to use.
   * @param signal - unpublished-start cancellation.
   * @param timeoutMs - authentication deadline; `0` waits indefinitely.
   */
  async authenticate(methodId: string, signal: AbortSignal, timeoutMs = 0): Promise<void> {
    const known = this.handshake.authMethods.map((method) => method.id)
    if (known.length > 0 && !known.includes(methodId)) {
      throw new Error(`subagent-codebuddy: authMethodId "${methodId}" is not offered by the child (offered: ${known.join(', ')})`)
    }
    await this.guarded(withDeadline(this.transport.request('authenticate', { methodId }, signal), timeoutMs,
      `subagent-codebuddy: the ACP child did not complete authentication within ${timeoutMs}ms`), signal)
  }

  /**
   * Create the run's ephemeral child session and retain its id.
   * @param cwd - workspace for the child process and its ACP session.
   * @param signal - unpublished-start cancellation.
   * @param timeoutMs - session-creation deadline; `0` waits indefinitely.
   */
  async newSession(cwd: string, signal: AbortSignal, timeoutMs = 0): Promise<string> {
    const session = await this.guarded(withDeadline(this.transport.request('session/new', { cwd, mcpServers: [] }, signal), timeoutMs,
      `subagent-codebuddy: the ACP child did not create a session within ${timeoutMs}ms`), signal) as { sessionId?: unknown }
    const id = session?.sessionId
    if (typeof id !== 'string' || id === '') throw new Error('subagent-codebuddy: the ACP child published no session id')
    this.sessionId = id
    return id
  }

  /**
   * Submit the one text task and await the child's terminal `session/prompt`
   * response.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @param timeoutMs - overall prompt deadline; `0` waits indefinitely.
   * @returns the child's terminal stop reason.
   */
  async prompt(texts: readonly string[], signal: AbortSignal, timeoutMs = 0): Promise<AcpStopReason> {
    if (this.sessionId === undefined) throw new Error('subagent-codebuddy: ACP session used before session/new')
    const response = await this.guarded(withDeadline(this.transport.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: texts.map((text) => ({ type: 'text' as const, text })),
    }, signal), timeoutMs, `subagent-codebuddy: the ACP child did not finish the task within ${timeoutMs}ms`), signal) as {
      stopReason?: unknown
    }
    if (typeof response?.stopReason !== 'string') {
      throw new Error('subagent-codebuddy: the ACP child returned no stop reason')
    }
    return response.stopReason
  }

  /**
   * Insert one message into the run that is currently executing.
   *
   * This is CodeBuddy's own ACP extension, not a standard method: it delivers
   * the text at the child's next step boundary without cancelling the step in
   * flight. A second `session/prompt` cannot do this — the CLI treats it as a
   * competing turn and ends the first one.
   * @param texts - the steering text blocks.
   * @param signal - local cancellation for the published run.
   * @param timeoutMs - deadline for the child to acknowledge; `0` waits indefinitely.
   * @returns whether the child took the message, plus its reason when it did not.
   */
  async steer(
    texts: readonly string[],
    signal: AbortSignal,
    timeoutMs = 0,
  ): Promise<{ steered: boolean, reason?: string }> {
    if (this.sessionId === undefined) throw new Error('subagent-codebuddy: ACP session used before session/new')
    const response = await this.guarded(withDeadline(this.transport.request('session/steer', {
      sessionId: this.sessionId,
      contentBlocks: texts.map((text) => ({ type: 'text' as const, text })),
    }, signal), timeoutMs, `subagent-codebuddy: the ACP child did not acknowledge the steering message within ${timeoutMs}ms`), signal) as {
      steered?: unknown
      reason?: unknown
    }
    // `{steered:false}` with no error is a valid answer: the child is idle, or
    // the message was not injectable. Reporting it beats pretending success.
    return {
      steered: response?.steered === true,
      ...(typeof response?.reason === 'string' && response.reason !== '' ? { reason: response.reason } : {}),
    }
  }

  /** Best-effort remote cancellation; process teardown stays authoritative. */
  cancel(): void {
    if (this.sessionId === undefined || this.closed) return
    try {
      this.transport.notify('session/cancel', { sessionId: this.sessionId })
    } catch {
      // A closed pipe already delivers the same intent through process teardown.
    }
  }

  /**
   * Assistant text accumulated from this session's streamed updates.
   *
   * Streamed `agent_message_chunk` text wins; a child that only emits whole
   * `agent_message` updates is honoured as a fallback, never both, so an agent
   * sending both shapes cannot duplicate its answer.
   */
  collectOutput(): ContentBlock[] {
    const text = this.chunks.length > 0 ? this.chunks.join('') : this.wholeMessages.join('')
    return text.length > 0 ? [{ type: 'text', text }] : []
  }

  /** Detach listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      pending.catch(() => {})
      throw signal.reason instanceof Error ? signal.reason : new Error('subagent-codebuddy: ACP request aborted')
    }
    return Promise.race([this.fatal, pending]) as Promise<T>
  }

  private handleServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'session/request_permission') {
      const options = Array.isArray(params.options) ? params.options : []
      if (this.permission === 'allow') {
        const chosen = pickAllowOption(options)
        if (chosen !== undefined) {
          this.emit('permission', `allowed ${permissionSubject(params)} (${chosen})`)
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: chosen } })
        }
      }
      // Unattended default: decline, so the child does not proceed on its own.
      this.emit('permission', `declined ${permissionSubject(params)}`)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    // Unknown server request (CodeBuddy extensions, fs/terminal offers): the
    // transport answers the rejection with a JSON-RPC error and the wire stays
    // alive — an extension we do not model is not a protocol failure.
    return Promise.reject(new Error(`method not found: ${method}`))
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return
    const update = params.update
    if (update === null || typeof update !== 'object') return
    const recorded = update as { sessionUpdate?: unknown; content?: unknown }
    this.traceUpdate(update as Record<string, unknown>)
    const text = textOf(recorded.content)
    if (text === undefined) return
    if (recorded.sessionUpdate === 'agent_message_chunk') this.chunks.push(text)
    else if (recorded.sessionUpdate === 'agent_message') this.wholeMessages.push(text)
  }

  /**
   * Record the parts of an update that belong in the run log, and forward every
   * tool transition to the live feed.
   *
   * The split is deliberate. A successful tool call is already on disk in the
   * CLI's own transcript, which the console reads directly — copying each of
   * them here again made a run log 250 KB of near-duplicate lines. So the log
   * keeps only what the *provider* alone knows: the plan the child published,
   * and the calls that failed. Everything else goes to `report()` (the card's
   * in-memory feed) and stays out of the file.
   * @param update - the raw `session/update` payload.
   */
  private traceUpdate(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : ''
      const previous = this.toolCalls.get(id) ?? {}
      const title = typeof update.title === 'string' && update.title !== '' ? update.title : previous.title
      const toolKind = typeof update.kind === 'string' ? update.kind : previous.kind
      const since = previous.at ?? Date.now()
      if (id !== '') {
        this.toolCalls.set(id, {
          ...title === undefined ? {} : { title },
          ...toolKind === undefined ? {} : { kind: toolKind },
          at: since,
        })
      }
      const label = title === undefined ? 'tool' : toolKind === undefined ? title : `${title} [${toolKind}]`
      const status = typeof update.status === 'string' ? update.status : 'pending'
      if (status === 'failed') {
        // A failure is the one tool event worth a line: it changes what the run
        // means, and it is the first thing anyone greps for afterwards.
        const took = ((Date.now() - since) / 1000).toFixed(1)
        this.emit('tool', `${label} → failed ${took}s`)
      }
      this.report({
        kind: 'tool',
        toolCallId: id,
        title: title ?? '',
        ...toolKind === undefined ? {} : { toolKind },
        status,
      })
      return
    }
    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : []
      const done = entries.filter((entry) => (entry as { status?: unknown }).status === 'completed').length
      const current = entries.find((entry) => (entry as { status?: unknown }).status === 'in_progress') as { content?: unknown } | undefined
      const next = typeof current?.content === 'string' ? ` — ${current.content}` : ''
      this.emit('plan', `${done}/${entries.length} done${next}`)
      this.report({
        kind: 'plan',
        done,
        total: entries.length,
        ...typeof current?.content === 'string' ? { current: current.content } : {},
      })
    }
  }

  /** Hand one structured action to the progress sink, containing any failure. */
  private report(action: ChildAction): void {
    try {
      this.progress?.(action)
    } catch {
      // A viewer-oriented sink never owns the run.
    }
  }

  /** Hand one event to the trace sink, containing any sink failure. */
  private emit(kind: string, text: string): void {
    try {
      this.trace?.(kind, text)
    } catch {
      // A diagnostic sink never owns the run.
    }
  }
}

/**
 * Read the human-facing subject of a permission request.
 * @param params - the `session/request_permission` params.
 * @returns the tool title when the child supplied one, else a generic label.
 */
function permissionSubject(params: Record<string, unknown>): string {
  const toolCall = params.toolCall
  if (toolCall !== null && typeof toolCall === 'object') {
    const candidate = toolCall as { title?: unknown; kind?: unknown }
    if (typeof candidate.title === 'string' && candidate.title !== '') {
      return typeof candidate.kind === 'string' ? `${candidate.title} [${candidate.kind}]` : candidate.title
    }
  }
  return 'a tool call'
}

/**
 * Pick the least-privilege allow option the child offered.
 * @param options - the permission options from the child's request.
 * @returns the option id to select, or undefined when none allows.
 */
function pickAllowOption(options: readonly unknown[]): string | undefined {
  const allow = (kind: string): string | undefined => {
    for (const option of options) {
      const candidate = option as { kind?: unknown; optionId?: unknown }
      if (candidate.kind === kind && typeof candidate.optionId === 'string') return candidate.optionId
    }
    return undefined
  }
  return allow('allow_once') ?? allow('allow_always')
}

/**
 * Read text out of an ACP content value (one block or a block list).
 * @param content - the update's content field.
 * @returns the concatenated text, or undefined when the update carries none.
 */
function textOf(content: unknown): string | undefined {
  if (content === undefined || content === null || typeof content !== 'object') return undefined
  const blocks: unknown[] = Array.isArray(content) ? content : [content]
  const parts: string[] = []
  for (const block of blocks) {
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate !== null && typeof candidate === 'object' && candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * Normalize the `authMethods` array from an `initialize` result.
 * @param value - the raw field.
 * @returns the well-formed methods, in child order.
 */
function authMethodsOf(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return []
  const methods: AcpAuthMethod[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as { id?: unknown; name?: unknown; description?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    methods.push({
      id: candidate.id,
      ...typeof candidate.name === 'string' ? { name: candidate.name } : {},
      ...typeof candidate.description === 'string' ? { description: candidate.description } : {},
    })
  }
  return methods
}
