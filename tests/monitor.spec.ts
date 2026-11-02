import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clip,
  displayWidth,
  heartbeatPath,
  pad,
  readEntries,
  readRuns,
  readTail,
  renderList,
  runLogPath,
  sortEntries,
  statusOf,
  summarize,
  summaryLine,
} from '../bin/lib/monitor.mjs'

let dir: string

/** ISO stamp offset from now, matching the index format the provider writes. */
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

/** Write a beacon or log whose mtime is `ageMs` old. */
function touch(path: string, ageMs: number, body = ''): void {
  writeFileSync(path, body)
  const stamp = new Date(Date.now() - ageMs)
  utimesSync(path, stamp, stamp)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codebuddy-monitor-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readRuns', () => {
  it('reports nothing for a directory with no index', () => {
    expect(readRuns(dir)).toEqual([])
  })

  it('parses starts, terminals and ignores a half-written line', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(5)} START aaaa1111 cwd=/w task="fix the header"`,
      `${at(4)} END   aaaa1111 stop=completed elapsed=63s output=821 chars`,
      `${at(1)} START bbbb2222 cwd=/w task="deploy"`,
      `${at(0)} STAR`,
      '',
    ].join('\n'))
    const runs = readRuns(dir)
    expect(runs).toHaveLength(2)
    // `task=` is what older builds wrote for the prompt head; it still reads.
    expect(runs[0]).toMatchObject({ id: 'aaaa1111', kind: 'END', prompt: 'fix the header', cwd: '/w' })
    expect(runs[1]).toMatchObject({ id: 'bbbb2222', kind: 'START' })
  })

  it('keeps the caller label apart from the prompt it labels', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(4)} START aaaa1111 cwd=/w label="fix the CSP header" prompt="In repo /w, update the CSP header so that the page loads."`,
      '',
    ].join('\n'))
    const [run] = readRuns(dir)
    expect(run).toMatchObject({ label: 'fix the CSP header', prompt: 'In repo /w, update the CSP header so that the page loads.' })
    expect(readEntries(dir, Date.now())[0]!.title).toBe('fix the CSP header')
  })

  it('reads a field whose value contains quotes', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(4)} START aaaa1111 cwd=/w label="say \\"hi\\"" prompt="quote \\"this\\" and \\\\ that"`,
      '',
    ].join('\n'))
    const [run] = readRuns(dir)
    expect(run).toMatchObject({ label: 'say "hi"', prompt: 'quote "this" and \\ that' })
  })

  it('does not mistake a field quoted inside the prompt for the field itself', () => {
    // A delegated task about this very index format quotes `label="…"`; a
    // per-key search would report that fragment as the run's label.
    writeFileSync(join(dir, 'index.log'), [
      `${at(4)} START aaaa1111 cwd=/w prompt="Explain how label=\\"x\\" is parsed from index.log"`,
      '',
    ].join('\n'))
    const [run] = readRuns(dir)
    expect(run).toMatchObject({ label: '', prompt: 'Explain how label="x" is parsed from index.log' })
  })

  it('reads a truncated final field instead of dropping the line', () => {
    writeFileSync(join(dir, 'index.log'), `${at(4)} START aaaa1111 cwd=/w label="short" prompt="a prompt that never got its closing quote\n`)
    const [run] = readRuns(dir)
    expect(run).toMatchObject({ label: 'short' })
    expect(run!.prompt).toContain('never got its closing quote')
  })

  it('falls back to the prompt head when no label was supplied', () => {
    writeFileSync(join(dir, 'index.log'), `${at(4)} START aaaa1111 cwd=/w prompt="do the thing"\n`)
    expect(readEntries(dir, Date.now())[0]!.title).toBe('do the thing')
  })
})

describe('statusOf', () => {
  it('calls a START with a fresh beacon running', () => {
    writeFileSync(join(dir, 'index.log'), `${at(3)} START live0001 cwd=/w task="t"\n`)
    touch(heartbeatPath(dir, 'live0001'), 2_000, '1')
    expect(statusOf(readRuns(dir)[0]!, dir, Date.now()).state).toBe('running')
  })

  it('calls a START with a quiet beacon lost — the hard-kill case', () => {
    writeFileSync(join(dir, 'index.log'), `${at(9)} START dead0001 cwd=/w task="t"\n`)
    touch(heartbeatPath(dir, 'dead0001'), 5 * 60_000, '1')
    touch(runLogPath(dir, 'dead0001'), 5 * 60_000, 'line\n')
    expect(statusOf(readRuns(dir)[0]!, dir, Date.now()).state).toBe('lost')
  })

  it('calls a quiet log with no beacon unknown rather than guessing', () => {
    writeFileSync(join(dir, 'index.log'), `${at(30)} START old00001 cwd=/w task="t"\n`)
    touch(runLogPath(dir, 'old00001'), 10 * 60_000, 'line\n')
    expect(statusOf(readRuns(dir)[0]!, dir, Date.now()).state).toBe('unknown')
  })

  it('treats a fresh log as alive even without a beacon', () => {
    writeFileSync(join(dir, 'index.log'), `${at(2)} START busy0001 cwd=/w task="t"\n`)
    touch(runLogPath(dir, 'busy0001'), 1_000, 'line\n')
    expect(statusOf(readRuns(dir)[0]!, dir, Date.now()).state).toBe('running')
  })

  it('maps terminal lines to their states', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(9)} START fff00001 cwd=/w task="t"`,
      `${at(8)} FAIL  fff00001 boom`,
      `${at(7)} START ccc00001 cwd=/w task="t"`,
      `${at(6)} CANCEL ccc00001 before start`,
      `${at(5)} START ddd00001 cwd=/w task="t"`,
      `${at(4)} END   ddd00001 stop=completed`,
      '',
    ].join('\n'))
    const states = readRuns(dir).map((run) => statusOf(run, dir, Date.now()).state)
    expect(states).toEqual(['failed', 'cancelled', 'done'])
  })
})

describe('sorting and counting', () => {
  it('puts active runs first, then newest first', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(60)} START done0001 cwd=/w task="old done"`,
      `${at(59)} END   done0001 stop=completed`,
      `${at(40)} START done0002 cwd=/w task="newer done"`,
      `${at(39)} END   done0002 stop=completed`,
      `${at(5)} START liveR001 cwd=/w task="active"`,
      '',
    ].join('\n'))
    touch(heartbeatPath(dir, 'liveR001'), 1_000, '1')
    const entries = readEntries(dir, Date.now())
    expect(entries.map((entry) => entry.title)).toEqual(['active', 'newer done', 'old done'])
  })

  it('counts each state', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(20)} START liveA001 cwd=/w task="a"`,
      `${at(20)} START deadB001 cwd=/w task="b"`,
      `${at(20)} START oldC0001 cwd=/w task="c"`,
      `${at(30)} START doneD001 cwd=/w task="d"`,
      `${at(29)} END   doneD001 stop=completed`,
      '',
    ].join('\n'))
    writeFileSync(heartbeatPath(dir, 'liveA001'), '1')
    touch(heartbeatPath(dir, 'deadB001'), 5 * 60_000, '1')
    const summary = summarize(readEntries(dir, Date.now()))
    expect(summary).toMatchObject({ running: 1, lost: 1, unknown: 1, done: 1, total: 4 })
    expect(summaryLine(summary)).toBe('运行中 1 · 未知 1 · 失联 1 · 共 4')
  })

  it('sorts without mutating the input', () => {
    const entries = readEntries(dir, Date.now())
    const copy = [...entries]
    sortEntries(entries)
    expect(entries).toEqual(copy)
  })
})

describe('rendering', () => {
  it('measures CJK as two cells and pads accordingly', () => {
    expect(displayWidth('运行中')).toBe(6)
    expect(displayWidth('abc')).toBe(3)
    expect(pad('运行中', 8)).toBe('运行中  ')
    expect(pad('abc', 6)).toBe('abc   ')
  })

  it('clips with an ellipsis without splitting a wide character', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('运行中运行中', 5)).toBe('运行…')
    expect(displayWidth(clip('运行中运行中', 5))).toBeLessThanOrEqual(5)
  })

  it('marks the selected run and clips long tasks', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(9)} START aaaa0001 cwd=/w task="short one"`,
      `${at(9)} END   aaaa0001 stop=completed`,
      `${at(8)} START bbbb0002 cwd=/w task="${'很长的任务描述'.repeat(10)}"`,
      `${at(7)} END   bbbb0002 stop=completed`,
      '',
    ].join('\n'))
    const entries = readEntries(dir, Date.now())
    const lines = renderList(entries, { width: 60, selectedId: entries[0]!.id })
    expect(lines[0]!.startsWith('▸')).toBe(true)
    expect(lines[1]!.startsWith(' ')).toBe(true)
    expect(displayWidth(lines[1]!)).toBeLessThanOrEqual(60)
  })

  it('says so when there is nothing to show', () => {
    expect(renderList([], { width: 60 })[0]).toContain('还没有任何运行记录')
  })
})

describe('readTail', () => {
  it('returns the last lines, ignoring the trailing newline', () => {
    writeFileSync(join(dir, 'x.log'), 'a\nb\nc\n')
    expect(readTail(join(dir, 'x.log'), 2)).toEqual(['b', 'c'])
    expect(readTail(join(dir, 'missing.log'), 2)).toEqual([])
  })
})
