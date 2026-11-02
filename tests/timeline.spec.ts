import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readSteps,
  resetTimelines,
  resolveTranscript,
  stepsForLog,
  summarize,
  transcriptPathOf,
} from '../bin/lib/timeline.mjs'

let dir: string
let transcript: string
let logPath: string

/** One `function_call` line as the CLI writes it: arguments are a JSON string. */
const call = (id: string, name: string, args: Record<string, unknown> | string, ms: number): string => JSON.stringify({
  type: 'function_call',
  callId: id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
  timestamp: ms,
})

const result = (id: string, name: string, status: string, ms: number): string => JSON.stringify({
  type: 'function_call_result',
  callId: id,
  name,
  status,
  timestamp: ms,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codebuddy-timeline-'))
  transcript = join(dir, 'session.jsonl')
  logPath = join(dir, 'run.log')
  writeFileSync(logPath, `# cwd: /tmp/ws\n12:00:00.100 spawn       child process started\n12:00:01.100 transcript  ${transcript}\n`)
  resetTimelines()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetTimelines()
})

describe('finding the transcript', () => {
  it('reads the path the provider recorded in the log', () => {
    expect(transcriptPathOf(logPath)).toBe(transcript)
  })

  it('returns nothing for a log that never got that far', () => {
    const bare = join(dir, 'bare.log')
    writeFileSync(bare, '# cwd: /tmp/ws\n12:00:00.100 spawn       child process started\n')
    expect(transcriptPathOf(bare)).toBe('')
    // And an empty path is not an error: it is a run with no timeline yet.
    expect(readSteps('')).toEqual({ steps: [], total: 0, lastAt: undefined })
  })
})

describe('folding calls into steps', () => {
  it('pairs each call with its result and derives the duration', () => {
    writeFileSync(transcript, [
      call('c1', 'Read', { file_path: '/tmp/a.ts' }, 1_000),
      result('c1', 'Read', 'completed', 1_500),
      call('c2', 'Bash', { command: 'npm test' }, 2_000),
      result('c2', 'Bash', 'failed', 8_000),
      '',
    ].join('\n'))
    const { steps, total, lastAt } = readSteps(transcript)
    expect(total).toBe(2)
    expect(steps).toEqual([
      { id: 'c1', name: 'Read', target: '/tmp/a.ts', state: 'done', at: 1_000, ms: 500 },
      { id: 'c2', name: 'Bash', target: 'npm test', state: 'failed', at: 2_000, ms: 6_000 },
    ])
    expect(lastAt).toBe(2_000)
  })

  it('leaves a call without a result in flight', () => {
    writeFileSync(transcript, `${call('c1', 'Edit', { file_path: '/tmp/a.ts' }, 1_000)}\n`)
    expect(readSteps(transcript).steps).toEqual([
      { id: 'c1', name: 'Edit', target: '/tmp/a.ts', state: 'ongoing', at: 1_000 },
    ])
  })

  it('parses only what was appended, and waits for a whole line', () => {
    const first = `${call('c1', 'Read', { file_path: '/a' }, 1_000)}\n`
    writeFileSync(transcript, first)
    expect(readSteps(transcript).steps).toHaveLength(1)

    // A half-written line must not become a step.
    appendFileSync(transcript, call('c2', 'Read', { file_path: '/b' }, 2_000).slice(0, 30))
    expect(readSteps(transcript).steps).toHaveLength(1)

    // Completing the line does.
    appendFileSync(transcript, `${call('c2', 'Read', { file_path: '/b' }, 2_000).slice(30)}\n`)
    const { steps, total } = readSteps(transcript)
    expect(total).toBe(2)
    expect(steps.map(step => step.target)).toEqual(['/a', '/b'])
  })

  it('skips a malformed line without losing the ones around it', () => {
    writeFileSync(transcript, [
      call('c1', 'Read', { file_path: '/a' }, 1_000),
      '{"type":"function_call",,,',
      call('c2', 'Read', { file_path: '/b' }, 2_000),
      '',
    ].join('\n'))
    expect(readSteps(transcript).steps.map(step => step.id)).toEqual(['c1', 'c2'])
  })

  it('starts over when the file is replaced by a shorter one', () => {
    writeFileSync(transcript, [call('c1', 'Read', { file_path: '/a' }, 1_000), call('c2', 'Read', { file_path: '/b' }, 2_000), ''].join('\n'))
    expect(readSteps(transcript).total).toBe(2)
    writeFileSync(transcript, `${call('c9', 'Read', { file_path: '/z' }, 3_000)}\n`)
    expect(readSteps(transcript).steps.map(step => step.id)).toEqual(['c9'])
  })

  it('keeps the newest rows and still counts the whole run', () => {
    const lines = Array.from({ length: 450 }, (_, index) => call(`c${index}`, 'Read', { file_path: `/${index}` }, index))
    writeFileSync(transcript, [...lines, ''].join('\n'))
    const { steps, total } = readSteps(transcript)
    expect(total).toBe(450)
    expect(steps).toHaveLength(400)
    expect(steps[steps.length - 1]!.id).toBe('c449')
  })
})

describe('naming what a call touched', () => {
  it('prefers the file, then the command, then the pattern', () => {
    expect(summarize('Read', JSON.stringify({ file_path: '/tmp/a.ts' }))).toBe('/tmp/a.ts')
    expect(summarize('Grep', JSON.stringify({ pattern: 'TODO', path: '/src' }))).toBe('/src')
  })

  it('keeps the first line of a command and clips the rest', () => {
    expect(summarize('Bash', JSON.stringify({ command: 'npm test\n--watch' }))).toBe('npm test')
    expect(summarize('Bash', JSON.stringify({ command: 'x'.repeat(200) })).endsWith('…')).toBe(true)
  })

  it('falls back to the raw text when the arguments are not JSON', () => {
    expect(summarize('Bash', 'echo hi')).toBe('echo hi')
    expect(summarize('Bash', JSON.stringify({ nothing: 1 }))).toBe('')
  })
})

describe('the whole path from a run log', () => {
  it('finds the transcript and returns steps plus where they came from', () => {
    writeFileSync(transcript, `${call('c1', 'Read', { file_path: '/a' }, 1_000)}\n`)
    expect(stepsForLog(logPath)).toMatchObject({ transcript, transcriptFound: true, total: 1 })
  })

  it('returns an empty timeline rather than throwing when the file is gone', () => {
    rmSync(transcript, { force: true })
    const result = stepsForLog(logPath, join(dir, 'no-projects'))
    expect(result.steps).toEqual([])
    expect(result.total).toBe(0)
    // And it says so, instead of claiming the run made no calls.
    expect(result.transcriptFound).toBe(false)
    expect(result.transcriptRecorded).toBe(transcript)
  })

  it('finds a transcript the recorded path got wrong', () => {
    // The provider predicted one directory name; the CLI used another — the
    // case for any workspace reached through a symlink (`/tmp` on macOS).
    const root = join(dir, 'projects')
    const actualDir = join(root, 'private-tmp-ws')
    writeFileSync(join(dir, 'wrong.log'), `12:00:01.100 transcript  ${join(root, 'tmp-ws', 'sess-9.jsonl')}\n`)
    mkdirSync(actualDir, { recursive: true })
    const actual = join(actualDir, 'sess-9.jsonl')
    writeFileSync(actual, `${call('c1', 'Bash', { command: 'ls' }, 1_000)}\n`)

    expect(resolveTranscript(join(dir, 'wrong.log'), root)).toEqual({
      path: actual,
      found: true,
      recorded: join(root, 'tmp-ws', 'sess-9.jsonl'),
    })
    expect(stepsForLog(join(dir, 'wrong.log'), root)).toMatchObject({ transcript: actual, transcriptFound: true, total: 1 })
  })

  it('remembers where it looked, so a poll does not rescan', () => {
    const root = join(dir, 'projects')
    writeFileSync(join(dir, 'wrong.log'), `12:00:01.100 transcript  ${join(root, 'x', 'sess-7.jsonl')}\n`)
    expect(resolveTranscript(join(dir, 'wrong.log'), root).found).toBe(false)
    mkdirSync(join(root, 'y'), { recursive: true })
    writeFileSync(join(root, 'y', 'sess-7.jsonl'), '')
    // A miss is re-checked after a short TTL, not on every request; within it,
    // the answer stays "no" rather than scanning a hundred directories a second.
    expect(resolveTranscript(join(dir, 'wrong.log'), root).found).toBe(false)
    resetTimelines()
    expect(resolveTranscript(join(dir, 'wrong.log'), root).found).toBe(true)
  })
})
