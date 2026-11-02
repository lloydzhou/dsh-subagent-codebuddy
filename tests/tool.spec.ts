/**
 * Model-facing contract of the custom delegation tool.
 *
 * The tool exists because the generic one renders a bare `started subagent <id>`
 * and never tells the model that the run cannot be polled. These assertions
 * pin the three facts a delegation result must carry, since losing any of them
 * puts the model back to calling `wait_agent` against a one-shot child.
 *
 * @module tool.spec
 */

import { describe, expect, it } from 'vitest'
import { Config, DESCRIPTION, activationNotice, apply, steerNotice } from '../src/tool.js'
import { findLiveRun, registerLiveRun } from '../src/steer.js'

interface Registered {
  name: string
  output: { render(args: any, value: any): { text: string }[] }
  execute(args: any, exec: unknown): Promise<any>
}

/** Pick one registered tool by name: the plugin mounts more than one. */
function toolNamed(registered: Registered[], name: string): Registered {
  const found = registered.find(entry => entry.name === name)
  if (found === undefined) throw new Error(`tool ${name} was not registered (got: ${registered.map(entry => entry.name).join(', ')})`)
  return found
}

/**
 * A minimal stand-in for the cordis context: enough to observe what `apply`
 * registers and to drive `execute` down the real code path.
 */
function fakeContext(overrides: { providerRegistered?: boolean; childId?: string } = {}) {
  const registered: Registered[] = []
  const starts: unknown[] = []
  const ctx = {
    effect(execute: () => () => void) {
      execute()
      return { dispose: () => {} }
    },
    tools: {
      register(definition: Registered) {
        registered.push(definition)
        return () => {}
      },
    },
    subagents: {
      getProvider(name: string) {
        return overrides.providerRegistered === false ? undefined : { name }
      },
      resolveMaxDepth() {
        return undefined
      },
      async startActivation(spec: unknown) {
        starts.push(spec)
        return { childId: overrides.childId ?? 'child-1' }
      },
    },
  }
  return { ctx, registered, starts }
}

const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }

describe('subagent_codebuddy result wording', () => {
  it('says the child is already running and does not need to be waited on', () => {
    const notice = activationNotice('sess-42', 'Fix CSP origin')
    expect(notice).toContain('sess-42')
    expect(notice).toMatch(/RUNNING/)
    // The load-bearing instruction: polling tools cannot see this run.
    expect(notice).toMatch(/No tool tracks this run/)
    expect(notice).toMatch(/wait_agent/)
    // And the delivery promise must name the id the notice will carry.
    expect(notice).toContain('Background subagent sess-42 finished')
  })

  it('never implies the result is already available', () => {
    const notice = activationNotice('sess-7', 'probe')
    expect(notice).not.toMatch(/finished\.\s*$/i)
    expect(notice).toMatch(/arrives in this conversation by itself/)
  })
})

describe('subagent_codebuddy description', () => {
  it('warns against polling and points at the steering tool instead', () => {
    expect(DESCRIPTION).toMatch(/Do NOT wait/)
    expect(DESCRIPTION).toMatch(/list_agents/)
    // Steering replaced the old "no follow-up messages" dead end.
    expect(DESCRIPTION).toMatch(/codebuddy_steer/)
    expect(DESCRIPTION).not.toMatch(/no follow-up messages/)
  })

  it('tells the model the child cannot see this conversation', () => {
    expect(DESCRIPTION).toMatch(/prompt must carry every detail/)
  })
})

describe('tool config', () => {
  it('defaults to the codebuddy provider and a provider-managed depth', () => {
    const resolved = Config({})
    expect(resolved.provider).toBe('codebuddy')
    expect(resolved.toolName).toBe('subagent_codebuddy')
    expect(resolved.maxDepth).toBe('provider-managed')
  })
})

describe('mounting', () => {
  it('registers the delegation tool and the steering tool', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, Config({}))
    expect(registered.map(entry => entry.name)).toEqual(['subagent_codebuddy', 'codebuddy_steer'])
  })

  it('starts the child with parent delivery so the runtime owns the notice', async () => {
    const { ctx, registered, starts } = fakeContext({ childId: 'child-9' })
    apply(ctx as never, Config({}))
    const value = await toolNamed(registered, 'subagent_codebuddy').execute({ description: 'probe', prompt: 'do it' }, exec)
    expect(value).toEqual({ kind: 'activation', subagentId: 'child-9' })
    expect((starts[0] as { delivery: string }).delivery).toBe('parent')
    expect((starts[0] as { provider: string }).provider).toBe('codebuddy')
  })

  it('renders the running notice, not a bare id', async () => {
    const { ctx, registered } = fakeContext({ childId: 'child-9' })
    apply(ctx as never, Config({}))
    const value = await toolNamed(registered, 'subagent_codebuddy').execute({ description: 'probe', prompt: 'do it' }, exec)
    const text = toolNamed(registered, 'subagent_codebuddy').output.render({ description: 'probe' }, value)[0]!.text
    expect(text).toContain('child-9')
    expect(text).toMatch(/RUNNING/)
    expect(text).toMatch(/do not poll/)
  })

  it('fails loudly when the provider is absent instead of starting nothing', async () => {
    const { ctx, registered } = fakeContext({ providerRegistered: false })
    apply(ctx as never, Config({}))
    await expect(toolNamed(registered, 'subagent_codebuddy').execute({ description: 'probe', prompt: 'do it' }, exec)).rejects.toThrow(/not registered/)
  })

  it('refuses a numeric depth at mount and names the fix', () => {
    const { ctx, registered } = fakeContext()
    // The provider has no depthLimit capability, so the harness would reject the
    // activation anyway; failing here turns a silently inactive row into an
    // error that says what to write instead.
    expect(() => apply(ctx as never, Config({ maxDepth: 3 }))).toThrow(/provider-managed/)
    expect(registered).toHaveLength(0)
  })

  it('never forwards a maxDepth, so the harness default cannot leak in', async () => {
    const { ctx, registered, starts } = fakeContext()
    apply(ctx as never, Config({}))
    await toolNamed(registered, 'subagent_codebuddy').execute({ description: 'probe', prompt: 'do it' }, exec)
    const request = (starts[0] as { request: Record<string, unknown> }).request
    expect('maxDepth' in request).toBe(false)
  })
})

describe('codebuddy_steer tool', () => {
  it('delivers through the live run and says when it will be read', async () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, Config({}))
    const received: string[] = []
    const off = registerLiveRun({
      childId: 'child-9',
      startedAt: 0,
      steer: async (message) => { received.push(message); return { steered: true } },
    })
    try {
      const steerTool = toolNamed(registered, 'codebuddy_steer')
      const value = await steerTool.execute({ childId: 'child-9', message: 'also update the docs' }, exec)
      expect(value).toEqual({ childId: 'child-9', steered: true })
      expect(received).toEqual(['also update the docs'])
      expect(steerTool.output.render({}, value)[0]!.text).toMatch(/next step boundary/)
    } finally {
      off()
    }
    expect(findLiveRun('child-9')).toBeUndefined()
  })

  it('refuses an id that already finished, without pretending to deliver', async () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, Config({}))
    await expect(
      toolNamed(registered, 'codebuddy_steer').execute({ childId: 'gone', message: 'hi' }, exec),
    ).rejects.toThrow(/already finished/)
  })

  it('lists the still-live runs when the id is wrong', async () => {
    const off = registerLiveRun({ childId: 'live-1', startedAt: 0, steer: async () => ({ steered: true }) })
    try {
      const { ctx, registered } = fakeContext()
      apply(ctx as never, Config({}))
      await expect(
        toolNamed(registered, 'codebuddy_steer').execute({ childId: 'typo', message: 'hi' }, exec),
      ).rejects.toThrow(/still running: live-1/)
    } finally {
      off()
    }
  })
})

describe('steer result wording', () => {
  it('tells the model a refusal is final rather than retryable', () => {
    const text = steerNotice('child-1', { steered: false, reason: 'content not injectable' })
    expect(text).toContain('content not injectable')
    expect(text).toMatch(/Do not resend/)
  })
})
