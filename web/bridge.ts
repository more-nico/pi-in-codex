import { BUILD } from "../src/build.js";
import { App } from '@modelcontextprotocol/ext-apps';
import type { Agent, Message } from '../src/types.js';
import { PanelFeed, previewMessage } from '../src/panel-feed.js';

export const demo = new URLSearchParams(location.search).has('demo');
let application: App | undefined;
let connection: Promise<void> | undefined;
const panelId = crypto.randomUUID();
export function connect(onContext: (context: any) => void) {
  if (demo) { const requestedTheme = new URLSearchParams(location.search).get('theme'); onContext({ theme: requestedTheme === 'dark' || requestedTheme === 'light' ? requestedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }); return Promise.resolve(); }
  if (!connection) {
    application = new App({ name: 'pi-in-codex-panel', version: BUILD.version }, {}, { autoResize: false });
    application.onhostcontextchanged = onContext;
    connection = application.connect().then(() => { onContext(application!.getHostContext() || {}); }).catch(error => { connection = undefined; application = undefined; throw error; });
  }
  return connection;
}
export async function call(name: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  if (name === 'pi_poll') args = { ...args, panelId, transportVersion: 2 };
  if (demo) return demoCall(name, args);
  if (!application || !connection) throw new Error('Panel is not connected to Codex');
  await connection;
  const result = await application.callServerTool({ name, arguments: args }, { signal });
  if (result.isError) throw new Error(result.content?.map(item => item.type === 'text' ? item.text : '').join('\n') || 'Tool call failed');
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text');
  return text?.type === 'text' ? JSON.parse(text.text) : {};
}

// Demo data mirrors the daemon: poll snapshots window the newest 50 messages,
// pi_read paginates with a `before` cursor, and long commands stay compact once
// collapsed. This only runs with ?demo=1 and is never bundled into the daemon.
const now = Date.now();
function demoHistory(): Message[] {
  const runId = 'demo-history-run';
  const started = now - 3_600_000;
  const messages: Message[] = [];
  for (let index = 0; index < 137; index++) {
    const id = `history-${index}`;
    const timestamp = started + index * 25_000;
    const label = `#${String(index).padStart(3, '0')}`;
    const cycle = Math.floor(index / 5), step = index % 5;
    if (index === 136) { messages.push({ id, runId, role: 'assistant', text: `${label} 正在汇总分页检查结果，这条流式消息还没有结束…`, complete: false, timestamp }); continue; }
    if (step === 0) messages.push({ id, runId, role: 'user', text: `${label} 请检查第 ${cycle + 1} 组消息的边界处理，并说明分页是否保持滚动位置。`, complete: true, timestamp });
    else if (step === 1) messages.push({ id, runId, role: 'assistant', text: `${label} 已确认这一组窗口的起点与终点。\n\n接下来检查工具输出折叠后是否仍然可读。`, complete: true, timestamp });
    else if (step === 2) {
      const command = cycle % 3 === 0;
      messages.push({ id, runId, role: 'assistant', text: '', complete: true, timestamp,
        toolCalls: [{ id: `${id}-tool`, name: command ? 'bash' : 'read', arguments: command
          ? JSON.stringify({ command: `for n in $(seq 1 ${cycle + 4}); do echo "paging \${n}"; done && grep -rn "MESSAGE_PAGE" web/ src/ | head -20 && echo ${'audit-'.repeat(12)}` })
          : JSON.stringify({ path: `src/module-${cycle}.ts`, offset: cycle * 40, limit: 80 }) }] });
    } else if (step === 3) messages.push({ id, runId, role: 'toolResult', toolName: cycle % 3 === 0 ? 'bash' : 'read', toolCallId: `${messages[messages.length - 1].id}-tool`,
      text: `${label} 输出\n${Array.from({ length: 6 + (index % 5) }, (_, line) => `line ${line + 1}: ${'data-'.repeat(4 + (index % 8))}${line}`).join('\n')}`, complete: true, timestamp });
    else messages.push({ id, runId, role: 'bashExecution', toolName: 'bash', command: `git log --oneline -n ${(index % 9) + 3} -- src/ web/ && echo ${'done-'.repeat(8)}`,
      text: `${label} 命令输出\n${Array.from({ length: 4 + (index % 4) }, (_, line) => `commit ${String(line).padStart(4, '0')} ${label} ${'subject '.repeat(3)}`).join('\n')}`, complete: true, timestamp });
  }
  return messages;
}
const sample: Agent[] = [
  { id: 'demo-markdown', threadId: 'demo', name: 'Markdown 渲染预览', cwd: '/workspace/pi_in_codex', status: 'running', runId: 'demo-markdown-run', task: '查看 Markdown 消息样式', activity: 'responding', createdAt: now - 90_000, startedAt: now - 90_000, tokens: 1800, toolUses: 0, dialogs: [], queued: [], pendingMessages: 0,
    messages: [{ id: 'md-1', runId: 'demo-markdown-run', role: 'assistant', complete: true, timestamp: now - 10_000,
      text: ['## 审查结果', '', '**结论：** 消息已支持 Markdown，可继续查看 `pi_wait` 的等待结果。', '', '- [x] 命令默认折叠', '- [x] 最近 50 条消息', '- [ ] 手动向上查找更早消息', '', '> 子任务提前完成时，等待会立即结束，无需等满预估时间。', '', '```ts', 'const result = await pi_wait({', '  agentIds: [agentId],', '  timeoutMs: 10 * 60 * 1000,', '});', '```', '', '| 功能 | 状态 |', '| --- | --- |', '| 自定义等待 | 最长 60 分钟 |', '| Markdown | 标题、列表、引用、表格、代码 |', '', '[Markdown 语法参考](https://commonmark.org/help/)', '', '~~旧的纯文本显示~~ → 新的消息排版'].join('\n') }] },
  { id: 'demo-research', threadId: 'demo', name: '核查会话隔离', cwd: '/workspace/pi_in_codex', status: 'running', runId: 'demo-run', task: '核查同一项目中多个聊天的会话隔离', activity: 'responding', createdAt: now - 42_000, startedAt: now - 42_000, tokens: 12480, toolUses: 8, dialogs: [], queued: [], pendingMessages: 0,
    model: { provider: 'demo', id: 'deepseek-v4.1-flash', thinking: 'max' }, messages: [
      { id: 'r1', runId: 'demo-run', role: 'user', text: '检查当前会话的子对话是否完全隔离。重点看跨聊天读取和多窗口切换。', complete: true, timestamp: now - 42_000 },
      { id: 'r2', runId: 'demo-run', role: 'assistant', text: '已确认每个请求都按父 threadId 查询，工作目录只用于执行任务。', complete: true, timestamp: now - 38_000,
        toolCalls: [{ id: 'r2-call', name: 'bash', arguments: JSON.stringify({ command: `grep -rn "threadId" src/ --include='*.ts' | head -40 && echo ${'audit-'.repeat(10)}` }) }] },
      { id: 'r3', runId: 'demo-run', role: 'toolResult', toolName: 'bash', toolCallId: 'r2-call', complete: true, timestamp: now - 36_000,
        text: 'src/manager.ts:73:  snapshot(threadId: string) {\nsrc/manager.ts:299:  read(threadId: string, id: string) {\nsrc/daemon.ts:61:  manager.assertParent(threadId);\n… 共 37 行匹配' },
      { id: 'r4', runId: 'demo-run', role: 'bashExecution', toolName: 'bash', command: `npm test -- --grep '边界'`,
        text: 'ok 1 - 分页边界\nok 2 - 滚动锚点\nok 3 - 折叠摘要', complete: true, timestamp: now - 33_000 },
      { id: 'r5', runId: 'demo-run', role: 'assistant', text: '正在检查消息追加、停止任务和完成回传是否使用相同的归属校验。', complete: false, timestamp: now - 30_000 },
    ] },
  { id: 'demo-history', threadId: 'demo', name: '长对话分页验证', cwd: '/workspace/pi_in_codex', status: 'running', runId: 'demo-history-run', task: '验证 50 条分页、折叠与滚动锚点', activity: 'responding', createdAt: now - 3_600_000, startedAt: now - 3_600_000, tokens: 92000, toolUses: 41, dialogs: [], queued: [], pendingMessages: 0,
    model: { provider: 'demo', id: 'demo-history-model', thinking: 'high' }, messages: demoHistory() },
  { id: 'demo-input', threadId: 'demo', name: '检查构建产物', cwd: '/workspace/pi_in_codex', status: 'waiting_input', runId: 'demo-input-run', task: '检查安装包', activity: 'waiting for input', createdAt: now - 28_000, startedAt: now - 28_000, tokens: 4200, toolUses: 3, dialogs: [{ id: 'confirm-1', method: 'confirm', title: '运行构建检查？', message: '允许执行 npm run build？' }], messages: [], queued: [], pendingMessages: 0 },
  { id: 'demo-done', threadId: 'demo', name: '整理 RPC 事件', cwd: '/workspace/pi_in_codex', status: 'completed', runId: 'demo-done-run', task: '梳理 RPC 生命周期', activity: 'completed', createdAt: now - 120_000, startedAt: now - 120_000, finishedAt: now - 60_000, tokens: 8300, toolUses: 5, dialogs: [], queued: [], pendingMessages: 0,
    messages: [
      { id: 'd0', runId: 'demo-done-run', role: 'user', text: '检查 RPC 的任务完成时机。', complete: true, timestamp: now - 120_000 },
      { id: 'd1', runId: 'demo-done-run', role: 'assistant', text: '读取协议说明。', toolCalls: [{ id: 'done-read', name: 'read', arguments: JSON.stringify({ path: 'docs/rpc.md' }) }], complete: true, timestamp: now - 100_000 },
      { id: 'd2', runId: 'demo-done-run', role: 'toolResult', toolName: 'read', toolCallId: 'done-read', text: 'agent_end\nagent_settled\nauto_retry_start', complete: true, timestamp: now - 80_000 },
      { id: 'd3', runId: 'demo-done-run', role: 'assistant', text: '## 检查结论\n\n应在 **`agent_settled`** 后判定任务完成。\n\n- `agent_end` 后仍可能继续重试、压缩或处理排队输入。\n- 本次检查已完成，未发现提前结算问题。', complete: true, timestamp: now - 60_000 },
    ] },
];
if (demo && new URLSearchParams(location.search).has('failed')) sample.push({
  id: 'demo-failed', threadId: 'demo', name: '连接失败示例', cwd: '/workspace/pi_in_codex', status: 'failed',
  runId: 'demo-failed-run', task: '展示失败任务分组', activity: 'failed', createdAt: now - 80_000,
  startedAt: now - 80_000, finishedAt: now - 10_000, error: 'Connection error.', tokens: 120, toolUses: 0,
  dialogs: [], queued: [], pendingMessages: 0,
  messages: [{ id: 'failed-1', runId: 'demo-failed-run', role: 'assistant', text: '', error: 'Connection error.', complete: true, timestamp: now - 10_000 }],
});
if (new URLSearchParams(location.search).has('performance')) sample.push({
  id: 'demo-large', threadId: 'demo', name: '长日志负载验证', cwd: '/workspace/pi_in_codex', status: 'running', runId: 'demo-large-run',
  task: '验证详情按需加载', activity: 'responding', createdAt: now - 1000, startedAt: now - 1000, tokens: 1000, toolUses: 1, dialogs: [], queued: [], pendingMessages: 0,
  messages: [
    { id: 'large-call', runId: 'demo-large-run', role: 'assistant', text: '日志已生成，展开后可分段阅读。', complete: true, timestamp: now,
      toolCalls: [{ id: 'large-tool', name: 'bash', arguments: '{"command":"npm test"}' }] },
    { id: 'large-result', runId: 'demo-large-run', role: 'toolResult', toolCallId: 'large-tool', toolName: 'bash', text: Array.from({ length: 10_000 }, (_, i) => `PERF_LOG_LINE ${i + 1}: passed\n`).join(''), complete: true, timestamp: now },
  ],
});
let revision = 0;
const changes = new Map<string, number>();
const touch = (id: string) => { revision++; changes.set(id, revision); };
const windowed = (agent: Agent) => ({ ...agent, messageTotal: agent.messages.length, messages: agent.messages.slice(-50).map(message => ({ ...message })) });
const feed = new PanelFeed();
const snapshot = () => ({ cursor: `demo:${revision}`, full: true, agents: sample.map(windowed), pendingCompletions: 1 });
async function demoCall(name: string, args: any) {
  if (name === 'pi_poll') {
    const cursor = typeof args.cursor === 'string' ? args.cursor : '';
    if (cursor === `demo:${revision}`) await new Promise(resolve => setTimeout(resolve, 1000));
    if (args.transportVersion === 2) {
      const value = cursor.startsWith('demo:') ? Number(cursor.slice(5)) : NaN;
      const after = Number.isSafeInteger(value) && value >= 0 && value <= revision ? value : undefined;
      return { cursor: `demo:${revision}`, full: after === undefined, transportVersion: 2, pendingCompletions: 1,
        agents: sample.filter(agent => after === undefined || (changes.get(agent.id) || 0) > after).map(agent => feed.agent(agent, revision, after)) };
    }
    if (!cursor.startsWith('demo:')) return snapshot();
    const previous = Number(cursor.slice('demo:'.length));
    if (!Number.isSafeInteger(previous) || previous < 0 || previous > revision) return snapshot();
    return { cursor: `demo:${revision}`, full: false, agents: sample.filter(agent => (changes.get(agent.id) || 0) > previous).map(windowed), pendingCompletions: 1 };
  }
  if (name === 'pi_read') {
    const agent = sample.find(item => item.id === args.agentId);
    if (!agent) return { messages: [], hasMore: false };
    if (args.messageId) {
      const message = agent.messages.find(message => message.id === args.messageId);
      if (!message) throw new Error('Message not found');
      const offset = args.offset || 0, max = args.maxChars || 16_000;
      return { messages: [{ ...message, text: message.text.slice(offset, offset + max), textTotal: message.text.length, textOffset: offset }] };
    }
    const limit = Number(args.limit) || 50;
    const end = args.before ? agent.messages.findIndex(message => message.id === args.before) : agent.messages.length;
    if (end < 0) return { messages: [], hasMore: false };
    const eligible = agent.messages.slice(0, end);
    return { messages: eligible.slice(-limit).map(message => args.preview ? previewMessage(message) : { ...message }), hasMore: eligible.length > limit };
  }
  if (name === 'pi_send') {
    const agent = sample.find(item => item.id === args.agentId)!;
    agent.messages.push({ id: crypto.randomUUID(), runId: agent.runId, role: 'user', text: args.message, timestamp: Date.now(), complete: true }); touch(agent.id);
  }
  if (name === 'pi_stop') { const agent = sample.find(item => item.id === args.agentId)!; agent.status = 'stopped'; agent.finishedAt = Date.now(); touch(agent.id); }
  if (name === 'pi_reply') { const agent = sample.find(item => item.id === args.agentId)!; agent.dialogs = []; agent.status = 'running'; agent.activity = 'thinking'; touch(agent.id); }
  if (name === 'pi_models') return { selected: sample[0].model, models: [{ provider: 'demo', id: 'deepseek-v4.1-flash' }], thinkingLevels: ['off', 'low', 'high', 'max'] };
  return snapshot();
}
