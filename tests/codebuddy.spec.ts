/**
 * Keyless behavior suite: a real subprocess running the scripted mock ACP
 * child drives the provider end to end — handshake, optional authentication,
 * unattended permission answers, extension-notification tolerance, deadline
 * enforcement, stderr-bearing diagnostics, result settlement, and quiescent
 * disposal.
 *
 * @module codebuddy.spec
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, codebuddyArgv, Config, expandHome, resolveChildEnv, withGuiBinDirs } from '../src/index.js'
import { readProgress, readProgressBySession } from '../src/progress.js'
import { textTask } from '../src/run.js'
import { findLiveRun } from '../src/steer.js'
import { acpStopReason, describeAuthMethods, toAcpPrompt } from '../src/wire.js'
import type { SubagentRun, SubagentStartRequest, SubprocessHandle, SubprocessSpawnSpec } from '../src/types.js'

const CHILD = fileURLToPath(new URL('./mock-acp-child.mjs', import.meta.url))

/**
 * Spawn the mock child through node and adapt it to the subprocess seam handle,
 * honoring the spawn spec's stdio dispositions — including the bounded stderr
 * collection the provider relies on for diagnostics.
 */
function spawnMock(spec: SubprocessSpawnSpec): SubprocessHandle {
  const collectsStderr = typeof spec.stdio.stderr === 'object'
  const child = nodeSpawn(spec.argv[0] ?? process.execPath, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', collectsStderr ? 'pipe' : 'inherit'],
  })
  const stderrText = { value: '' }
  if (collectsStderr && child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer) => { stderrText.value += chunk.toString() })
  }
  const handle: SubprocessHandle = {
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    control: undefined,
    collected: collectsStderr
      ? { stderr: { readFrom: () => ({ text: stderrText.value, nextOffset: stderrText.value.length, lossy: false }) } }
      : {},
    done: once(child, 'exit').then(([code, signal]) => ({ exitCode: code, signal })),
    terminate: () => { child.kill('SIGTERM') },
    waitForExit: async (signal) => {
      if (signal?.aborted) return false
      return Promise.race([
        once(child, 'exit').then(() => true),
        signal === undefined ? Promise.resolve(true) : once(signal, 'abort').then(() => false),
      ])
    },
  }
  return handle
}

/** The conversation every request in this suite claims to be started from. */
const SESSION = 'test-parent-session'

function startRequest(prompt: string, cwd = process.cwd()): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: prompt }],
    cwd,
    signal: new AbortController().signal,
    // A real parent always carries the conversation it is driving; the provider
    // records it so the session header can list its own runs.
    parent: { session: { id: SESSION } } as SubagentStartRequest['parent'],
  }
}

interface Registered {
  readonly name: string
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

/** Mount the plugin on a minimal fake context and return the provider. */
function mount(config: Record<string, unknown> = {}): Registered {
  const warnings: string[] = []
  let provider: unknown
  const ctx = {
    logger: { warn: (message: string) => { warnings.push(message) } },
    subprocess: { spawn: spawnMock },
    subagents: {
      registerProvider: (registered: unknown) => { provider = registered },
    },
  }
  // `progressLog: false` keeps the suite out of the operator's real log
  // directory; the log format itself is covered by progress-log.spec.ts.
  apply(ctx as never, Config({ command: process.execPath, args: [CHILD], progressLog: false, ...config }) as never)
  if (provider === undefined) throw new Error('plugin did not register a provider')
  return provider as Registered
}

/** Mount a provider whose child runs one named scenario. */
function mountScenario(scenario: string, config: Record<string, unknown> = {}): Registered {
  return mount({ model: '', args: [CHILD, '--scenario', scenario], ...config })
}

describe('codebuddyArgv', () => {
  it('appends the model flag and honors an empty model', () => {
    expect(codebuddyArgv('codebuddy', ['--acp'], 'deepseek-v4.1-flash')).toEqual([
      'codebuddy', '--acp', '--model', 'deepseek-v4.1-flash',
    ])
    expect(codebuddyArgv('codebuddy', ['--acp'], '')).toEqual(['codebuddy', '--acp'])
  })
})

describe('textTask', () => {
  it('rejects non-text and whitespace-only tasks', () => {
    expect(() => textTask([{ type: 'image' } as never])).toThrow(/only text blocks/)
    expect(() => textTask([{ type: 'text', text: '  ' }])).toThrow(/must not be empty/)
  })
})

describe('wire helpers', () => {
  it('maps ACP stop reasons with unknown variants failing', () => {
    expect(acpStopReason('end_turn')).toBe('completed')
    expect(acpStopReason('max_tokens')).toBe('max-tokens')
    expect(acpStopReason('refusal')).toBe('refusal')
    expect(acpStopReason('cancelled')).toBe('aborted')
    expect(acpStopReason('max_turn_requests')).toBe('error')
    expect(acpStopReason('future-variant')).toBe('error')
  })

  it('drops non-text prompt blocks', () => {
    expect(toAcpPrompt([{ type: 'text', text: 'hi' }, { type: 'image' } as never])).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  it('names the child auth methods it was offered', () => {
    expect(describeAuthMethods([])).toBeUndefined()
    const hint = describeAuthMethods([{ id: 'wechat', name: 'WeChat' }, { id: 'sso' }])
    expect(hint).toContain('wechat (WeChat)')
    expect(hint).toContain('sso')
    expect(hint).toContain('authMethodId')
  })
})

describe('provider end to end over the mock ACP child', () => {
  it('completes a run and returns the streamed answer', async () => {
    const provider = mountScenario('pong')
    const run = await provider.start(startRequest('reply pong'))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'pong' }])
    await run.dispose()
  })

  it('approves the least-privilege allow option by default', async () => {
    const provider = mountScenario('permission')
    const run = await provider.start(startRequest('ask me', '/tmp'))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'pong' }])
    await run.dispose()
  })

  it('declines permission prompts under the reject policy', async () => {
    const provider = mountScenario('permission', { permission: 'reject' })
    const run = await provider.start(startRequest('ask me', '/tmp'))
    const result = await run.result
    expect(result.stopReason).toBe('refusal')
    await run.dispose()
  })

  it('falls back to whole agent_message updates', async () => {
    const provider = mountScenario('whole-message')
    const run = await provider.start(startRequest('reply pong'))
    const result = await run.result
    expect(result.output).toEqual([{ type: 'text', text: 'pong' }])
    await run.dispose()
  })

  it('explains a silent child with its stderr tail', async () => {
    const provider = mountScenario('silent')
    const run = await provider.start(startRequest('say nothing'))
    const result = await run.result
    expect(result.output).toEqual([])
    expect(result.diagnostic).toContain('no closing message')
    expect(result.diagnostic).toContain('empty assistant message')
    await run.dispose()
  })

  it('settles a child that dies mid-prompt as an error instead of waiting', async () => {
    const provider = mountScenario('crash')
    const run = await provider.start(startRequest('apply the patch'))
    // The pipe closes with no JSON-RPC answer. The run must NOT stay pending:
    // the parent's card only reaches a terminal state if this settles.
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBeDefined()
    expect(result.diagnostic).toContain('out of memory')
    await run.dispose()
  }, 20_000)

  it('reports an unauthenticated child with the offered auth methods and stderr', async () => {
    const provider = mountScenario('auth')
    await expect(provider.start(startRequest('reply pong'))).rejects.toThrow(/Authentication required/)
    await expect(provider.start(startRequest('reply pong'))).rejects.toThrow(/wechat \(WeChat\)/)
    await expect(provider.start(startRequest('reply pong'))).rejects.toThrow(/not logged in/)
  }, 20_000)

  it('authenticates with a configured method and then runs', async () => {
    const provider = mountScenario('auth-ok', { authMethodId: 'wechat' })
    const run = await provider.start(startRequest('reply pong'))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'pong' }])
    await run.dispose()
  })

  it('rejects an auth method the child did not advertise', async () => {
    const provider = mountScenario('auth-ok', { authMethodId: 'nope' })
    await expect(provider.start(startRequest('reply pong'))).rejects.toThrow(/not offered by the child/)
  })

  it('fails a wedged handshake on the startup deadline', async () => {
    const provider = mountScenario('hang', { startupTimeoutMs: 200 })
    const started = Date.now()
    await expect(provider.start(startRequest('reply pong'))).rejects.toThrow(/did not answer initialize within 200ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  it('dispose is idempotent and reaps the child', async () => {
    const provider = mountScenario('pong')
    const run = await provider.start(startRequest('reply pong'))
    await run.result
    await expect(run.dispose()).resolves.toBeUndefined()
    await expect(run.dispose()).resolves.toBeUndefined()
  }, 20_000)

  it('a refusal stop reason surfaces as refusal', async () => {
    const provider = mountScenario('refusal')
    const run = await provider.start(startRequest('reply pong'))
    const result = await run.result
    expect(result.stopReason).toBe('refusal')
    await run.dispose()
  }, 20_000)

  it('delivers a steering message into the running turn', async () => {
    const provider = mountScenario('steer')
    const run = await provider.start(startRequest('hold the turn'))
    // Published only after session/new: before that there is nothing to steer.
    const live = findLiveRun(String(run.id))
    expect(live).toBeDefined()
    expect(live?.childId).toBe(String(run.id))

    const outcome = await live!.steer('also update the docs')
    expect(outcome.steered).toBe(true)
    // The child answers with what the steer carried, so this proves delivery
    // rather than the provider merely accepting the call.
    const result = await run.result
    expect(result.output).toEqual([{ type: 'text', text: 'steered: also update the docs' }])

    // A settled run must stop accepting messages.
    expect(findLiveRun(String(run.id))).toBeUndefined()
    await run.dispose()
  }, 20_000)

  it('reports a child refusal instead of throwing or retrying', async () => {
    const provider = mountScenario('steer-reject')
    const run = await provider.start(startRequest('hold the turn'))
    const outcome = await findLiveRun(String(run.id))!.steer('too late')
    expect(outcome).toEqual({ steered: false, reason: 'content not injectable' })
    await run.result
    await run.dispose()
  }, 20_000)

  it('keeps only the events the provider alone witnessed in the run log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codebuddy-runlog-'))
    const previous = process.env.DSH_SUBAGENT_CODEBUDDY_LOG_DIR
    process.env.DSH_SUBAGENT_CODEBUDDY_LOG_DIR = dir
    try {
      const provider = mountScenario('tools', { progressLog: true })
      const run = await provider.start({ ...startRequest('do the thing'), label: 'patch the header' })
      await run.result
      await run.dispose()

      const runLog = readdirSync(dir).filter((file) => file.endsWith('.log') && file !== 'index.log')
      expect(runLog).toHaveLength(1)
      const text = readFileSync(join(dir, runLog[0]!), 'utf8')
      // Context first: the operator must be able to tell runs apart, and must
      // be able to tell the label apart from the prompt it labels.
      expect(text).toContain('# cwd: ')
      expect(text).toContain('# label: patch the header')
      expect(text).toContain('# prompt: do the thing')
      // The spine: what happened that nothing else records.
      expect(text).toContain('spawn')
      expect(text).toContain('1/2 done — patch it')
      expect(text).toMatch(/transcript /)
      expect(text).toMatch(/stop=completed/)
      // A failure is the one tool event kept — it changes what the run means.
      expect(text).toMatch(/Bash npm test \[execute\] → failed [\d.]+s/)
      // And a success is not copied: the CLI's transcript already has it, in
      // more detail than this log could offer.
      expect(text).not.toContain('Edit src/a.ts')
      expect(text).not.toContain('→ in_progress')

      const index = readFileSync(join(dir, 'index.log'), 'utf8')
      expect(index).toMatch(/START \S+ .*label="patch the header" prompt="do the thing"/)
      expect(index).toMatch(/END \S+ stop=completed/)

      // The same actions, as the chat card reads them: one row per tool call,
      // keyed by the run id the runtime adopts as the child id.
      const feed = readProgress([String(run.id)])[String(run.id)]
      expect(feed?.steps.map(step => [step.kind, step.label, step.state])).toEqual([
        ['tool', 'Edit src/a.ts', 'done'],
        ['plan', '1/2 步 · patch it', 'running'],
        ['tool', 'Bash npm test', 'failed'],
      ])
      // Settled feeds stay readable, and say so, so a late poll stops asking.
      expect(typeof feed?.endedAt).toBe('number')
    } finally {
      if (previous === undefined) delete process.env.DSH_SUBAGENT_CODEBUDDY_LOG_DIR
      else process.env.DSH_SUBAGENT_CODEBUDDY_LOG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

/**
 * The credential seam: the plugin's only file-based auth is one `envFile`, and
 * a machine that synced its config but not its secrets gets a silent no-op
 * unless the outcome is recorded for the diagnostic.
 */
describe('envFile credential resolution', () => {
  const quiet = { logger: { warn: (): void => {} } }

  it('expands a leading tilde so a human-written path survives a GUI launch', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/.dsh/secrets/key')).toBe(join(homedir(), '.dsh/secrets/key'))
    // Absolute and relative paths are left alone.
    expect(expandHome('/tmp/key')).toBe('/tmp/key')
    expect(expandHome('rel/key')).toBe('rel/key')
  })

  it('injects a trimmed key and reports only its length, never the secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codebuddy-envfile-'))
    try {
      const file = join(dir, 'key')
      writeFileSync(file, '  ck_secret_value\n')
      const resolved = resolveChildEnv({ envFile: file }, quiet)
      expect(resolved.env.CODEBUDDY_API_KEY).toBe('ck_secret_value')
      expect(resolved.credential).toContain('injected (15 chars)')
      expect(resolved.credential).not.toContain('ck_secret_value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names a missing file instead of silently delegating without a key', () => {
    const resolved = resolveChildEnv({ envFile: '/nonexistent/codebuddy-key' }, quiet)
    expect(resolved.env.CODEBUDDY_API_KEY).toBeUndefined()
    expect(resolved.credential).toContain('UNREADABLE')
    expect(resolved.credential).toContain('/nonexistent/codebuddy-key')
  })

  it('separates an empty file from an unreadable one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codebuddy-envfile-'))
    try {
      const file = join(dir, 'empty')
      writeFileSync(file, '   \n')
      const resolved = resolveChildEnv({ envFile: file }, quiet)
      expect(resolved.env.CODEBUDDY_API_KEY).toBeUndefined()
      expect(resolved.credential).toContain('EMPTY')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves an unconfigured envFile entirely alone', () => {
    const resolved = resolveChildEnv({}, quiet)
    expect(resolved.credential).toBeUndefined()
    expect(resolved.env.DISABLE_AUTOUPDATER).toBe('1')
  })
})

/**
 * A GUI-launched host has launchd's PATH, not the login shell's — so the bare
 * `codebuddy` default would fail to spawn on a machine where Homebrew is
 * installed and the harness was never started from a terminal.
 */
describe('GUI bin dirs on the child PATH', () => {
  it('appends Homebrew prefixes the host PATH lacks', () => {
    const env = withGuiBinDirs({ PATH: '/usr/bin:/bin' }, '/usr/bin:/bin')
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
  })

  it('keeps an already-correct PATH untouched and never duplicates', () => {
    const good = '/opt/homebrew/bin:/usr/bin:/usr/local/bin'
    expect(withGuiBinDirs({ PATH: good }, '/usr/bin').PATH).toBe(good)
  })

  it('falls back to the inherited PATH when the config sets none', () => {
    const env = withGuiBinDirs({}, '/usr/bin:/bin')
    expect(env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined()
  })
})

/**
 * The session header's jump list reads this: every run the provider starts must
 * be findable from the conversation that started it, labelled, with its steps —
 * whether or not the browser ever rendered the card.
 */
describe('the session a run belongs to', () => {
  it('publishes the run, its label, and its steps to that conversation', async () => {
    const provider = mountScenario('tools')
    const run = await provider.start({ ...startRequest('do the thing'), label: 'patch the header' })
    // Listed the moment the run is published — before the browser ever sees a
    // card, which is the whole point of the jump list.
    const listed = readProgressBySession(SESSION).find(row => row.childId === String(run.id))
    expect(listed?.label).toBe('patch the header')
    expect(listed?.sessionId).toBe(SESSION)
    await run.result
    // And it keeps accumulating the run's calls while the card was never open.
    const settled = readProgressBySession(SESSION).find(row => row.childId === String(run.id))
    expect(settled?.steps.length).toBeGreaterThan(0)
    expect(settled?.endedAt).toBeDefined()
    // How it ended is recorded with the feed, not left to the card's message:
    // the jump list colours a finished row by this and has no notice to read.
    expect(settled?.outcome).toBeDefined()
    await run.dispose()
  }, 20_000)

  it('keeps a session-less parent working: the listing is a convenience', async () => {
    const provider = mountScenario('tools')
    const request = { ...startRequest('do the thing'), parent: {} as SubagentStartRequest['parent'] }
    const run = await provider.start(request)
    const result = await run.result
    expect(result.output.length).toBeGreaterThan(0)
    // Not listed anywhere — and that must not have failed the delegation.
    expect(readProgressBySession(SESSION).some(row => row.childId === String(run.id))).toBe(false)
    await run.dispose()
  }, 20_000)
})
