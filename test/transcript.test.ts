import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../src/types.js';
import { Transcript } from '../web/transcript.js';

const invocation = (id = 'call'): Message => ({
  id: 'assistant', runId: 'run', role: 'assistant', text: 'Reading **source**.', complete: true, timestamp: 0,
  toolCalls: [{ id, name: 'read', arguments: '{"path":"first.ts"}' }],
});
const result = (id = 'call', text = 'FIRST_OUTPUT'): Message => ({
  id: 'result', runId: 'run', role: 'toolResult', toolCallId: id, toolName: 'read', text, complete: true, timestamp: 1,
});
const render = (messages: Message[]) => renderToStaticMarkup(React.createElement(Transcript, { messages }));
const rows = (html: string) => html.match(/<details\b[\s\S]*?<\/details>/g) || [];

test('an invocation and result render once with both arguments and output inside the row', () => {
  const html = render([invocation(), result()]);
  const [row] = rows(html);
  assert.equal(rows(html).length, 1);
  assert.ok(row);
  assert.match(row, /调用参数/); assert.match(row, /first\.ts/);
  assert.match(row, /执行结果/); assert.match(row, /FIRST_OUTPUT/);
  assert.equal(html.match(/FIRST_OUTPUT/g)?.length, 1);
  assert.match(html, /<strong>source<\/strong>/);
  assert.doesNotMatch(html, /工具 · read/);
});

test('parallel calls of the same tool match by call ID even when results arrive in reverse order', () => {
  const call = invocation();
  call.toolCalls!.push({ id: 'second', name: 'read', arguments: '{"path":"second.ts"}' });
  const html = render([call, { ...result('second', 'SECOND_OUTPUT'), id: 'second-result' }, result()]);
  const paired = rows(html);
  assert.equal(paired.length, 2);
  assert.match(paired[0], /first\.ts/); assert.match(paired[0], /FIRST_OUTPUT/);
  assert.doesNotMatch(paired[0], /SECOND_OUTPUT/);
  assert.match(paired[1], /second\.ts/); assert.match(paired[1], /SECOND_OUTPUT/);
  assert.doesNotMatch(paired[1], /FIRST_OUTPUT/);
});

test('pending and partial tool output update the same row without inventing a successful result', () => {
  const pending = render([invocation()]);
  assert.equal(rows(pending).length, 1); assert.match(pending, /未返回结果/);
  const partial = render([invocation(), { ...result('call', 'partial output'), complete: false }]);
  assert.equal(rows(partial).length, 1); assert.match(partial, /输出中/); assert.match(partial, /partial output/);
  const final = render([invocation(), result()]);
  assert.equal(rows(final).length, 1); assert.doesNotMatch(final, /输出中|未返回结果/);
});

test('a result outside the loaded call history remains visible and merges when history arrives', () => {
  const alone = render([result()]);
  assert.equal(rows(alone).length, 1); assert.match(alone, /FIRST_OUTPUT/);
  const paged = render([invocation(), result()]);
  assert.equal(rows(paged).length, 1); assert.match(paged, /first\.ts/); assert.match(paged, /FIRST_OUTPUT/);
});

test('a reused tool-call ID in a different run never attaches an old result to new work', () => {
  const html = render([{ ...result(), runId: 'old-run' }, invocation()]);
  const separate = rows(html);
  assert.equal(separate.length, 2);
  assert.match(separate[0], /FIRST_OUTPUT/);
  assert.match(separate[1], /未返回结果/); assert.doesNotMatch(separate[1], /FIRST_OUTPUT/);
});

test('missing IDs do not hide results or pair distinct calls just because the names match', () => {
  const html = render([invocation(''), { ...result(), toolCallId: undefined }]);
  assert.equal(rows(html).length, 2); assert.match(html, /FIRST_OUTPUT/);
});

test('failed output stays on the paired row and untrusted output is literal text', () => {
  const html = render([invocation(), { ...result('call', '<script>unsafe()</script>'), isError: true }]);
  assert.equal(rows(html).length, 1);
  assert.match(html, /tone-danger/); assert.match(html, /失败 ·/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
