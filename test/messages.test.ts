import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Message } from '../src/types.js';
import { argumentHint, completedProcessMessages, completedSummary, hasEarlierMessages, mergeAgents, mergeOlder, mergeWindow, MESSAGE_PAGE, outputSummary, prettyArguments, recentMessages, visibleMessages } from '../web/messages.js';

const message = (id: string, text = id, complete = true): Message => ({ id, runId: 'run', role: 'assistant', text, complete, timestamp: 0 });
const agent = (id: string, createdAt: number, messages: Message[]): Agent => ({ id, threadId: 'chat', name: id, cwd: '/tmp', status: 'running', runId: 'run', task: '', activity: 'thinking', createdAt, messages, tokens: 0, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0 });
const sequence = (start: number, count: number) => Array.from({ length: count }, (_, index) => message(`#${String(start + index).padStart(3, '0')}`));

test('completed summaries use the persisted current-run result even outside the message window', () => {
  const item = agent('a', 1, [{ ...message('tool'), role: 'toolResult', text: 'tool output' }]);
  item.status = 'completed'; item.finalText = '**Final summary**';
  assert.equal(completedSummary(item), '**Final summary**');
});

test('the completed process excludes duplicated final prose but retains tool calls', () => {
  const item = agent('a', 1, [message('step'), message('final', 'summary')]);
  assert.deepEqual(completedProcessMessages(item, item.messages).map(message => message.id), ['step']);
  item.messages[1].toolCalls = [{ id: 'call', name: 'read', arguments: '{}' }];
  const process = completedProcessMessages(item, item.messages);
  assert.equal(process[1].text, '');
  assert.equal(process[1].toolCalls?.[0].name, 'read');
});

test('summary fallback excludes tool output, incomplete replies and previous runs', () => {
  const item = agent('a', 1, [
    { ...message('old', 'old summary'), runId: 'previous' },
    message('current', 'new summary'),
    { ...message('tool', 'raw output'), role: 'toolResult' },
    message('partial', 'unfinished', false),
  ]);
  assert.equal(completedSummary(item), 'new summary');
  item.messages = [item.messages[0], item.messages[2]];
  assert.equal(completedSummary(item), '本次任务未生成文字总结。');
  item.finalText = '';
  assert.equal(completedSummary(item), '本次任务未生成文字总结。');
});

test('merging a sliding poll window never drops messages that left the window', () => {
  const merged = mergeWindow(sequence(0, MESSAGE_PAGE), sequence(10, MESSAGE_PAGE));
  assert.equal(merged.length, MESSAGE_PAGE + 10);
  assert.deepEqual(merged.map(item => item.id), Array.from({ length: MESSAGE_PAGE + 10 }, (_, index) => `#${String(index).padStart(3, '0')}`));
});

test('partial messages replace in place instead of duplicating', () => {
  const merged = mergeWindow([message('m0'), message('m1', 'half', false)], [message('m0'), message('m1', 'done', true)]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], message('m1', 'done', true));
});

test('without paging, poll updates replace the window so the view stays at the newest 50', () => {
  const previous = [agent('a', 1, sequence(0, 50)), agent('b', 2, [message('m3')])];
  const merged = mergeAgents(previous, { full: false, agents: [agent('a', 1, sequence(10, 50))] });
  assert.deepEqual(merged.map(item => item.id), ['a', 'b']);
  assert.equal(merged[0].messages.length, 50);
  assert.equal(merged[0].messages[0].id, '#010');
  assert.equal(merged[0].messages.at(-1)!.id, '#059');
  assert.deepEqual(merged[1].messages.map(item => item.id), ['m3']);
});

test('only agents in history mode merge; full snapshots keep their loaded history too', () => {
  const previous = [agent('a', 1, [message('m1'), message('m2')]), agent('b', 2, [message('m3')])];
  const incoming = agent('a', 1, [message('m2', 'updated'), message('m4')]);
  const merged = mergeAgents(previous, { full: false, agents: [incoming] }, id => id === 'a');
  assert.deepEqual(merged[0].messages.map(item => item.id), ['m1', 'm2', 'm4']);
  assert.equal(merged[0].messages[1].text, 'updated');
  const replaced = mergeAgents(previous, { full: false, agents: [incoming] });
  assert.deepEqual(replaced[0].messages.map(item => item.id), ['m2', 'm4']);
  const full = mergeAgents(previous, { full: true, agents: [incoming] }, id => id === 'a');
  assert.deepEqual(full.map(item => item.id), ['a']);
  assert.deepEqual(full[0].messages.map(item => item.id), ['m1', 'm2', 'm4']);
});

test('appending while un-paged keeps exactly 50 and after 100 loaded keeps 101', () => {
  const beforePaging = mergeAgents([agent('a', 1, sequence(0, 50))], { full: false, agents: [agent('a', 1, sequence(10, 50))] });
  assert.equal(beforePaging[0].messages.length, 50);
  assert.equal(beforePaging[0].messages.at(-1)!.id, '#059');
  const afterHistory = mergeAgents([agent('a', 1, sequence(0, 100))], { full: false, agents: [agent('a', 1, sequence(51, 50))] }, id => id === 'a');
  assert.equal(afterHistory[0].messages.length, 101);
  assert.equal(afterHistory[0].messages[0].id, '#000');
  assert.equal(afterHistory[0].messages.at(-1)!.id, '#100');
});

test('recentMessages trims to the 50-message boundary and keeps a partial tail', () => {
  assert.equal(recentMessages(sequence(0, 49)).length, 49);
  assert.equal(recentMessages(sequence(0, 50)).length, 50);
  const window = recentMessages(sequence(0, 51));
  assert.equal(window.length, 50);
  assert.equal(window[0].id, '#001');
  assert.equal(recentMessages([...sequence(0, 50), message('#050', 'streaming', false)]).at(-1)!.complete, false);
});

test('older pages dedupe overlaps and the live tail wins same-id updates', () => {
  const older = mergeOlder([], sequence(50, MESSAGE_PAGE));
  const overlap = mergeOlder(older, sequence(20, MESSAGE_PAGE));
  assert.equal(overlap.length, 80);
  assert.equal(overlap[0].id, '#020');
  assert.equal(overlap.at(-1)!.id, '#099');
  const visible = visibleMessages(overlap, [message('#050', 'updated'), message('#100')]);
  assert.equal(visible.length, 81);
  assert.equal(visible.filter(item => item.id === '#050').length, 1);
  assert.equal(visible.find(item => item.id === '#050')!.text, 'updated');
  assert.equal(visible.at(-1)!.id, '#100');
});

test('earlier-message detection uses exact totals including the 49/50/51 boundaries', () => {
  assert.equal(hasEarlierMessages(120, 50), true);
  assert.equal(hasEarlierMessages(51, 50), true);
  assert.equal(hasEarlierMessages(50, 50), false);
  assert.equal(hasEarlierMessages(49, 49), false);
  assert.equal(hasEarlierMessages(undefined, 10), false);
});

test('tool arguments collapse to one compact line while full arguments stay printable', () => {
  assert.equal(argumentHint(JSON.stringify({ command: 'ls -la' })), 'ls -la');
  assert.equal(argumentHint(JSON.stringify({ path: 'src/a.ts', offset: 3 })), 'src/a.ts');
  assert.equal(argumentHint('{not json'), '{not json');
  assert.match(argumentHint(JSON.stringify({ command: 'x'.repeat(300) })), /…$/);
  assert.equal(prettyArguments('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyArguments('{"a":'), '{"a":');
  assert.equal(outputSummary('one\ntwo'), '2 行');
  assert.equal(outputSummary(''), '空输出');
});
