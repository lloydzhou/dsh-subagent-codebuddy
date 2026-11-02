/**
 * The conversation-node contract, driven offline.
 *
 * These cases exist because the card silently never appeared: the definition
 * has to match the exact event shapes the session log writes, produce a view
 * node the assembler accepts (`key` must equal the context key, `target` must
 * be the target being built), and switch state on the settlement notice rather
 * than guessing from the tool result.
 */

import { describe, expect, it } from 'vitest'
import {
  CODEBUDDY_NODE_KIND,
  codebuddyRunDefinition as definition,
  readAddressedChild,
  readPrompt,
  readResultCallId,
  readSettledChild,
  readSettledText,
  readSteerText,
  readTask,
  splitUsage,
} from '../src/client/definition.ts'

const CALL_ID = 'call_00_codebuddy'

/** One `tool/call` event, shaped exactly as the session log writes it. */
function callEvent(name = 'subagent_codebuddy', callId = CALL_ID, seq = 32) {
  return {
    type: 'tool/call',
    seq,
    time: 1_000,
    data: {
      turn: 1,
      step: 2,
      callId,
      name,
      arguments: JSON.stringify({ description: '迁移构建脚本', prompt: '把 webpack 换成 esbuild' }),
    },
  }
}

/** One `tool/result` event carrying the activation notice the tool renders. */
function resultEvent(text: string, callId = CALL_ID, seq = 33, extra: Record<string, unknown> = {}) {
  return {
    type: 'tool/result',
    seq,
    time: 1_500,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 2,
      message: {
        id: 'msg_1',
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
      },
      ...extra,
    },
  }
}

/** The runtime's settlement notice: an ordinary user message with a tagged source. */
function settledEvent(childId: string, seq = 60) {
  return {
    type: 'user/message',
    seq,
    time: 90_000,
    surfaceOp: 'append',
    data: {
      id: 'msg_2',
      role: 'user',
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent finished.', senderSessionId: childId },
      content: [
        { type: 'text', text: `Background subagent ${childId} finished.` },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '构建脚本已迁移，测试全绿。' },
      ],
    },
  }
}

/** The match object the assembler hands each callback. */
function asMatch(event: object, role: 'start' | 'update') {
  return { event: event as { type: string; seq: number; time: number; data?: unknown }, role, location: { kind: 'unresolved' } }
}

const ACTIVATION = `subagent_codebuddy is RUNNING as child_abc123 (迁移构建脚本).
The CodeBuddy child already has the task; this call returned when the child started, not when it finished.`

describe('conversation definition matching', () => {
  it('starts on a codebuddy tool call and keeps the call id', () => {
    expect(definition.match(callEvent())).toEqual({ id: CALL_ID, role: 'start' })
  })

  it('ignores tool calls from other tools', () => {
    expect(definition.match(callEvent('read'))).toBeNull()
    expect(definition.match(callEvent('bash'))).toBeNull()
  })

  it('ignores a result whose call this definition never started', () => {
    // Without the started-set guard the registry would keep a start-less
    // context for every tool call in the session.
    const event = resultEvent(ACTIVATION, 'call_other')
    expect(definition.match(event)).toBeNull()
  })

  it('ignores a replacement copy of a result', () => {
    definition.match(callEvent())
    const event = { ...resultEvent(ACTIVATION), surfaceOp: 'update' }
    expect(definition.match(event)).toBeNull()
  })

  it('reads the call id from either carrier', () => {
    expect(readResultCallId({ message: { toolCallId: 'a' } })).toBe('a')
    expect(readResultCallId({ message: { source: { kind: 'tool', callId: 'b' } } })).toBe('b')
    expect(readResultCallId({})).toBeUndefined()
  })

  it('ignores user messages that are not settlement notices', () => {
    const plain = { type: 'user/message', seq: 61, time: 1, data: { content: [], source: { kind: 'user' } } }
    expect(definition.match(plain)).toBeNull()
  })
})

/** One `tool/call` for a steering tool: the delegation shape, but it names a child. */
function steerCallEvent(childId: string, callId: string, seq: number) {
  return {
    type: 'tool/call',
    seq,
    time: 40_000,
    data: {
      turn: 1,
      step: 3,
      callId,
      name: 'codebuddy_steer',
      arguments: JSON.stringify({ childId, message: 'also update the docs' }),
    },
  }
}

/**
 * Run the delegation up to the activation notice and return the live state.
 *
 * The activation notice is what teaches the page that a child belongs to a
 * card, so every steering case has to go through it.
 */
function activatedRun(base: string, child: string) {
  const call = callEvent('subagent_codebuddy', base, 300)
  definition.match(call)
  let state = definition.start({}, asMatch(call, 'start'))
  const activation = resultEvent(`subagent_codebuddy is RUNNING as ${child} (probe).`, base, 301)
  definition.match(activation)
  state = definition.update({ state }, asMatch(activation, 'update'))
  return { call, base, child, state }
}

describe('steering a live run', () => {
  it('does not open a card for a call that addresses an existing child', () => {
    // The bug this pins: `codebuddy_steer` matched the /codebuddy/ name pattern
    // and got a second card of its own, frozen at 后台运行中 forever, next to the
    // run it was only sending a message to.
    const { base, child } = activatedRun('call_steer_a', 'child_steer_a')
    expect(definition.match(steerCallEvent(child, 'call_steer_a_msg', 302))).toEqual({ id: base, role: 'update' })
  })

  it('ignores a steering call for a run this page never saw', () => {
    // Nothing to fold it into; the ordinary tool row still reports the call.
    expect(definition.match(steerCallEvent('child_never_seen', 'call_steer_b_msg', 310))).toBeNull()
  })

  it('records the message on the run it was sent to, without ending it', () => {
    const { call, base, child, state: activated } = activatedRun('call_steer_c', 'child_steer_c')
    const steer = steerCallEvent(child, 'call_steer_c_msg', 302)
    const state = definition.update({ state: activated }, asMatch(steer, 'update'))
    const node = definition.buildViewNode({
      key: `codebuddy-run:${base}`,
      id: base,
      start: { event: call, location: { kind: 'unresolved' } },
      state,
    })
    expect(node?.data.steers).toEqual([{ message: 'also update the docs', at: 40_000 }])
    // A steer is a message, not a result: the run is still out there.
    expect(node?.data.status).toBe('delegated')
  })

  it('ignores the steering call’s own result', () => {
    const { base, child } = activatedRun('call_steer_d', 'child_steer_d')
    const steer = steerCallEvent(child, 'call_steer_d_msg', 302)
    definition.match(steer)
    const result = resultEvent('Message delivered to child_steer_d; the child reads it at its next step boundary.', 'call_steer_d_msg', 303)
    expect(definition.match(result)).toBeNull()
    expect(base).toBe('call_steer_d')
  })

  it('reads the addressed child and the message out of a steering call', () => {
    expect(readAddressedChild(JSON.stringify({ childId: 'c1', message: 'go' }))).toBe('c1')
    expect(readAddressedChild(JSON.stringify({ description: 'x', prompt: 'y' }))).toBeUndefined()
    expect(readSteerText(JSON.stringify({ childId: 'c1', message: ' also update the docs ' }))).toBe('also update the docs')
    expect(readSteerText(JSON.stringify({ childId: 'c1' }))).toBeUndefined()
  })
})

describe('conversation node lifecycle', () => {
  it('reports a running card before the tool result lands', () => {
    const call = callEvent('subagent_codebuddy', 'call_life_1', 100)
    const matched = definition.match(call)
    expect(matched).toEqual({ id: 'call_life_1', role: 'start' })

    const state = definition.start({}, asMatch(call, 'start'))
    expect(state.task).toBe('迁移构建脚本')
    // The label titles the card; the prompt is what the run was asked to do.
    expect(state.prompt).toBe('把 webpack 换成 esbuild')

    const node = definition.buildViewNode({
      key: `codebuddy-run:call_life_1`,
      id: 'call_life_1',
      start: { event: call, location: { kind: 'unresolved' } },
      state,
    })
    expect(node?.data.status).toBe('running')
    expect(node?.kind).toBe(CODEBUDDY_NODE_KIND)
    expect(node?.target).toBe('chat')
    // The assembler throws unless the node repeats the context key verbatim.
    expect(node?.key).toBe('codebuddy-run:call_life_1')
    // Sits just after the built-in tool-call row for the same event.
    expect(node?.anchorSeq).toBe(100.1)
  })

  it('turns into a handed-off card on the activation notice, then into a finished one', () => {
    const call = callEvent('subagent_codebuddy', 'call_life_2', 200)
    definition.match(call)
    const start = { event: call, location: { kind: 'unresolved' } }
    let state = definition.start({}, asMatch(call, 'start'))

    const result = resultEvent(ACTIVATION, 'call_life_2', 201)
    expect(definition.match(result)).toEqual({ id: 'call_life_2', role: 'update' })
    state = definition.update({ state }, asMatch(result, 'update'))

    const context = { key: 'codebuddy-run:call_life_2', id: 'call_life_2', start, state }
    let node = definition.buildViewNode(context)
    expect(node?.data.status).toBe('delegated')
    expect(node?.data.childId).toBe('child_abc123')
    expect(node?.data.output).toBe('')

    // The child reports back on its own; the same card has to follow it.
    const settled = settledEvent('child_abc123', 260)
    expect(readSettledChild(settled.data)).toBe('child_abc123')
    expect(definition.match(settled)).toEqual({ id: 'call_life_2', role: 'update' })

    state = definition.update({ state }, asMatch(settled, 'update'))
    node = definition.buildViewNode({ ...context, state })
    expect(node?.data.status).toBe('done')
    expect(node?.data.output).toContain('构建脚本已迁移')
    // Appended, not substituted: the task survives its own result, so a
    // finished card can still answer "what was this run asked to do?".
    expect(node?.data.prompt).toBe('把 webpack 换成 esbuild')
    // The anchor never moves: the card keeps the position of its call.
    expect(node?.anchorSeq).toBe(200.1)
  })

  it('never links a notice whose child this definition did not start', () => {
    expect(definition.match(settledEvent('child_someone_else', 300))).toBeNull()
  })

  it('reports a failed run with its error body', () => {
    const call = callEvent('subagent_codebuddy', 'call_life_3', 400)
    definition.match(call)
    let state = definition.start({}, asMatch(call, 'start'))
    const result = resultEvent('- [failed] session/new 返回 401', 'call_life_3', 401, {})
    result.data.message = { ...result.data.message, isError: true }
    state = definition.update({ state }, asMatch(result, 'update'))

    const node = definition.buildViewNode({
      key: 'codebuddy-run:call_life_3',
      id: 'call_life_3',
      start: { event: call, location: { kind: 'unresolved' } },
      state,
    })
    expect(node?.data.status).toBe('failed')
    expect(node?.data.output).toContain('401')
    expect(node?.data.steps).toEqual([{ label: 'session/new 返回 401', status: 'failed' }])
  })

  it('hides a context that never saw its start event', () => {
    expect(definition.buildViewNode({ key: 'k', id: 'i', state: { task: '', startedAt: 0 } })).toBeNull()
  })

  it('reads the settlement text as plain text', () => {
    expect(readSettledText(settledEvent('child_abc123').data)).toBe(
      'Background subagent child_abc123 finished.\nIts closing message:\n构建脚本已迁移，测试全绿。',
    )
  })

  it('lifts the CLI usage line out of the body and into the data', () => {
    const settled = settledEvent('child_abc123', 261)
    settled.data.content = [
      { type: 'text', text: 'Background subagent child_abc123 finished.' },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'pong\n\n用量 0.01 credit · 1 次调用（输入 181 / 输出 3 / 缓存 23.9k）' },
    ]
    const call = callEvent('subagent_codebuddy', 'call_usage_1', 500)
    definition.match(call)
    definition.match(resultEvent(`subagent_codebuddy is RUNNING as child_abc123 (ping).`, 'call_usage_1', 501))
    const state = definition.update(
      { state: definition.start({}, asMatch(call, 'start')) },
      asMatch(settled, 'update'),
    )
    const node = definition.buildViewNode({
      key: 'codebuddy-run:call_usage_1',
      id: 'call_usage_1',
      start: { event: call, location: { kind: 'unresolved' } },
      state,
    })
    // The numbers belong in the header, so they must not appear in the body.
    expect(node?.data.output).toBe('pong')
    expect(node?.data.usage).toEqual({
      credit: '0.01',
      calls: '1',
      input: '181',
      output: '3',
      cached: '23.9k',
    })
  })
})

describe('the task text', () => {
  it('keeps the short label and the full prompt apart', () => {
    // The bug this pins: the card titled itself with the label and printed
    // nothing else, so a reader could not tell what the run had been asked.
    const args = JSON.stringify({
      description: 'review the index parser',
      prompt: 'Check how label="x" is read out of index.log, and report the gaps.',
    })
    expect(readTask(args)).toBe('review the index parser')
    expect(readPrompt(args)).toBe('Check how label="x" is read out of index.log, and report the gaps.')
  })

  it('falls back to whichever field the call carries', () => {
    expect(readPrompt(JSON.stringify({ description: 'only a label' }))).toBe('only a label')
    expect(readTask(JSON.stringify({ prompt: 'only a prompt' }))).toBe('only a prompt')
    // A bare argument string is the task itself when there are no keys.
    expect(readPrompt('raw task text')).toBe('raw task text')
    expect(readPrompt(JSON.stringify({ cwd: '/w' }))).toBe('')
  })

  it('trims a padded prompt so it does not start with a blank block', () => {
    expect(readPrompt(JSON.stringify({ prompt: '\n  do the thing  \n' }))).toBe('do the thing')
  })
})

describe('usage line parsing', () => {
  it('parses the Chinese line and keeps the body', () => {
    const out = splitUsage('pong\n\n用量 0.01 credit · 1 次调用（输入 181 / 输出 3 / 缓存 23.9k）')
    expect(out.text).toBe('pong')
    expect(out.usage).toEqual({ credit: '0.01', calls: '1', input: '181', output: '3', cached: '23.9k' })
  })

  it('parses the English line', () => {
    const out = splitUsage('Usage: 0.02 credits · 2 calls (input 400 / output 20 / cached 12k)')
    expect(out.text).toBe('')
    expect(out.usage).toEqual({ credit: '0.02', calls: '2', input: '400', output: '20', cached: '12k' })
  })

  it('keeps a line that mentions a credit but reports no call count', () => {
    const prose = '这次预算是 1 credit，不属于用量行。'
    expect(splitUsage(prose)).toEqual({ text: prose })
  })

  it('reports no usage when there is none', () => {
    expect(splitUsage('构建脚本已迁移，测试全绿。').usage).toBeUndefined()
  })
})

describe('settlement endings', () => {
  /** Run one call through handoff and then settle it with a stated summary. */
  function settleWith(summary: string, callId: string, seq: number, closing = '收尾正文') {
    const call = callEvent('subagent_codebuddy', callId, seq)
    definition.match(call)
    const start = { event: call, location: { kind: 'unresolved' } }
    let state = definition.start({}, asMatch(call, 'start'))
    const activation = `subagent_codebuddy is RUNNING as child_${callId} (probe).`
    const result = resultEvent(activation, callId, seq + 1)
    definition.match(result)
    state = definition.update({ state }, asMatch(result, 'update'))
    const notice = {
      type: 'user/message',
      seq: seq + 10,
      time: 90_000,
      surfaceOp: 'append',
      data: {
        id: 'msg',
        role: 'user',
        source: { kind: 'subagent-settled', form: 'notice', senderSessionId: `child_${callId}` },
        content: [{ type: 'text', text: summary }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing }],
      },
    }
    state = definition.update({ state }, asMatch(notice, 'update'))
    return definition.buildViewNode({ key: `codebuddy-run:${callId}`, id: callId, start, state })
  }

  it('reports a stopped child as stopped, not as finished', () => {
    const node = settleWith('Background subagent child_x was stopped before it finished.', 'call_end_1', 700)
    expect(node?.data.status).toBe('stopped')
    // The only explanation of *why* stays in the body for every non-completed ending.
    expect(node?.data.output).toContain('was stopped')
    expect(node?.data.output).toContain('收尾正文')
  })

  it('reports a refusal as refused', () => {
    const node = settleWith('Background subagent child_x declined the task.', 'call_end_2', 720)
    expect(node?.data.status).toBe('refused')
  })

  it('reports an error ending as failed and keeps the diagnostic', () => {
    const node = settleWith(
      'Background subagent child_x failed before it finished.\nsubagent-codebuddy: child run failed: 401',
      'call_end_3', 740,
    )
    expect(node?.data.status).toBe('failed')
    expect(node?.data.output).toContain('401')
  })

  it('reports an unrecognised ending as failed rather than as success', () => {
    const node = settleWith('Background subagent child_x ended abnormally (weird) before it finished.', 'call_end_4', 760)
    expect(node?.data.status).toBe('failed')
  })

  it('keeps the plain finished summary out of the body', () => {
    const node = settleWith('Background subagent child_x finished. It cannot receive follow-up messages.', 'call_end_5', 780)
    expect(node?.data.status).toBe('done')
    expect(node?.data.output).toBe('收尾正文')
  })
})
