/**
 * One-shot CodeBuddy CLI subagent provider. Every accepted run spawns the
 * local `codebuddy --acp` server — authenticated by the machine's own login
 * state, an `envFile` API key, or an explicitly selected `authMethodId` — and
 * drives it through the ACP wire in this package. The child's model is pinned
 * by config (default `deepseek-v4.1-flash`) via the CLI's `--model` flag.
 *
 * The provider is deliberately one tool's worth of surface: it starts a run
 * and lets the harness deliver the settlement notice, so no companion
 * "status" tool is mounted.
 *
 * This plugin uses named exports only; a default would hide its loader
 * metadata.
 *
 * @module dsh-subagent-codebuddy
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { NO_START_CAPABILITIES, assertPositiveFinite, assertUsableCwd } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { startCodebuddyRun } from './run.js'
import { registerProgressRoute } from './progress-route.js'
import type { RouteHost } from './progress-route.js'

export const name = 'subagent-codebuddy'
export const inject = ['subagents', 'subprocess']

/** The model the provider pins by default, per the deployment requirement. */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/** Default tier-1 window after stdin EOF before termination escalates. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default POSIX grace between SIGTERM and SIGKILL on dispose. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/**
 * Default deadline for the ACP handshake plus session creation. An
 * unauthenticated or wedged child would otherwise hold the delegating tool
 * call open forever; the CLI reports auth problems through `session/new`.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

/**
 * The update-check banner the CLI prints on stdout when it finds a newer
 * release. stdout carries the ACP JSON-lines stream, so a banner line corrupts
 * the wire; spawned runs therefore disable auto-update. A deployment can still
 * override the variable through `env` (an explicit opt-in beats the default).
 */
const DISABLE_AUTOUPDATER_ENV: Record<string, string> = { DISABLE_AUTOUPDATER: '1' }

/**
 * Where a Homebrew-installed CLI actually lives, but where a GUI-launched host
 * never looks: an app started from Finder inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell's.
 */
const GUI_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * Append the Homebrew bin dirs to the child's PATH when they are missing.
 *
 * The provider's default `command` is the bare word `codebuddy`, so spawn
 * resolves it against the env handed to the child. Without this, the same
 * machine can work when the harness was started from a terminal and fail with
 * `spawn codebuddy ENOENT` when it was started from Finder — a difference no
 * config file records.
 * @param env - the child environment built so far.
 * @param inherited - the host's PATH, used when the config sets none.
 * @returns the environment, with PATH extended in place.
 */
export function withGuiBinDirs(
  env: Record<string, string>,
  inherited: string | undefined = process.env.PATH,
): Record<string, string> {
  const current = (env.PATH ?? inherited ?? '').split(':').filter(part => part !== '')
  const missing = GUI_BIN_DIRS.filter(dir => !current.includes(dir))
  if (missing.length === 0) return env
  return { ...env, PATH: [...current, ...missing].join(':') }
}

/** Config: the CodeBuddy CLI spawn shape, its pinned model, and disposal graces. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codebuddy`). */
  providerName?: string
  /** The CodeBuddy CLI executable (default `codebuddy`). */
  command?: string
  /** Arguments that start the CLI's ACP server (default `['--acp']`). */
  args?: string[]
  /**
   * Model id passed to the child as `--model <id>` (default
   * `deepseek-v4.1-flash`). The id must exist in the account's model list (the
   * CLI's `/model` list); an unknown id fails in the child. An empty string
   * omits the flag and uses the CLI's own session default.
   */
  model?: string
  /**
   * How to auto-answer the child's `session/request_permission` prompts:
   * `allow` (default — approve through the first `allow_once`/`allow_always`
   * option, so a delegated task can actually use its tools) or `reject`
   * (decline every prompt, leaving the child to report what it could not do).
   * No prompt is surfaced to a human either way.
   */
  permission?: 'allow' | 'reject'
  /**
   * Extra environment variables for the child process, merged over the
   * `DISABLE_AUTOUPDATER=1` wire-protection default on top of a
   * credential-scrubbed copy of the parent env.
   */
  env?: Record<string, string>
  /**
   * Path to a file whose trimmed content is injected as the child's
   * `CODEBUDDY_API_KEY` (API-key auth without putting the secret into this
   * config). Absolute, or relative to the harness launch directory. Read at
   * each start, so rotating the key takes effect on the next delegation. A
   * missing or empty file is an OPTIONAL secret: the provider logs a warning
   * and continues — the child then falls back to the machine's CLI login
   * state.
   */
  envFile?: string
  /**
   * Advertised ACP authentication method to select explicitly, from the child's
   * `initialize` result (the ids `codebuddy --acp` reports, e.g. a WeChat or
   * SSO method). Unset keeps the machine's CLI login state plus any `envFile`
   * API key, which is the right default for an already-logged-in host; a
   * failure then reports the offered ids so this can be filled in.
   */
  authMethodId?: string
  /** Grace period (ms) for the child's EOF-driven quiesce on dispose. */
  disposeEofGraceMs?: number
  /** Termination-escalation grace (ms) between SIGTERM and SIGKILL. */
  disposeGraceMs?: number
  /**
   * Deadline (ms) shared by the ACP handshake and session creation
   * (`initialize` + `session/new`), which is where a missing or expired
   * credential surfaces. A timeout fails the delegation with the child's
   * stderr tail instead of hanging the tool call. `0` waits indefinitely.
   */
  startupTimeoutMs?: number
  /**
   * Overall deadline (ms) for one submitted task. `0` (default) waits
   * indefinitely, because a real coding task can legitimately run for many
   * minutes; set it to bound unattended delegations.
   */
  promptTimeoutMs?: number
  /**
   * Write a live progress log per run to
   * `~/.dsh/logs/subagent-codebuddy/<runId>.log`, plus a one-line-per-run
   * `index.log` beside it (default `true`). This is the only window into a run
   * that happens between the delegation result and the settlement notice: the
   * child's tool calls and their status, permission answers, handshake, session
   * id, the CLI's own transcript path, and the terminal outcome. `tail -f` on
   * either file is the progress view. Nothing here reaches the parent model.
   */
  progressLog?: boolean
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('codebuddy'),
  command: z.string().min(1).default('codebuddy'),
  args: z.array(z.string()).default(['--acp']),
  model: z.string().default(DEFAULT_MODEL),
  permission: z.union(['allow', 'reject'] as const).default('allow'),
  env: z.dict(z.string()).default({}),
  envFile: z.string(),
  authMethodId: z.string(),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  startupTimeoutMs: z.number().default(DEFAULT_STARTUP_TIMEOUT_MS),
  promptTimeoutMs: z.number().default(0),
  progressLog: z.boolean().default(true),
})

/** The shape after schemastery applied the defaults (`envFile`/`authMethodId` have none). */
type ResolvedConfig = Required<Omit<Config, 'envFile' | 'authMethodId'>> & Pick<Config, 'envFile' | 'authMethodId'>

/**
 * The complete child argv: command, ACP-start arguments, then `--model <id>`
 * unless the model is the empty string.
 * @param command - the configured CLI command.
 * @param args - the configured ACP-start arguments.
 * @param model - the configured model id, or `''` to omit the flag.
 * @returns the complete child argv.
 */
export function codebuddyArgv(command: string, args: readonly string[], model: string): string[] {
  return [command, ...args, ...(model === '' ? [] : ['--model', model])]
}

/**
 * The CodeBuddy provider. Advertises NO start-time capabilities: an
 * out-of-process child cannot honor parent-enforced start features, and the
 * service rejects a request needing any of them before `start` runs.
 */
class CodebuddyProvider {
  readonly name: string
  readonly capabilities = NO_START_CAPABILITIES
  // Context contract: an out-of-process CodeBuddy child starts fresh — no
  // parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.name = name
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const cwd = assertUsableCwd('subagent-codebuddy', 'delegating session workspace', request.cwd)
    // Read per start, so rotating the key on disk takes effect on the next
    // delegation without a plugin reload.
    const child = resolveChildEnv(this.config, this.ctx)
    const sessionId = parentSessionId(request)
    return startCodebuddyRun(request, {
      argv: codebuddyArgv(this.config.command, this.config.args, this.config.model),
      cwd,
      permission: this.config.permission,
      // An empty string is an explicit "do not authenticate explicitly".
      authMethodId: this.config.authMethodId === '' ? undefined : this.config.authMethodId,
      env: child.env,
      ...(child.credential === undefined ? {} : { credentialNote: child.credential }),
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      startupTimeoutMs: this.config.startupTimeoutMs,
      promptTimeoutMs: this.config.promptTimeoutMs,
      progressLog: this.config.progressLog,
      // `parent.session.id` is the conversation this delegation was started
      // from; the header list filters on it so one session never shows another
      // session's runs. Read defensively: the feed is a convenience, and a
      // parent without a session (a bare test harness, an unusual embedder)
      // must still get its delegation.
      ...sessionId === undefined ? {} : { sessionId },
      ...request.label === undefined ? {} : { label: request.label },
      // The pinned model id, for the card header and the header's jump list.
      // An empty string means "CLI default": nothing to show.
      ...(this.config.model === '' ? {} : { model: this.config.model }),
      spawn: (spec: SubprocessSpawnSpec) => this.ctx.subprocess.spawn(spec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`subagent-codebuddy "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    })
  }
}

/**
 * Build the child environment for ONE start: the wire-protection default
 * merges first, then an explicit `env` entry, then the `envFile` secret. The
 * file is read per start — not once at plugin load — so rotating the key on
 * disk takes effect on the next delegation without reloading the plugin. A
 * missing or empty file is an OPTIONAL secret: it only warns, because the
 * child can still fall back to the machine's CLI login state.
 * @param config - the resolved plugin config.
 * @param ctx - context whose logger receives the envFile warnings.
 * @returns the child environment plus a human-safe note about the credential.
 */
export function resolveChildEnv(
  config: Pick<Config, 'env' | 'envFile'>,
  ctx: { logger: { warn(message: string): void } },
): { env: Record<string, string>, credential: string | undefined } {
  // The wire-protection default merges first so an explicit `env` entry wins.
  let env: Record<string, string> = withGuiBinDirs({ ...DISABLE_AUTOUPDATER_ENV, ...config.env })
  if (config.envFile === undefined) return { env, credential: undefined }
  const expanded = expandHome(config.envFile)
  const path = isAbsolute(expanded) ? expanded : resolve(expanded)
  try {
    const key = readFileSync(path, 'utf8').trim()
    if (key === '') {
      ctx.logger.warn(`subagent-codebuddy: envFile is empty, skipping CODEBUDDY_API_KEY injection: ${path}`)
      return { env, credential: `envFile ${path} is EMPTY — no API key was injected` }
    }
    // The key itself never reaches a diagnostic: only its length does.
    return { env: { ...env, CODEBUDDY_API_KEY: key }, credential: `envFile ${path} injected (${key.length} chars)` }
  } catch (error) {
    ctx.logger.warn(`subagent-codebuddy: envFile is unreadable, skipping CODEBUDDY_API_KEY injection: ${path} (${thrownMessage(error)})`)
    return { env, credential: `envFile ${path} is UNREADABLE (${thrownMessage(error)}) — no API key was injected` }
  }
}

/**
 * The conversation a delegation was started from, when the request names one.
 *
 * The type says `parent` always carries a session, but this value only feeds a
 * convenience — the session header's jump list — so it is read structurally and
 * allowed to be absent rather than thrown over.
 * @param request - the accepted start request.
 * @returns the parent session id, or undefined when the request has none.
 */
export function parentSessionId(request: ResolvedSubagentStartRequest): string | undefined {
  const session = (request.parent as { session?: { id?: unknown } } | undefined)?.session
  const id = session?.id
  return id === undefined || id === null ? undefined : String(id)
}

/**
 * Expand a leading `~` so an `envFile` written for a human shell also works
 * when the harness launches from a GUI app.
 * @param path - the configured path.
 * @returns the path with `~` replaced by the current user's home directory.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Render an unknown thrown value as a message, for a diagnostic.
 * @param error - anything caught.
 * @returns its message, or its string form.
 */
function thrownMessage(error: unknown): string {
  return error instanceof Error ? `${error.message}${errorCode(error) === undefined ? '' : ` [${errorCode(error)}]`}` : String(error)
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

/**
 * Assert a configured deadline is finite and not negative (`0` disables it).
 * @param prefix - the consuming plugin's diagnostic prefix.
 * @param name - the config field name, for the diagnostic.
 * @param value - the configured value.
 */
function assertNonNegativeFinite(prefix: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${prefix}: ${name} must be a non-negative finite number (0 disables it)`)
}

/**
 * Register the fixed CodeBuddy provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - CLI spawn shape, pinned model, permission policy, and disposal graces.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('subagent-codebuddy', 'disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('subagent-codebuddy', 'disposeGraceMs', resolved.disposeGraceMs)
  assertNonNegativeFinite('subagent-codebuddy', 'startupTimeoutMs', resolved.startupTimeoutMs)
  assertNonNegativeFinite('subagent-codebuddy', 'promptTimeoutMs', resolved.promptTimeoutMs)
  if (resolved.model.trim() === '' && resolved.model !== '') {
    throw new Error('subagent-codebuddy: model must not be whitespace — use an empty string to omit the flag')
  }
  ctx.subagents.registerProvider(new CodebuddyProvider(resolved.providerName, ctx, resolved))
  /*
   * The card's live feed needs a transport, and the host's own HTTP listener is
   * the only one a page can reach without a second port or a new credential:
   * the web UI is served by it, and the desktop window forwards its own
   * `dsh-app://app/…` requests to the host it owns. A headless profile has no
   * such listener, which is why this is an optional injection rather than a
   * declared one — the provider must keep working where nothing is listening.
   */
  const inject = (ctx as { inject?: unknown }).inject
  // `inject` is mixed onto the context by the plugin registry; a bare context
  // (a unit-test harness, an older loader) simply has no web server to claim.
  if (typeof inject !== 'function') return
  ;(inject as (deps: string[], callback: (scoped: Context) => void) => unknown).call(ctx, ['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: RouteHost }).webServer
    if (webServer === undefined) return
    scoped.effect(() => registerProgressRoute(webServer))
  })
}
