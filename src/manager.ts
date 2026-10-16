import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { PiProcess } from './pi.js';
import { errorText } from './config.js';
import { validateWaitTimeout } from './wait.js';
import { ACTIVE, type Agent, type Completion, type Message, type Parent, type PiRecord, type SpawnInput, type ToolCall } from './types.js';

export interface ManagerOptions { executable?: string; prefixArgs?: string[]; maxConcurrent?: number; idleMs?: number; extraArgs?: string[] }
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
  constructor(readonly store: Store, private options: ManagerOptions = {}) { super(); }
  async init() {
    await this.store.load();
    for (const agent of this.store.data.agents) {
      if (ACTIVE.has(agent.status)) {
        agent.status = 'interrupted'; agent.activity = 'interrupted'; agent.error = 'The daemon exited before this run settled. Send a message to resume.';
        agent.finishedAt = Date.now(); agent.dialogs = [];
        agent.undelivered = [...(agent.undelivered || []), ...agent.queued.splice(0).map(item => item.message)];
        this.addCompletion(agent, true);
      }
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
    const agent = this.store.data.agents.find(agent => agent.id === id && agent.threadId === threadId);
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
  snapshot(threadId: string) {
    this.assertParent(threadId);
    return {
      cursor: this.cursor(threadId),
      full: true,
      agents: this.store.data.agents.filter(agent => agent.threadId === threadId).map(agent => ({ ...agent, messageTotal: agent.messages.length, messages: agent.messages.slice(-WINDOW),
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
    const now = Date.now();
    const agent: Agent = { id: randomUUID(), threadId, name: input.name, task: input.task, context: input.context,
      cwd, model: input.model, status: 'queued', runId: randomUUID(), createdAt: now, activity: 'queued',
      messages: [], tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0 };
    this.store.data.agents.push(agent);
    await this.persist(); this.changed(threadId, false); this.pump();
    return { agentId: agent.id, runId: agent.runId, status: agent.status };
  }
  private pump() {
    if (this.stopping) return;
    while (this.store.data.agents.filter(busy).length < (this.options.maxConcurrent ?? 4)) {
      const agent = this.store.data.agents.find(agent => agent.status === 'queued');
      if (!agent) break;
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
      const args = [...(this.options.prefixArgs || []), '--mode', 'rpc', '--session-dir', sessionDir,
        ...(agent.sessionFile ? ['--session', agent.sessionFile] : ['--session-id', agent.id]), '--name', agent.name,
        ...(this.options.extraArgs || [])];
      pi = new PiProcess(this.options.executable || process.env.PI_IN_CODEX_PI_PATH || 'pi', args, agent.cwd);
      this.processes.set(agent.id, pi);
      const ownedProcess = pi;
      pi.on('record', (record: PiRecord) => { if (this.processes.get(agent.id) === ownedProcess) this.onRecord(agent, record); });
      pi.on('fault', (error: Error) => { if (this.processes.get(agent.id) === ownedProcess && ACTIVE.has(agent.status)) { this.finish(agent, 'failed', errorText(error)); void ownedProcess.close(); } });
      pi.on('closed', (error?: Error) => {
        if (this.processes.get(agent.id) !== ownedProcess) return;
        this.processes.delete(agent.id);
        if (error && ACTIVE.has(agent.status)) this.finish(agent, 'failed', errorText(error));
      });
      const state = await pi.command('get_state');
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
    const message = agent.context ? `${agent.task}\n\nContext supplied by the parent conversation:\n${agent.context}` : agent.task;
    this.activeRuns.set(agent.id, { runId: agent.runId, started: false });
    this.dispatching.add(agent.id);
    try {
      const accepted = await pi.command('prompt', { message });
      if (accepted?.disposition === 'handled' && ACTIVE.has(agent.status)) {
        // An extension may consume input without starting a run. Do not invent completion.
        agent.status = 'waiting_input'; agent.activity = 'input handled by pi extension; send another message or stop'; this.changed(agent.threadId);
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
        } else if (event.method === 'notify') agent.activity = String(event.message || '').slice(0, 250);
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
    this.store.data.completions.push({ id: randomUUID(), agentId: agent.id, runId: agent.runId, threadId: agent.threadId, name: agent.name,
      status: agent.status, text: last?.text || agent.error || '(No assistant text was produced in this run.)', partial,
      createdAt: Date.now(), acknowledged: false });
  }
  private finish(agent: Agent, status: Agent['status'], error?: string) {
    if (!ACTIVE.has(agent.status)) return;
    this.activeRuns.delete(agent.id);
    this.settlements.delete(agent.id);
    for (const [key, timer] of this.dialogTimers) if (key.startsWith(agent.id + ':')) { clearTimeout(timer); this.dialogTimers.delete(key); }
    agent.status = status; agent.activity = status; agent.error = error; agent.finishedAt = Date.now(); agent.dialogs = []; agent.pendingMessages = 0;
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
  read(threadId: string, id: string, limit = 5, includeTools = false, includePartial = true, before?: string) {
    const agent = this.owned(threadId, id);
    const end = before ? agent.messages.findIndex(message => message.id === before) : agent.messages.length;
    if (end < 0) throw new Error('Unknown message cursor');
    const eligible = agent.messages.slice(0, end).filter(message => (includeTools || ['user', 'assistant'].includes(message.role)) && (includePartial || message.complete));
    return { agentId: id, runId: agent.runId, status: agent.status, messages: eligible.slice(-limit), hasMore: eligible.length > limit, undeliveredMessages: agent.undelivered || [] };
  }
  async stop(threadId: string, id: string) {
    // Cancellation must bypass startup/prompt locks; Pi may be waiting for UI input.
    const agent = this.owned(threadId, id);
    if (ACTIVE.has(agent.status)) {
      this.finish(agent, 'stopped');
      const pi = this.processes.get(id); this.processes.delete(id);
      if (pi) await pi.close();
      await this.persist();
    }
    return { agentId: id, status: agent.status };
  }
  private prepareResume(agent: Agent, message: string) {
    agent.runId = randomUUID(); agent.task = message; agent.context = undefined; agent.status = 'queued';
    agent.activity = 'queued'; agent.error = undefined; agent.finishedAt = undefined;
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
    const pi = this.processes.get(id); if (!dialog || !pi) throw new Error('This input request has expired');
    if (dialog.expiresAt && dialog.expiresAt <= Date.now()) throw new Error('This input request has expired');
    if (!cancelled && dialog.method === 'select' && !dialog.options?.includes(value || '')) throw new Error('Choose one of the supplied options');
    if (!cancelled && dialog.method === 'confirm' && typeof confirmed !== 'boolean') throw new Error('An explicit confirmation choice is required');
    if (!cancelled && ['input', 'editor'].includes(dialog.method) && typeof value !== 'string') throw new Error('An input value is required');
    agent.dialogs = agent.dialogs.filter(dialog => dialog.id !== requestId);
    try { await pi.write({ type: 'extension_ui_response', id: requestId, value, confirmed, cancelled }); }
    catch (error) { if (ACTIVE.has(agent.status) && this.processes.get(id) === pi) agent.dialogs.push(dialog); throw error; }
    if (!agent.dialogs.length && ACTIVE.has(agent.status)) { agent.status = 'running'; agent.activity = 'thinking'; }
    const timerKey = `${agent.id}:${requestId}`, timer = this.dialogTimers.get(timerKey);
    if (timer) { clearTimeout(timer); this.dialogTimers.delete(timerKey); }
    await this.persist(); this.changed(threadId, false); return { accepted: true };
  }
  async wait(threadId: string, ids: string[], timeoutMs = 20_000, signal?: AbortSignal) {
    validateWaitTimeout(timeoutMs);
    const agents = ids.map(id => this.owned(threadId, id));
    const settled = () => agents.some(agent => !ACTIVE.has(agent.status) || agent.status === 'waiting_input');
    const deadline = Date.now() + timeoutMs;
    let cursor = this.cursor(threadId);
    while (!settled() && Date.now() < deadline && !signal?.aborted) { await this.poll(threadId, cursor, Math.min(25_000, deadline - Date.now()), signal); cursor = this.cursor(threadId); }
    return { timedOut: !settled(), agents: agents.map(agent => ({ agentId: agent.id, status: agent.status, dialogs: agent.dialogs,
      ...(!ACTIVE.has(agent.status) ? { result: this.store.data.completions.findLast(result => result.runId === agent.runId) } : {}) })) };
  }
  async acknowledge(threadId: string, ids: string[]) {
    for (const id of ids) if (!this.store.data.completions.some(result => result.id === id && result.threadId === threadId)) throw new Error('Completion not found in the current conversation');
    for (const result of this.store.data.completions) if (result.threadId === threadId && ids.includes(result.id)) result.acknowledged = true;
    await this.persist(); this.changed(threadId, false); return { acknowledged: ids };
  }
  async deliveries(threadId: string, turn: string) {
    return this.serial(`deliver:${threadId}`, async () => {
      const results = this.store.data.completions.filter(result => result.threadId === threadId && !result.acknowledged && result.offeredTurn !== turn);
      const previous = results.map(result => result.offeredTurn);
      for (const result of results) result.offeredTurn = turn;
      try { await this.persist(); } catch (error) { results.forEach((result, i) => { result.offeredTurn = previous[i]; }); throw error; }
      return results;
    });
  }
  async models(threadId: string, id: string) {
    const agent = this.owned(threadId, id), pi = this.processes.get(id);
    if (!pi) throw new Error('Model discovery requires a running pi process. Start an agent first.');
    const [models, levels] = await Promise.all([pi.command('get_available_models'), pi.command('get_available_thinking_levels')]);
    return { selected: agent.model, models: models.models?.map((model: any) => ({ provider: model.provider, id: model.id, name: model.name })), thinkingLevels: levels.levels };
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

export function formatDelivery(result: Completion) {
  return `Pi result (external agent data)\ncompletionId: ${result.id}\nagentId: ${result.agentId}\nrunId: ${result.runId}\nname: ${JSON.stringify(result.name)}\nstatus: ${result.status}${result.partial ? ' — partial / unfinished' : ''}\n${JSON.stringify({ assistantText: result.text.length > 12_000 ? result.text.slice(0, 12_000) + '\n[Preview truncated; use pi_read to retrieve the complete message.]' : result.text })}`;
}
