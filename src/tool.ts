/**
 * Model-facing delegation tool for the CodeBuddy backend.
 *
 * The shipped `@deepseek-ai/dsh-tool-subagent` renders a fixed
 * `started subagent <id>` and offers no wording knob, which leaves the model
 * free to mistake an out-of-process one-shot child for an agent-team teammate
 * and try to wait on it (`wait_agent` / `list_agents`), where it can only ever
 * see "no subagent running". This module mounts the same activation path —
 * `ctx.subagents.startActivation({ delivery: 'parent' })` — behind a tool whose
 * description and result say plainly that the run is already in flight and that
 * the result arrives by itself.
 *
 * The runtime keeps every guarantee the generic tool had: activation ownership,
 * depth policy, cancellation, the child catalog entry, and the settlement
 * notice.
 *
 * @module dsh-subagent-codebuddy/tool
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { findLiveRun, liveRunIds } from './steer.js'

export const name = 'tool-subagent-codebuddy'
export const inject = ['tools', 'subagents']

/** Config: which provider to start and the names the model sees. */
export interface Config {
  /** Registered backend name on `ctx.subagents` (default `codebuddy`). */
  provider?: string
  /** Model-facing tool name (default `subagent_codebuddy`). */
  toolName?: string
  /** Model-facing mid-run steering tool name (default `codebuddy_steer`). */
  steerToolName?: string
  /**
   * Child depth budget: `'provider-managed'` (default) sends no cap, which is
   * the only valid form here because the provider advertises no `depthLimit`
   * capability. Any numeric value makes the mount fail with a named error
   * rather than leaving the tool inactive with a reason nobody reads.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().min(1).default('codebuddy'),
  toolName: z.string().min(1).default('subagent_codebuddy'),
  steerToolName: z.string().min(1).default('codebuddy_steer'),
  maxDepth: z.union([z.natural(), z.const('provider-managed')]).default('provider-managed'),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * The tool description, written around the two mistakes this backend invites:
 * treating a one-shot external child as a continuable teammate, and trying to
 * poll for a run that the runtime reports on its own.
 */
export const DESCRIPTION = [
  'Delegate one self-contained task to the local CodeBuddy CLI agent.',
  'It runs in its own process, with its own tools and a fresh context: it cannot see this conversation,',
  "the files this agent has read, or any earlier turn, so the prompt must carry every detail it needs.",
  'The call returns as soon as the child has started.',
  'Do NOT wait for it: wait_agent, list_agents, and team_task_list only track in-process teammates and one-shot',
  'local children, so they always report nothing about this run, and sleeping burns the turn without advancing it.',
  'The result arrives on its own as a "Background subagent <id> finished" notice in this conversation.',
  'While it runs, its progress (every tool call the child makes, and their status) is appended to',
  '~/.dsh/logs/subagent-codebuddy/<id>.log — read that file when the user asks how the run is going,',
  'never to wait for the end.',
  'To add a requirement mid-run, call codebuddy_steer with that id: the message reaches the child at its',
  'next step boundary without interrupting the tool call it is in the middle of.',
  'Either continue with other work or end the turn.',
].join(' ')

/**
 * The steering tool's description. Its whole job is to keep the model from
 * doing the two things that look natural and do not work here: starting a
 * second turn on the same child, or waiting for the first one to end.
 */
export const STEER_DESCRIPTION = [
  'Send one message into a running CodeBuddy child without cancelling what it is doing.',
  'The child reads it at its next step boundary, then continues; the tool call it is in the middle of is not interrupted.',
  'Use it to add a requirement, correct a wrong assumption, or answer a question the child raised in its progress log.',
  'The child id is the one in the activation notice ("subagent_codebuddy is RUNNING as <id>").',
  'It only works while the child is running: once the closing notice has arrived, the run is over and the message is refused.',
  'Do not resend on refusal, and do not use this to poll for progress — read ~/.dsh/logs/subagent-codebuddy/<id>.log for that.',
].join(' ')

/**
 * The model-facing text for an accepted activation.
 *
 * It states three things the model would otherwise have to guess: the child is
 * already running, no tool can observe it, and the result is delivered without
 * being asked for.
 * @param subagentId - the child id named in the later settlement notice.
 * @param label - the short task label the caller supplied.
 * @returns the rendered tool result.
 */
export function activationNotice(subagentId: string, label: string): string {
  return [
    `subagent_codebuddy is RUNNING as ${subagentId} (${label}).`,
    'The CodeBuddy child already has the task; this call returned when the child started, not when it finished.',
    'No tool tracks this run — wait_agent and list_agents cover only in-process teammates and one-shot local children —',
    'so do not poll them and do not sleep.',
    `To add a requirement while it runs, call codebuddy_steer with childId "${subagentId}": the message is delivered at`,
    "the child's next step boundary and does not interrupt the tool call it is currently in.",
    `When it ends, a "Background subagent ${subagentId} finished" notice with its closing message arrives in this conversation by itself.`,
    'Continue with other work or end your turn now.',
  ].join(' ')
}

/**
 * The model-facing text for one steering delivery.
 *
 * `steered:false` is a real answer rather than a failure — the child may be
 * between turns, or the run may be finishing — so the result says which
 * happened instead of quietly reporting success.
 * @param childId - the run the message was addressed to.
 * @param outcome - what the child answered.
 * @returns the rendered tool result.
 */
export function steerNotice(childId: string, outcome: { steered: boolean, reason?: string }): string {
  if (outcome.steered) {
    return `Message delivered to ${childId}; the child reads it at its next step boundary. Continue with other work.`
  }
  return [
    `The CodeBuddy child ${childId} did not take the message${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`,
    '— it is most likely between turns or already finishing. Do not resend it in a loop;',
    'its closing message will arrive in this conversation on its own.',
  ].join(' ')
}

/**
 * Register the CodeBuddy delegation tool.
 * @param ctx - context carrying the tool registry and the subagent service.
 * @param config - provider name, tool name, and depth policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  // The CodeBuddy provider advertises no `depthLimit` capability, so a numeric
  // budget cannot be enforced and the harness rejects such an activation. Fail
  // at mount with a message that names the fix instead of leaving the row
  // silently inactive, and never derive the depth from the harness default —
  // `resolveMaxDepth(undefined)` answers with that same unusable number.
  if ((resolved.maxDepth ?? 'provider-managed') !== 'provider-managed') {
    throw new Error(
      `${resolved.toolName}: maxDepth ${String(resolved.maxDepth)} cannot be enforced by the `
      + `"${resolved.provider}" provider (no depthLimit capability); set maxDepth: 'provider-managed'`,
    )
  }
  const definition = defineTool({
    name: resolved.toolName,
    description: DESCRIPTION,
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task. The child sees nothing else.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: activationNotice(value.subagentId, args.description) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${resolved.toolName} requires a calling agent (exec.agent was undefined)`)
      if (ctx.subagents.getProvider(resolved.provider) === undefined) {
        throw new Error(`subagent-codebuddy: provider "${resolved.provider}" is not registered`)
      }
      const activation = await ctx.subagents.startActivation({
        provider: resolved.provider,
        label: args.description,
        request: {
          prompt: [{ type: 'text', text: args.prompt }],
          parent,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      return { kind: 'activation' as const, subagentId: String(activation.childId) }
    },
  })
  const steerDefinition = defineTool({
    name: resolved.steerToolName,
    description: STEER_DESCRIPTION,
    parameters: {
      childId: {
        type: 'string',
        required: true,
        description: 'The child id from the activation notice ("… is RUNNING as <id>").',
      },
      message: {
        type: 'string',
        required: true,
        description: 'What the running child should know. It reads this text alone, with no parent context.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          steered: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: steerNotice(value.childId, {
          steered: value.steered,
          ...(value.reason === undefined ? {} : { reason: value.reason }),
        }),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const run = findLiveRun(args.childId)
      if (run === undefined) {
        const still = liveRunIds()
        throw new Error(
          `${resolved.steerToolName}: no live CodeBuddy run "${args.childId}"`
          + (still.length === 0
            ? ' — it has already finished; its closing message is in this conversation.'
            : `; still running: ${still.join(', ')}`),
        )
      }
      const outcome = await run.steer(args.message)
      return { childId: args.childId, ...outcome }
    },
  })
  ctx.effect(() => {
    const unregisterTask = ctx.tools.register(definition)
    const unregisterSteer = ctx.tools.register(steerDefinition)
    return () => {
      unregisterSteer()
      unregisterTask()
    }
  })
}
