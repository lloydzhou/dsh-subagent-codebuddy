/**
 * Scripted ACP child used by the keyless suite: speaks just enough of the
 * protocol for one scripted run. The scenario arrives on argv as
 * `--scenario <name>`; every frame is line-delimited JSON on stdio.
 *
 * Scenarios:
 * - `pong` (default): answer the task with "pong".
 * - `permission`: ask permission first, then answer.
 * - `refusal`: answer with a `refusal` stop reason.
 * - `whole-message`: emit one whole `agent_message` update, no chunks.
 * - `tools`: stream tool_call / tool_call_update / plan updates, then answer.
 * - `steer`: hold the prompt open until a `session/steer` arrives, then answer
 *   with what the steer carried — the only way to prove mid-run delivery.
 * - `steer-reject`: same hold, but answer `{steered:false}` — the child's own
 *   "not injectable" refusal, which the provider must report and not retry.
 * - `silent`: finish with no assistant text, but explain itself on stderr.
 * - `crash`: die mid-prompt without answering, leaving a stderr line behind —
 *   the provider must settle the run as an error instead of waiting forever.
 * - `auth`: advertise auth methods and reject `session/new` as unauthenticated.
 * - `auth-ok`: advertise auth methods, accept `authenticate`, then answer.
 * - `hang`: never answer `initialize`, so a startup deadline must fire.
 *
 * @module mock-acp-child
 */

import { createInterface } from 'node:readline'

const scenario = process.argv[process.argv.indexOf('--scenario') + 1] ?? 'pong'
const pending = new Map()

// Steering: the `steer` scenario keeps its prompt open until a `session/steer`
// frame arrives, so the suite can prove the message reached a *running* turn.
const steered = []
let releaseSteer = () => {}
const steerGate = new Promise((resolve) => { releaseSteer = resolve })
// Never let a missing steer hang the suite: answer anyway after a short wait.
setTimeout(() => { releaseSteer() }, 5_000).unref?.()

const AUTH_METHODS = [
  { id: 'wechat', name: 'WeChat' },
  { id: 'sso', name: 'Enterprise SSO' },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function complain(text) {
  process.stderr.write(`${text}\n`)
}

function serverRequest(method, params) {
  const id = `srv_${pending.size}`
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve) => { pending.set(id, resolve) })
}

const rl = createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))

rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialized') return
  if (message.method === 'session/cancel') process.exit(0)
  const resolver = pending.get(String(message.id))
  if (resolver !== undefined) {
    pending.delete(String(message.id))
    resolver(message)
    return
  }
  if (message.method === 'initialize') {
    if (scenario === 'hang') return
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: {},
      ...scenario === 'auth' || scenario === 'auth-ok' ? { authMethods: AUTH_METHODS } : {},
    })
  } else if (message.method === 'authenticate') {
    if (message.params?.methodId === 'wechat') reply(message.id, {})
    else fail(message.id, -32602, `unknown auth method: ${String(message.params?.methodId)}`)
  } else if (message.method === 'session/new') {
    if (scenario === 'auth') {
      complain('error: not logged in. Run `codebuddy` and complete the login flow.')
      fail(message.id, -32000, 'Authentication required')
    } else {
      reply(message.id, { sessionId: 'mock-session' })
    }
  } else if (message.method === 'session/prompt') {
    void answerPrompt(message)
  } else if (message.method === 'session/steer') {
    const blocks = message.params?.contentBlocks
    const holding = scenario === 'steer' || scenario === 'steer-reject'
    const accepted = scenario === 'steer' && Array.isArray(blocks) && blocks.length > 0
    if (accepted) steered.push(blocks)
    // `{steered:false}` is the CLI's own "not injectable / not running" answer.
    reply(message.id, accepted ? { steered: true } : { steered: false, reason: holding ? 'content not injectable' : 'no turn in flight' })
    if (holding) releaseSteer()
  } else if (message.id !== undefined) {
    reply(message.id, {})
  }
})

async function answerPrompt(message) {
  if (scenario === 'permission') {
    const answer = await serverRequest('session/request_permission', {
      sessionId: 'mock-session',
      options: [
        { optionId: 'allow-always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    })
    // Exercise the extension-notification path: the provider must drop this
    // silently instead of failing the wire.
    send({ jsonrpc: '2.0', method: '_codebuddy.ai/command', params: { answered: answer } })
    const outcome = answer?.result?.outcome
    if (outcome?.optionId !== 'allow-once') {
      complain(`permission answer was ${JSON.stringify(outcome)}, expected the least-privilege selection`)
      reply(message.id, { stopReason: 'refusal' })
      return
    }
  }
  if (scenario === 'crash') {
    // A child that dies while the task is in flight: no JSON-RPC answer ever
    // leaves, so the parent's only evidence is the closed pipe and this line.
    complain('fatal: out of memory while applying the patch')
    process.exit(9)
  }
  if (scenario === 'silent') {
    complain('warning: model returned an empty assistant message')
    reply(message.id, { stopReason: 'end_turn' })
    return
  }
  if (scenario === 'whole-message') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-session',
        update: { sessionUpdate: 'agent_message', content: { type: 'text', text: 'pong' } },
      },
    })
    reply(message.id, { stopReason: 'end_turn' })
    return
  }
  if (scenario === 'steer' || scenario === 'steer-reject') {
    await steerGate
    const text = (steered.at(-1) ?? []).map((block) => block.text ?? '').join(' ')
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steered: ${text}` } },
      },
    })
    reply(message.id, { stopReason: 'end_turn' })
    return
  }
  if (scenario === 'tools') {
    // Shaped like the updates a real child streams, so the progress log can be
    // asserted against what it actually receives.
    for (const update of [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Edit src/a.ts', kind: 'edit', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' },
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'read the file', status: 'completed' },
          { content: 'patch it', status: 'in_progress' },
        ],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
      // One call that fails: the only kind of tool event the run log keeps,
      // because it is the only one the transcript would not already show.
      { sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'Bash npm test', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'failed' },
    ]) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update } })
    }
  }
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'mock-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
    },
  })
  reply(message.id, { stopReason: scenario === 'refusal' ? 'refusal' : 'end_turn' })
}
