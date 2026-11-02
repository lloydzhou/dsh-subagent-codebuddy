/**
 * Contract of the run progress log.
 *
 * This file is the only place a human can watch a run while it happens, so the
 * naming rule (a notice's id must lead to its log) and the "logging never
 * breaks the run" property both need pinning.
 *
 * @module progress-log.spec
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codebuddyTranscriptPath,
  disabledRunLog,
  heartbeatPath,
  openRunLog,
  progressLogPath,
  startHeartbeat,
  workspaceSlug,
} from '../src/progress-log.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codebuddy-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('log location', () => {
  it('names the log after the run id the settlement notice carries', () => {
    const dir = tempDir()
    expect(progressLogPath('a3eecc2d-0000-4000-8000-000000000000', dir))
      .toBe(join(dir, 'a3eecc2d-0000-4000-8000-000000000000.log'))
  })

  it('derives the CLI transcript path from the workspace slug and session id', () => {
    const path = codebuddyTranscriptPath('/home/demo/project', 'sess-1')
    expect(path).toBe(join(process.env.HOME ?? '', '.codebuddy', 'projects', 'home-demo-project', 'sess-1.jsonl'))
  })

  it('ignores a trailing slash on the workspace', () => {
    expect(codebuddyTranscriptPath('/tmp/work/', 's'))
      .toBe(codebuddyTranscriptPath('/tmp/work', 's'))
  })

  it('slugifies the resolved workspace, so a symlinked path finds its transcript', () => {
    // `/tmp` is a symlink on macOS, and the CLI writes under the real name:
    // `/tmp/w` becomes `private-tmp-w`, not `tmp-w`. Predicting the unresolved
    // name points at a file that never exists.
    const dir = tempDir()
    const real = join(dir, 'real-workspace')
    mkdirSync(real)
    const link = join(dir, 'link-workspace')
    symlinkSync(real, link)
    expect(workspaceSlug(link)).toBe(workspaceSlug(real))
    // Built from the real path, which on macOS is `/private/var/...` even when
    // the temp dir was handed to us as `/var/...`.
    const resolved = realpathSync(dir)
    expect(workspaceSlug(link)).toBe(`${resolved.split('/').filter(Boolean).join('-')}-real-workspace`)
  })
})

describe('run log', () => {
  it('writes the header and one aligned line per event', () => {
    const dir = tempDir()
    const log = openRunLog('run-1', ['cwd: /tmp'], dir)
    log.line('tool', 'Edit src/a.ts → in_progress')
    log.line('done', 'stop=completed elapsed=1.2s')
    log.close()

    const text = readFileSync(progressLogPath('run-1', dir), 'utf8')
    expect(text).toContain('# cwd: /tmp')
    expect(text).toMatch(/\d\d:\d\d:\d\d\.\d\d\d tool +Edit src\/a\.ts → in_progress/)
    expect(text).toContain('stop=completed')
  })

  it('folds newlines so one event cannot break the one-line format', () => {
    const dir = tempDir()
    const log = openRunLog('run-2', [], dir)
    log.line('failed', 'line one\nline two')
    log.close()

    const lines = readFileSync(progressLogPath('run-2', dir), 'utf8').trimEnd().split('\n')
    const event = lines[lines.length - 1]!
    expect(event).toContain('line one line two')
    expect(event.split('\n')).toHaveLength(1)
  })

  it('appends across reopens, so a resumed run keeps its history', () => {
    const dir = tempDir()
    openRunLog('run-3', [], dir).close()
    openRunLog('run-3', [], dir).line('tool', 'Bash → completed')
    const text = readFileSync(progressLogPath('run-3', dir), 'utf8')
    expect(text).toContain('Bash → completed')
    expect(text.match(/# run run-3 started/g)).toHaveLength(2)
  })

  it('discards silently when the directory cannot be created', () => {
    const log = openRunLog('run-4', [], '/dev/null/nope')
    expect(() => { log.line('tool', 'x'); log.close() }).not.toThrow()
  })

  it('offers a no-op sink for runs that opted out', () => {
    expect(() => { disabledRunLog().line('tool', 'x'); disabledRunLog().close() }).not.toThrow()
  })

  it('beats while a run is live and clears the beacon when it stops', () => {
    const dir = tempDir()
    const beat = startHeartbeat('run-5', dir)
    // The beacon is what lets a viewer tell a running child from one that was
    // killed, so it must exist immediately, not after the first interval.
    expect(existsSync(heartbeatPath('run-5', dir))).toBe(true)
    beat.stop()
    expect(existsSync(heartbeatPath('run-5', dir))).toBe(false)
    expect(() => { beat.stop() }).not.toThrow()
  })
})
