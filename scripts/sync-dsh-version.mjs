#!/usr/bin/env node
/**
 * Keep this plugin's version identical to the DSH runtime it ships against.
 *
 * The plugin is versioned in lockstep with the harness: one DSH release
 * candidate, one plugin build, one number. That makes "which build am I
 * running" answerable from either side without a lookup table, and it keeps the
 * version the plugin manager shows honest — `0.2.1-rc.5` plugin against
 * `0.2.1-rc.5` DSH.
 *
 * Usage:
 *   node scripts/sync-dsh-version.mjs            # write the discovered version
 *   node scripts/sync-dsh-version.mjs --check    # exit 1 when they disagree
 *   node scripts/sync-dsh-version.mjs 0.2.1-rc.6 # write the version named
 *
 * Note the deliberate asymmetry: `version` follows the runtime, but
 * `engines.dsh` stays a wide range. The two answer different questions —
 * "which build is this" versus "which runtimes can load it" — and the packages
 * are known to be byte-identical across a patch line, so a plugin built for
 * rc.3 runs unchanged on rc.5. Narrowing the range to the exact runtime would
 * rebuild the wall this plugin just climbed over.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MANIFEST = path.join(ROOT, 'package.json')

/**
 * Where the harness records the desktop version it was built for.
 *
 * Checked first because it is the same value the host compares against
 * (`getDshRuntimeVersion()` reads the app-boot manifest next to it).
 */
function runtimeManifestCandidates() {
  return [
    '/Applications/DeepSeek Harness.app',
    path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app'),
  ].map((app) => path.join(app, 'Contents', 'Resources', 'runtime', 'primary-runtime', 'runtime.json'))
}

/** The version this install of DSH runs, or undefined when there is none. */
export function discoverDshVersion() {
  for (const file of runtimeManifestCandidates()) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      const version = json.desktopVersion ?? json.version
      if (typeof version === 'string' && SEMVER.test(version)) return version
    } catch {
      // Not this layout; try the next source.
    }
  }
  // A profile that has installed the runtime carries the same number.
  try {
    const entry = path.join(
      os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-subagent', 'package.json',
    )
    const version = JSON.parse(fs.readFileSync(entry, 'utf8')).version
    if (typeof version === 'string' && SEMVER.test(version)) return version
  } catch {
    // No profile on this machine.
  }
  // Last resort: ask the CLI. It prints an Electron warning on stderr, so only
  // the stdout lines are scanned for a version.
  try {
    const text = execFileSync('dsh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of text.split('\n').reverse()) {
      const hit = line.trim().match(SEMVER)
      if (hit !== null) return hit[0]
    }
  } catch {
    // No dsh on PATH.
  }
  return undefined
}

/**
 * Rewrite the manifest's version.
 * @param version - the version to write.
 * @returns the previous version, so the caller can report the change.
 */
export function writeVersion(version) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const previous = manifest.version
  if (previous !== version) {
    manifest.version = version
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return previous
}

function main(argv) {
  const check = argv.includes('--check')
  const named = argv.find((arg) => SEMVER.test(arg))
  const version = named ?? discoverDshVersion()
  if (version === undefined) {
    console.error('找不到 DSH 版本：既没有安装记录，`dsh --version` 也不可用。')
    return 1
  }
  const current = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version
  if (check) {
    if (current === version) {
      console.log(`版本一致：${current}`)
      return 0
    }
    console.error(`版本不一致：插件 ${current} ／ DSH ${version}，运行 npm run version:dsh 对齐。`)
    return 1
  }
  const previous = writeVersion(version)
  console.log(previous === version ? `版本已是 ${version}` : `版本 ${previous} → ${version}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
