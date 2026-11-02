import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'codebuddy-runs.mjs')

let dir: string

/** Run the CLI against the temp log directory, capturing stdout. */
function run(args: readonly string[] = []): string {
  return execFileSync(process.execPath, [CLI, '--dir', dir, ...args], { encoding: 'utf8' })
}

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codebuddy-runs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('codebuddy-runs', () => {
  it('reports an empty directory instead of failing', () => {
    expect(run(['--list'])).toContain('还没有任何运行记录')
  })

  it('separates what is running from what already ended', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(9)} START aaaa1111 cwd=/tmp/ws label="fix the CSP header" prompt="In /tmp/ws, update the CSP header so the page loads."`,
      `${at(8)} END   aaaa1111 stop=completed elapsed=63s output=821 chars`,
      `${at(2)} START cccc2222 cwd=/tmp/ws label="rebuild and deploy test2" prompt="Rebuild every package and deploy the result to the test environment."`,
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cccc2222.alive'), '1')
    writeFileSync(join(dir, 'cccc2222.log'), '20:12:09.010 tool       bash [execute] → in_progress\n')

    const listing = run(['--list'])
    expect(listing).toContain('运行中 1')
    expect(listing).toContain('rebuild and deploy test2')
    expect(listing).toContain('fix the CSP header')
    expect(listing).toContain('已完成')
    // The list is a column of names, not of prompts: a prompt would be clipped
    // mid-sentence and read as a description it is not.
    expect(listing).not.toContain('Rebuild every package')
  })

  it('prints just the number of live runs for scripts', () => {
    writeFileSync(join(dir, 'index.log'), [
      `${at(3)} START aaaa1111 cwd=/w task="a"`,
      `${at(3)} START bbbb2222 cwd=/w task="b"`,
      `${at(30)} START cccc3333 cwd=/w task="c"`,
      `${at(29)} END   cccc3333 stop=completed`,
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'aaaa1111.alive'), '1')
    writeFileSync(join(dir, 'bbbb2222.alive'), '1')
    expect(run(['--count']).trim()).toBe('2')
  })

  it('dumps one run by id prefix, header and log together', () => {
    writeFileSync(join(dir, 'index.log'), `${at(1)} START eeee3333 cwd=/tmp/ws label="probe the build" prompt="probe"\n`)
    writeFileSync(join(dir, 'eeee3333.alive'), '1')
    writeFileSync(join(dir, 'eeee3333.log'), '20:14:00.100 spawn      child process started\n')

    const dumped = run(['eeee'])
    expect(dumped).toContain('eeee3333')
    // Both, because here there is room: what the caller called it, and what the
    // child was actually told.
    expect(dumped).toContain('任务  probe the build')
    expect(dumped).toContain('提示  probe')
    expect(dumped).toContain('spawn      child process started')
  })

  it('shows a run with no label under its prompt', () => {
    writeFileSync(join(dir, 'index.log'), `${at(1)} START eeee3333 cwd=/tmp/ws prompt="probe"\n`)
    writeFileSync(join(dir, 'eeee3333.alive'), '1')
    writeFileSync(join(dir, 'eeee3333.log'), 'spawn\n')

    const dumped = run(['eeee'])
    expect(dumped).toContain('任务  probe')
    // Repeating it as both the label and the prompt would read as two tasks.
    expect(dumped).not.toContain('提示  probe')
  })

  it('rejects an unknown id instead of printing nothing', () => {
    writeFileSync(join(dir, 'index.log'), `${at(1)} START eeee3333 cwd=/tmp/ws task="probe"\n`)
    expect(() => run(['zzzz'])).toThrow()
  })
})
