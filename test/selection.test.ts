import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../src/types.js';
import { selectAgent } from '../web/selection.js';

const agent = (id: string, status: Agent['status'], createdAt: number, extra: Partial<Agent> = {}): Agent => ({
  id, status, createdAt, threadId: 'chat', runId: id, name: id, task: '', cwd: '/tmp',
  activity: status, messages: [], tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0, ...extra,
});

test('first open chooses running work even when old completed jobs come first', () => {
  assert.equal(selectAgent([agent('old', 'completed', 1), agent('live', 'running', 2), agent('new', 'completed', 3)]), 'live');
  assert.equal(selectAgent([agent('queued', 'queued', 4), agent('live', 'running', 2), agent('starting', 'starting', 5)]), 'live');
});

test('first open prefers the latest active run and falls back to the latest finished result', () => {
  assert.equal(selectAgent([agent('old', 'running', 1, { startedAt: 8 }), agent('new', 'running', 2, { startedAt: 9 })]), 'new');
  assert.equal(selectAgent([agent('old', 'completed', 1, { finishedAt: 12 }), agent('new', 'failed', 2, { finishedAt: 10 })]), 'old');
  assert.equal(selectAgent([agent('done', 'completed', 5), agent('input', 'waiting_input', 1)]), 'input');
});

test('new tasks and status changes keep the task the user is already reading', () => {
  const items = [agent('reading', 'completed', 1), agent('live', 'running', 2)];
  assert.equal(selectAgent(items, 'reading'), 'reading');
  assert.equal(selectAgent([...items, agent('newer', 'running', 3)], 'reading'), 'reading');
  assert.equal(selectAgent(items, 'live'), 'live');
});

test('removed or archived selection falls back, and empty lists clear selection', () => {
  const items = [agent('archived', 'running', 2, { archivedAt: 4 }), agent('visible', 'starting', 1)];
  assert.equal(selectAgent(items, 'archived'), 'visible');
  assert.equal(selectAgent(items, 'missing'), 'visible');
  assert.equal(selectAgent([], 'missing'), undefined);
});
