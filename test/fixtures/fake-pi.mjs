#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('1.2.0'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const directory = process.argv.includes('--session-dir') ? option('--session-dir') : '/tmp';
const sessionFile = process.argv.includes('--session') ? option('--session') : join(directory, 'fake-session.jsonl');
mkdirSync(directory, { recursive: true }); writeFileSync(sessionFile, '{}\n');
let buffer = '', running = false, model = { provider: 'fake', id: 'test-model' }, thinkingLevel = 'high', held = '', pendingDialog, startupRequest;
let startupAsked = false;
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const response = (command, data) => emit({ id: command.id, type: 'response', command: command.type, success: true, data });
const message = (role, text, stopReason = 'stop') => ({ role, content: role === 'user' ? text : [{ type: 'text', text }], stopReason, timestamp: Date.now(), usage: { totalTokens: role === 'assistant' ? 12 : 0 } });
function finish(text = '完成：你好\u2028世界\u2029✓', failed = false) {
  if (!running) return;
  const final = message('assistant', text, failed ? 'error' : 'stop');
  if (failed) final.errorMessage = 'provider failed';
  emit({ type: 'message_end', message: final }); emit({ type: 'agent_end', messages: [final] });
  setTimeout(() => { if (!running) return; running = false; emit({ type: 'agent_settled', aborted: false }); }, 35);
}
function begin(command) {
  if (command.message === 'handled') { response(command, { disposition: 'handled' }); return; }
  running = true; held = command.message; response(command, { disposition: 'started' });
  emit({ type: 'agent_start' });
  const user = message('user', command.message);
  emit({ type: 'message_start', message: user }); emit({ type: 'message_end', message: user });
  if (command.message === 'empty') { emit({ type: 'agent_end', messages: [] }); setTimeout(() => { running = false; emit({ type: 'agent_settled', aborted: false }); }, 20); return; }
  emit({ type: 'message_start', message: message('assistant', '', 'pending') });
  if (command.message === 'fast') { emit({ type: 'message_end', message: message('assistant', 'FAST_OK') }); emit({ type: 'agent_end', messages: [] }); running = false; emit({ type: 'agent_settled', aborted: false }); return; }
  if (command.message === 'hold') return;
  if (command.message === 'end-only') { emit({ type: 'agent_end', messages: [] }); return; }
  if (command.message === 'crash') { setTimeout(() => process.exit(2), 10); return; }
  if (command.message === 'malformed') { process.stdout.write('{broken\n'); return; }
  if (command.message === 'dialog') { pendingDialog = 'input-1'; emit({ type: 'extension_ui_request', id: pendingDialog, method: 'input', title: '请输入说明' }); return; }
  if (command.message === 'retry') {
    emit({ type: 'agent_end', messages: [], willRetry: true });
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 150 });
    setTimeout(() => { emit({ type: 'compaction_start', reason: 'overflow' }); }, 60);
    setTimeout(() => { emit({ type: 'compaction_end', reason: 'overflow', willRetry: true }); finish(); }, 150); return;
  }
  emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'src.ts' } });
  emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [] }, isError: false });
  const update = Buffer.from(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好\u2028世界\u2029✓' } }) + '\n');
  for (let offset = 0; offset < update.length; offset += 3) process.stdout.write(update.subarray(offset, offset + 3));
  setTimeout(() => finish(undefined, command.message === 'fail'), 15);
}
function handle(command) {
  switch (command.type) {
    case 'get_state':
      if (process.argv.includes('--startup-dialog') && !startupAsked) { startupAsked = true; startupRequest = command; emit({ type: 'extension_ui_request', id: 'startup-input', method: 'input', title: 'startup input' }); }
      else if (process.argv.includes('--slow-state')) setTimeout(() => response(command, { model, thinkingLevel, sessionFile, isStreaming: running }), 5000);
      else response(command, { model, thinkingLevel, sessionFile, sessionId: 'fake-session', isStreaming: running });
      break;
    case 'get_available_models': response(command, { models: [model] }); break;
    case 'get_available_thinking_levels': response(command, { levels: ['off', 'high', 'max'] }); break;
    case 'set_model': model = { provider: command.provider, id: command.modelId }; response(command, model); break;
    case 'set_thinking_level': thinkingLevel = command.level; response(command, {}); break;
    case 'prompt': if (command.message === 'prompt-fail') emit({ id: command.id, type: 'response', command: command.type, success: false, error: 'prompt rejected' }); else if (running && command.streamingBehavior) handle({ ...command, type: command.streamingBehavior === 'followUp' ? 'follow_up' : 'steer' }); else begin(command); break;
    case 'steer': case 'follow_up': {
      response(command, { disposition: 'queued' });
      emit({ type: 'queue_update', steering: command.type === 'steer' ? [command.message] : [], followUp: command.type === 'follow_up' ? [command.message] : [] });
      const user = message('user', command.message); emit({ type: 'message_start', message: user }); emit({ type: 'message_end', message: user });
      if (held === 'hold') setTimeout(() => { emit({ type: 'message_start', message: message('assistant', '', 'pending') }); finish(command.message); }, 10);
      break;
    }
    case 'extension_ui_response': if (command.id === 'startup-input' && startupRequest) { response(startupRequest, { model, thinkingLevel, sessionFile, isStreaming: false }); startupRequest = undefined; } else if (command.id === pendingDialog) { emit({ type: 'message_start', message: message('assistant', '', 'pending') }); finish(command.value || 'cancelled'); } break;
    case 'abort': running = false; response(command, {}); emit({ type: 'agent_settled', aborted: true }); break;
    default: response(command, {});
  }
}
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
