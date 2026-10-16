import { App } from '@modelcontextprotocol/ext-apps';
import type { Agent } from '../src/types.js';

export const demo = new URLSearchParams(location.search).has('demo');
let application: App | undefined;
let connection: Promise<void> | undefined;
export function connect(onContext: (context: any) => void) {
  if (demo) { const requestedTheme = new URLSearchParams(location.search).get('theme'); onContext({ theme: requestedTheme === 'dark' || requestedTheme === 'light' ? requestedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }); return Promise.resolve(); }
  if (!connection) {
    application = new App({ name: 'pi-in-codex-panel', version: '0.1.0' }, {}, { autoResize: false });
    application.onhostcontextchanged = onContext;
    connection = application.connect().then(() => { onContext(application!.getHostContext() || {}); }).catch(error => { connection = undefined; application = undefined; throw error; });
  }
  return connection;
}
export async function call(name: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  if (demo) return demoCall(name, args);
  if (!application || !connection) throw new Error('Panel is not connected to Codex');
  await connection;
  const result = await application.callServerTool({ name, arguments: args }, { signal });
  if (result.isError) throw new Error(result.content?.map(item => item.type === 'text' ? item.text : '').join('\n') || 'Tool call failed');
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text');
  return text?.type === 'text' ? JSON.parse(text.text) : {};
}
const now = Date.now();
const sample: Agent[] = [
  { id: 'demo-research', threadId: 'demo', name: '核查会话隔离', cwd: '/workspace/pi_in_codex', status: 'running', runId: 'demo-run', task: '核查同一项目中多个聊天的会话隔离', activity: 'reading', createdAt: now - 42_000, startedAt: now - 42_000, tokens: 12480, toolUses: 8, dialogs: [], queued: [], pendingMessages: 0,
    model: { provider: 'demo', id: 'deepseek-v4.1-flash', thinking: 'max' }, messages: [
      { id: 'm1', runId: 'demo-run', role: 'user', text: '检查当前会话的子对话是否完全隔离。重点看跨聊天读取和多窗口切换。', complete: true, timestamp: now - 42_000 },
      { id: 'm2', runId: 'demo-run', role: 'assistant', text: '已确认每个请求都按父 threadId 查询，工作目录只用于执行任务。\n\n正在检查消息追加、停止任务和完成回传是否使用相同的归属校验。', complete: false, timestamp: now - 30_000 },
    ] },
  { id: 'demo-input', threadId: 'demo', name: '检查构建产物', cwd: '/workspace/pi_in_codex', status: 'waiting_input', runId: 'demo-input-run', task: '检查安装包', activity: 'waiting for input', createdAt: now - 28_000, startedAt: now - 28_000, tokens: 4200, toolUses: 3, dialogs: [{ id: 'confirm-1', method: 'confirm', title: '运行构建检查？', message: '允许执行 npm run build？' }], messages: [], queued: [], pendingMessages: 0 },
  { id: 'demo-done', threadId: 'demo', name: '整理 RPC 事件', cwd: '/workspace/pi_in_codex', status: 'completed', runId: 'demo-done-run', task: '梳理 RPC 生命周期', activity: 'completed', createdAt: now - 120_000, startedAt: now - 120_000, finishedAt: now - 60_000, tokens: 8300, toolUses: 5, dialogs: [], queued: [], pendingMessages: 0,
    messages: [{ id: 'm3', runId: 'demo-done-run', role: 'assistant', text: '应在 agent_settled 后判定完成。agent_end 后可能继续重试、压缩或处理排队输入。', complete: true, timestamp: now - 60_000 }] },
];
let revision = 0;
async function demoCall(name: string, args: any) {
  if (name === 'pi_poll' && args.cursor === `demo:${revision}`) await new Promise(resolve => setTimeout(resolve, 1000));
  if (name === 'pi_send') {
    const agent = sample.find(agent => agent.id === args.agentId)!;
    agent.messages.push({ id: crypto.randomUUID(), runId: agent.runId, role: 'user', text: args.message, timestamp: Date.now(), complete: true }); revision++;
  }
  if (name === 'pi_stop') { const agent = sample.find(agent => agent.id === args.agentId)!; agent.status = 'stopped'; agent.finishedAt = Date.now(); revision++; }
  if (name === 'pi_reply') { const agent = sample.find(agent => agent.id === args.agentId)!; agent.dialogs = []; agent.status = 'running'; agent.activity = 'thinking'; revision++; }
  if (name === 'pi_models') return { selected: sample[0].model, models: [{ provider: 'demo', id: 'deepseek-v4.1-flash' }], thinkingLevels: ['off', 'low', 'high', 'max'] };
  if (name === 'pi_read') return { messages: [], hasMore: false };
  return { cursor: `demo:${revision}`, full: true, agents: structuredClone(sample), pendingCompletions: 1 };
}
