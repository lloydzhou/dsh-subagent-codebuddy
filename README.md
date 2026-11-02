# dsh-subagent-codebuddy

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile bundle: a one-shot subagent provider that runs each child in the local **CodeBuddy CLI** (`codebuddy --acp`), with the child's model pinned by config (default `deepseek-v4.1-flash`, passed as `--model <id>`). Runs consume the logged-in account's subscription credits, or the API key supplied through `envFile`.

The provider is written against the installed harness's public subagent seam (`@deepseek-ai/dsh-subagent` helpers `NO_START_CAPABILITIES`, `settleRunResult`, `subprocessRunHandle`) and ships as a bundle: `dsh.bundle.patch` inserts the provider row plus a tool row that mounts this package's own `./tool` entry.

Two model-facing tools are mounted, both this package's rather than the generic `@deepseek-ai/dsh-tool-subagent`: `subagent_codebuddy` starts a run and `codebuddy_steer` adds a message to one that is still running. The generic tool renders a bare `started subagent <id>` and offers no wording knob, so the model has no reason to stop looking for the run and reaches for `wait_agent` / `list_agents` — which only track in-process teammates and continuable local children, and therefore always report "no subagent running" for an out-of-process one-shot child. This tool drives the identical runtime path (`ctx.subagents.startActivation({ delivery: 'parent' })`) but its description and result say the child is already running, that nothing can observe it, and that the result arrives by itself.

## Progress and result delivery

An external child reports exactly once, when it settles: the harness injects a `Background subagent <id> finished` notice with the child's closing message, and that notice starts the parent's next turn. There is no mid-run progress channel, and this is a property of the backend, not a bug in this plugin:

- the "task message" style notice (`Team message from <child>: …`) belongs to continuable **local** children, which carry dsh's `send_message` tool and a parent inbox;
- a CodeBuddy child is a separate CLI process with no dsh tools, so it cannot call back into the parent's conversation, and the provider advertises no `prepareContinuable`, so no inbox exists on either side.

What the tool can do — and does — is keep the parent from burning the run waiting: its result states that polling is futile and that the parent should continue with other work or end its turn, which lets the settlement notice arrive at the earliest possible step boundary.

### Steering a run that is still going

Progress cannot flow out, but intent can still flow in. The CLI ships an ACP extension for exactly this, and it is the only mechanism that works:

| Attempt | Result |
|---|---|
| second `session/prompt` | the CLI treats it as a competing turn and ends the first one in ~33ms, with no output |
| `--input-format stream-json` | starts a *different* session; the running one never sees it |
| `session/steer` | `{steered: true}`; the message is delivered at the child's next step boundary, and the tool call in flight is not interrupted |

`codebuddy_steer({ childId, message })` wraps that extension. The child id is the one in the activation notice, and the provider publishes a live handle in `src/steer.ts` when `session/new` returns and withdraws it the moment the run settles — so an id that has already finished is refused (the tool lists the ids that are still live instead of guessing). A `{steered:false}` answer from the child is reported as a refusal with its reason, never retried: the usual cause is that the child is between turns.

## The chat card: what it may claim

Each delegation also gets one card in the transcript (`conversation.chat.node`, kind `codebuddy-run`), anchored on its own `tool/call` event. It folds exactly three things — the handoff result, the settlement notice, and any mid-run message sent into it — because those are the only moments an external child produces. That bounds what it can honestly say:

| State | Reached from | What the card shows |
|---|---|---|
| 运行中 | `tool/call` | the clock starts counting at the call |
| 后台运行中 | `tool/result` (the activation notice) | the same clock, still counting; the body names the run and its log, and fills with the child's actions as they arrive |
| 已完成 | settlement `finished` | the closing words, appended below the task and the timeline, with the CLI's cost line lifted into the header |
| 已停止 | settlement `was stopped` | the notice kept whole — it is the only explanation there is |
| 被拒绝 | settlement `declined the task` | idem |
| 失败 | settlement `failed before it finished` / `ended abnormally`, or a run that raised | the diagnostic, plus any `- [done] …` steps |

**One run, one card.** A `codebuddy_steer` call is an ordinary tool call in the transcript, and it matches `/codebuddy/` just like the delegation does — so it would open a second card that nothing ever settles, sitting at 后台运行中 next to the run it only sent a message to. The definition therefore keys on what a call *does*, not only on its name: a call whose arguments carry a `childId` addresses a run instead of starting one, and folds into the card that started that child (`↪ 插话 …` in its body), or into nothing when this page never saw that card. Its own result is ignored either way — the run's status changes only when the child settles. The ordinary tool row still reports the call.

**The body is a record, not a replacement.** A card reads in the order the run lived: the task the child was handed (the full `prompt`, clamped to four lines with a local expand — the header only has room for the caller's 3–5 word label), then any mid-run messages, then what the child did, and only at the end how it ended. Settling *appends* that closing block; it never overwrites what came before, because the timeline is the only record of the work that produced the answer. What makes this hold across a remount — a reconnect, a transcript re-rendered from the session log — is `src/client/live.ts`'s small per-run cache: polling stops at settlement, so without it a finished card would come back with its history missing.

Two consequences are worth stating plainly:

- **The clock measures waiting, not life.** Between the two events the card hears nothing from the transcript, and a browser cannot read the run's beacon. So the header counts up without claiming more than that, and its hover text says so and names `codebuddy-runs`, where the beacon does answer the question. What the card *can* see is the child's own actions, when the host answers (next section): rows appear as it works, `最后动作 12s 前` ages them, and the `N 步` counter in the collapsed header moves. With no feed it falls back to the plain clock, exactly as before.
- **A child that dies with its host stays at 后台运行中 forever**, because no event exists to fold — `codebuddy-runs` calls that 失联. A child that dies while the host lives is a different case and not this one: the ACP pipe closes, the run settles as `error`, and the card turns 失败. The `crash` scenario in `tests/mock-acp-child.mjs` pins that.

### Live progress: the one channel that is not the transcript

A card that only folds transcript events can show two moments of a ten-minute run. The child's actions are not in that transcript at all — they are ACP `session/update` notifications that arrive in the host process, where the provider already mirrors them into the run log. `src/progress.ts` keeps the last 60 of them per run, in memory, keyed by the run id the runtime adopts as the child id, and `src/progress-route.ts` serves them on the host's own listener:

```
GET /subagent-codebuddy/progress?ids=<childId>[,<childId>…]   →   { runs: { <childId>: { steps, updatedAt, endedAt? } } }
```

The card polls that path while the run is outstanding (every 1.5s, `src/client/live.ts`), and stops at settlement or after three failures. Four decisions are worth knowing:

- **A relative URL, not a port.** The web UI is served by the same listener, and the desktop window forwards its own `dsh-app://app/…` requests to the host it owns, keeping the path — so one URL works in both without the client knowing a port or holding a token. The route sits below the `/api` trust fence, so it answers without a cookie; it serves only ids the caller already has from its own transcript, and only GET/HEAD.
- **One row per action, not per notification.** ACP reports a tool call once and then once per status change; the feed merges on `toolCallId`, so one edit is one row that turns ✓. The child's plan is one row that is replaced rather than appended, because it describes the shape of the work.
- **Not the model's.** Progress is not injected into the parent conversation: doing that would put a heartbeat into the model's context and wake it for work it did not ask for. The feed only ever reaches a viewer.
- **It degrades to the card that shipped before.** No web server (headless profile), an unreachable route, a 404 from a host that has not reloaded the plugin, a page opened from a file: the poll gives up quietly, the body falls back to the handoff text, and the clock is the only thing moving. `tests/client-live.spec.ts` pins that every malformed payload reads as "no feed".

## Watching a run: the panel

Between the delegation result and the settlement notice this child has no surface in the app: the parent session records its catalog entry (`subagent/catalog`, mode `external`) at start and nothing else until it settles, and that entry carries only `{id, createdAt, mode, label}`. The app renders a subagent panel from the child's *session* events, and an out-of-process child has no session here — which is why a plugin cannot add a panel of its own.

So the panel is served instead, and docked like one:

```sh
codebuddy-runs            # opens a borderless window pinned to the right edge
codebuddy-runs --serve    # same page, foreground only, prints the URL
codebuddy-runs --install-agent    # keep it running from login (macOS launchd)
```

`codebuddy-runs` starts a loopback-only console and opens it through Chrome/Edge/Brave/Chromium with `--app`, no address bar, sized to ~30% of the screen width and positioned against the right edge — a narrow event stream beside the app, with no input box. Closing that window leaves the page live at `http://127.0.0.1:7717/`; the process stays in the terminal until Ctrl-C. Without a Chromium-family browser it falls back to the default browser.

The page refreshes once a second and shows, for the selected run, the identity block and then the *timeline*: one row per tool call — ✓ done, · in flight, × failed — with what it touched and how long it took, plus 最后动作 Ns 前. The whole retained timeline is sent, not a window: 263 calls is 50 KB and about 7 ms on the server, and the page only rebuilds the DOM when a row's state actually changes, so a long run stays scrollable back to its first call. Only the in-memory cap (400 rows per run) ever drops history, and that is the one case where the pane says 更早的 N 步. The raw log is folded behind 原始日志 and fetched only when opened.

### Two records, each keeping what it alone knows

The CLI already writes a JSONL transcript per session (`~/.codebuddy/projects/<slug>/<sessionId>.jsonl`): every call, its result, the reasoning between them, appended while the run is still going. That file is the best account of what the child did, so nothing tries to reproduce it — and the page reads it directly:

- **Timeline = transcript.** `bin/lib/timeline.mjs` folds calls and results on `callId` into coarse rows, reading only the bytes appended since the last poll and keeping the newest 400. The card gets the same information from ACP notifications over its own route, so a run reads the same in both places; the transcript is the one that survives the host.
- **Log = what the provider alone witnessed.** `~/.dsh/logs/subagent-codebuddy/<runId>.log` now records only events the CLI cannot: spawn, handshake, session and transcript path, permission decisions, steer results, plan changes, *failed* tool calls, stop reason, stderr. Copying every successful call into it made each run log ~250 KB of near-duplicate lines — a one-hour run is now a few dozen lines, and it is the file that still exists when the transcript path is wrong or the CLI changed it.

That split is also why `-f` follows steps rather than lines: it prints one line per call as it starts and again when it finishes, and only falls back to the log when a run has no transcript.

### The list column is the label, not the prompt

A delegated call carries two different texts: `description` (3–5 words, for display) and `prompt` (the whole self-contained task). The index records both, as `label="…" prompt="…"`, and every list — terminal, web console, `-f` header — titles a run by its label. The prompt is shown only in the detail view, under `提示`, and only when it is not what the title already says.

That split matters for a monitor: a 120-character prompt clipped to the column width reads like a description while saying something else, and two runs of the same task ("try again", "try again") become indistinguishable. Runs started by a caller that supplies no label fall back to the prompt head — the label is simply absent from the line, and the reader notices by the missing field rather than by an empty column. Labels and prompts are quote-escaped on the way in, so a task containing `"` cannot shift the fields after it; `--list` on a log directory written by an older build still works, because `task="…"` is read as the prompt.

### The console follows the file it reads

A monitor that stays up for days is a reader whose parser is older than the writer. When the index line changed from `task="…"` to `label="…" prompt="…"`, the running console kept the old parser in memory and reported every *new* run as 无任务描述 while the old rows still read fine — a writer bug by appearance, a stale process in fact. So `server.mjs` re-imports `monitor.mjs` (under its mtime) whenever that file's mtime changes: upgrade the plugin and the console on the same machine starts reading the new format at the next request, with no restart and no version skew in between. Rows written before the upgrade keep their labels via the `task=` fallback.

The other direction — new writer, old reader — cannot be fixed from here, which is exactly why the reader is now the part that reloads.

`--host 0.0.0.0` is how the same page is reached from another machine (the default stays loopback: the page lists workspace paths and log names). The listener is read-only either way — two JSON endpoints and one static page, no write path.

### State is decided by a beacon, not by a guess

Every live run writes `<runId>.alive` every 5s and removes it when it settles (see `startHeartbeat`). That splits three cases the index alone cannot:

| State | Meaning |
|---|---|
| 运行中 | index says `START` and the beacon (or log) moved within 20s |
| 失联 | `START`, the beacon exists but went quiet — hard kill, crash, or host exit |
| 未知 | `START` from a build without beacons and a quiet log — nothing can say, so it does not pretend |

`--count` prints just the number of live runs, for scripts.

### Terminal modes

```sh
codebuddy-runs --list     # snapshot: what is running, then recent history
codebuddy-runs -w         # same list, redrawn every second, plus the live run's tail
codebuddy-runs -f [id]    # stream one run's steps until it ends
codebuddy-runs <id>       # print one run's log
```

From a checkout run `node bin/codebuddy-runs.mjs`; `--dir <path>` or `DSH_SUBAGENT_CODEBUDDY_LOG_DIR` points it at another log directory. The files are plain text, so `tail` works too:

```sh
tail -f ~/.dsh/logs/subagent-codebuddy/index.log        # all runs: started / ended / failed
tail -f ~/.dsh/logs/subagent-codebuddy/<runId>.log      # one run: the events nothing else records
```

`<runId>` is the id the settlement notice names, so a notice always leads back to its log. Each run log opens with the context that identifies it — command, workspace, permission policy, auth mode, label, prompt head — and then records, in order:

| Column | What it shows |
|---|---|
| `spawn` / `handshake` / `auth` / `session` | startup phases, the ACP protocol version, the auth methods the child advertised, and the session id it created |
| `transcript` | where the CLI writes its own full transcript for that session (`~/.codebuddy/projects/<workspace-slug>/<sessionId>.jsonl`) — every message, tool result and file edit, live. **This is the tool-by-tool record; the console reads it directly** |
| `tool` | only the calls that *failed*, with how long they took (`Bash npm test [execute] → failed 7.0s`) — a failure changes what the run means and is the first thing anyone greps for |
| `permission` | each approval the provider answered for the child, and whether it allowed or declined |
| `plan` | the child's plan progress when it publishes one |
| `steer` | whether an injected message was delivered or refused, and why |
| `prompt` / `done` / `failed` / `cancel` / `teardown` | task submission, terminal stop reason with elapsed time and output size, failure detail, cancellation, process reaping |

Assistant text is deliberately not mirrored — the settlement notice already carries the closing message. Successful tool calls are not mirrored either: the transcript above already has them, with arguments and output, so duplicating them here only made the file 250 KB per hour and pushed the events this provider is the sole witness to out of sight. Nothing in these files reaches the parent model; they are for the operator (and for the agent only when the user asks about progress).

## The CodeBuddy CLI

This plugin drives your locally installed **CodeBuddy CLI** (Tencent's terminal coding agent); it does not bundle or install it.

```sh
# macOS (Homebrew)
brew install tencent-codebuddy/tap/codebuddy-code

codebuddy --version   # tested with 2.176.0
```

Requirements:

- **A recent CLI** — the plugin speaks ACP over stdio (`--acp`) and passes `--permission-mode` / `--model` startup flags; verify yours supports them with `codebuddy --help`. Builds older than the ACP-capable line will fail the startup handshake with a clear error.
- **A login or an API key** — run `codebuddy` once and `/login` (WeChat); the token persists locally in `~/.codebuddy` and every spawned child reuses it. Alternatively configure `envFile` with an API key (see Configuration); the key takes precedence over the login state.
- **First check**: `codebuddy -p "reply with exactly: pong" --model deepseek-v4.1-flash` should print `pong` before you blame the plugin for anything.

## Build and test

```sh
npm install
npm test        # keyless suite: real subprocess, scripted mock ACP server
npm run build   # emits lib/index.js and the browser half lib/client.js
npm run typecheck   # host half and browser half (tsconfig.client.json)
```

## Install into a profile

```sh
plugin_manager install_bundle target=~/codebuddy-subagent
```

or add the bundle to the profile. The patch is one `insert` list with exactly two rows — the provider and the delegation tool — the same shape the shipped `@deepseek-ai/dsh-subagent-claude-code` bundle uses.

```yaml
- insert:
    - id: subagent-codebuddy
      name: 'dsh-subagent-codebuddy'
      config:
        permission: allow
        startupTimeoutMs: 60000
        envFile: ~/.dsh/secrets/codebuddy-api-key
    - id: tool-subagent-codebuddy
      name: 'dsh-subagent-codebuddy/tool'
      config:
        provider: codebuddy
        toolName: subagent_codebuddy
        maxDepth: provider-managed   # REQUIRED, and required to be explicit
```

`maxDepth: provider-managed` is not optional and must not be dropped as "the default is the same". Omitting the key makes the harness resolve the depth from its own numeric default (`resolveMaxDepth(undefined)` reads the service setting), which the CodeBuddy provider cannot enforce because it advertises no `depthLimit` capability — the row then fails to activate with `provider "codebuddy" cannot enforce maxDepth`, the tool never mounts, and the model has no way to delegate. Writing it explicitly is also what keeps a stale module generation from the previous install (which can still be the generic tool) from failing the same check.

Do **not** move the tool row into an agent preset (e.g. by overriding `preset-cordis`). A preset override only applies where that preset row exists; in a profile that ships a different preset set the patch fails with `entry "preset-cordis" not found`, the tool silently never mounts, and the model has no way to delegate — while the provider still shows up as a lone component. Both rows at the bundle's top level keep the provider and the tool together everywhere.

The tool's depth policy is fixed at `provider-managed`: the provider advertises no depth capability, so a numeric `maxDepth` would be rejected at mount time.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `codebuddy` | Registry name on `ctx.subagents`. |
| `command` | `codebuddy` | The CLI executable. |
| `args` | `['--acp']` | Arguments that start the CLI's ACP server. |
| `model` | `deepseek-v4.1-flash` | Model id appended as `--model <id>`; empty omits the flag. |
| `permission` | `allow` | Auto-answer the child's tool prompts by selecting its least-privilege allow option, or `reject` to decline them all. No prompt reaches a human. |
| `env` | `{}` | Explicit child environment layered over the wire-protection default. |
| `envFile` | — | File whose trimmed content becomes the child's `CODEBUDDY_API_KEY`; re-read at each start, so rotating the key needs no reload. Missing or empty only warns (the child falls back to the CLI login state). |
| `authMethodId` | — | ACP auth method id to select explicitly (`initialize` reports the ids as `authMethods`). Unset keeps the CLI login state plus any `envFile` key. |
| `startupTimeoutMs` | `60000` | Deadline for each startup phase (`initialize`, `authenticate`, `session/new`). `0` waits indefinitely. |
| `promptTimeoutMs` | `0` | Overall deadline for the submitted task. `0` waits indefinitely, because a real coding task can run for many minutes. |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before termination. |
| `disposeGraceMs` | `3000` | POSIX grace between SIGTERM and SIGKILL. |
| `progressLog` | `true` | Append each run's progress to `~/.dsh/logs/subagent-codebuddy/` (see above). |
| `toolName` | `subagent_codebuddy` | Model-facing name of the delegation tool. |
| `steerToolName` | `codebuddy_steer` | Model-facing name of the mid-run steering tool. |

Each child runs in the delegating session's workspace (the service resolves `request.cwd`); there is no separate `cwd` override.

## Failure reporting

The child's stderr is collected (bounded tail) instead of inherited, so a failed delegation explains itself in the settlement notice:

- a startup failure reports the transport error, the auth methods the child advertised when no `authMethodId` was configured, and the CLI's stderr tail;
- a child that finishes without any assistant text reports its stderr tail instead of only "it left no closing message";
- a wedged startup fails on `startupTimeoutMs` instead of holding the delegating tool call open.

## Known Limitations and Deferred Work

- **One-shot, but steerable** — no durable continuable children and no follow-up turn after settlement; each run is a fresh CLI process. While it runs, `codebuddy_steer` can still add a message.
- **Auth is the machine's CLI login state** unless `envFile` supplies an API key or `authMethodId` selects an advertised method.
- **Unattended approvals are auto-answered** (`permission: allow` by default); no prompt is surfaced to a human. Use `permission: reject` for a child that must stay read-only.
