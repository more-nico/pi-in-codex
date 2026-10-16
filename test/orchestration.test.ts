import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { dispatch } from '../src/daemon.js';

const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
async function fixture(t: any, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-orchestration-'));
  const manager = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake], idleMs: 10_000, ...options });
  await manager.init();
  for (const threadId of ['a', 'b', 'c']) await manager.register({ threadId, cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method: string, args = {}, threadId = 'a') => dispatch(manager, { id: 'transport', method, args, threadId });
  return { manager, root, call };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('send tools request one shared panel and retry receipts use current UI presence', async t => {
  const { manager, call } = await fixture(t);
  const args = { name: 'panel', task: 'hold', requestId: 'panel-spawn' };
  const first = await call('pi_spawn', args);
  assert.equal(first.panel.shouldOpen, true);
  const opened = await call('pi_panel');
  assert.equal(opened.panel.state, 'opening');
  assert.equal((await call('pi_spawn', args)).panel.shouldOpen, false);
  const panelId = '17da566e-8dc5-4ea2-8c56-954c3224ac53';
  await call('pi_poll', { waitMs: 0, panelId });
  assert.equal((await call('pi_message', { agentId: first.agentId, message: 'Keep working' })).panel.state, 'open');
  assert.equal((await call('pi_spawn', args)).panel.shouldOpen, false);
  // A cancelled UI request must release its own presence, including an already-aborted call.
  const controller = new AbortController();
  controller.abort();
  await dispatch(manager, { id: 'close', method: 'pi_poll', threadId: 'a', args: { waitMs: 0, panelId } }, controller.signal);
  assert.equal((await call('pi_spawn', args)).panel.shouldOpen, true, 'the receipt must not cache an old UI hint');
  assert.equal(manager.list('a').agents.length, 1);
  assert.equal(manager.panels.status('b').shouldOpen, true);
  const snapshot = await call('pi_poll', { waitMs: 0, panelId }, 'c');
  const closing = new AbortController();
  const waiting = dispatch(manager, { id: 'in-flight', method: 'pi_poll', threadId: 'c', args: { cursor: snapshot.cursor, waitMs: 25_000, panelId } }, closing.signal);
  closing.abort(); await waiting;
  assert.equal(manager.panels.status('c').shouldOpen, true);
});

test('progress reports wake waits and hooks, persist, isolate chats, and require event acknowledgment', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'report', task: 'report' });
  const waited = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  assert.equal(waited.reason, 'message'); assert.equal(waited.agents[0].status, 'running');
  assert.match(waited.events[0].text, /接口变更/);
  assert.deepEqual(manager.events('b').events, []);
  assert.equal((await manager.deliveries('a', 'turn1')).length, 1);
  assert.equal((await manager.deliveries('a', 'turn1')).length, 0);
  assert.equal((await manager.deliveries('a', 'turn2')).length, 1);
  await assert.rejects(call('pi_ack', { eventIds: [waited.events[0].id] }, 'b'), /current conversation/);
  await call('pi_ack', { eventIds: [waited.events[0].id] });
  assert.equal((await manager.deliveries('a', 'turn3')).length, 0);
  assert.equal((await call('pi_wait', { agentIds: [child.agentId], afterCursor: waited.cursor, timeoutMs: 30 })).reason, 'timeout');
});

test('input requests reach safe-point hooks without polling and stop repeating after a reply', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'input', task: 'dialog' });
  await until(() => manager.list('a').agents[0].status === 'waiting_input');
  const [notice] = await manager.deliveries('a', 'input-turn');
  assert.ok('requestId' in notice); assert.equal(notice.requestId, 'input-1');
  await call('pi_reply', { agentId: child.agentId, requestId: 'input-1', value: 'continue' });
  const settled = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  assert.equal(settled.reason, 'completed');
  assert.equal((await manager.deliveries('a', 'next-turn')).filter(notice => 'kind' in notice && notice.kind === 'input').length, 0);
});

test('wait cursors skip old completions, bind runs, wait for all, and distinguish cancellation', async t => {
  const { manager, call } = await fixture(t);
  const first = await call('pi_spawn', { name: 'first', task: 'fast' });
  const one = await call('pi_wait', { agentIds: [first.agentId], timeoutMs: 3000 });
  const second = await call('pi_spawn', { name: 'second', task: 'hold' });
  const next = await call('pi_wait', { agentIds: [first.agentId, second.agentId], afterCursor: one.cursor, timeoutMs: 40 });
  assert.equal(next.reason, 'timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try { assert.equal((await manager.wait('a', [second.agentId], 3000, controller.signal)).reason, 'cancelled'); } finally { clearTimeout(timer); }
  const both = call('pi_wait', { agentIds: [first.agentId, second.agentId], mode: 'all', afterCursor: one.cursor, timeoutMs: 3000 });
  await call('pi_send', { agentId: second.agentId, message: 'finish' });
  assert.equal((await both).reason, 'completed');
  await call('pi_follow_up', { agentId: first.agentId, message: 'normal' });
  const replaced = await call('pi_wait', { agentIds: [first.agentId], runIds: { [first.agentId]: first.runId }, timeoutMs: 0 });
  assert.equal(replaced.reason, 'replaced');
  await call('pi_wait', { agentIds: [first.agentId], timeoutMs: 3000 });
});

test('ordinary messages never restart idle agents; explicit follow-up consumes the durable inbox', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'idle', task: 'fast' });
  const done = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  const sent = await call('pi_message', { agentId: child.agentId, message: 'Remember this constraint' });
  assert.equal(sent.started, false); assert.equal(sent.status, 'completed'); assert.equal(sent.runId, child.runId);
  assert.deepEqual(manager.read('a', child.agentId).inbox, ['Remember this constraint']);
  assert.equal(manager.store.data.completions.length, 1);
  const follow = await call('pi_follow_up', { agentId: child.agentId, message: 'Continue explicitly' });
  assert.notEqual(follow.runId, child.runId);
  await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000, afterCursor: done.cursor });
  assert.match(manager.read('a', child.agentId).messages.find(message => message.runId === follow.runId && message.role === 'user')!.text, /Remember this constraint/);
  assert.deepEqual(manager.read('a', child.agentId).inbox, []);
});

test('soft interrupt retains a responsive Pi process, while stop releases it and preserves history', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'interrupt', task: 'hold' });
  await until(() => manager.read('a', child.agentId).messages.length > 1);
  const result = await call('pi_interrupt', { agentId: child.agentId });
  assert.equal(result.status, 'stopped'); assert.equal(result.processRetained, true);
  assert.equal(manager.store.data.completions[0].partial, true);
  await call('pi_stop', { agentId: child.agentId });
  assert.equal((await call('pi_interrupt', { agentId: child.agentId })).processRetained, false);
  assert.ok(manager.read('a', child.agentId).messages.length > 0);
});

test('a busy chat cannot consume other chats slots and scheduling alternates eligible chats', async t => {
  const { manager, call } = await fixture(t, { maxConcurrent: 2, maxPerThread: 1 });
  const a1 = await call('pi_spawn', { name: 'a1', task: 'hold' });
  const a2 = await call('pi_spawn', { name: 'a2', task: 'hold' });
  const b1 = await call('pi_spawn', { name: 'b1', task: 'hold' }, 'b');
  const c1 = await call('pi_spawn', { name: 'c1', task: 'hold' }, 'c');
  await until(() => manager.read('a', a1.agentId).messages.length > 1 && manager.read('b', b1.agentId).messages.length > 1);
  assert.equal(manager.list('a').agents.find(agent => agent.id === a2.agentId)!.queueReason, 'chat_limit');
  await call('pi_stop', { agentId: a1.agentId });
  await until(() => manager.read('c', c1.agentId).messages.length > 1);
  assert.equal(manager.read('a', a2.agentId).status, 'queued');
});

test('model discovery runs before spawning, and a selected-model probe never changes a live child', async t => {
  const { manager, call } = await fixture(t);
  const models = await call('pi_models');
  assert.equal(models.selected.id, 'test-model'); assert.ok(models.thinkingLevels.includes('max'));
  assert.equal(manager.list('a').agents.length, 0);
  const child = await call('pi_spawn', { name: 'model', task: 'hold' });
  await until(() => manager.read('a', child.agentId).messages.length > 1);
  const probe = await call('pi_models', { agentId: child.agentId, model: { provider: 'fake', id: 'other-model' } });
  assert.equal(probe.selected.id, 'other-model');
  assert.equal((await call('pi_models', { agentId: child.agentId })).selected.id, 'test-model');
  await assert.rejects(call('pi_models', { agentId: child.agentId }, 'b'), /current conversation/);
});

test('list previews stay small and stable result IDs retrieve complete old runs in pages', async t => {
  const { manager, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'long', task: 'long' });
  const waited = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  assert.equal(waited.agents[0].result.truncated, true);
  const listing = await call('pi_list');
  assert.ok(JSON.stringify(listing).length < 2000); assert.equal(listing.agents[0].finalText, undefined);
  const completionId = waited.agents[0].result.id;
  await call('pi_follow_up', { agentId: child.agentId, message: 'fast' });
  await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  let text = '', offset = 0;
  for (;;) { const page = await call('pi_result', { completionId, offset, maxChars: 3333 }); text += page.text; if (page.nextOffset === undefined) break; offset = page.nextOffset; }
  assert.equal(text, '完整结果✓'.repeat(5000));
  await assert.rejects(call('pi_result', { completionId }, 'b'), /current conversation/);
  const event = manager.events('a').events.find(event => event.completionId === completionId)!;
  await call('pi_ack', { eventIds: [event.id] });
  assert.equal(manager.store.data.completions.find(result => result.id === completionId)!.acknowledged, true);
});

test('paths are chat-scoped aliases and archived tasks retain history and pending results', async t => {
  const { manager, call } = await fixture(t);
  await call('pi_spawn', { name: 'review', path: 'review/api', group: 'review', profile: 'reviewer', task: 'fast' });
  await call('pi_wait', { agentIds: ['review/api'], timeoutMs: 3000 });
  assert.equal((await call('pi_list', { pathPrefix: 'review', group: 'review' })).agents.length, 1);
  await call('pi_archive', { agentId: 'review/api' });
  assert.equal((await call('pi_list')).agents.length, 0);
  assert.equal((await call('pi_list', { includeArchived: true })).agents.length, 1);
  assert.equal((await manager.deliveries('a', 'archived')).length, 1);
  assert.ok(manager.read('a', 'review/api').messages.length > 0);
  await call('pi_archive', { agentId: 'review/api', archived: false });
  await call('pi_follow_up', { agentId: 'review/api', message: 'hold' });
  await assert.rejects(call('pi_archive', { agentId: 'review/api' }), /Stop/);
  await assert.rejects(call('pi_read', { agentId: 'review/api' }, 'b'), /current conversation/);
});

test('retry keys deduplicate concurrent spawn/send, persist receipts, and reject ambiguous replay', async t => {
  const { manager, root, call } = await fixture(t);
  const args = { name: 'once', task: 'hold', requestId: 'spawn-1' };
  const [a, b] = await Promise.all([call('pi_spawn', args), call('pi_spawn', args)]);
  assert.equal(a.agentId, b.agentId); assert.equal(manager.list('a').agents.length, 1);
  await assert.rejects(call('pi_spawn', { ...args, task: 'different' }), /different arguments/);
  await call('pi_message', { agentId: a.agentId, message: 'One delivery', requestId: 'message-1' });
  await call('pi_message', { agentId: a.agentId, message: 'One delivery', requestId: 'message-1' });
  await until(() => manager.read('a', a.agentId).messages.some(message => message.text === 'One delivery'));
  assert.equal(manager.read('a', a.agentId, 200).messages.filter(message => message.text === 'One delivery').length, 1);
  await manager.close();
  const data = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  data.receipts[0].state = 'pending'; await writeFile(join(root, 'state.json'), JSON.stringify(data));
  const restored = new Manager(new Store(root)); await restored.init();
  assert.equal(restored.store.data.receipts[0].state, 'uncertain');
  await assert.rejects(dispatch(restored, { id: 'retry', threadId: 'a', method: 'pi_spawn', args }), /uncertain/);
  assert.equal(restored.list('a').agents.length, 1); await restored.close();
});

test('the inspection bridge blocks shell, writes and arbitrary tools, and reports through RPC notifications', async () => {
  const source = (await readFile(new URL('../extensions/parent.mjs', import.meta.url), 'utf8')).replace("import { Type } from '@earendil-works/pi-ai';", "const Type = {Object: properties => ({type:'object',properties}), String: options => ({type:'string',...options})};");
  const bridge = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  const previous = process.env.PI_IN_CODEX_ALLOWED_TOOLS;
  process.env.PI_IN_CODEX_ALLOWED_TOOLS = JSON.stringify(['read', 'grep', 'find', 'ls', 'pi_report']);
  const handlers: Record<string, Function> = {}, notifications: string[] = [];
  let report: any;
  try {
    bridge({ on: (event: string, handler: Function) => handlers[event] = handler, registerTool: (tool: any) => report = tool });
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } };
    await handlers.session_start({}, ctx);
    assert.equal(notifications[0], 'pi_in_codex_ready');
    for (const toolName of ['bash', 'write', 'edit', 'codemode', 'unknown_mcp_tool']) assert.equal(handlers.tool_call({ toolName }).block, true);
    for (const toolName of ['read', 'grep', 'find', 'ls', 'pi_report']) assert.equal(handlers.tool_call({ toolName }), undefined);
    await report.execute('call', { message: '中文报告✓' }, undefined, undefined, ctx);
    assert.match(notifications.at(-1)!, /中文报告✓/);
  } finally { if (previous === undefined) delete process.env.PI_IN_CODEX_ALLOWED_TOOLS; else process.env.PI_IN_CODEX_ALLOWED_TOOLS = previous; }
});

test('bridge loading failure prevents a task from being submitted', async t => {
  const { manager, call } = await fixture(t, { extraArgs: ['--broken-bridge'] });
  const child = await call('pi_spawn', { name: 'blocked', profile: 'reviewer', task: 'hold' });
  const settled = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  assert.equal(settled.agents[0].status, 'failed');
  assert.match(settled.agents[0].result.text, /bridge did not load/);
  assert.equal(manager.read('a', child.agentId).messages.length, 0);
});

test('mailbox cursors and acknowledgments survive restart, and legacy databases gain completion events', async t => {
  const { manager, root, call } = await fixture(t);
  const child = await call('pi_spawn', { name: 'durable', task: 'report' });
  const report = await call('pi_wait', { agentIds: [child.agentId], timeoutMs: 3000 });
  await call('pi_ack', { eventIds: [report.events[0].id] });
  await manager.close();
  const restored = new Manager(new Store(root)); await restored.init();
  const saved = restored.events('a', undefined, 50, report.events[0].id).events[0];
  assert.equal(saved.acknowledged, true);
  assert.equal(saved.id, report.events[0].id);
  assert.ok(restored.events('a', report.cursor).events.some(event => event.kind === 'completion'));
  await restored.close();
  const data = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  delete data.events; delete data.receipts;
  await writeFile(join(root, 'state.json'), JSON.stringify(data));
  const legacy = new Manager(new Store(root)); await legacy.init();
  const migrated = legacy.events('a').events[0];
  assert.equal(migrated.kind, 'completion');
  assert.equal(migrated.completionId, legacy.store.data.completions[0].id);
  await legacy.acknowledge('a', [], [migrated.id]);
  assert.equal(legacy.store.data.completions[0].acknowledged, true);
  await legacy.close();
});
