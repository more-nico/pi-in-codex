import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { JsonLines } from '../src/jsonl.js';
import { resolveThread, schemas } from '../src/schemas.js';
import { MAX_WAIT_MS, WAIT_RESPONSE_GRACE_MS, daemonRequestTimeout } from '../src/wait.js';
const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
test('custom waits require an explicit duration and support up to sixty minutes end to end', () => {
  const agentIds = ['00000000-0000-4000-8000-000000000001'];
  assert.equal(schemas.pi_wait.parse({ agentIds, timeoutMs: MAX_WAIT_MS }).timeoutMs, 3_600_000);
  assert.equal(schemas.pi_wait.parse({ agentIds, timeoutMs: 0 }).timeoutMs, 0);
  for (const timeoutMs of [undefined, -1, 1.5, MAX_WAIT_MS + 1, Infinity]) {
    assert.equal(schemas.pi_wait.safeParse({ agentIds, timeoutMs }).success, false);
  }
  assert.equal(daemonRequestTimeout('pi_wait', { timeoutMs: MAX_WAIT_MS }), MAX_WAIT_MS + WAIT_RESPONSE_GRACE_MS);
  assert.equal(daemonRequestTimeout('pi_list', {}), 70_000);
});

test('a sixty-minute wait returns immediately on settlement and queues the final parent result', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'early completion', task: 'normal' });
  const started = Date.now();
  const result = await manager.wait('chat-a', [child.agentId], MAX_WAIT_MS);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.timedOut, false);
  assert.equal(result.agents[0].status, 'completed');
  assert.equal(manager.snapshot('chat-a').agents[0].finalText, result.agents[0].result!.text);
  const deliveries = await manager.deliveries('chat-a', 'early-result');
  assert.equal(deliveries[0].id, result.agents[0].result!.id);
  assert.match(deliveries[0].text, /你好/);
});

test('custom waits time out without stopping the child and can be cancelled promptly', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'held', task: 'hold' });
  const started = Date.now();
  assert.equal((await manager.wait('chat-a', [child.agentId], 40)).timedOut, true);
  assert.ok(Date.now() - started >= 30);
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 20);
  try {
    const cancelled = await manager.wait('chat-a', [child.agentId], MAX_WAIT_MS, controller.signal);
    assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.timedOut, false);
  }
  finally { clearTimeout(cancellation); }
  assert.ok(['starting', 'running'].includes(manager.snapshot('chat-a').agents[0].status));
});
async function fixture(t: any, concurrency = 4) {
  const root = await mkdtemp(join(tmpdir(), 'pi-in-codex-test-'));
  const manager = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake], maxConcurrent: concurrency, idleMs: 1000 });
  await manager.init();
  for (const threadId of ['chat-a', 'chat-b']) await manager.register({ threadId, cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, root };
}
async function startupFixture(t: any, extraArgs: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'pi-startup-'));
  const manager = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake], extraArgs });
  await manager.init(); await manager.register({ threadId: 'chat', cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return manager;
}
async function until(predicate: () => boolean, timeout = 4000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('JSONL framing preserves split Chinese, Unicode separators, CRLF, and multiple records', () => {
  const values: any[] = [], errors: Error[] = [], decoder = new JsonLines(value => values.push(value), error => errors.push(error));
  const bytes = Buffer.from(JSON.stringify({ text: '中文\u2028你好\u2029✓' }) + '\r\n{"n":2}\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(values, [{ text: '中文\u2028你好\u2029✓' }, { n: 2 }]); assert.equal(errors.length, 0);
});
test('thread identity never falls back to a shared process or project', () => {
  assert.equal(resolveThread({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'chat-a' }) }), 'chat-a');
  assert.throws(() => resolveThread({ 'openai/session': 'opaque', cwd: '/same/project' }), /did not supply/);
  assert.throws(() => resolveThread({ threadId: 'a', 'x-codex-turn-metadata': { thread_id: 'b' } }), /Conflicting/);
});
test('same-directory chats cannot list, read, steer, stop, reply to or acknowledge each other', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: '隔离', task: 'normal' });
  assert.equal(manager.snapshot('chat-b').agents.length, 0);
  assert.throws(() => manager.read('chat-b', child.agentId), /current conversation/);
  await assert.rejects(manager.send('chat-b', child.agentId, 'x'), /current conversation/);
  await assert.rejects(manager.stop('chat-b', child.agentId), /current conversation/);
  await assert.rejects(manager.reply('chat-b', child.agentId, 'x'), /current conversation/);
  await manager.wait('chat-a', [child.agentId], 3000);
  const completion = manager.store.data.completions[0];
  await assert.rejects(manager.acknowledge('chat-b', [completion.id]), /current conversation/);
});
test('accepted prompts and agent_end do not complete before retry/compaction settles', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'retry', task: 'retry' });
  const early = await manager.wait('chat-a', [child.agentId], 100);
  assert.equal(early.timedOut, true); assert.equal(manager.store.data.completions.length, 0);
  const settled = await manager.wait('chat-a', [child.agentId], 3000);
  assert.equal(settled.agents[0].status, 'completed'); assert.match(settled.agents[0].result!.text, /你好/);
  assert.equal(manager.store.data.completions.length, 1);
});
test('end without settled remains active and cancellation preserves partial history', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'end', task: 'end-only' });
  const result = await manager.wait('chat-a', [child.agentId], 100);
  assert.equal(result.timedOut, true);
  await manager.stop('chat-a', child.agentId);
  assert.equal(manager.read('chat-a', child.agentId).status, 'stopped');
  assert.equal(manager.store.data.completions[0].partial, true);
});
test('concurrency queues work, queued stops free no live slot, and steering reaches a running agent', async t => {
  const { manager } = await fixture(t, 1);
  const first = await manager.spawn('chat-a', { name: 'first', task: 'hold' });
  await until(() => manager.snapshot('chat-a').agents[0].messages.length >= 2);
  const queued = await manager.spawn('chat-b', { name: 'queued', task: 'normal' });
  assert.equal(manager.snapshot('chat-b').agents[0].status, 'queued');
  await manager.stop('chat-b', queued.agentId);
  await manager.send('chat-a', first.agentId, '新的指令', 'steer');
  const result = await manager.wait('chat-a', [first.agentId], 3000);
  assert.equal(result.agents[0].result!.text, '新的指令');
  assert.equal(manager.snapshot('chat-b').agents[0].status, 'stopped');
});
test('follow-up and resume retain conversation but allocate a new run; empty runs never reuse old final text', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'resume', task: 'hold' });
  await until(() => manager.snapshot('chat-a').agents[0].messages.length >= 2);
  await manager.send('chat-a', child.agentId, 'follow up result', 'followUp');
  await manager.wait('chat-a', [child.agentId], 3000);
  const previous = child.runId;
  const resumed = await manager.send('chat-a', child.agentId, 'empty');
  assert.notEqual(previous, resumed.runId);
  const result = await manager.wait('chat-a', [child.agentId], 3000);
  assert.match(result.agents[0].result!.text, /No assistant text/);
  assert.equal(manager.store.data.completions.length, 2);
});
test('extension dialogs enter waiting_input and only their owner may respond', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'input', task: 'dialog' });
  const waiting = await manager.wait('chat-a', [child.agentId], 3000);
  assert.equal(waiting.agents[0].status, 'waiting_input');
  await manager.reply('chat-a', child.agentId, waiting.agents[0].dialogs[0].id, '输入已收到');
  const result = await manager.wait('chat-a', [child.agentId], 3000);
  assert.equal(result.agents[0].result!.text, '输入已收到');
});
test('malformed protocol, provider errors and crashes produce partial failures', async t => {
  const { manager } = await fixture(t);
  for (const scenario of ['malformed', 'fail', 'crash']) {
    const child = await manager.spawn('chat-a', { name: scenario, task: scenario });
    const result = await manager.wait('chat-a', [child.agentId], 3000);
    assert.equal(result.agents[0].status, 'failed', scenario); assert.equal(result.agents[0].result!.partial, true);
  }
});
test('startup rejects missing Pi executables without hanging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-missing-'));
  const manager = new Manager(new Store(root), { executable: join(root, 'no-pi') });
  await manager.init(); await manager.register({ threadId: 'chat', cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const child = await manager.spawn('chat', { name: 'missing', task: 'x' });
  const result = await manager.wait('chat', [child.agentId], 3000);
  assert.equal(result.agents[0].status, 'failed');
});
test('startup input can be answered while the initial RPC handshake is waiting', async t => {
  const manager = await startupFixture(t, ['--startup-dialog']);
  const child = await manager.spawn('chat', { name: 'startup input', task: 'normal' });
  const waiting = await manager.wait('chat', [child.agentId], 3000);
  assert.equal(waiting.agents[0].status, 'waiting_input');
  await manager.reply('chat', child.agentId, 'startup-input', 'continue');
  assert.equal((await manager.wait('chat', [child.agentId], 3000)).agents[0].status, 'completed');
});
test('stopping a starting process does not wait for its unresponsive handshake', async t => {
  const manager = await startupFixture(t, ['--slow-state']);
  const child = await manager.spawn('chat', { name: 'slow startup', task: 'normal' });
  const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Stop waited for the handshake')), 2000); timer.unref(); });
  const stopped = await Promise.race([manager.stop('chat', child.agentId), timeout]);
  assert.equal(stopped.status, 'stopped');
});
test('queued input survives completion before the prompt response continuation', async t => {
  const { manager } = await fixture(t, 1);
  const blocker = await manager.spawn('chat-b', { name: 'blocker', task: 'hold' });
  await until(() => manager.snapshot('chat-b').agents[0].messages.length > 1);
  const child = await manager.spawn('chat-a', { name: 'fast', task: 'fast' });
  await manager.send('chat-a', child.agentId, 'first queued', 'followUp');
  await manager.send('chat-a', child.agentId, 'second queued', 'steer');
  await manager.stop('chat-b', blocker.agentId);
  await until(() => manager.read('chat-a', child.agentId, 200).messages.some(message => message.text === 'second queued'));
  await manager.wait('chat-a', [child.agentId], 3000);
  const users = manager.read('chat-a', child.agentId, 200).messages.filter(message => message.role === 'user').map(message => message.text);
  assert.deepEqual(users, ['fast', 'first queued', 'second queued']);
});
test('startup rejection preserves undelivered queued messages for inspection', async t => {
  const { manager } = await fixture(t, 1);
  const blocker = await manager.spawn('chat-b', { name: 'blocker', task: 'hold' });
  await until(() => manager.snapshot('chat-b').agents[0].messages.length > 1);
  const child = await manager.spawn('chat-a', { name: 'rejected', task: 'prompt-fail' });
  await manager.send('chat-a', child.agentId, 'keep this instruction');
  await manager.stop('chat-b', blocker.agentId);
  await manager.wait('chat-a', [child.agentId], 3000);
  assert.deepEqual(manager.read('chat-a', child.agentId).undeliveredMessages, ['keep this instruction']);
});
test('hook delivery is atomic per turn; unacknowledged results reappear on a later turn', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'delivery', task: 'normal' });
  await manager.wait('chat-a', [child.agentId], 3000);
  const deliveries = await Promise.all([manager.deliveries('chat-a', 'turn-1'), manager.deliveries('chat-a', 'turn-1')]);
  assert.equal(deliveries.flat().length, 1);
  const next = await manager.deliveries('chat-a', 'turn-2'); assert.equal(next.length, 1);
  await manager.acknowledge('chat-a', [next[0].id]); await manager.acknowledge('chat-a', [next[0].id]);
  assert.equal((await manager.deliveries('chat-a', 'turn-3')).length, 0);
});
test('restart restores transcripts and marks unfinished work interrupted', async t => {
  const { manager, root } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'restore', task: 'hold' });
  await until(() => manager.snapshot('chat-a').agents[0].messages.length >= 2);
  await manager.store.save();
  const recovered = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake] });
  await manager.close(); await recovered.init();
  assert.equal(recovered.read('chat-a', child.agentId).status, 'interrupted');
  assert.ok(recovered.read('chat-a', child.agentId).messages.length > 0);
  const next = await recovered.send('chat-a', child.agentId, 'normal');
  assert.notEqual(next.runId, child.runId);
  await recovered.wait('chat-a', [child.agentId], 3000); await recovered.close();
});
test('snapshots window the newest 50 messages and pi_read walks exact page boundaries', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'history', task: 'hold' });
  await until(() => manager.snapshot('chat-a').agents[0].messages.length >= 2);
  const record = manager.store.data.agents.find(agent => agent.id === child.agentId)!;
  const total = 120;
  record.messages = Array.from({ length: total }, (_, index) => ({ id: `h${String(index).padStart(3, '0')}`, runId: record.runId,
    role: index % 2 ? 'assistant' : 'user', text: `#${index}`, complete: index !== total - 1, timestamp: Date.now() + index }));
  const snapshot = manager.snapshot('chat-a').agents[0];
  assert.equal(snapshot.messageTotal, total);
  assert.equal(snapshot.messages.length, 50);
  assert.equal(snapshot.messages[0].id, 'h070');
  assert.equal(snapshot.messages.at(-1)!.id, 'h119');
  assert.equal(snapshot.messages.at(-1)!.complete, false);
  const first = manager.read('chat-a', child.agentId, 50, true, true, snapshot.messages[0].id);
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].id, 'h020');
  assert.equal(first.hasMore, true);
  const second = manager.read('chat-a', child.agentId, 50, true, true, first.messages[0].id);
  assert.equal(second.messages.length, 20);
  assert.equal(second.messages[0].id, 'h000');
  assert.equal(second.hasMore, false);
  const exact = manager.read('chat-a', child.agentId, 50, true, true, 'h050');
  assert.equal(exact.messages.length, 50);
  assert.equal(exact.hasMore, false);
  assert.throws(() => manager.read('chat-a', child.agentId, 50, true, true, 'missing'), /Unknown message cursor/);
});
test('tool calls, tool results and shell messages keep arguments for collapsed rows', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('chat-a', { name: 'tools', task: 'tools' });
  assert.equal((await manager.wait('chat-a', [child.agentId], 3000)).agents[0].status, 'completed');
  const messages = manager.read('chat-a', child.agentId, 50, true).messages;
  const assistant = messages.find(message => message.toolCalls?.length);
  assert.equal(assistant!.toolCalls![0].name, 'bash');
  assert.match(assistant!.toolCalls![0].arguments, /echo x{10,}/);
  const result = messages.find(message => message.role === 'toolResult');
  assert.equal(result!.toolName, 'bash');
  assert.equal(result!.isError, false);
  assert.match(result!.text, /命令输出行2/);
  const shell = messages.find(message => message.role === 'bashExecution');
  assert.equal(shell!.command, 'npm test');
  assert.equal(shell!.text, 'ok');
});
test('polling wakes only for its owner and supports a fresh cursor after restart', async t => {
  const { manager } = await fixture(t);
  const snapshot = manager.snapshot('chat-b');
  const pending = manager.poll('chat-b', snapshot.cursor, 150);
  await manager.spawn('chat-a', { name: 'other chat', task: 'normal' });
  const result = await pending; assert.equal(result.agents.length, 0); assert.equal(result.cursor, snapshot.cursor);
  assert.equal((await manager.poll('chat-b', 'old-epoch:999', 20_000)).agents.length, 0);
});
