# Pi in Codex

<p align="center">
  <img src="assets/pi-in-codex.svg" alt="Pi in Codex" width="280" />
</p>

<p align="center">
  <strong>Hand work to independent Pi agents while you keep coding in the current Codex chat.</strong>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#more-usage">More usage</a> ·
  <a href="#full-tool-list">Tools</a> ·
  <a href="#runtime-boundaries">Runtime boundaries</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="LICENSE">MIT License</a>
</p>

**Pi in Codex** runs separate Pi conversations for the Codex chat you are already
in. Codex keeps the main thread, an agent works on its own task in the same
project, and results come back at safe points instead of interrupting you. A
read-only side panel shows what each agent is doing.

Every agent is a real Pi session with its own model, credentials and tools. It
does not copy the parent transcript and it does not inherit the Codex sandbox.
Two chats in the same project get separate agents. These are not Codex native
subagents.

![Read-only Pi panel in light and dark themes (demo data)](docs/panel-preview.png)

*Preview with simulated data; the panel is read-only.*

## What it can do

| Capability | What it means for you |
| --- | --- |
| **Delegation without context loss** | Give an agent only the context you choose, then keep working in the parent chat. |
| **A live, read-only panel** | Summary first, process collapsed: tool calls, commands and messages load on demand, oldest first, up to 50 per view. |
| **Mid-run control** | Steer an agent while it runs, queue a follow-up, soft-interrupt it, or release the process. |
| **Multiple agents at once** | Default limits are 4 agents globally and 2 per chat, scheduled fairly. |
| **Delivery at safe points** | Completed results are handed to their original parent chat between turns, never forced into the middle of your work. |
| **Resumable history** | A finished conversation continues with one more message; archived tasks keep their transcripts. |
| **Scoped inspection** | Optional `reviewer` / `explorer` profiles restrict an agent to read-only tools. See the boundary note below. |
| **Model discovery** | Query the models and thinking levels your Pi install actually provides before spawning. |

## Quick start

You need three things: the **Codex desktop app**, a configured **Pi** install, and
this **plugin** with its hooks trusted.

| Component | Requirement |
| --- | --- |
| Host | macOS. Codex desktop with MCP Apps conversation panels, per-call thread metadata and trusted plugin hooks. Development baseline: Codex `26.1013.31256`. |
| Agent runtime | Pi **1.2.0+**, installed and configured with your own model credentials. |
| Node.js | **22.19+** (the installer records the Node path it uses). |
| Distribution | [Source repository](https://github.com/more-nico/pi-in-codex) or a prebuilt macOS bundle from [Releases](https://github.com/more-nico/pi-in-codex/releases). |

### 1. Install from source

```sh
git clone https://github.com/more-nico/pi-in-codex.git
cd pi-in-codex
npm ci
npm run check
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs install
```

For a prebuilt bundle, download `pi-in-codex-0.1.1-macos.zip` and `SHA256SUMS`
from [v0.1.1](https://github.com/more-nico/pi-in-codex/releases/tag/v0.1.1).
Keep both files in the same directory, then run:

```sh
shasum -a 256 -c SHA256SUMS
unzip pi-in-codex-0.1.1-macos.zip
cd pi-in-codex
node bin/pi-in-codex.mjs doctor
node bin/pi-in-codex.mjs install
```

The bundle includes its dependencies and documentation; it still needs your
Node and Pi installs. No `npm ci` or build step is needed for the bundle.

The installer copies the bundle to `~/.codex/plugins/pi-in-codex`, merges its entry
into `~/.agents/plugins/marketplace.json`, and backs that catalog up first. Always
install through the installer: it resolves the MCP and hook script paths for the
real location, so copying source templates into a plugin directory does not work.

<details>
<summary><b>Isolated test install</b></summary>

First check what a plain install would touch: `node bin/pi-in-codex.mjs doctor`.

```sh
node bin/pi-in-codex.mjs install --codex-home /absolute/test-codex-home
```

Its catalog lives at `/absolute/test-codex-home/.agents/plugins/marketplace.json`.
Add that root as a local plugin source in the desktop app if you want it to appear
there, and use the same `--codex-home` to uninstall it.

</details>

### 2. Enable the plugin and trust its hooks

Restart the Codex desktop app, find **Pi in Codex** under the local plugin source,
install and enable it, then **review and trust its hooks**, and start a new turn.
Enabling a plugin does not trust its hooks; without them there is no automatic
safe-point delivery, and the parent has to read results with `pi_read` or `pi_events`. Open **Pi agents** from the conversation panel, or ask
Codex to call `pi_panel`.

<!-- TODO: screenshot — plugin detail with hooks listed as trusted. -->

### 3. Try it with one sentence

> Use a Pi agent to inspect the authentication module. Give it the relevant
> context, then continue working here.

The bundled skill teaches Codex the workflow: estimate the work, spawn an agent
with the context it actually needs, and keep going in the parent chat. The panel
is read-only. Inspect summaries and expand execution history there; Codex sends
instructions, answers Pi extension dialogs and stops agents through tools in the
parent chat. There are no panel input forms.

After spawning or sending a message, Codex checks whether this chat's panel needs
opening. An existing panel updates in place and keeps the task you are reading.
On first open, running work takes priority over completed results.

Before starting or resuming a task, Codex estimates how long it will take and
shares a rough range. If a task looks like 5–10 minutes, it sets a matching
`pi_wait` ceiling such as `600000`. A result that arrives early ends the wait
immediately; a timeout leaves the task running.

## More usage

### Run agents in parallel

Ask for more than one agent in one turn. `name` is only a display label; later calls
take `agentId`, which is the UUID returned by `pi_spawn` or, once you set `path`,
that task path (unique inside this chat). Groups support filtering. Defaults are 4 agents globally and 2 per
chat, scheduled fairly. Agents share the directory you give them, so divide write
work explicitly instead of letting two agents edit the same files.

### Choose models and thinking levels

Models and thinking levels come from Pi, not from this plugin, and the list is
queried live rather than hard-coded. Ask Codex to call `pi_models` to see what your
Pi install offers, optionally probing one model before committing work, then pass
`{provider,id,thinking}` when spawning. Omitting `model` uses Pi's own defaults.
Other provider credential variables can be added to the manifest's `env_vars`;
file-backed Pi credentials need no copying and none of them reach the panel.

### Steer, follow up, interrupt

| Situation | What to ask for |
| --- | --- |
| Course-correct a running agent | `pi_send` in steer mode — the message lands in the current run. |
| Add work after the current task | `pi_send` in `followUp` mode, or `pi_follow_up` to start/queue another task. |
| Continue a finished conversation | `pi_send` or `pi_follow_up`; the session resumes and each run gets a new ID. |
| Abort a run but keep the process responsive | `pi_interrupt`. |
| Abort and release the process | `pi_stop`. |
| Hand over information, no new turn | `pi_message` — it does not wake an idle child. |

### Wait for results

`pi_wait` is the blocking tool, so its parameters are strict by design:

| Parameter | Behaviour |
| --- | --- |
| `agentIds` | Required. Which agents to wait for. |
| `timeoutMs` | Required, `0`–`3600000` (up to 60 minutes). This is a ceiling, not a poll interval. |
| `runIds` | Optional map of agent to run, when you want one specific run rather than the next one. |
| `afterCursor` | Cursor from a previous wait. Reuse it for consecutive waits so old results are skipped. |
| `mode` | `any` (default) or `all` decides which agents must settle; new messages and input requests also wake early. |

A wait can return early — on completion, on a new message, or when an agent needs a
parent answer to a Pi extension request. Only `agent_settled` ends a run; accepted prompts, `agent_end`, retries and
context compaction do not. Timeouts leave the task running. The plugin's own MCP
timeout covers the full hour, but the host may enforce a shorter limit.

Read results by cursor or by stable ID instead of re-asking the agent: `pi_events`
gives mailbox previews by cursor (or one full notice by `eventId`), `pi_result`
pages complete results by stable `completionId` including older runs, and `pi_ack`
acknowledges IDs once the parent has read them. Results may be reoffered on later
turns until acknowledged, so duplicates stay explicit; long results arrive as a
preview plus a `pi_result` reference. `requestId` de-duplication on
spawn/send/message/follow_up is best-effort idempotency, not exactly-once delivery.

An agent can also use its own `pi_report` tool to surface progress or a blocker to
the parent without ending its task; Pi extension input requests reach the same
safe-point hooks and Codex answers them with `pi_reply`. `pi_report` is a Pi-side
tool, not an eighteenth MCP tool.

## Full tool list

The plugin exposes **17 MCP tools**. Only `name` and `task` are required to create
an agent. `pi_poll` is app-only, `pi_models` is also available to the parent chat,
and mutation tools are model-only.

<details>
<summary><b>All 17 tools and what they do</b></summary>

| Tool | Purpose |
| --- | --- |
| `pi_spawn` | Start a named task with explicit context, directory and optional `{provider,id,thinking}` model |
| `pi_list` | List the children of this chat |
| `pi_read` | Latest N messages (default 5, maximum 200), optional tools/partial text, `before` pagination |
| `pi_send` | Steer a running agent (`steer`) or queue the next task (`followUp`) |
| `pi_stop` | Interrupt execution and release the process, history preserved |
| `pi_wait` | Wait on `agentIds` with a required `timeoutMs` (0–3,600,000); returns early on completion, a message, or an extension request |
| `pi_ack` | Acknowledge completion IDs after the parent has read their results |
| `pi_reply` | Parent-chat answer to a Pi extension input, selection or confirmation request |
| `pi_message` | Deliver information without starting an idle child |
| `pi_follow_up` | Explicitly start or queue another task |
| `pi_interrupt` | Abort a run while keeping a responsive process |
| `pi_events` | Read mailbox previews by cursor, or one full notice by `eventId` |
| `pi_result` | Page complete results by stable `completionId`, including older runs |
| `pi_models` | Discover models before spawning; optionally probe a selected model |
| `pi_archive` | Archive or restore settled tasks, keeping history and pending results |
| `pi_panel` | Open the read-only side panel for this chat |
| `pi_poll` | App-side poll used by the panel |

</details>

## Runtime boundaries

<details>
<summary><b>Where the work runs, and what is <i>not</i> isolated</b></summary>

- Each agent is its own Pi conversation. It does not copy the parent transcript
  and does not inherit the Codex sandbox; Pi runs with its own tools and
  permissions, configured with its own model credentials.
- Pi reads credentials from its own configuration. They are not exported to the
  panel and are not copied into this plugin.
- The local daemon keeps running after the panel or MCP connection closes.
  Completed results are queued on disk and delivered to **their original parent
  chat** at safe points by PostToolUse, Stop, UserPromptSubmit and SessionStart
  hooks. A Stop hook continues once for newly offered results; it never loops.
- Idle parent chats are not woken up: their next turn picks up pending results.
- Settled processes are released after 5 minutes and restored from Pi sessions on
  demand. Restarting the daemon marks unfinished work as interrupted instead of
  silently replaying it; reinstall, upgrade and uninstall stop the old daemon and
  interrupt active runs.
- `reviewer` and `explorer` are tool allowlists plus an extension gate, **not an
  operating-system sandbox**. Use them to keep an agent from writing, not to
  contain untrusted code.
- Missing thread metadata fails loudly. The plugin never guesses a chat by
  directory, last active window, or a process-wide `CODEX_THREAD_ID`.
- State and transcripts live in `${CODEX_HOME:-~/.codex}/pi_in_codex`, including
  task text and tool output. Treat that directory like your coding-agent
  transcript. Its socket and data files are private to the local user.

</details>

### Configuration

| Environment variable | Default |
| --- | --- |
| `PI_IN_CODEX_PI_PATH` | `pi` on PATH |
| `PI_IN_CODEX_NODE_PATH` | Node path recorded by the installer |
| `PI_IN_CODEX_DATA_DIR` | Codex user data directory + `pi_in_codex` |
| `PI_IN_CODEX_CONCURRENCY` | `4` (1–32) |
| `PI_IN_CODEX_CHAT_CONCURRENCY` | `2` (1–32) |
| `PI_CODING_AGENT_DIR` | Pi's own default (`~/.pi/agent`) |

The launcher prepends Node's bin directory and Homebrew paths to `PATH`. If Pi
lives elsewhere, set `PI_IN_CODEX_PI_PATH` to its absolute executable path in
your MCP environment. Models and thinking levels come from Pi.

### Upgrade and uninstall

```sh
node bin/pi-in-codex.mjs doctor        # environment and install checks
node bin/pi-in-codex.mjs daemon-stop   # stop the local daemon
node bin/pi-in-codex.mjs uninstall     # remove plugin + catalog entry
```

Uninstall removes only the marked plugin directory and its catalog entry and
preserves transcripts. Use the same `--codex-home` when uninstalling an isolated
installation. Daemon diagnostics are in `daemon.log` inside the data directory.
Reinstalling to upgrade stops the old daemon and interrupts active runs, so
settle or stop your agents first. The installer waits for actual shutdown before
replacing files. Clients compare build fingerprints, restart older daemons, and
refuse to downgrade a newer daemon. Restart Codex after upgrading so cached
clients refresh. `doctor` reports both build identities and compatibility.

## The panel

Summary first, process on demand. Completed tasks open on their final Markdown
summary; expand the **用时** collapse row to see tool calls and messages, loading older
history as needed.

- User and assistant messages render Markdown: tables, task lists, fenced code,
  quotes and links. Commands and tool output stay literal and collapsible.
- Up to 50 messages per view; older content loads as you page back.
- Raw HTML is disabled and Markdown images are links, not automatic downloads.
- The **子对话** task list in the top-right corner expands, collapses, and can be
  pinned as a floating overlay that stays up while you switch tasks.

The current source includes an unreleased performance update: panel refreshes
coalesce to about four per second, unchanged messages are reused, and collapsed
details mount on demand. Long content starts with an 8,000-character preview;
explicit reading uses 16,000-character pages while preserving the full original.
These changes do not throttle parent-chat completion delivery.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SUBAGENT_PARITY.md](docs/SUBAGENT_PARITY.md) | Invocation and coordination semantics, modes, profiles and parameters |
| [docs/INTERFACE.md](docs/INTERFACE.md) | Panel information, layout and interaction notes |
| [docs/VALIDATION.md](docs/VALIDATION.md) | What has been verified against the baseline host, and what has not |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Retained third-party license notices |
| [LICENSE](LICENSE) | MIT |

If hooks are not registered, enable and trust them, then start another turn. If
the host cannot expose the thread entry point, the tools still work but desktop
acceptance is incomplete.

## Development

```sh
npm run check      # typecheck + tests (the test script builds first)
npm run dev:ui     # panel preview on http://127.0.0.1:4173
npm run pack:plugin # plugin ZIP under release/
```

Open `http://127.0.0.1:4173/?demo=1` for simulated data — it does not launch
agents or prove the Codex host integration. `/preview.html` compares the 380px
light and dark panels; `/?demo=1&markdown=1` previews Markdown rendering. Tests
exercise real stdio, Unix-socket and MCP transports against a deterministic fake
Pi. Live provider smoke tests stay separate because they use your model
subscription, and panel mounting, hook trust and two-window routing must be
checked in the installed desktop host. The plugin ZIP is written under
`release/` (currently `pi-in-codex-0.1.1-macos.zip`).

See `dist/DEPENDENCY_NOTICES.txt` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for retained license notices.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
This is an independent community project, not affiliated with or endorsed by
OpenAI or Earendil. Product names and trademarks belong to their owners; the
MIT license does not grant trademark rights. The purple terminal artwork is
original project artwork, not the Codex logo.

No OpenAI desktop application code is included. Plugins that ship hooks currently
use manual installation rather than the public plugin directory; see
[official packaging documentation](https://developers.openai.com/plugins/build/plugins).
