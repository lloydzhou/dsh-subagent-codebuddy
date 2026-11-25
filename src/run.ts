/**
 * One-shot CodeBuddy child lifecycle: spawn the local ACP CLI through the
 * subprocess seam, publish only after the ACP handshake (plus an optional
 * authenticate step) and session creation, flatten post-publication failures,
 * and dispose to whole-range quiescence.
 *
 * Two properties keep failure modes debuggable instead of mysterious:
 * - every startup phase is bounded by a deadline, so a wedged or
 *   unauthenticated child cannot hold the delegating tool call open forever;
 * - the child's stderr is collected and appended to the diagnostic, so the
 *   settlement notice carries the CLI's own explanation.
 *
 * @module dsh-subagent-codebuddy/run
 */

import { randomUUID } from 'node:crypto'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CodebuddyAcpWire, acpStopReason, describeAuthMethods } from './wire.js'
import { appendIndex, codebuddyTranscriptPath, disabledRunLog, indexField, openRunLog, startHeartbeat } from './progress-log.js'
import { beginProgress, finishProgress, recordProgress, runOutcome } from './progress.js'
import { registerLiveRun } from './steer.js'
import { formatUsageNotice, readTranscriptUsage, tokensPerSecond } from './usage.js'
import type { Heartbeat } from './progress-log.js'
import type { ContentBlock, SubagentRun, SubagentStartRequest, SubagentStopReason, SubprocessHandle } from './types.js'

/** Retained stderr tail: enough for a stack trace or an auth banner, and bounded. */
const STDERR_TAIL_BYTES = 8_192

/** Resolved run inputs; the provider fills every field before this exists. */
export interface CodebuddyRunSpec {
  argv: readonly string[]
  cwd: string
  permission: 'allow' | 'reject'
  /** Advertised auth method to select before `session/new`, when configured. */
  authMethodId: string | undefined
  env: NodeJS.ProcessEnv
  /**
   * What the provider did about the credential, phrased for a human and safe to
   * print: it names the `envFile` and its state, never the key itself. Read per
   * start.
   */
  credentialNote?: string
  /** Tier-1 window after stdin EOF before termination escalates. */
  disposeEofGraceMs: number
  /** POSIX grace between SIGTERM and SIGKILL inside `terminate()`. */
  disposeGraceMs: number
  /** Deadline for each startup phase; `0` waits indefinitely. */
  startupTimeoutMs: number
  /** Overall deadline for the submitted task; `0` waits indefinitely. */
  promptTimeoutMs: number
  /** Append this run's progress to `~/.dsh/logs/subagent-codebuddy/`. */
  progressLog: boolean
  /**
   * The conversation that started this run. Carried so the session header can
   * list its own runs: the card only exists where its message was rendered, and
   * that is exactly the thing a long run makes hard to find.
   */
  sessionId?: string
  /** The caller's short label, for a list row no card has painted. */
  label?: string
  /**
   * The model the child was pinned to, when configured as a non-empty id.
   * Carried so the card's header and the header's jump list can both name the
   * model a run used; absent means the CLI chose its own session default.
   */
  model?: string
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('subagent-codebuddy: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-codebuddy: the one-shot task must not be empty')
  }
  return texts
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Fold whitespace and bound a length, for values that go on one log line.
 * @param value - raw text; `undefined` reads as empty.
 * @param maxChars - hard ceiling, ellipsis included.
 * @returns the flattened, bounded text.
 */
function oneLineOf(value: string | undefined, maxChars: number): string {
  if (value === undefined) return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/**
 * The child's retained stderr tail, when the spawn collected one.
 * @param child - the spawned ACP child's handle.
 * @returns the trimmed tail, or undefined when nothing was captured.
 */
export function stderrTail(child: SubprocessHandle): string | undefined {
  const reader = child.collected?.stderr
  if (reader === undefined) return undefined
  try {
    const text = reader.readFrom(0).text.replace(/\s+$/, '')
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Append the child's stderr tail to a diagnostic, so a failure explains itself
 * instead of reaching the parent as "it failed".
 * @param detail - the diagnostic built by the caller.
 * @param child - the spawned ACP child's handle.
 * @returns the diagnostic, with the stderr tail appended when available.
 */
export function withStderrTail(detail: string, child: SubprocessHandle): string {
  const tail = stderrTail(child)
  return tail === undefined ? detail : `${detail}\n--- child stderr (tail) ---\n${tail}`
}

/**
 * Cooperative teardown ladder over the subprocess seam's public verbs:
 * stdin EOF (the child's window to flush and reap its own descendants), then
 * the terminate() escalation and its whole-tree exit proof.
 * @param child - the spawned ACP child's handle.
 * @param eofGraceMs - tier-1 window after stdin EOF.
 */
export async function disposeCodebuddyChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  // A spawn failure has no process to tear down; `terminate()` and the exit
  // wait stay no-ops there, and the rejection is observed (not awaited) so a
  // finally-block disposal cannot surface it as unhandled.
  child.done.catch(() => {})
  child.stdin?.end()
  const exitsWithin = async (ms: number): Promise<boolean> => {
    const timer = new AbortController()
    const timeout = setTimeout(() => { timer.abort() }, ms)
    try {
      return await child.waitForExit(timer.signal)
    } finally {
      clearTimeout(timeout)
    }
  }
  if (await exitsWithin(eofGraceMs)) return
  child.terminate()
  await child.waitForExit()
}

/**
 * Start the real ACP child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - workspace, auth, permission policy, environment, graces, and process service.
 * @returns the published run after the handshake and session creation.
 */
export async function startCodebuddyRun(request: SubagentStartRequest, spec: CodebuddyRunSpec): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) throw new Error('subagent-codebuddy: request was aborted before the ACP child started')
  const runId = SessionId(randomUUID())
  const startedAt = Date.now()
  // The label is what the caller called this run ("fix the CSP header"); the
  // prompt is what the child was told to do. Monitoring surfaces read the label,
  // because a truncated prompt is a bad row title and a worse `ps`-style column.
  const label = oneLineOf(request.label, 80)
  const promptHead = oneLineOf(texts.join(' '), 120)
  const log = spec.progressLog
    ? openRunLog(String(runId), [
      `command: ${spec.argv.join(' ')}`,
      `cwd: ${spec.cwd}`,
      `permission: ${spec.permission}`,
      `auth: ${spec.authMethodId ?? '(none configured: relies on the CLI login state or envFile)'}`,
      `credential: ${spec.credentialNote ?? '(no envFile configured)'}`,
      ...(label === '' ? [] : [`label: ${label}`]),
      `prompt: ${promptHead}`,
    ])
    : disabledRunLog()
  let logClosed = false
  let heartbeat: Heartbeat | undefined
  /** Set once the ACP session exists; cleared on every terminal path via `closeLog`. */
  let unregisterLive: (() => void) | undefined
  const closeLog = (): void => {
    // Every terminal path (startup failure, cancellation, settlement) closes the
    // log, so the beacon is stopped here rather than at each of them. The same
    // funnel retires the steering entry: a settled run must not accept messages.
    heartbeat?.stop()
    heartbeat = undefined
    unregisterLive?.()
    unregisterLive = undefined
    // The feed outlives the run by a TTL, so a card that was mid-poll when the
    // child settled still paints its last rows; `finishProgress` is what stops
    // new polls from mattering.
    finishProgress(String(runId))
    if (logClosed) return
    logClosed = true
    log.close()
  }
  if (spec.progressLog) {
    // `label` is absent for callers that supply none (a bare provider start), so
    // the reader falls back to the prompt head rather than printing an empty row.
    appendIndex(`START ${String(runId)} cwd=${spec.cwd}`
      + (label === '' ? '' : ` ${indexField('label', label)}`)
      + ` ${indexField('prompt', promptHead)}`)
  }
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      // stderr is collected, not inherited: the CLI's auth and startup
      // diagnostics belong in the run's settlement notice, where the delegating
      // Agent can act on them, instead of on the harness console.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: STDERR_TAIL_BYTES } },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error) {
    log.line('failed', `spawn: ${thrown(error).message}`)
    if (spec.progressLog) appendIndex(`FAIL  ${String(runId)} spawn: ${thrown(error).message}`)
    closeLog()
    throw thrown(error)
  }
  if (child.stdin === undefined || child.stdout === undefined) {
    throw new Error('subagent-codebuddy: the subprocess implementation dropped a piped protocol stream')
  }
  // Spawn-level failure surfaces as `done` rejecting into the startup race; a
  // clean exit must never win it, so the success arm parks forever.
  const spawnFailed: Promise<never> = child.done.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(thrown(error)),
  )
  spawnFailed.catch(() => {})

  const wire = new CodebuddyAcpWire(child.stdout, child.stdin, spec.permission, (kind, text) => {
    log.line(kind, text)
  }, (action) => {
    // The card's live feed. Keyed by this run's own id, which the runtime adopts
    // as the child id, so the id in the activation notice addresses this entry.
    recordProgress(String(runId), action)
  })
  log.line('spawn', 'child process started')
  // From here on the run is observable as "live": the index has a START and the
  // beacon is fresh, so a viewer can tell this run from one that died silently.
  if (spec.progressLog) heartbeat = startHeartbeat(String(runId))
  // The feed opens with the process, before the handshake: a child that fails
  // during startup still has a card to leave a last observation on.
  beginProgress(String(runId), startedAt, Date.now(), {
    ...spec.sessionId === undefined ? {} : { sessionId: spec.sessionId },
    ...spec.label === undefined ? {} : { label: spec.label },
    ...spec.model === undefined ? {} : { model: spec.model },
  })
  // Startup rollback and the published handle share one process teardown.
  let processDisposal: Promise<void> | undefined
  const disposeProcess = (): Promise<void> => (processDisposal ??= disposeCodebuddyChild(child, spec.disposeEofGraceMs))

  let cancelled = false
  let settleCancel: (() => void) | undefined
  const cancelSettled = new Promise<void>((resolve) => { settleCancel = resolve })
  const requestCancel = (): void => {
    if (cancelled) return
    cancelled = true
    log.line('cancel', 'cancellation requested')
    settleCancel?.()
    wire.cancel()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // Establish the remote session before publishing a handle. Any failure owns
  // the still-private process and therefore reaps it before rejecting.
  let transcriptPath: string | undefined
  try {
    await Promise.race([
      (async (): Promise<void> => {
        wire.start()
        const handshake = await wire.initialize(request.signal, spec.startupTimeoutMs)
        log.line('handshake', `protocol ${handshake.protocolVersion ?? 'unknown'}, auth methods [${handshake.authMethods.map((method) => method.id).join(', ')}]`)
        if (spec.authMethodId !== undefined) {
          await wire.authenticate(spec.authMethodId, request.signal, spec.startupTimeoutMs)
          log.line('auth', `selected method ${spec.authMethodId}`)
        }
        const sessionId = await wire.newSession(spec.cwd, request.signal, spec.startupTimeoutMs)
        log.line('session', sessionId)
        // The CLI writes its own full transcript; naming it here is what turns
        // "where is this run" into a path the operator can open.
        transcriptPath = codebuddyTranscriptPath(spec.cwd, sessionId)
        log.line('transcript', transcriptPath)
        if (cancelled) throw new Error('subagent-codebuddy: request was aborted before the ACP session started')
        // Publish the steering handle only now: before `session/new` there is no
        // session to steer, and after settlement the entry is withdrawn again.
        unregisterLive = registerLiveRun({
          childId: String(runId),
          startedAt,
          steer: async (message: string) => {
            const outcome = await wire.steer([message], request.signal, spec.startupTimeoutMs)
            log.line('steer', outcome.steered
              ? `accepted: ${message.replace(/\s+/g, ' ').slice(0, 120)}`
              : `not delivered${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`)
            if (!outcome.steered && spec.progressLog) {
              appendIndex(`STEER-REJECTED ${String(runId)} ${outcome.reason ?? 'child did not accept the message'}`)
            }
            return outcome
          },
        })
      })(),
      spawnFailed,
      cancelSettled.then((): never => { throw new Error('subagent-codebuddy: request was aborted before the ACP session started') }),
    ])
  } catch (error) {
    request.signal.removeEventListener('abort', onAbort)
    wire.close()
    // Reap before reading stderr: a dead child's pipes are drained, so the tail
    // is complete instead of whatever happened to have arrived already.
    await disposeProcess()
    if (cancelled) {
      log.line('cancelled', 'cancelled before the ACP session started')
      if (spec.progressLog) appendIndex(`CANCEL ${String(runId)} before start`)
      closeLog()
      throw new Error('subagent-codebuddy: request was aborted before the ACP child started')
    }
    const detail = startupDiagnostic(error, child, wire, {
      authConfigured: spec.authMethodId !== undefined,
      credentialNote: spec.credentialNote,
      command: spec.argv[0] ?? 'codebuddy',
    })
    log.line('failed', detail)
    if (spec.progressLog) appendIndex(`FAIL  ${String(runId)} ${detail.split('\n')[0] ?? detail}`)
    closeLog()
    throw new Error(detail)
  }

  const collectOutput = () => wire.collectOutput()
  /**
   * Append the child's own token accounting to the result content. ACP carries
   * no usage, so the CLI transcript is the only truthful source; it is written
   * asynchronously, hence the single retry. Accounting is cosmetic and must
   * never fail the delegation.
   * @param output - result blocks the settlement notice is built from.
   */
  const appendUsage = async (output: ContentBlock[]): Promise<void> => {
    const path = transcriptPath
    if (path === undefined) return
    try {
      const first = await readTranscriptUsage(path)
      const usage = first ?? await new Promise<void>((resolve) => { setTimeout(resolve, 300) })
        .then(() => readTranscriptUsage(path))
      if (usage === undefined) return
      const notice = formatUsageNotice(usage)
      if (notice === undefined) return
      // End-to-end rate: wall clock covers tool time too, so this reads as
      // "how fast did the delegation produce output", not as decode speed.
      const tps = tokensPerSecond(usage, Date.now() - startedAt).toFixed(1)
      output.push({ type: 'text', text: notice })
      log.line('usage', `${notice.trim()} tps=${tps}`)
      if (spec.progressLog) {
        appendIndex(`USAGE ${String(runId)} calls=${usage.calls} in=${usage.input} cache=${usage.cacheRead} out=${usage.output} tps=${tps}`)
      }
    } catch {
      // Accounting never breaks delegation.
    }
  }
  // Built lazily at diagnostic-read time: the stderr tail is only complete once
  // the child is gone, and the settlement sink reads it after the attempt.
  let failure: Error | undefined
  let silent = false
  const collectDiagnostic = (): string | undefined => {
    if (failure !== undefined) return `subagent-codebuddy: child run failed: ${withStderrTail(failure.message, child)}`
    if (!silent) return undefined
    return withStderrTail('subagent-codebuddy: the child produced no closing message', child)
  }
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await Promise.race([
          (async () => {
            log.line('prompt', `${texts.join(' ').length} chars submitted`)
            const reason = acpStopReason(await wire.prompt(texts, request.signal, spec.promptTimeoutMs))
            const output = collectOutput()
            // A silent child is the most opaque ending: it reaches the parent as
            // "it left no closing message". Attach it as a success diagnostic so
            // the settlement notice carries whatever the CLI said on stderr.
            silent = output.length === 0
            // After the silence decision: accounting rows must never mask a
            // child that produced no closing message.
            await appendUsage(output)
            const notice = silent ? collectDiagnostic() : undefined
            return { output, stopReason: reason, ...notice === undefined ? {} : { diagnostic: notice } }
          })(),
          cancelSettled.then(() => ({ output: collectOutput(), stopReason: 'aborted' as const })),
        ])
      } catch (error) {
        // Cover a process rejection already queued when cancellation arrives.
        if (cancelled) return { output: collectOutput(), stopReason: 'aborted' as const }
        failure = thrown(error)
        throw failure
      }
    },
    collectOutput,
    collectDiagnostic,
    cancelled: () => cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })
  // Record the outcome once, on the settlement path the runtime will report, so
  // the log's last line matches the notice the parent receives.
  void result.then((settled) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const chars = settled.output.reduce(
      (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
      0,
    )
    const diagnostic = settled.diagnostic === undefined ? '' : ' (diagnostic attached)'
    log.line('done', `stop=${settled.stopReason} output=${chars} chars elapsed=${elapsed}s${diagnostic}`)
    if (spec.progressLog) appendIndex(`END   ${String(runId)} stop=${settled.stopReason} elapsed=${elapsed}s output=${chars} chars`)
    // Before `closeLog`, because the feed is what a jump list colours a
    // finished row by, and closing it without a verdict would leave every run
    // looking "unknown". `closeLog` then re-closes it with no reason, which is
    // why the reason is only ever written when one is known.
    finishProgress(String(runId), Date.now(), runOutcome(settled.stopReason))
    closeLog()
  }, () => {
    // A rejected result is the failure path: the run never produced a
    // settlement to read a stop reason from.
    finishProgress(String(runId), Date.now(), 'failed')
  })
  return subprocessRunHandle({
    id: runId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      wire.close()
      try {
        await disposeProcess()
      } finally {
        // Allow one macrotask turn so the child's final output listeners flush
        // before the run's consumers read the accumulated text.
        await new Promise<void>((resolve) => { setImmediate(() => { resolve() }) })
        log.line('teardown', 'child process reaped')
        closeLog()
      }
    },
  })
}

/**
 * Compose the startup failure the delegating Agent sees: the transport error,
 * the executable hint when nothing was spawned, the auth-method hint when the
 * operator never chose one, what happened to the configured secret, and the
 * CLI's own stderr tail.
 * @param error - the failure that ended startup.
 * @param child - the spawned ACP child's handle.
 * @param wire - the connection, for the advertised auth methods.
 * @param context - what the caller knows about this run's auth setup.
 * @returns the diagnostic message.
 */
function startupDiagnostic(
  error: unknown,
  child: SubprocessHandle,
  wire: CodebuddyAcpWire,
  context: { readonly authConfigured: boolean, readonly credentialNote: string | undefined, readonly command: string },
): string {
  const parts = [thrown(error).message]
  // A missing executable is not an auth problem, and the raw message
  // ("spawn codebuddy ENOENT") never says why a GUI host cannot see it.
  if (errorCode(error) === 'ENOENT') {
    parts.push(
      `subagent-codebuddy: \`${context.command}\` was not found on the harness PATH — a GUI-launched host does not ` +
      'inherit your login shell PATH (Homebrew lives in /opt/homebrew/bin). Set `command` to an absolute path.',
    )
  }
  if (!context.authConfigured) {
    const hint = describeAuthMethods(wire.authMethods())
    if (hint !== undefined) parts.push(hint)
  }
  // Say what actually happened to the configured secret: "supply envFile" is
  // useless advice when one IS configured and was skipped as unreadable.
  if (context.credentialNote !== undefined) parts.push(`subagent-codebuddy: ${context.credentialNote}`)
  // A key can be readable, current, and still rejected — because the CLI
  // resolves it against whichever site its environment selects, and the
  // domestic and international sites do not accept each other's keys. Without
  // this the model reads a bare "Authentication required" and retries.
  if (/401|Authentication required|Unauthorized/i.test(parts.join('\n'))) {
    parts.push(
      'subagent-codebuddy: the CLI exited at its authentication step with a rejection, which is what a key from ' +
      'the OTHER site looks like. Set `env.CODEBUDDY_INTERNET_ENVIRONMENT` to `internal` for the domestic site ' +
      '(copilot.tencent.com) or `external` for codebuddy.ai; leaving it unset selects the international site.',
    )
  }
  return withStderrTail(parts.join('\n'), child)
}

/**
 * Read a Node-style `code` off a thrown error, when present.
 * @param error - anything caught.
 * @returns the error code, or undefined.
 */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
