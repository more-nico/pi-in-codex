import React, { memo, useMemo, useState } from 'react';
import type { Message, ToolCall } from '../src/types.js';
import { argumentHint, compactLine, outputSummary, prettyArguments, transcriptMessages, type TranscriptMessage } from './messages.js';
import { MessageContent } from './content.js';

function Disclosure({ label, hint, meta, tone, children, defaultOpen = false }: { label: string; hint?: string; meta?: string; tone?: 'danger'; children: () => React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className={`disclosure${tone ? ` tone-${tone}` : ''}`}>
    <summary><span className="disclosure-label">{label}</span>{hint && <span className="disclosure-hint" title={hint}>{hint}</span>}{meta && <span className="disclosure-meta">{meta}</span>}<span className="disclosure-chevron" aria-hidden="true" /></summary>
    {open && <div className="disclosure-body">{children()}</div>}
  </details>;
}

const ToolCallRow = memo(function ToolCallRow({ call, result, agentId, defaultOpen }: { call: ToolCall; result?: Message; agentId?: string; defaultOpen?: boolean }) {
  const meta = result ? `${result.isError ? '失败 · ' : ''}${outputSummary(result.text, result.textTotal)}` : '未返回结果';
  return <Disclosure label={call.name} hint={argumentHint(call.arguments)} meta={meta} tone={result?.isError ? 'danger' : undefined} defaultOpen={defaultOpen}>{() => <>
    <div className="tool-section-label">调用参数</div><pre>{prettyArguments(call.arguments)}</pre>
    <div className="tool-section-label">执行结果{result && !result.complete ? '（输出中）' : ''}</div>
    {result ? <MessageContent text={result.text} total={result.textTotal} literal source={agentId ? { agentId, messageId: result.id } : undefined} /> : <pre>尚未收到工具结果。</pre>}
    {result?.error && <p className="message-error">{result.error}</p>}
  </>}</Disclosure>;
});

const auxiliaryLabels: Record<string, string> = { toolResult: '工具结果', bashExecution: '命令', system: '系统', custom: '扩展消息', branchSummary: '分支摘要', compactionSummary: '压缩摘要' };
const auxiliaryLabel = (message: Message) => message.role === 'toolResult' && message.toolName ? `工具 · ${message.toolName}` : auxiliaryLabels[message.role] || `消息 · ${message.role}`;

const MessageItem = memo(function MessageItem({ message, tools, agentId, defaultExpanded }: TranscriptMessage & { agentId?: string; defaultExpanded?: boolean }) {
  const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (message.role === 'user') return <article className="message user">
    <header className="message-label"><span>指令</span><time>{time}</time></header>
    <MessageContent text={message.text} total={message.textTotal} source={agentId ? { agentId, messageId: message.id } : undefined} />
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  if (message.role === 'assistant') return <article className="message assistant">
    <header className="message-label"><span>PI</span><time>{time}</time>{!message.complete && <i className="typing" aria-label="正在输出" />}</header>
    {message.text ? <MessageContent text={message.text} total={message.textTotal} source={agentId ? { agentId, messageId: message.id } : undefined} /> : !message.complete ? <div className="message-text placeholder">…</div> : null}
    {tools.map(({ call, result }, index) => <ToolCallRow key={call.id || `${message.id}-${index}`} call={call} result={result} agentId={agentId} defaultOpen={defaultExpanded} />)}
    {!message.text && message.complete && !tools.length && <div className="message-text placeholder">(无文本)</div>}
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  return <article className={`message auxiliary${message.isError ? ' is-error' : ''}`}>
    <Disclosure label={auxiliaryLabel(message)} hint={message.command ? `$ ${message.command}` : compactLine(message.text)} meta={outputSummary(message.text, message.textTotal)} tone={message.isError ? 'danger' : undefined} defaultOpen={defaultExpanded}>{() => <>
      {message.command && <pre className="command-line"><span aria-hidden="true">$ </span>{message.command}</pre>}
      <MessageContent text={message.text} total={message.textTotal} literal={['tool', 'toolResult', 'bashExecution'].includes(message.role)} source={agentId ? { agentId, messageId: message.id } : undefined} />
    </>}</Disclosure>
  </article>;
}, (a, b) => a.message === b.message && a.agentId === b.agentId && a.defaultExpanded === b.defaultExpanded
  && a.tools.length === b.tools.length && a.tools.every((tool, index) => tool.call === b.tools[index].call && tool.result === b.tools[index].result));

export const Transcript = memo(function Transcript({ messages, agentId, defaultExpanded = false }: { messages: Message[]; agentId?: string; defaultExpanded?: boolean }) {
  const rows = useMemo(() => transcriptMessages(messages), [messages]);
  return <>{rows.map(item => <MessageItem key={item.message.id} {...item} agentId={agentId} defaultExpanded={defaultExpanded} />)}</>;
});
