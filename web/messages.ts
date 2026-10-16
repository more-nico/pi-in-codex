import type { Agent, Message, ToolCall } from '../src/types.js';

/** History is loaded in pages of this size; the manager windows poll snapshots the same way. */
export const MESSAGE_PAGE = 50;

export type TranscriptMessage = { message: Message; tools: Array<{ call: ToolCall; result?: Message }> };
const toolKey = (runId: string, id: string) => JSON.stringify([runId, id]);
const isToolResult = (message: Message) => message.role === 'toolResult' || message.role === 'tool';

/** A tool invocation and its result are one row, matched by run and call ID, never by tool name. */
export function transcriptMessages(messages: Message[]): TranscriptMessage[] {
  const calls = new Set<string>(), results = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls || []) if (call.id) calls.add(toolKey(message.runId, call.id));
    if (isToolResult(message) && message.toolCallId) results.set(toolKey(message.runId, message.toolCallId), message);
  }
  return messages.flatMap(message => {
    // An unmatched result stays visible when its invocation is outside the loaded history window.
    if (isToolResult(message) && message.toolCallId && calls.has(toolKey(message.runId, message.toolCallId))) return [];
    return [{ message, tools: message.role === 'assistant' ? (message.toolCalls || []).map(call => ({
      call, result: call.id ? results.get(toolKey(message.runId, call.id)) : undefined,
    })) : [] }];
  });
}

/** A completed task opens on its final answer, never on tool calls or an older run. */
export function completedSummary(agent: Agent): string {
  if (agent.finalText !== undefined) return agent.finalText.trim() || '本次任务未生成文字总结。';
  const final = agent.messages.findLast(message => message.runId === agent.runId && message.role === 'assistant' && message.complete);
  return final?.text.trim() || '本次任务未生成文字总结。';
}

/** The final prose is shown below the process disclosure, without duplicating it inside. */
export function completedProcessMessages(agent: Agent, messages: Message[]): Message[] {
  const final = agent.messages.findLast(message => message.runId === agent.runId && message.role === 'assistant' && message.complete);
  return messages.flatMap(message => message.id !== final?.id ? [message] : message.toolCalls?.length ? [{ ...message, text: '' }] : []);
}

/** Merge a newer poll window into the held transcript without dropping messages that left the window. */
export function mergeWindow(current: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return current;
  if (!current.length) return incoming.slice();
  const positions = new Map(current.map((message, index) => [message.id, index]));
  const merged = current.slice();
  const appended: Message[] = [];
  for (const message of incoming) {
    const index = positions.get(message.id);
    if (index === undefined) appended.push(message);
    else merged[index] = message;
  }
  return appended.length ? [...merged, ...appended] : merged;
}

/** Apply a poll snapshot. Without paging, `messages` is always replaced by the newest window so the view stays at 50. Once the user asked for history, merge instead so nothing loaded is lost when the window slides. */
export function mergeAgents(previous: Agent[], snapshot: { full?: boolean; agents?: Agent[] }, keepHistory: (id: string) => boolean = () => false): Agent[] {
  const incoming = snapshot.agents || [];
  const held = new Map(previous.map(agent => [agent.id, agent]));
  const apply = (agent: Agent) => {
    const current = held.get(agent.id);
    return current && keepHistory(agent.id) ? { ...agent, messages: mergeWindow(current.messages, agent.messages) } : agent;
  };
  const next = snapshot.full ? incoming.map(apply) : (() => {
    const merged = new Map(held);
    for (const agent of incoming) merged.set(agent.id, apply(agent));
    return [...merged.values()];
  })();
  return next.sort((a, b) => a.createdAt - b.createdAt);
}

/** The newest page shown while the user has not asked for history yet. */
export function recentMessages(messages: Message[]): Message[] {
  return messages.slice(-MESSAGE_PAGE);
}

/** Prepend an older page, ignoring ids already held because pages overlap while the tail moves. */
export function mergeOlder(older: Message[], page: Message[]): Message[] {
  const seen = new Set(older.map(message => message.id));
  const prepended: Message[] = [];
  for (const message of page) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    prepended.push(message);
  }
  return [...prepended, ...older];
}

/** Chronological transcript: explicitly loaded history plus the current tail, where the tail wins updates. */
export function visibleMessages(older: Message[], latest: Message[]): Message[] {
  const latestIds = new Set(latest.map(message => message.id));
  return [...older.filter(message => !latestIds.has(message.id)), ...latest];
}

export function hasEarlierMessages(total: number | undefined, visibleCount: number): boolean {
  return typeof total === 'number' && visibleCount < total;
}

const ARGUMENT_KEYS = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'name'];

/** One compact line for a tool call, so even huge arguments stay a single collapsible row. */
export function argumentHint(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ARGUMENT_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return compactLine(value);
      if (typeof value === 'number') return `${key}: ${value}`;
    }
    const first = Object.values(record).find(value => typeof value === 'string' && value.trim());
    if (typeof first === 'string') return compactLine(first);
  }
  return compactLine(raw);
}

export function prettyArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch { /* clipped or non-JSON arguments are shown as stored */ }
  return raw;
}

export function compactLine(value: string, max = 96): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function outputSummary(text: string): string {
  if (!text) return '空输出';
  const lines = text.split('\n').length;
  return lines > 1 ? `${lines} 行` : `${text.length} 字符`;
}
