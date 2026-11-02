import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The host refuses to load a plugin whose declared DSH requirement does not
 * cover the running version:
 *
 * > 当清单声明了 `engines.dsh` 时，只由该范围决定，忽略 `peerDependencies`。
 * > 否则 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*`
 * > 的每个范围都必须匹配……
 *
 * An exact pin like `0.2.1-rc.3` therefore breaks on every DSH release, even a
 * patch that changed no code — which is exactly what happened on 0.2.1-rc.5
 * (that release differs from rc.3 only in these pins; every `.js` and `.d.ts`
 * is byte-identical). These assertions keep the manifest declarative instead.
 *
 * Separately, `version` is meant to equal the running DSH version, so the two
 * halves of a deployment can be named with one string. `engines.dsh` stays a
 * range on purpose: identity and acceptance are different questions.
 */

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  engines?: Record<string, unknown>
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Packages whose version the host itself owns; we must not pin them. */
function dshPackages(field: Record<string, string> | undefined): [string, string][] {
  return Object.entries(field ?? {}).filter(([name]) => /^@deepseek-ai\/dsh(-|$)/.test(name))
}

/** An exact version has nothing but digits, dots and a prerelease tag. */
function isExact(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())
}

describe('the plugin manifest', () => {
  it('declares the DSH range the host should read first', () => {
    expect(typeof manifest.engines?.['dsh']).toBe('string')
    expect((manifest.engines?.['dsh'] as string).trim()).not.toBe('')
  })

  it('never pins an exact DSH version in peerDependencies', () => {
    const pinned = dshPackages(manifest.peerDependencies)
      .filter(([, range]) => isExact(range))
      .map(([name, range]) => `${name}@${range}`)
    expect(pinned).toEqual([])
  })

  it('never pins an exact DSH version in dependencies or devDependencies', () => {
    // The bundled runtime packages ship identical code across patch releases,
    // so an exact pin buys nothing and blocks every upgrade.
    const pinned = [...dshPackages(manifest.dependencies), ...dshPackages(manifest.devDependencies)]
      .filter(([, range]) => isExact(range))
      .map(([name, range]) => `${name}@${range}`)
    expect(pinned).toEqual([])
  })

  it('covers the prerelease line, not just the first release candidate', () => {
    const range = manifest.engines?.['dsh'] as string
    // A bare `0.2.1-rc.3` or `~0.2.1-rc.3` would stop matching the next rc;
    // the range has to be open-ended enough for the host to keep loading us.
    expect(range).toMatch(/[<>]|\^|~/)
    expect(range).not.toMatch(/^\d/)
  })

  /**
   * The plugin is versioned in lockstep with the harness: 0.2.1-rc.5 plugin for
   * 0.2.1-rc.5 DSH. The check is delegated to the script that owns the rule
   * rather than re-derived here, so there is one definition of "the version of
   * the DSH I am running".
   */
  const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
  const lockstep = (() => {
    try {
      return { ran: true, output: execFileSync(process.execPath, ['scripts/sync-dsh-version.mjs', '--check'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() }
    } catch (error) {
      const failure = error as { stdout?: string, stderr?: string }
      const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
      // No DSH on this machine (a bare CI runner) is not a version mismatch.
      return { ran: !output.includes('找不到 DSH 版本'), output }
    }
  })()

  it.skipIf(!lockstep.ran)('keeps its version identical to the running DSH', () => {
    expect(lockstep.output).toContain('版本一致')
  })
})
