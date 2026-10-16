import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { PiProcess } from './pi.js';
import { errorText } from './config.js';
import { validateWaitTimeout } from './wait.js';
import { ACTIVE, type Agent, type Completion, type MailEvent, type Message, type Parent, type PiRecord, type SpawnInput, type ToolCall } from './types.js';
import { profiles } from './profiles.js';

export interface ManagerOptions { executable?: string; prefixArgs?: string[]; maxConcurrent?: number; maxPerThread?: number; idleMs?: number; extraArgs?: string[]; extensionPath?: string }
export interface WaitOptions { runIds?: Record<string, string>; afterCursor?: string; mode?: 'any' | 'all'; wakeOnMessages?: boolean }
// The panel loads history in pages; snapshots carry only the newest window so
// polling never ships a full transcript. Keep this in sync with web/messages.ts.
const WINDOW = 50;
const MAX_ARGUMENT_LENGTH = 4_000;
const busy = (agent: Agent) => ['starting', 'running', 'waiting_input'].includes(agent.status);
const plain = (value: any): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
const messageText = (value: PiRecord): string => value.role === 'bashExecution' ? String(value.output ?? '')
  : value.role === 'branchSummary' || value.role === 'compactionSummary' ? String(value.summary ?? '') : plain(value.content);
const toolCalls = (value: PiRecord): ToolCall[] | undefined => Array.isArray(value.content)
  ? value.content.filter((block: any) => block?.type === 'toolCall' && typeof block.name === 'string').map((block: any) => ({
      id: String(block.id || ''), name: String(block.name),
      arguments: String(JSON.stringify(block.arguments ?? {})).slice(0, MAX_ARGUMENT_LENGTH),
    }))
  : undefined;
const actions: Record<string, string> = { read: 'reading', bash: 'running command', edit: 'editing', write: 'writing', grep: 'searching', find: 'finding files', ls: 'listing' };

export class Manager extends EventEmitter {
  private processes = new Map<string, PiProcess>();
  private idle = new Map<string, NodeJS.Timeout>();
  private revisions = new Map<string, number>();
  private agentRevisions = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();
  private saveTimer?: NodeJS.Timeout;
  private stopping = false;
  private persistenceError?: Error;
  private versionCheck?: Promise<void>;
  private activeRuns = new Map<string, { runId: string; started: boolean }>();
  private dispatching = new Set<string>();
  private settlements = new Map<string, { aborted: boolean }>();
  private dialogTimers = new Map<string, NodeJS.Timeout>();
  private revisionEpoch = randomUUID();
  private schedulingOrder = new Map<string, number>();
  private schedulingTurn = 0;
  constructor(readonly store: Store, private options: ManagerOptions = {}) { super(); }
  async init() {
    await this.store.load();
    for (const receipt of this.store.data.receipts) if (receipt.state === 'pending') receipt.state = 'uncertain';
    for (const agent of this.store.data.agents) {
      if (ACTIVE.has(agent.status)) {
        agent.status = 'interrupted'; agent.activity = 'interrupted'; agent.error = 'The daemon exited before this run settled. Send a message to resume.';
        agent.finishedAt = Date.now(); agent.dialogs = [];
        agent.undelivered = [...(agent.undelivered || []), ...agent.queued.splice(0).map(item => item.message)];
        this.addCompletion(agent, true);
      }
    }
    for (const result of this.store.data.completions) if (!this.store.data.events.some(event => event.completionId === result.id)) {
      this.mail(this.owned(result.threadId, result.agentId), 'completion', result.text, { completionId: result.id, acknowledged: result.acknowledged, runId: result.runId });
    }
    await this.store.save();
  }
  private assertHealthy() { if (this.persistenceError) throw new Error(`State persistence failed: ${this.persistenceError.message}`); }
  private async persist() { this.assertHealthy(); try { await this.store.save(); } catch (e) { this.persistenceError = e as Error; throw e; } }
  private changed(threadId: string, deferSave = true, agentId?: string) {
    const revision = (this.revisions.get(threadId) || 0) + 1;
    this.revisions.set(threadId, revision);
    for (const agent of this.store.data.agents) if (agent.threadId === threadId && (!agentId || agent.id === agentId)) this.agentRevisions.set(agent.id, revision);
    this.emit('change', threadId);
    if (deferSave && !this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.persist().catch(error => this.emit('diagnostic', errorText(error)));
    }, 100);
  }
  private cursor(threadId: string) { return `${this.revisionEpoch}:${this.revisions.get(threadId) || 0}`; }
  private owned(threadId: string, id: string) {
    const agent = this.store.data.agents.find(agent => agent.id === id && agent.threadId === threadId)
      || this.store.data.agents.find(agent => agent.path === id && agent.threadId === threadId);
    if (!agent) throw new Error('Agent not found in the current conversation');
    return agent;
  }
  parent(threadId: string) { return this.store.data.parents.find(parent => parent.threadId === threadId); }
  async register(parent: Parent) {
    const existing = this.parent(parent.threadId);
    if (existing) Object.assign(existing, parent); else this.store.data.parents.push(parent);
    await this.persist();
  }
  assertParent(threadId: string) {
    if (!this.parent(threadId)) throw new Error('This conversation has not been registered by trusted pi_in_codex hooks. Enable/trust the hooks, then start a new turn.');
  }
  async idempotent(threadId: string, method: string, args: Record<string, any>, action: () => Promise<any>) {
    if (!args.requestId) return action();
    const { requestId, ...payload } = args;
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.serial(`request:${threadId}:${method}:${requestId}`, async () => {
      const previous = this.store.data.receipts.find(item => item.threadId === threadId && item.method === method && item.key === requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('requestId was already used with different arguments');
        if (previous.state !== 'completed') throw new Error('Previous delivery is uncertain. Inspect pi_list/pi_read before explicitly submitting a new requestId; it was not replayed.');
        return previous.result;
      }
      const receipt = { threadId, method, key: requestId, fingerprint, state: 'pending' as 'pending' | 'completed' | 'uncertain', result: undefined as any };
      this.store.data.receipts.push(receipt); await this.persist();
      try { receipt.result = await action(); receipt.state = 'completed'; await this.persist(); return receipt.result; }
      catch (error) { receipt.state = 'uncertain'; await this.persist(); throw error; }
    });
  }
  private mail(agent: Agent, kind: MailEvent['kind'], text: string, extra: Partial<MailEvent> = {}) {
    const sequence = this.store.data.events.filter(event => event.threadId === agent.threadId).at(-1)?.sequence || 0;
    const event: MailEvent = { id: randomUUID(), sequence: sequence + 1, threadId: agent.threadId, agentId: agent.id, runId: agent.runId,
      name: agent.name, kind, text: text.slice(0, 12_000), createdAt: Date.now(), acknowledged: false, ...extra };
    this.store.data.events.push(event); return event;
  }
  private mailSequence(threadId: string, cursor?: string) {
    const latest = this.store.data.events.filter(event => event.threadId === threadId).at(-1)?.sequence || 0;
    if (!cursor) return 0;
    const match = /^mailbox:(\d+)$/.exec(cursor), value = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(value) || value > latest) throw new Error('Invalid mailbox cursor; call pi_events without a cursor to resynchronize');
    return value;
  }
  events(threadId: string, afterCursor?: string, limit = 50, eventId?: string) {
    this.assertParent(threadId); const after = this.mailSequence(threadId, afterCursor);
    if (eventId) {
      const event = this.store.data.events.find(event => event.id === eventId && event.threadId === threadId);
      if (!event) throw new Error('Event not found in the current conversation');
      return { events: [event], cursor: `mailbox:${event.sequence}`, hasMore: false };
    }
    const pending = this.store.data.events.filter(event => event.threadId === threadId && event.sequence > after);
    const events = pending.slice(0, limit);
    return { events: events.map(event => ({ ...event, text: event.text.slice(0, 500), truncated: event.text.length > 500 })), cursor: `mailbox:${events.at(-1)?.sequence ?? after}`, hasMore: pending.length > limit };
  }
  private queueInfo(agent: Agent) {
    if (agent.status !== 'queued') return {};
    const active = this.store.data.agents.filter(busy);
    return { queuePosition: this.store.data.agents.filter(item => item.threadId === agent.threadId && item.status === 'queued').findIndex(item => item.id === agent.id) + 1,
      queueReason: active.filter(item => item.threadId === agent.threadId).length >= (this.options.maxPerThread ?? 2) ? 'chat_limit'
        : active.length >= (this.options.maxConcurrent ?? 4) ? 'global_limit' : 'fair_queue' };
  }
  list(threadId: string, options: { pathPrefix?: string; group?: string; includeArchived?: boolean } = {}) {
    this.assertParent(threadId);
    return { cursor: this.cursor(threadId), pendingCompletions: this.store.data.completions.filter(result => result.threadId === threadId && !result.acknowledged).length,
      agents: this.store.data.agents.filter(agent => agent.threadId === threadId && (options.includeArchived || !agent.archivedAt)
        && (!options.group || agent.group === options.group) && (!options.pathPrefix || agent.path === options.pathPrefix || agent.path?.startsWith(options.pathPrefix + '/')))
        .map(agent => { const result = this.store.data.completions.findLast(item => item.runId === agent.runId);
          return { agentId: agent.id, id: agent.id, name: agent.name, runId: agent.runId, status: agent.status, activity: agent.activity,
            cwd: agent.cwd, model: agent.model, profile: agent.profile || 'worker', path: agent.path, group: agent.group, archivedAt: agent.archivedAt,
            createdAt: agent.createdAt, startedAt: agent.startedAt, finishedAt: agent.finishedAt, error: agent.error,
            messageCount: agent.messages.length, queuedMessages: agent.queued.length, inboxCount: agent.inbox?.length || 0,
            dialogs: agent.dialogs, tokens: agent.tokens, toolUses: agent.toolUses, ...this.queueInfo(agent),
            completionId: result?.id, resultPreview: result?.text.slice(0, 240), resultTruncated: !!result && result.text.length > 240 };
        }) };
  }
  snapshot(threadId: string) {
    this.assertParent(threadId);
    return {
      cursor: this.cursor(threadId),
      full: true,
      agents: this.store.data.agents.filter(agent => agent.threadId === threadId).map(agent => ({ ...agent, ...this.queueInfo(agent), messageTotal: agent.messages.length, messages: agent.messages.slice(-WINDOW),
        finalText: agent.status === 'completed' ? this.store.data.completions.findLast(result => result.agentId === agent.id && result.runId === agent.runId)?.text : undefined })),
      pendingCompletions: this.store.data.completions.filter(result => result.threadId === threadId && !result.acknowledged).length,
    };
  }
  async poll(threadId: string, cursor?: string, waitMs = 20_000, signal?: AbortSignal) {
    this.assertParent(threadId);
    if (cursor === this.cursor(threadId) && waitMs > 0 && !signal?.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.off('change', onChange); signal?.removeEventListener('abort', finish); resolve(); };
      const onChange = (changed: string) => { if (threadId === changed) finish(); };
      const timer = setTimeout(finish, Math.min(25_000, waitMs));
      this.on('change', onChange); signal?.addEventListener('abort', finish, { once: true });
      if (cursor !== this.cursor(threadId) || signal?.aborted) finish();
    });
    const snapshot = this.snapshot(threadId);
    const prefix = `${this.revisionEpoch}:`;
    if (!cursor?.startsWith(prefix)) return snapshot;
    const previous = Number(cursor.slice(prefix.length));
    if (!Number.isSafeInteger(previous) || previous < 0 || previous > (this.revisions.get(threadId) || 0)) return snapshot;
    return { ...snapshot, full: false, agents: snapshot.agents.filter(agent => (this.agentRevisions.get(agent.id) || 0) > previous) };
  }
  async spawn(threadId: string, input: SpawnInput) {
    this.assertHealthy(); this.assertParent(threadId);
    const cwd = input.cwd || this.parent(threadId)!.cwd;
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('cwd must be an existing absolute directory');
    if (input.path && this.store.data.agents.some(agent => agent.threadId === threadId && agent.path === input.path)) throw new Error('Task path already exists in this chat');
    const now = Date.now();
    const agent: Agent = { id: randomUUID(), threadId, name: input.name, task: input.task, context: input.context,
      cwd, model: input.model, status: 'queued', runId: randomUUID(), createdAt: now, activity: 'queued',
      messages: [], tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0, inbox: [], profile: input.profile || 'worker', path: input.path, group: input.group };
    this.store.data.agents.push(agent);
    await this.persist(); this.changed(threadId, false); this.pump();
    return { agentId: agent.id, runId: agent.runId, status: agent.status };
  }
  private pump() {
    if (this.stopping) return;
    while (this.store.data.agents.filter(busy).length < (this.options.maxConcurrent ?? 4)) {
      const active = this.store.data.agents.filter(busy);
      const eligible = this.store.data.agents.filter(agent => agent.status === 'queued' && active.filter(item => item.threadId === agent.threadId).length < (this.options.maxPerThread ?? 2));
      const threads = [...new Set(eligible.map(agent => agent.threadId))];
      const thread = threads.sort((a, b) => (this.schedulingOrder.get(a) || 0) - (this.schedulingOrder.get(b) || 0))[0];
      const agent = eligible.find(agent => agent.threadId === thread);
      if (!agent) break;
      this.schedulingOrder.set(agent.threadId, ++this.schedulingTurn);
      agent.status = 'starting'; agent.activity = 'starting'; agent.startedAt = Date.now();
      this.changed(agent.threadId);
      const runId = agent.runId;
      this.serial(agent.id, () => this.start(agent)).catch(error => {
        if (agent.runId === runId && ACTIVE.has(agent.status)) {
          const pi = this.processes.get(agent.id); this.processes.delete(agent.id); if (pi) void pi.close();
          this.finish(agent, 'failed', errorText(error));
        }
      });
    }
  }
  private async start(agent: Agent) {
    let pi = this.processes.get(agent.id);
    const timer = this.idle.get(agent.id); if (timer) { clearTimeout(timer); this.idle.delete(agent.id); }
    if (!pi) {
      if (!this.versionCheck) this.versionCheck = (async () => {
        const executable = this.options.executable || process.env.PI_IN_CODEX_PI_PATH || 'pi';
        const { stdout } = await promisify(execFile)(executable, [...(this.options.prefixArgs || []), '--version'], { timeout: 10_000 });
        const match = stdout.trim().match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
        if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 2)) throw new Error('pi >= 1.2.0 is required for agent_settled and the current RPC protocol');
      })();
      await this.versionCheck;
      if (!ACTIVE.has(agent.status) || this.stopping) return;
      const sessionDir = join(this.store.root, 'sessions', agent.id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      if (!ACTIVE.has(agent.status) || this.stopping) return;
      const args = [...(this.options.prefixArgs || []), '--mode', 'rpc', '--extension', this.options.extensionPath || fileURLToPath(new URL('./parent.mjs', import.meta.url)), '--session-dir', sessionDir,
        '--append-system-prompt', `Agent profile (${agent.profile || 'worker'}): ${profiles[agent.profile || 'worker'].instructions}\nUse pi_report to report progress or blockers to the parent without ending your task.`,
        ...(profiles[agent.profile || 'worker'].tools ? ['--tools', profiles[agent.profile || 'worker'].tools!.join(',')] : []),
        ...(agent.sessionFile ? ['--session', agent.sessionFile] : ['--session-id', agent.id]), '--name', agent.name,
        ...(this.options.extraArgs || [])];
      pi = new PiProcess(this.options.executable || process.env.PI_IN_CODEX_PI_PATH || 'pi', args, agent.cwd,
        { PI_IN_CODEX_ALLOWED_TOOLS: profiles[agent.profile || 'worker'].tools ? JSON.stringify(profiles[agent.profile || 'worker'].tools) : undefined });
      this.processes.set(agent.id, pi);
      const ownedProcess = pi;
      let bridgeReady = false;
      pi.on('record', (record: PiRecord) => {
        if (this.processes.get(agent.id) !== ownedProcess) return;
        if (record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'pi_in_codex_ready') { bridgeReady = true; return; }
        this.onRecord(agent, record);
      });
      pi.on('fault', (error: Error) => { if (this.processes.get(agent.id) === ownedProcess && ACTIVE.has(agent.status)) { this.finish(agent, 'failed', errorText(error)); void ownedProcess.close(); } });
      pi.on('closed', (error?: Error) => {
        if (this.processes.get(agent.id) !== ownedProcess) return;
        this.processes.delete(agent.id);
        if (error && ACTIVE.has(agent.status)) this.finish(agent, 'failed', errorText(error));
      });
      const state = await pi.command('get_state');
      if (!bridgeReady) throw new Error('Pi parent bridge did not load. No task was submitted; check extension compatibility.');
      if (typeof state.sessionFile === 'string') agent.sessionFile = state.sessionFile;
      if (agent.model) await pi.command('set_model', { provider: agent.model.provider, modelId: agent.model.id });
      const effective = await pi.command('get_state');
      const thinking = agent.model?.thinking || effective.thinkingLevel;
      const levels = await pi.command('get_available_thinking_levels');
      if (thinking && !levels.levels?.includes(thinking)) throw new Error(`Thinking level ${thinking} is unavailable for this pi model`);
      if (agent.model?.thinking) await pi.command('set_thinking_level', { level: agent.model.thinking });
      if (effective.model) agent.model = { provider: effective.model.provider, id: effective.model.id, thinking };
    }
    if (!ACTIVE.has(agent.status) || this.stopping) return;
    agent.status = 'running'; agent.activity = 'connecting';
    await this.persist(); this.changed(agent.threadId, false);
    const pendingInbox = [...(agent.inbox || [])];
    const message = [agent.task, agent.context ? `Context supplied by the parent conversation:\n${agent.context}` : '',
      pendingInbox.length ? `Messages left by the parent while idle:\n${pendingInbox.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
    this.activeRuns.set(agent.id, { runId: agent.runId, started: false });
    this.dispatching.add(agent.id);
    try {
      const accepted = await pi.command('prompt', { message });
      agent.inbox?.splice(0, pendingInbox.length);
      if (accepted?.disposition === 'handled' && ACTIVE.has(agent.status)) {
        // An extension may consume input without starting a run. Do not invent completion.
        agent.status = 'waiting_input'; agent.activity = 'input handled by pi extension; send another message or stop'; this.changed(agent.threadId);
        this.mail(agent, 'input', 'Pi extension handled the input without starting a run. Send a new instruction or stop the task.');
      }
      while (agent.queued.length) {
        const input = agent.queued[0];
        // prompt+streamingBehavior also starts work if Pi became idle before
        // reading this command, avoiding a stranded steer/follow_up queue.
        await pi.command('prompt', { message: input.message, streamingBehavior: input.mode });
        if (agent.queued[0] === input) agent.queued.shift();
        await this.persist();
      }
    } finally { this.dispatching.delete(agent.id); await this.flushSettlement(agent, pi); }
  }
  private message(agent: Agent, value: PiRecord, complete: boolean) {
    const role = value.role || 'assistant';
    const current = agent.messages.at(-1);
    const message: Message = { id: current && !current.complete && current.role === role ? current.id : randomUUID(), runId: agent.runId,
      role, text: messageText(value), timestamp: value.timestamp || Date.now(), complete,
      toolName: value.toolName, toolCallId: value.toolCallId, toolCalls: role === 'assistant' ? toolCalls(value) : undefined,
      command: role === 'bashExecution' ? String(value.command ?? '') : undefined,
      isError: typeof value.isError === 'boolean' ? value.isError : undefined,
      error: value.errorMessage ? errorText(value.errorMessage) : undefined };
    if (current && !current.complete && current.role === role) agent.messages[agent.messages.length - 1] = message;
    else agent.messages.push(message);
    if (role === 'assistant' && complete) {
      if (value.stopReason === 'error' || value.stopReason === 'aborted') message.error ||= value.stopReason;
      agent.tokens += Number(value.usage?.totalTokens || 0);
    }
  }
  private onRecord(agent: Agent, event: PiRecord) {
    if (!ACTIVE.has(agent.status) || agent.status === 'queued') return;
    switch (event.type) {
      case 'agent_start': {
        const generation = this.activeRuns.get(agent.id);
        if (!generation || generation.runId !== agent.runId) return;
        this.settlements.delete(agent.id);
        generation.started = true; agent.status = agent.dialogs.length ? 'waiting_input' : 'running'; agent.activity = 'thinking'; break;
      }
      case 'message_start': this.message(agent, event.message, false); break;
      case 'message_update': {
        const update = event.assistantMessageEvent || {};
        if (update.type === 'text_delta') {
          if (!agent.messages.at(-1) || agent.messages.at(-1)!.complete || agent.messages.at(-1)!.role !== 'assistant') this.message(agent, { role: 'assistant', content: [] }, false);
          agent.messages.at(-1)!.text += update.delta || ''; agent.activity = 'responding';
        } else if (update.type?.startsWith('thinking')) agent.activity = 'thinking';
        break;
      }
      case 'message_end': this.message(agent, event.message, true); break;
      case 'tool_execution_start': agent.activity = actions[event.toolName] || `using ${event.toolName}`; agent.toolUses++; break;
      case 'tool_execution_end': agent.activity = 'thinking'; break;
      case 'compaction_start': agent.activity = 'compacting'; break;
      case 'compaction_end': agent.activity = event.willRetry ? 'retrying' : 'thinking'; break;
      case 'auto_retry_start': agent.activity = `retrying (${event.attempt}/${event.maxAttempts})`; break;
      case 'auto_retry_end': agent.activity = event.success ? 'thinking' : 'retry failed'; break;
      case 'summarization_retry_scheduled': agent.activity = 'retrying compaction'; break;
      case 'queue_update': agent.pendingMessages = (event.steering?.length || 0) + (event.followUp?.length || 0); break;
      case 'extension_ui_request':
        if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
          agent.dialogs.push({ id: event.id, method: event.method, title: event.title, message: event.message, options: event.options,
            placeholder: event.placeholder, prefill: event.prefill, expiresAt: typeof event.timeout === 'number' ? Date.now() + event.timeout : undefined });
          agent.status = 'waiting_input'; agent.activity = 'waiting for input';
          this.mail(agent, 'input', String(event.message || event.title || 'Pi needs input'), { requestId: event.id });
          if (event.timeout) {
            const id = event.id, runId = agent.runId, key = `${agent.id}:${id}`;
            const timeout = setTimeout(() => {
              this.dialogTimers.delete(key);
              if (agent.runId !== runId || !agent.dialogs.some(dialog => dialog.id === id)) return;
              agent.dialogs = agent.dialogs.filter(dialog => dialog.id !== id);
              if (agent.status === 'waiting_input' && !agent.dialogs.length) { agent.status = 'running'; agent.activity = 'thinking'; }
              this.changed(agent.threadId);
            }, event.timeout);
            this.dialogTimers.set(key, timeout);
            timeout.unref();
          }
        } else if (event.method === 'notify') {
          const text = String(event.message || '');
          if (text.startsWith('pi_in_codex_report:')) {
            try {
              const report = JSON.parse(text.slice('pi_in_codex_report:'.length));
              if (typeof report.message === 'string' && report.message.trim()) this.mail(agent, 'message', report.message);
            } catch { /* malformed child reports are data, not protocol commands */ }
          } else agent.activity = text.slice(0, 250);
        }
        break;
      case 'agent_settled': {
        const generation = this.activeRuns.get(agent.id);
        if (!generation?.started || generation.runId !== agent.runId) return;
        if (this.dispatching.has(agent.id)) this.settlements.set(agent.id, { aborted: Boolean(event.aborted) });
        else this.completeSettled(agent, Boolean(event.aborted));
        return;
      }
    }
    this.changed(agent.threadId, true, agent.id);
  }
  private addCompletion(agent: Agent, partial: boolean) {
    if (this.store.data.completions.some(result => result.runId === agent.runId)) return;
    const last = agent.messages.findLast(message => message.runId === agent.runId && message.role === 'assistant');
    const result: Completion = { id: randomUUID(), agentId: agent.id, runId: agent.runId, threadId: agent.threadId, name: agent.name,
      status: agent.status, text: last?.text || agent.error || '(No assistant text was produced in this run.)', partial,
      createdAt: Date.now(), acknowledged: false };
    this.store.data.completions.push(result);
    this.mail(agent, 'completion', result.text, { completionId: result.id });
  }
  private finish(agent: Agent, status: Agent['status'], error?: string) {
    if (!ACTIVE.has(agent.status)) return;
    this.activeRuns.delete(agent.id);
    this.settlements.delete(agent.id);
    for (const [key, timer] of this.dialogTimers) if (key.startsWith(agent.id + ':')) { clearTimeout(timer); this.dialogTimers.delete(key); }
    agent.status = status; agent.activity = status; agent.error = error; agent.finishedAt = Date.now(); agent.dialogs = []; agent.pendingMessages = 0;
    for (const event of this.store.data.events) if (event.agentId === agent.id && event.runId === agent.runId && event.kind === 'input') event.acknowledged = true;
    if (status !== 'completed' && agent.queued.length) {
      agent.undelivered = [...(agent.undelivered || []), ...agent.queued.splice(0).map(item => item.message)];
      agent.error = `${agent.error || status}. ${agent.undelivered.length} queued message(s) were not confirmed delivered; inspect pi_read before resending.`;
    }
    this.addCompletion(agent, status !== 'completed'); this.changed(agent.threadId);
    const timeout = setTimeout(() => { this.idle.delete(agent.id); const pi = this.processes.get(agent.id); this.processes.delete(agent.id); if (pi) void pi.close(); }, this.options.idleMs ?? 300_000);
    timeout.unref(); this.idle.set(agent.id, timeout); this.pump();
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(id, next); next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }
  async send(threadId: string, id: string, message: string, mode: 'steer' | 'followUp' = 'steer') {
    const requested = this.owned(threadId, id), requestedRun = requested.runId, requestedActive = ACTIVE.has(requested.status);
    id = requested.id;
    return this.serial(id, async () => {
      this.assertHealthy(); const agent = this.owned(threadId, id);
      if (requestedActive && (requestedRun !== agent.runId || agent.status === 'stopped')) throw new Error('The run was stopped or replaced before this message could be sent; resend explicitly if needed');
      if (agent.status === 'queued' || agent.status === 'starting') agent.queued.push({ message, mode });
      else if (busy(agent)) {
        const pi = this.processes.get(id); if (!pi) throw new Error('pi process unavailable');
        this.dispatching.add(agent.id);
        try {
          const accepted = await pi.command('prompt', { message, streamingBehavior: mode });
          if (accepted?.disposition === 'started') { agent.status = 'running'; agent.activity = 'thinking'; }
        } finally { this.dispatching.delete(agent.id); await this.flushSettlement(agent, pi); }
      } else this.prepareResume(agent, message);
      await this.persist(); this.changed(threadId, false); this.pump();
      return { agentId: id, runId: agent.runId, status: agent.status, mode };
    });
  }
  async messageParentToChild(threadId: string, target: string, message: string) {
    const requested = this.owned(threadId, target);
    return this.serial(requested.id, async () => {
      this.assertHealthy(); const agent = this.owned(threadId, requested.id);
      if (agent.status === 'queued' || agent.status === 'starting') agent.queued.push({ message, mode: 'steer' });
      else if (busy(agent)) {
        const pi = this.processes.get(agent.id); if (!pi) throw new Error('pi process unavailable');
        // Unlike prompt+streamingBehavior, steer never starts a new idle turn.
        await pi.command('steer', { message });
      } else { agent.inbox ||= []; agent.inbox.push(message); }
      await this.persist(); this.changed(threadId, false);
      return { agentId: agent.id, runId: agent.runId, status: agent.status, inboxCount: agent.inbox?.length || 0, started: false };
    });
  }
  read(threadId: string, id: string, limit = 5, includeTools = false, includePartial = true, before?: string) {
    const agent = this.owned(threadId, id);
    const end = before ? agent.messages.findIndex(message => message.id === before) : agent.messages.length;
    if (end < 0) throw new Error('Unknown message cursor');
    const eligible = agent.messages.slice(0, end).filter(message => (includeTools || ['user', 'assistant'].includes(message.role)) && (includePartial || message.complete));
    return { agentId: agent.id, runId: agent.runId, status: agent.status, messages: eligible.slice(-limit), hasMore: eligible.length > limit, undeliveredMessages: agent.undelivered || [], inbox: agent.inbox || [] };
  }
  async interrupt(threadId: string, id: string) {
    const agent = this.owned(threadId, id), pi = this.processes.get(agent.id);
    const runId = agent.runId;
    if (!ACTIVE.has(agent.status)) return { agentId: agent.id, status: agent.status, processRetained: !!pi };
    if (!pi || agent.status === 'starting' || agent.status === 'queued') return this.stop(threadId, agent.id);
    try {
      await pi.command('abort', {}, 1500);
      if (agent.runId !== runId) return { agentId: agent.id, status: agent.status, superseded: true };
      const state = await pi.command('get_state', {}, 1500);
      if (agent.runId !== runId) return { agentId: agent.id, status: agent.status, superseded: true };
      if (state.isStreaming || state.isCompacting) return this.stop(threadId, agent.id);
      this.finish(agent, 'stopped'); await this.persist();
      return { agentId: agent.id, status: agent.status, processRetained: this.processes.get(agent.id) === pi };
    } catch { return agent.runId === runId ? this.stop(threadId, agent.id) : { agentId: agent.id, status: agent.status, superseded: true }; }
  }
  async stop(threadId: string, id: string) {
    // Cancellation must bypass startup/prompt locks; Pi may be waiting for UI input.
    const agent = this.owned(threadId, id);
    id = agent.id;
    if (ACTIVE.has(agent.status)) {
      this.finish(agent, 'stopped');
    }
    const pi = this.processes.get(id); this.processes.delete(id);
    const timer = this.idle.get(id); if (timer) clearTimeout(timer); this.idle.delete(id);
    if (pi) await pi.close();
    await this.persist();
    return { agentId: id, status: agent.status };
  }
  private prepareResume(agent: Agent, message: string) {
    agent.runId = randomUUID(); agent.task = message; agent.context = undefined; agent.status = 'queued';
    agent.activity = 'queued'; agent.error = undefined; agent.finishedAt = undefined;
    agent.archivedAt = undefined;
  }
  private completeSettled(agent: Agent, aborted: boolean) {
    const last = agent.messages.findLast(message => message.runId === agent.runId && message.role === 'assistant');
    this.finish(agent, aborted ? 'stopped' : last?.error ? 'failed' : 'completed', last?.error);
  }
  private async flushSettlement(agent: Agent, pi: PiProcess) {
    const candidate = this.settlements.get(agent.id);
    if (!candidate || !ACTIVE.has(agent.status)) return;
    // A round trip observes whether an input accepted across a settlement
    // boundary has already started another automatic run.
    const state = await pi.command('get_state');
    if (this.settlements.get(agent.id) !== candidate) return;
    this.settlements.delete(agent.id);
    if (!state.isStreaming && !state.isCompacting && !state.pendingMessageCount) this.completeSettled(agent, candidate.aborted);
  }
  async reply(threadId: string, id: string, requestId: string, value?: string, confirmed?: boolean, cancelled = false) {
    // Startup extensions can ask for input before get_state resolves. Replies
    // must not queue behind that unresolved startup request.
    const agent = this.owned(threadId, id), dialog = agent.dialogs.find(dialog => dialog.id === requestId);
    const pi = this.processes.get(agent.id); if (!dialog || !pi) throw new Error('This input request has expired');
    if (dialog.expiresAt && dialog.expiresAt <= Date.now()) throw new Error('This input request has expired');
    if (!cancelled && dialog.method === 'select' && !dialog.options?.includes(value || '')) throw new Error('Choose one of the supplied options');
    if (!cancelled && dialog.method === 'confirm' && typeof confirmed !== 'boolean') throw new Error('An explicit confirmation choice is required');
    if (!cancelled && ['input', 'editor'].includes(dialog.method) && typeof value !== 'string') throw new Error('An input value is required');
    agent.dialogs = agent.dialogs.filter(dialog => dialog.id !== requestId);
    try { await pi.write({ type: 'extension_ui_response', id: requestId, value, confirmed, cancelled }); }
    catch (error) { if (ACTIVE.has(agent.status) && this.processes.get(agent.id) === pi) agent.dialogs.push(dialog); throw error; }
    if (!agent.dialogs.length && ACTIVE.has(agent.status)) { agent.status = 'running'; agent.activity = 'thinking'; }
    for (const event of this.store.data.events) if (event.agentId === agent.id && event.runId === agent.runId && event.requestId === requestId) event.acknowledged = true;
    const timerKey = `${agent.id}:${requestId}`, timer = this.dialogTimers.get(timerKey);
    if (timer) { clearTimeout(timer); this.dialogTimers.delete(timerKey); }
    await this.persist(); this.changed(threadId, false); return { accepted: true };
  }
  async wait(threadId: string, ids: string[], timeoutMs = 20_000, signal?: AbortSignal, options: WaitOptions = {}) {
    validateWaitTimeout(timeoutMs); this.assertParent(threadId);
    if (options.runIds && Object.keys(options.runIds).some(id => !ids.includes(id))) throw new Error('runIds must refer to selected agents');
    const targets = ids.map(id => { const agent = this.owned(threadId, id); return { agent, runId: options.runIds?.[id] || agent.runId }; });
    const after = this.mailSequence(threadId, options.afterCursor);
    const notices = () => this.store.data.events.filter(event => event.threadId === threadId && event.sequence > after
      && targets.some(target => target.agent.id === event.agentId && target.runId === event.runId));
    const reason = (): 'completed' | 'input' | 'message' | 'replaced' | undefined => {
      if (targets.some(target => target.agent.runId !== target.runId)) return 'replaced';
      const fresh = notices().filter(event => !event.acknowledged);
      if (fresh.some(event => event.kind === 'input' && targets.some(target => target.agent.id === event.agentId && (event.requestId ? target.agent.dialogs.some(dialog => dialog.id === event.requestId) : target.agent.status === 'waiting_input')))) return 'input';
      const complete = targets.map(target => !ACTIVE.has(target.agent.status));
      if ((options.mode === 'all' ? complete.every(Boolean) : complete.some(Boolean)) && fresh.some(event => event.kind === 'completion')) return 'completed';
      if (options.wakeOnMessages !== false && fresh.some(event => event.kind === 'message')) return 'message';
      return undefined;
    };
    const deadline = Date.now() + timeoutMs;
    let revision = this.cursor(threadId), outcome = reason();
    while (!outcome && Date.now() < deadline && !signal?.aborted) {
      await this.poll(threadId, revision, Math.min(25_000, deadline - Date.now()), signal);
      revision = this.cursor(threadId); outcome = reason();
    }
    const pending = notices(), events = pending.slice(0, 20);
    let resultBudget = 16_000;
    return { reason: signal?.aborted ? 'cancelled' : outcome || 'timeout', timedOut: !outcome && !signal?.aborted,
      cursor: `mailbox:${events.at(-1)?.sequence ?? after}`, hasMore: pending.length > events.length,
      events: events.map(event => ({ ...event, text: event.text.slice(0, 500), truncated: event.text.length > 500 })),
      agents: targets.map(({ agent, runId }) => {
        const result = this.store.data.completions.findLast(result => result.runId === runId && result.agentId === agent.id);
        const preview = result?.text.slice(0, Math.min(4000, resultBudget)); resultBudget -= preview?.length || 0;
        return { agentId: agent.id, runId, currentRunId: agent.runId, status: agent.status, dialogs: agent.dialogs,
          ...(result ? { result: { ...result, text: preview!, truncated: result.text.length > preview!.length, totalChars: result.text.length } } : {}) };
      }) };
  }
  result(threadId: string, id: string, offset = 0, maxChars = 12_000) {
    const result = this.store.data.completions.find(result => result.id === id && result.threadId === threadId);
    if (!result) throw new Error('Completion not found in the current conversation');
    return { ...result, text: result.text.slice(offset, offset + maxChars), offset, totalChars: result.text.length,
      nextOffset: offset + maxChars < result.text.length ? offset + maxChars : undefined };
  }
  async acknowledge(threadId: string, ids: string[], eventIds: string[] = []) {
    for (const id of ids) if (!this.store.data.completions.some(result => result.id === id && result.threadId === threadId)) throw new Error('Completion not found in the current conversation');
    for (const id of eventIds) if (!this.store.data.events.some(event => event.id === id && event.threadId === threadId)) throw new Error('Event not found in the current conversation');
    const completions = new Set([...ids, ...this.store.data.events.filter(event => event.threadId === threadId && eventIds.includes(event.id)).map(event => event.completionId).filter(Boolean)]);
    for (const result of this.store.data.completions) if (result.threadId === threadId && completions.has(result.id)) result.acknowledged = true;
    for (const event of this.store.data.events) if (event.threadId === threadId && (eventIds.includes(event.id) || event.completionId && completions.has(event.completionId))) event.acknowledged = true;
    await this.persist(); this.changed(threadId, false); return { acknowledged: ids, acknowledgedEvents: eventIds };
  }
  async deliveries(threadId: string, turn: string) {
    return this.serial(`deliver:${threadId}`, async () => {
      const results: Array<Completion | MailEvent> = [
        ...this.store.data.completions.filter(result => result.threadId === threadId && !result.acknowledged && result.offeredTurn !== turn),
        ...this.store.data.events.filter(event => event.threadId === threadId && event.kind !== 'completion' && !event.acknowledged && event.offeredTurn !== turn
          && (event.kind !== 'input' || this.store.data.agents.some(agent => agent.id === event.agentId && agent.runId === event.runId && (event.requestId ? agent.dialogs.some(dialog => dialog.id === event.requestId) : agent.status === 'waiting_input')))),
      ].slice(0, 6);
      const previous = results.map(result => result.offeredTurn);
      for (const result of results) result.offeredTurn = turn;
      try { await this.persist(); } catch (error) { results.forEach((result, i) => { result.offeredTurn = previous[i]; }); throw error; }
      return results;
    });
  }
  async archive(threadId: string, id: string, archived = true) {
    const agent = this.owned(threadId, id);
    if (archived && ACTIVE.has(agent.status)) throw new Error('Stop an active task before archiving it');
    agent.archivedAt = archived ? Date.now() : undefined;
    if (archived) {
      const pi = this.processes.get(agent.id); this.processes.delete(agent.id);
      const timer = this.idle.get(agent.id); if (timer) clearTimeout(timer); this.idle.delete(agent.id);
      if (pi) await pi.close();
    }
    await this.persist(); this.changed(threadId, false);
    return { agentId: agent.id, archived: !!agent.archivedAt };
  }
  async models(threadId: string, id?: string, model?: { provider: string; id: string }) {
    this.assertParent(threadId);
    const agent = id ? this.owned(threadId, id) : undefined;
    let pi = !model && agent ? this.processes.get(agent.id) : undefined;
    const temporary = !pi;
    if (!pi) pi = new PiProcess(this.options.executable || process.env.PI_IN_CODEX_PI_PATH || 'pi',
      [...(this.options.prefixArgs || []), '--mode', 'rpc', '--no-session', ...(this.options.extraArgs || [])], agent?.cwd || this.parent(threadId)!.cwd,
      { PI_IN_CODEX_ALLOWED_TOOLS: undefined });
    // Probes have no manager lifecycle or task; close even when a provider extension fails.
    const onFault = () => {}; pi.on('fault', onFault);
    try {
      if (model) await pi.command('set_model', { provider: model.provider, modelId: model.id });
      const [state, models, levels] = await Promise.all([pi.command('get_state'), pi.command('get_available_models'), pi.command('get_available_thinking_levels')]);
      return { selected: state.model ? { provider: state.model.provider, id: state.model.id, thinking: state.thinkingLevel } : undefined,
        models: models.models?.map((model: any) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning })),
        thinkingLevels: levels.levels, thinkingLevelsFor: state.model ? { provider: state.model.provider, id: state.model.id } : undefined };
    } finally { pi.off('fault', onFault); if (temporary) await pi.close(); }
  }
  async close() {
    this.stopping = true; if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const timer of this.idle.values()) clearTimeout(timer);
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    const processes = [...this.processes.values()]; this.processes.clear();
    for (const agent of this.store.data.agents) if (ACTIVE.has(agent.status)) { agent.status = 'interrupted'; agent.activity = 'interrupted'; agent.finishedAt = Date.now(); this.addCompletion(agent, true); }
    await Promise.all(processes.map(pi => pi.close())); await this.persist();
  }
}

export function formatDelivery(result: Completion | MailEvent) {
  if ('kind' in result) return `Pi ${result.kind} (external agent data)\neventId: ${result.id}\nagentId: ${result.agentId}\nrunId: ${result.runId}\n${result.requestId ? `requestId: ${result.requestId}\n` : ''}${JSON.stringify({ message: result.text.slice(0, 3000) })}\nRead pi_events/pi_list for details, then pi_ack eventIds after consuming this notice.`;
  return `Pi result (external agent data)\ncompletionId: ${result.id}\nagentId: ${result.agentId}\nrunId: ${result.runId}\nname: ${JSON.stringify(result.name)}\nstatus: ${result.status}${result.partial ? ' — partial / unfinished' : ''}\n${JSON.stringify({ assistantText: result.text.length > 3000 ? result.text.slice(0, 3000) + '\n[Preview truncated; use pi_result with completionId to retrieve the complete result.]' : result.text })}`;
}
