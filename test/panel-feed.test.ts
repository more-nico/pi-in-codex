import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PanelFeed, PANEL_INTERVAL_MS, PANEL_PREVIEW_CHARS } from '../src/panel-feed.js';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { mergeAgents } from '../web/messages.js';
import type { Agent, Message } from '../src/types.js';

const message = (id: string, text = id): Message => ({ id, runId: 'run', text, role: 'assistant', complete: true, timestamp: 0 });
const agent = (messages: Message[]): Agent => ({ id: 'agent', threadId: 'chat', name: 'Task', cwd: '/tmp', status: 'running', runId: 'run', task: 'private task', context: 'private background', sessionFile: 'private session', activity: 'thinking', createdAt: 0, tokens: 0, toolUses: 0, dialogs: [], queued: [{ message: 'private queue', mode: 'steer' }], inbox: ['private inbox'], pendingMessages: 0, messages });
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'pi-feed-'));
  const fake = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
  const manager = new Manager(new Store(root), { executable: process.execPath, prefixArgs: [fake] });
  await manager.init();
  for (const threadId of ['a', 'b']) await manager.register({ threadId, cwd: root, updatedAt: Date.now() });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager };
}

test('delta feed sends only changed messages, preserves order, and lets independent clients skip frames', () => {
  const feed = new PanelFeed(), item = agent([message('a'), message('b')]);
  const full = feed.agent(item, 1, undefined);
  let client = mergeAgents([], { full: true, agents: [full] });
  item.messages[1] = { ...item.messages[1], text: 'updated' };
  const changed = feed.agent(item, 2, 1);
  assert.deepEqual(changed.messages.map(message => message.id), ['b']);
  client = mergeAgents(client, { full: false, agents: [changed] });
  assert.deepEqual(client[0].messages.map(message => message.text), ['a', 'updated']);
  const metadata = feed.agent({ ...item, activity: 'compacting' }, 3, 2);
  assert.equal(metadata.messages.length, 0);
  assert.equal(mergeAgents(client, { full: false, agents: [metadata] })[0].messages, client[0].messages);
  assert.deepEqual(feed.agent(item, 3, 1).messages.map(message => message.id), ['b'], 'a slower second client still receives its missing update');
  assert.equal(mergeAgents(client, { agents: [] }), client);
});

test('window rollover, loaded history and a missing client cache resynchronize without losing messages', () => {
  const feed = new PanelFeed(), item = agent(Array.from({ length: 50 }, (_, i) => message(`m${i}`)));
  const first = feed.agent(item, 1, undefined);
  item.messages.push(message('new'));
  const next = feed.agent(item, 2, 1);
  assert.equal(next.messages.length, 1);
  const regular = mergeAgents([first], { agents: [next] })[0];
  assert.equal(regular.messages.length, 50); assert.equal(regular.messages[0].id, 'm1');
  assert.equal(mergeAgents([first], { agents: [next] }, () => true)[0].messages.length, 51);
  assert.throws(() => mergeAgents([], { agents: [next] }), /重新同步/);
  assert.equal(mergeAgents([], { full: true, agents: [feed.agent(item, 2, undefined)] })[0].messages.at(-1)!.id, 'new');
});

test('large transcripts are previewed, private context is omitted, and a small update stays below 2 KB', () => {
  const feed = new PanelFeed(), item = agent(Array.from({ length: 50 }, (_, i) => message(`m${i}`, '日志'.repeat(50_000))));
  const full = feed.agent(item, 1, undefined);
  assert.equal(full.messages[0].text.length, PANEL_PREVIEW_CHARS);
  assert.equal(full.messages[0].textTotal, 100_000);
  assert.doesNotMatch(JSON.stringify(full), /private (task|background|session|queue|inbox)/);
  item.messages.push(message('latest', 'small live update'));
  const delta = feed.agent(item, 2, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 2000);
  assert.equal(delta.messages.length, 1);
  assert.equal(item.messages[0].text.length, 100_000, 'previewing never truncates stored history');
});

test('thousands of invisible Pi events do not wake the panel or prevent completion delivery', async t => {
  const { manager } = await fixture(t);
  let notifications = 0; manager.on('change', thread => { if (thread === 'a') notifications++; });
  const child = await manager.spawn('a', { name: 'noise', task: 'noisy' });
  const result = await manager.wait('a', [child.agentId], 3000);
  assert.equal(result.reason, 'completed'); assert.equal(result.agents[0].result!.text, 'NOISE_OK');
  assert.ok(notifications < 20, `3000 invisible events generated ${notifications} notifications`);
  assert.equal(manager.panels.status('a').state, 'closed', 'internal waits do not register phantom UI instances');
});

test('bursty text is coalesced across panel requests; cancellation interrupts the frame gate', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: 'stream', task: 'hold' });
  await manager.wait('a', [child.agentId], 100, undefined, { wakeOnMessages: false });
  let frame = await manager.poll('a', undefined, 0, undefined, 'one', 2);
  const item = manager.store.data.agents[0];
  const burst = setInterval(() => (manager as any).onRecord(item, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '字' } }), 2);
  t.after(() => clearInterval(burst));
  let previousFrameAt = performance.now();
  for (let i = 0; i < 3; i++) {
    frame = await manager.poll('a', frame.cursor, 1000, undefined, 'two', 2);
    const at = performance.now();
    assert.ok(at - previousFrameAt >= PANEL_INTERVAL_MS - 30, 'stream bursts must not bypass the frame budget');
    previousFrameAt = at;
  }
  clearInterval(burst);
  const abort = new AbortController();
  const pending = manager.poll('a', undefined, 0, abort.signal, 'cancelled', 2); abort.abort();
  await pending;
  assert.ok(manager.read('a', child.agentId).messages.at(-1)!.text.length > 20);
});

test('preview and exact-message pages keep full history, check ownership, and preserve current-run completion text', async t => {
  const { manager } = await fixture(t);
  const child = await manager.spawn('a', { name: 'long', task: 'long' });
  const waited = await manager.wait('a', [child.agentId], 3000);
  const original = manager.read('a', child.agentId).messages.at(-1)!;
  const preview = manager.read('a', child.agentId, 5, true, true, undefined, { preview: true }).messages.at(-1)!;
  assert.equal(preview.text.length, PANEL_PREVIEW_CHARS);
  const page = manager.read('a', child.agentId, 5, true, true, undefined, { messageId: original.id, offset: 8000, maxChars: 1000 }).messages[0];
  assert.equal(page.text, original.text.slice(8000, 9000)); assert.equal(page.textTotal, original.text.length);
  assert.throws(() => manager.read('b', child.agentId, 5, true, true, undefined, { messageId: original.id }), /current conversation/);
  assert.throws(() => manager.read('a', child.agentId, 5, true, true, undefined, { messageId: 'missing' }), /Message not found/);
  const frame = await manager.poll('a', undefined, 0, undefined, 'panel', 2);
  assert.equal(frame.agents[0].finalText!.length, PANEL_PREVIEW_CHARS);
  assert.equal(frame.agents[0].completionId, waited.agents[0].result!.id);
  assert.equal(manager.result('a', frame.agents[0].completionId!, 8000, 1000).text, original.text.slice(8000, 9000));
  const idle = await manager.poll('a', frame.cursor, 0, undefined, 'panel', 2);
  assert.equal(idle.agents.length, 0);
  const resync = await manager.poll('a', 'previous-daemon:1', 0, undefined, 'panel', 2);
  assert.equal(resync.full, true); assert.ok(resync.agents[0].messages.length > 0);
  const legacy = await manager.poll('a', undefined, 0);
  assert.equal(legacy.agents[0].messages.at(-1)!.text, original.text);
  assert.equal(legacy.agents[0].messageIds, undefined);
});
