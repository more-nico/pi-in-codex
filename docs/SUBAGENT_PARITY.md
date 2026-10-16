# Subagent invocation and behavior

Baseline: the collaboration tools exposed by Codex in this chat on 2026-10-16.
Codex tool families can vary by runtime; these are not ordinary sidebar chats.

| Creation input | Codex spawn_agent | pi_spawn |
| --- | --- | --- |
| Required | task_name, message | name, task |
| Background | fork_turns all/none; defaults to all in this runtime | Explicit context; parent transcript never copied |
| Model | Inherits parent unless overridden | Uses Pi defaults unless provider/id/thinking supplied |
| Directory | Parent execution environment | Parent cwd unless an absolute existing cwd supplied |
| Permissions/tools | Host-managed parent configuration | Pi's own configuration; optional inspection tool gate |
| Recommended task brief | Objective, boundaries, output and validation | Same, plus explicit background the parent wants to share |

Pi additionally accepts profile, path, group and an optional requestId retry key.
Creating Pi does not need a user-supplied threadId, credential or transcript.
The host supplies chat identity; Pi manages its own credentials.

## Coordination

- pi_message does not start an idle child. pi_follow_up explicitly starts/queues
  another task. pi_send remains backward compatible with steer/followUp/resume.
- pi_interrupt uses abort and retains a responsive process; pi_stop releases it.
- pi_report is injected as a Pi extension tool. Its notifications become durable,
  chat-scoped events. Input requests and completions enter the same mailbox.
- pi_wait accepts explicit timeoutMs up to one hour, runIds, afterCursor,
  mode any/all and wakeOnMessages. Reasons distinguish message/input/completed,
  replaced runs, timeout and cancellation. It never silently changes the run
  being awaited. Reuse the cursor to skip previously observed results.
- pi_events pages event previews; eventId retrieves a complete notice. pi_result
  pages full results by completionId, including older runs. pi_ack acknowledges
  eventIds/completionIds; acknowledging either completion representation covers
  both. Reading alone is not acknowledgment.
- Hooks deliver bounded batches at safe points; an idle parent is not woken.
  Unacknowledged notices can return on a later turn. This provides recoverable,
  at-least-once delivery, not exactly-once effects or native host notifications.

## Scheduling and lifecycle

The global default is four active agents, each chat defaults to two. Set
PI_IN_CODEX_CONCURRENCY and PI_IN_CODEX_CHAT_CONCURRENCY to override (1–32).
Eligible chats are scheduled by least recent service, FIFO within a chat.
Running jobs are not preempted. Waiting for input occupies a slot. Lists expose
queuePosition/queueReason without expanding transcripts.

Paths are unique aliases within a chat. pi_list supports pathPrefix/group.
pi_archive hides only settled agents by default, preserves history and pending
results, and releases idle resources. Restore with archived=false or an explicit
follow-up; pi_list includeArchived=true includes them.

## Inspection profiles

worker uses normal Pi tools. reviewer/explorer allow only read, grep, find, ls
and pi_report. Pi's CLI allowlist reduces exposed tools and a tool_call hook
blocks other model-issued/nested calls. The daemon checks the bridge handshake
before submitting a task, so a broken bridge fails without running the prompt.
These restrictions do not isolate files, credentials or the network from trusted
Pi extensions, and do not inherit or reproduce the Codex sandbox.

## Retry and recovery

requestId is supported on spawn/send/message/follow_up. Completed receipts replay
the original response for identical arguments, including across restarts. A key
with changed arguments is rejected. In-flight receipts restored after a crash
are uncertain and are not retried automatically; inspect pi_list/pi_read before
using a new key. A child/provider can still have performed work before a socket
or process failure, so exactly-once delivery is not claimed.
