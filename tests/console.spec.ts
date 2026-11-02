import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startConsole } from '../bin/lib/server.mjs'

let dir: string
let running: Awaited<ReturnType<typeof startConsole>>

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

/** One `function_call` line, shaped the way the CLI writes it. */
const call = (id: string, name: string, args: Record<string, unknown>, ms: number): string => JSON.stringify({
  type: 'function_call',
  id: `event-${id}`,
  callId: id,
  name,
  arguments: JSON.stringify(args),
  timestamp: ms,
})

/** The matching result, keyed by the same `callId` — that is the join. */
const result = (id: string, name: string, status: string, ms: number): string => JSON.stringify({
  type: 'function_call_result',
  id: `result-${id}`,
  callId: id,
  name,
  status,
  timestamp: ms,
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codebuddy-console-'))
  writeFileSync(join(dir, 'index.log'), [
    `${at(6)} START aaaa1111-0000 cwd=/tmp/ws label="fix the CSP header" prompt="In /tmp/ws, update the CSP header so the page loads again."`,
    `${at(5)} END   aaaa1111-0000 stop=completed elapsed=63s output=821 chars`,
    `${at(2)} START bbbb2222-0000 cwd=/tmp/ws label="rebuild and deploy" prompt="Rebuild the site and deploy it to staging."`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'bbbb2222-0000.alive'), '1')
  const transcript = join(dir, 'bbbb2222-0000.jsonl')
  writeFileSync(transcript, [
    call('c1', 'Read', { file_path: '/tmp/ws/src/a.ts' }, 1_000),
    result('c1', 'Read', 'completed', 1_400),
    call('c2', 'Bash', { command: 'npm test\n--watch' }, 2_000),
    result('c2', 'Bash', 'failed', 9_000),
    '',
  ].join('\n'))
  // The log is the spine now: lifecycle, plus a pointer to the transcript.
  writeFileSync(join(dir, 'bbbb2222-0000.log'), [
    '# cwd: /tmp/ws',
    '20:12:00.000 spawn       child process started',
    `20:12:01.000 transcript  ${transcript}`,
    '20:12:09.000 tool        Bash npm test [execute] → failed 7.0s',
    '',
  ].join('\n'))
  running = await startConsole({ dir, port: 0 })
})

afterEach(async () => {
  await running.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('console server', () => {
  it('serves the page', async () => {
    const response = await fetch(running.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('CodeBuddy 子代理')
    expect(html).toContain('/api/runs')
  })

  it('reports the run list with live state and counts', async () => {
    const body = await (await fetch(`${running.url}api/runs`)).json() as {
      summary: { running: number; done: number; total: number }
      runs: { id: string; state: string; title: string; prompt: string }[]
    }
    expect(body.summary).toMatchObject({ running: 1, done: 1, total: 2 })
    // The row title is the caller's label; the prompt is detail, not the column.
    expect(body.runs[0]).toMatchObject({ id: 'bbbb2222-0000', state: 'running', title: 'rebuild and deploy' })
    expect(body.runs[0]!.prompt).toContain('Rebuild the site')
    expect(body.runs[1]).toMatchObject({ state: 'done' })
  })

  it('serves one run as coarse steps read from the child transcript', async () => {
    const body = await (await fetch(`${running.url}api/runs/bbbb2222-0000`)).json() as {
      steps: { name: string; target: string; state: string; ms?: number }[]
      hidden: number
      total: number
      transcript: string
    }
    expect(body.total).toBe(2)
    expect(body.hidden).toBe(0)
    expect(body.transcript).toContain('bbbb2222-0000.jsonl')
    expect(body.steps).toEqual([
      { id: 'c1', name: 'Read', target: '/tmp/ws/src/a.ts', state: 'done', at: 1_000, ms: 400 },
      { id: 'c2', name: 'Bash', target: 'npm test', state: 'failed', at: 2_000, ms: 7_000 },
    ])
  })

  it('sends the whole timeline by default, and only counts what memory dropped', async () => {
    const transcript = join(dir, 'bbbb2222-0000.jsonl')
    const lines = Array.from({ length: 30 }, (_, index) => call(`y${index}`, 'Grep', { pattern: `p${index}` }, 1_000 + index))
    writeFileSync(transcript, [...lines, ''].join('\n'))
    const body = await (await fetch(`${running.url}api/runs/bbbb2222-0000`)).json() as {
      steps: { id: string }[]
      hidden: number
      total: number
    }
    expect(body.total).toBe(30)
    expect(body.steps).toHaveLength(30)
    expect(body.steps[0]!.id).toBe('y0')
    // Nothing is withheld, so the page has nothing to explain away.
    expect(body.hidden).toBe(0)
  })

  it('still honours an explicit window when a caller asks for one', async () => {
    const transcript = join(dir, 'bbbb2222-0000.jsonl')
    const lines = Array.from({ length: 20 }, (_, index) => call(`x${index}`, 'Read', { file_path: `/tmp/${index}.ts` }, 1_000 + index))
    writeFileSync(transcript, [...lines, ''].join('\n'))
    const body = await (await fetch(`${running.url}api/runs/bbbb2222-0000?steps=5`)).json() as {
      steps: { id: string }[]
      hidden: number
      total: number
    }
    expect(body.total).toBe(20)
    expect(body.steps).toHaveLength(5)
    expect(body.steps[4]!.id).toBe('x19')
    expect(body.hidden).toBe(15)
  })

  it('serves the raw log only when it is asked for', async () => {
    const body = await (await fetch(`${running.url}api/runs/bbbb2222-0000/log`)).json() as { lines: string[] }
    expect(body.lines.join('\n')).toContain('Bash npm test [execute] → failed')
    // The detail view itself must not carry the text log any more.
    const detail = await (await fetch(`${running.url}api/runs/bbbb2222-0000`)).json() as Record<string, unknown>
    expect(detail.lines).toBeUndefined()
  })

  it('answers 404 for an unknown run, view and path', async () => {
    expect((await fetch(`${running.url}api/runs/nope`)).status).toBe(404)
    expect((await fetch(`${running.url}api/runs/bbbb2222-0000/other`)).status).toBe(404)
    expect((await fetch(`${running.url}api/other`)).status).toBe(404)
  })

  it('is read-only', async () => {
    const response = await fetch(`${running.url}api/runs`, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('never caches', async () => {
    const response = await fetch(`${running.url}api/runs`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('the monitor module the console reads', () => {
  // The bug this pins: a console that keeps a parser in memory forever reports
  // every run started after an index-format upgrade as having no task at all.
  //
  // Spawned rather than imported: under the test runner a dynamic `import()` of
  // a file URL loses its `?v=` query and lands in the runner's own module cache,
  // so an in-process test would pass or fail for reasons the console never sees.
  // The whole sequence — read, read, rewrite, read — happens inside one child,
  // which is the only way to prove the second read of a *changed* file is fresh.
  it('is re-read in place once the file on disk changes, and only then', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'codebuddy-fresh-'))
    const modulePath = join(scratch, 'probe.mjs')
    const serverPath = fileURLToPath(new URL('../bin/lib/server.mjs', import.meta.url))
    try {
      writeFileSync(modulePath, 'export const version = 1\n')
      utimesSync(modulePath, 1_700_000_000, 1_700_000_000)
      const script = `
        const { importFresh } = await import(${JSON.stringify(pathToFileURL(serverPath).href)})
        const { writeFileSync, utimesSync } = await import('node:fs')
        const path = process.env.PROBE
        const seen = [String((await importFresh(path)).version)]
        seen.push(String((await importFresh(path)).version))
        writeFileSync(path, 'export const version = 2\\n')
        utimesSync(path, 1700000060, 1700000060)
        seen.push(String((await importFresh(path)).version))
        process.stdout.write(seen.join(','))
      `
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, PROBE: modulePath },
        encoding: 'utf8',
      })
      expect(out).toBe('1,1,2')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // Same rule for the timeline: it owns the transcript parser, so upgrading the
  // plugin must not leave a long-lived console folding rows with the old one.
  // The console is started from a *copy* of bin/lib, which is what lets the test
  // rewrite `timeline.mjs` underneath it without touching the working tree.
  it('serves steps from a timeline.mjs that was replaced mid-flight', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'codebuddy-hot-'))
    const lib = join(scratch, 'lib')
    mkdirSync(lib, { recursive: true })
    const source = fileURLToPath(new URL('../bin/lib/', import.meta.url))
    for (const name of ['server.mjs', 'monitor.mjs', 'timeline.mjs', 'page.html']) {
      copyFileSync(join(source, name), join(lib, name))
    }
    // Fresh import so the copy gets its own module instance and its own HERE.
    const copied = await import(`${pathToFileURL(join(lib, 'server.mjs')).href}?v=${Date.now()}`) as {
      startConsole: typeof startConsole
    }
    const hot = await copied.startConsole({ dir, port: 0 })
    try {
      const before = await (await fetch(`${hot.url}api/runs/bbbb2222-0000`)).json() as {
        steps: { name: string }[]
        total: number
      }
      expect(before.steps.map((step) => step.name)).toEqual(['Read', 'Bash'])

      writeFileSync(join(lib, 'timeline.mjs'), [
        'export function stepsForLog() {',
        "  return { steps: [{ id: 'stub', name: 'Stub' }], total: 1, lastAt: 0,",
        "    transcript: '', transcriptFound: true, transcriptRecorded: true }",
        '}',
        '',
      ].join('\n'))
      utimesSync(join(lib, 'timeline.mjs'), 1_700_000_060, 1_700_000_060)

      const after = await (await fetch(`${hot.url}api/runs/bbbb2222-0000`)).json() as {
        steps: { name: string }[]
        total: number
      }
      expect(after.steps.map((step) => step.name)).toEqual(['Stub'])
      expect(after.total).toBe(1)
    } finally {
      await hot.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
