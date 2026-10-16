# Pi in Codex

[简体中文](README.zh-CN.md) · MIT · macOS first

Independent Pi child conversations in the **current Codex chat**, with a live side
panel, mid-run steering, resumable history, and completion delivery at safe points.
Two chats in the same project have separate agents. These are not Codex native subagents.

## Install

Requirements: Node.js **22.19+**, an installed and configured **Pi 1.2.0+**, and a
Codex desktop host supporting MCP Apps conversation panels, per-call thread
metadata, and trusted plugin hooks. The development baseline is Codex
**26.1013.31256** / Pi **1.2.0**; a baseline is not a claim of full desktop acceptance.

From source:

```sh
npm ci
npm run check
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs install
```

Or unzip the release and run `node bin/pi-in-codex.mjs install` inside its folder.
The release bundles its dependencies; it still needs your own Node and Pi.

The installer copies the bundle to `~/.codex/plugins/pi-in-codex`, preserves other
entries in `~/.agents/plugins/marketplace.json`, and backs that catalog up before
editing it. Restart the desktop app, find **Pi in Codex** under the local plugin
source, install/enable it, and **review and trust its hooks**. Then start a new turn.
Open **Pi agents** from the current conversation panel, or ask Codex to call `pi_panel`.
Installing a plugin does not automatically trust its hooks.

The first release uses the `.codex-plugin/plugin.json` compatibility format,
verified against the baseline host. The installer resolves MCP and hook script
paths for that installation; run it instead of copying the source templates
directly into a plugin directory.

An isolated installation can be prepared with:

```sh
node bin/pi-in-codex.mjs install --codex-home /absolute/test-codex-home
```

Its catalog is `/absolute/test-codex-home/.agents/plugins/marketplace.json`. Add
that root with `codex plugin marketplace add /absolute/test-codex-home` if you
want the desktop to discover the isolated installation.

## Use

Ask Codex: “Use a Pi agent to inspect the authentication module. Give it the
relevant context, then continue working here.” The bundled skill teaches Codex
the workflow. The panel is read-only: inspect summaries and expand execution
history there. Codex sends instructions, answers Pi extension dialogs and stops
agents through tools in the parent chat; there are no panel input forms.

| Tool | Purpose |
|---|---|
| `pi_spawn` | Start a named task with explicit context, directory, and optional `{provider,id,thinking}` model |
| `pi_list` | List children of this chat |
| `pi_read` | Latest N messages (default 5, maximum 200), optional tools/partial text, `before` pagination |
| `pi_send` | Steer, queue `followUp`, or resume the same conversation |
| `pi_stop` | Interrupt execution, preserve history |
| `pi_wait` | Required custom `timeoutMs`, 0–3,600,000 (60 minutes); returns early on completion or input |
| `pi_ack` | Acknowledge completion IDs after the parent reads their results |
| `pi_reply` | Parent-chat response to a Pi extension input, selection or confirmation request |
| `pi_message` | Deliver information without starting an idle child |
| `pi_follow_up` | Explicitly start or queue another task |
| `pi_interrupt` | Abort a run while retaining a responsive process |
| `pi_events` | Read mailbox previews by cursor, or a full notice by eventId |
| `pi_result` | Page complete results by stable completionId, including older runs |
| `pi_models` | Discover models before spawning; optionally probe a selected model |
| `pi_archive` | Archive/restore settled tasks, preserving history and pending results |

Only `name` and `task` are required to create a child. Background stays explicit;
directory and Pi model defaults apply when omitted. Optional `profile` selects
worker/reviewer/explorer; inspection profiles restrict tools to
read/grep/find/ls/pi_report through an allowlist and extension gate, not an OS
sandbox. Optional task paths/groups support scoped aliases and filtering.
See [invocation and coordination semantics](docs/SUBAGENT_PARITY.md).

Only `pi_poll` is app-only; `pi_models` is also available to the parent.
Mutation tools are model-only. Completed tasks open on their final Markdown
summary; expand the **用时** disclosure to inspect calls and messages with history paging.
`?demo=1` on the development page shows simulated data;
it does not launch agents or prove the Codex host integration.

Before starting or resuming a Pi task, Codex estimates its duration and shares a
rough range. It chooses `pi_wait.timeoutMs` accordingly (for example, `600000`
for an estimated 5–10 minute task). The duration is a ceiling: an earlier result
ends the wait immediately and completion hooks deliver it at the next safe point.
Timeouts leave the task running. The plugin's MCP timeout includes the full hour;
hosts may enforce their own shorter limits.

User and assistant messages render Markdown, including tables, task lists, fenced
code, quotes and links. Commands and tool output remain literal and collapsible.
Raw HTML is disabled; Markdown images are links instead of automatic downloads.
Preview formatting at `/?demo=1&markdown=1` on the development server.

Only `agent_settled` ends a run. Accepted prompts, `agent_end`, retries, and
compaction do not. A completed conversation can be resumed with another message;
each run gets a new ID. Stopped/failed/interrupted results are marked partial.

## Completion delivery and persistence

The local daemon continues after the panel or MCP connection closes. It queues
completed results on disk. PostToolUse, Stop, UserPromptSubmit, and SessionStart
hooks deliver them to **their original parent chat** at safe points. A Stop hook
continues once for newly offered results; it never loops waiting for agents.
Idle parents are not woken up: their next turn receives the pending results.

Pi can use its injected `pi_report` tool for progress or blockers; extension input
requests also reach safe-point hooks. `pi_wait` supports runIds, afterCursor,
any/all completion modes and progress wakeups; reuse the cursor to skip old
results. `pi_ack` accepts eventIds and/or completionIds. Retry requestIds are
supported on spawn/send/message/follow_up; ambiguous crash deliveries are not
automatically replayed.

The parent acknowledges completion IDs with `pi_ack`. Results may be reoffered
on later turns until acknowledged; completion IDs make duplicate handling explicit.
Long results have a preview plus a `pi_result` reference. In a crash between handing
hook output to Codex and host consumption, the next turn can redeliver the result.

Default concurrency is four globally and two per chat, with fair scheduling.
Settled processes are released after 5 minutes and
restored from Pi sessions on demand. Restarting the daemon marks unfinished work
interrupted rather than silently replaying tasks. Reinstalling/upgrading or
uninstalling stops the old daemon and interrupts active runs.
An agent waiting for input occupies a concurrency slot until answered or stopped.

State and transcripts live in `${CODEX_HOME:-~/.codex}/pi_in_codex`. This contains
task text and tool output: treat it like your coding-agent transcript. The Unix
socket and data files are private to the local user. Pi reads credentials from
its own configuration; they are not exported to the panel. Pi executes with its
own tools and permissions, **not the Codex sandbox**. Agents share their selected
directory; divide write tasks to avoid concurrent edits.

## Configuration and troubleshooting

| Environment variable | Default |
|---|---|
| `PI_IN_CODEX_PI_PATH` | `pi` on PATH |
| `PI_IN_CODEX_NODE_PATH` | Node path recorded by the installer |
| `PI_IN_CODEX_DATA_DIR` | Codex user data directory + `pi_in_codex` |
| `PI_IN_CODEX_CONCURRENCY` | 4 (1–32) |
| `PI_IN_CODEX_CHAT_CONCURRENCY` | 2 (1–32) |
| `PI_CODING_AGENT_DIR` | Pi's own default (`~/.pi/agent`) |

The launcher prepends Node's bin directory and Homebrew paths to PATH. If Pi is
elsewhere, set `PI_IN_CODEX_PI_PATH` to its absolute executable path in your MCP
environment. Models and thinking levels come from Pi. Other provider credential
environment variables can be added to the manifest's `env_vars`; file-backed Pi
credentials require no copying.

Missing thread metadata fails explicitly; the plugin never guesses by directory,
last active window, or process-wide `CODEX_THREAD_ID`. Missing hook registration
asks you to enable/trust hooks and start another turn. If the host cannot expose
the thread entry point, tools remain usable, but desktop acceptance is incomplete.

```sh
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs daemon-stop
node bin/pi-in-codex.mjs uninstall
```

Uninstall removes only the marked plugin directory and its catalog entry. It
preserves transcripts. Daemon diagnostics are in the data directory's `daemon.log`.
Use a custom `--codex-home` again when uninstalling an isolated installation.

## Develop and package

```sh
npm run check
npm run dev:ui
# Open http://127.0.0.1:4173/?demo=1 for a UI preview
# /preview.html compares 380px light/dark panels
npm run pack:plugin
```

The ZIP is written to `release/pi-in-codex-0.1.0-macos.zip`. Tests exercise real
stdio/Unix-socket/MCP transports against a deterministic fake Pi, in addition to
manager and stream-framing tests. Live provider smoke tests are separate because
they use the user's model subscription. Desktop panel mounting, hook trust,
and two-window routing must also be checked in the installed desktop host.

Plugins containing hooks currently use manual installation rather than the public
plugin directory: [official packaging documentation](https://developers.openai.com/plugins/build/plugins).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `dist/DEPENDENCY_NOTICES.txt`
for retained license notices. No OpenAI desktop application code is included.
