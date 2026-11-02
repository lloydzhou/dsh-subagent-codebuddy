#!/usr/bin/env node
/**
 * CodeBuddy subagent monitor.
 *
 * Bare invocation opens the console in a chromeless, right-docked window — the
 * closest thing to the built-in subagent panel this harness allows for an
 * external child (see `bin/lib/server.mjs` for why a plugin cannot add one).
 * Terminal modes stay available for scripts and SSH sessions.
 *
 *   codebuddy-runs                 open the panel (falls back to printing the URL)
 *   codebuddy-runs --serve         serve only, print the URL, stay in foreground
 *   codebuddy-runs --list          snapshot of runs in the terminal
 *   codebuddy-runs -w              live list in the terminal (Ctrl-C to stop)
 *   codebuddy-runs -f [id]         stream one run's log until it ends
 *   codebuddy-runs <id>            print one run's log and exit
 *   codebuddy-runs --count         number of runs in progress (for scripts)
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fmtClock,
  fmtDuration,
  logDir as resolveLogDir,
  readEntries,
  readTail,
  renderDetail,
  renderList,
  summarize,
  summaryLine,
} from './lib/monitor.mjs'
import { startConsole } from './lib/server.mjs'
import { stepsForLog } from './lib/timeline.mjs'

const argv = process.argv.slice(2)
const flags = { serve: false, list: false, watch: false, follow: false, count: false, open: true, all: false, help: false, installAgent: false, uninstallAgent: false, printAgent: false }
let dir = resolveLogDir()
let port = 7717
// Loopback by default: the console is read-only but it names workspaces and run
// logs. Serving it to the LAN is an explicit choice (`--host 0.0.0.0`).
let host = '127.0.0.1'
const positional = []

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--serve' || arg === '--panel') flags.serve = true
  else if (arg === '--list' || arg === '--plain') flags.list = true
  else if (arg === '-w' || arg === '--watch') flags.watch = true
  else if (arg === '-f' || arg === '--follow') flags.follow = true
  else if (arg === '--count') flags.count = true
  else if (arg === '--no-open') flags.open = false
  else if (arg === '--install-agent') flags.installAgent = true
  else if (arg === '--print-agent') flags.printAgent = true
  else if (arg === '--uninstall-agent') flags.uninstallAgent = true
  else if (arg === '-a' || arg === '--all') flags.all = true
  else if (arg === '-h' || arg === '--help') flags.help = true
  else if (arg === '--dir') { dir = argv[i + 1] ?? dir; i += 1 }
  else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length)
  else if (arg === '--port') { port = Number(argv[i + 1] ?? port); i += 1 }
  else if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length))
  else if (arg === '--host') { host = argv[i + 1] ?? host; i += 1 }
  else if (arg.startsWith('--host=')) host = arg.slice('--host='.length)
  else if (arg.startsWith('-')) {
    process.stderr.write(`codebuddy-runs: unknown option ${arg}\n`)
    process.exit(2)
  } else positional.push(arg)
}

const color = process.stdout.isTTY && process.env.NO_COLOR === undefined
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
const dim = (text) => paint('2', text)
const CODES = { running: '32', lost: '33', failed: '31', cancelled: '33', done: '36' }

function help() {
  process.stdout.write(`codebuddy-runs — CodeBuddy 子代理监控

  codebuddy-runs              打开右侧面板（无地址栏窗口）
  codebuddy-runs --serve      只起服务并打印地址，前台常驻
  codebuddy-runs --list       在终端打印一次快照
  codebuddy-runs -w           终端里实时刷新列表（Ctrl-C 退出）
  codebuddy-runs -f [id]      流式跟随一次运行的进度（每个工具调用一行）
  codebuddy-runs <id>         打印某一次运行的完整日志
  codebuddy-runs --count      只输出"进行中"的数量（便于脚本）
  codebuddy-runs --install-agent    登录自启后台服务（页面常驻，macOS）
  codebuddy-runs --uninstall-agent  取消自启

  选项  --port <n>  面板端口（默认 7717，被占用则自动 +1）
        --host <a>  监听地址（默认 127.0.0.1；要让别的机器打开就写 0.0.0.0）
        --dir <p>   日志目录（默认 ~/.dsh/logs/subagent-codebuddy）
        --no-open   不打开窗口，只起服务
        --all       列表包含历史运行

日志目录：${dir}
`)
}

/** Terminal width, clamped so a narrow window still lays out. */
function termWidth() {
  return Math.max(40, Math.min(process.stdout.columns ?? 100, 160))
}

function printSnapshot() {
  const entries = readEntries(dir, Date.now())
  const summary = summarize(entries)
  const width = termWidth()
  const lines = [`${paint('1', 'CodeBuddy 子代理')}   ${dim(summaryLine(summary))}`]
  const running = entries.filter((entry) => entry.state === 'running')
  // `renderList([])` answers with a placeholder; with history below it that
  // placeholder reads as "there is nothing here" right above ten rows.
  if (running.length > 0) {
    for (const line of renderList(running, { width, showAll: true })) lines.push(paint(CODES.running, line))
  }
  const rest = entries.filter((entry) => entry.state !== 'running')
  if (rest.length > 0) {
    if (running.length > 0) lines.push(dim('─'.repeat(Math.min(width, 60))))
    for (const entry of renderList(rest, { width, showAll: flags.all, limit: 10 })) {
      lines.push(entry.includes('失联') ? paint(CODES.lost, entry) : entry)
    }
  }
  if (entries.length === 0) lines.push(dim('还没有任何运行记录。'))
  lines.push(dim(`日志 ${dir}`))
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** Live terminal view: the list, plus the newest running run's tail. */
function watch() {
  const draw = () => {
    const entries = readEntries(dir, Date.now())
    const summary = summarize(entries)
    const width = termWidth()
    const out = [`${paint('1', 'CodeBuddy 子代理')}   ${dim(summaryLine(summary))}   ${dim(fmtClock(new Date().toISOString()))}`]
    if (entries.length === 0) {
      // The placeholder belongs to this view, not to `renderList`, which would
      // print it and let the branch below print it a second time.
      out.push('', dim('还没有任何运行记录。'))
    } else {
      for (const entry of renderList(entries, { width, showAll: flags.all, limit: 10 })) {
        out.push(entry.includes('运行中') ? paint(CODES.running, entry) : entry.includes('失联') ? paint(CODES.lost, entry) : entry)
      }
    }
    const active = entries.find((entry) => entry.state === 'running')
    if (active !== undefined) {
      out.push('')
      for (const line of renderDetail(active, { width, lines: readTail(active.logPath, 14) })) out.push(dim(line))
    }
    process.stdout.write(`\u001b[H\u001b[2J${out.join('\n')}\n`)
  }
  draw()
  const timer = setInterval(draw, 1000)
  const stop = () => {
    clearInterval(timer)
    process.stdout.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function dump(selector) {
  const entries = readEntries(dir, Date.now())
  const match = selector === undefined
    ? entries[0]
    : entries.filter((entry) => entry.id.startsWith(selector)).at(-1)
  if (match === undefined) {
    process.stderr.write(`codebuddy-runs: 没有匹配 "${selector}" 的运行（目录 ${dir}）\n`)
    process.exit(1)
  }
  const width = termWidth()
  const header = renderDetail(match, { width, lines: [] })
  process.stdout.write(`${header.slice(0, -1).join('\n')}\n\n`)
  // The timeline first: what the child actually did, one row per call, read
  // from the CLI's own transcript. Then the log, which now holds only the
  // events nothing else records.
  const { steps, total, transcript, transcriptFound, transcriptRecorded } = stepsForLog(match.logPath)
  if (steps.length > 0) {
    const shown = steps.slice(-20)
    if (total > shown.length) process.stdout.write(`${dim(`更早的 ${total - shown.length} 步已省略`)}\n`)
    for (const step of shown) process.stdout.write(`${stepLine(step)}\n`)
    process.stdout.write('\n')
  } else if (transcriptFound === false) {
    process.stdout.write(`${dim(`找不到 transcript：${transcriptRecorded || transcript}`)}\n\n`)
  } else if (transcript === '') {
    process.stdout.write(`${dim('（这次运行没有 transcript，只能看日志）')}\n\n`)
  }
  const lines = readTail(match.logPath, 1000)
  if (steps.length > 0) process.stdout.write(`${dim('关键事件')}\n`)
  process.stdout.write(lines.length === 0 ? dim('(该运行还没有日志)\n') : `${lines.join('\n')}\n`)
}

/** One timeline row, aligned like the list: time, mark, tool, what it touched. */
function stepLine(step) {
  const mark = step.state === 'failed' ? '×' : step.state === 'ongoing' ? '·' : '✓'
  const code = step.state === 'failed' ? CODES.failed : step.state === 'ongoing' ? CODES.running : '0'
  const took = typeof step.ms === 'number' ? ` ${dim(fmtDuration(step.ms))}` : ''
  const at = typeof step.at === 'number' ? dim(fmtClock(step.at)) : dim('        ')
  return `${at} ${paint(code, mark)} ${step.name}${step.target === '' ? '' : ` ${step.target}`}${took}`
}

/**
 * Follow one run until it ends.
 *
 * The steps are the stream here, not the log lines: the log keeps only the
 * events nothing else records, so following it would show a handful of lines an
 * hour. A run without a transcript (a mock child, an old record) falls back to
 * the log lines, which is all there is in that case.
 */
function follow(selector) {
  let current
  let offset = 0
  let announced = false
  /** callId -> the state that was last printed, so a step is not repeated. */
  const printed = new Map()

  const resolve = () => {
    const entries = readEntries(dir, Date.now())
    if (selector === undefined) {
      const running = entries.filter((entry) => entry.state === 'running')
      return running[0] ?? entries.find((entry) => entry.state === 'lost') ?? entries[0]
    }
    return entries.filter((entry) => entry.id.startsWith(selector)).at(-1)
  }

  const pump = () => {
    current = resolve()
    if (current === undefined) return
    if (!announced) {
      announced = true
      const tip = current.state === 'running' ? 'follow' : `already ${current.label}`
      process.stdout.write(`${paint(CODES[current.state] ?? '0', current.label)} ${current.id}  ${dim(`(${tip}, ${fmtDuration(current.elapsedMs)})`)}\n`)
      if (current.title !== '') process.stdout.write(`${dim('任务:')} ${current.title}\n`)
      process.stdout.write(`${dim(`log:  ${current.logPath}`)}\n\n`)
    }
    const { steps } = stepsForLog(current.logPath)
    if (steps.length > 0) {
      for (const step of steps) {
        const seen = printed.get(step.id)
        if (seen === step.state) continue
        printed.set(step.id, step.state)
        process.stdout.write(`${stepLine(step)}\n`)
      }
      return
    }
    if (!existsSync(current.logPath)) return
    const lines = readTail(current.logPath, Number.MAX_SAFE_INTEGER)
    if (lines.length < offset) offset = 0
    if (lines.length > offset) {
      process.stdout.write(`${lines.slice(offset).join('\n')}\n`)
      offset = lines.length
    }
  }

  pump()
  const timer = setInterval(() => {
    pump()
    if (current !== undefined && current.state !== 'running') {
      clearInterval(timer)
      process.stdout.write(`\n${paint(CODES[current.state] ?? '0', current.label)}  ${current.detail}\n`)
    }
  }, 400)
  process.on('SIGINT', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

/** Chromium-family browsers accept `--app`, which is what makes the panel. */
function findBrowser() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  return candidates.find((path) => existsSync(path))
}

/** Screen size, so the window can be docked against the right edge. */
function screenSize() {
  return new Promise((resolve) => {
    const fallback = { width: 1440, height: 900 }
    if (process.platform !== 'darwin') {
      resolve(fallback)
      return
    }
    const child = spawn('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString() })
    child.on('error', () => resolve(fallback))
    child.on('close', () => {
      const parts = out.split(',').map((part) => Number(part.trim()))
      resolve(parts.length === 4 && parts.every((value) => Number.isFinite(value)) ? { width: parts[2], height: parts[3] } : fallback)
    })
  })
}

/**
 * Open the console as a borderless, right-docked window.
 * @returns `true` when a Chromium-family browser took it.
 */
async function openPanel(url) {
  const browser = findBrowser()
  if (browser === undefined) return false
  const screen = await screenSize()
  const width = Math.min(480, Math.max(380, Math.round(screen.width * 0.3)))
  const args = [
    `--app=${url}`,
    `--window-size=${width},${screen.height}`,
    `--window-position=${Math.max(0, screen.width - width)},0`,
    `--user-data-dir=${join(homedir(), '.dsh', 'subagent-codebuddy-panel')}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  const child = spawn(browser, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return true
}

async function live() {
  const consoleServer = await startConsole({ dir, port, host })
  process.stdout.write(`${paint('1', 'CodeBuddy 子代理监控')}  ${consoleServer.url}\n${dim('Ctrl-C 停止服务')}\n`)
  if (flags.open) {
    const opened = await openPanel(consoleServer.url)
    if (!opened) {
      // No Chromium: fall back to the default browser, same page, no dock.
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [consoleServer.url], { stdio: 'ignore', detached: true }).unref()
    }
  }
  const stop = async () => {
    await consoleServer.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}

/* ---------------------------------------------------------------- launchd --
 * An always-on console. The panel is only useful if it is already there when a
 * delegation starts, so the login agent keeps `--serve` running from boot. It is
 * opt-in: nothing is written to ~/Library unless asked.
 */

const AGENT_LABEL = 'cn.codebuddy.subagent-runs'
const AGENT_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)

/** The launchd job, as a string, so it can be inspected before being installed. */
function agentPlist() {
  const logPath = join(homedir(), 'Library', 'Logs', 'codebuddy-runs.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${fileURLToPath(import.meta.url)}</string>
    <string>--serve</string>
    <string>--no-open</string>
    <string>--port</string><string>${port}</string>
    <string>--dir</string><string>${dir}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`
}

function installAgent() {
  if (process.platform !== 'darwin') {
    process.stderr.write('codebuddy-runs: --install-agent 目前只支持 macOS；其他系统请把 --serve 交给 systemd/supervisor\n')
    process.exit(1)
  }
  const plist = agentPlist()
  writeFileSync(AGENT_PLIST, plist)
  execFileSync('launchctl', ['unload', AGENT_PLIST], { stdio: 'ignore' })
  execFileSync('launchctl', ['load', '-w', AGENT_PLIST], { stdio: 'ignore' })
  process.stdout.write(`已安装登录自启：${AGENT_PLIST}\n页面地址：http://127.0.0.1:${port}/\n卸载：codebuddy-runs --uninstall-agent\n`)
}

function uninstallAgent() {
  try {
    execFileSync('launchctl', ['unload', AGENT_PLIST], { stdio: 'ignore' })
  } catch {
    // Not loaded, or already removed.
  }
  rmSync(AGENT_PLIST, { force: true })
  process.stdout.write('已移除登录自启\n')
}

if (flags.help) {
  help()
} else if (flags.count) {
  process.stdout.write(`${summarize(readEntries(dir, Date.now())).running}\n`)
} else if (flags.follow) {
  follow(positional[0])
} else if (flags.watch) {
  watch()
} else if (flags.list) {
  printSnapshot()
} else if (flags.printAgent) {
  process.stdout.write(agentPlist())
} else if (flags.installAgent) {
  installAgent()
} else if (flags.uninstallAgent) {
  uninstallAgent()
} else if (positional.length > 0) {
  dump(positional[0])
} else if (flags.serve) {
  flags.open = false
  void live()
} else {
  // Bare invocation: the panel is the point. A non-interactive stdout (piped,
  // CI, an agent shell) gets the snapshot instead of a server nobody can see.
  if (process.stdout.isTTY) void live()
  else printSnapshot()
}
