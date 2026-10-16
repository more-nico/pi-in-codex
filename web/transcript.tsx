import React from 'react';
import type { Message, ToolCall } from '../src/types.js';
import { MarkdownText } from './markdown.js';
import { argumentHint, compactLine, outputSummary, prettyArguments, transcriptMessages, type TranscriptMessage } from './messages.js';

function Disclosure({ label, hint, meta, tone, children }: { label: string; hint?: string; meta?: string; tone?: 'danger'; children: React.ReactNode }) {
  return <details className={`disclosure${tone ? ` tone-${tone}` : ''}`}>
    <summary><span className="disclosure-label">{label}</span>{hint && <span className="disclosure-hint" title={hint}>{hint}</span>}{meta && <span className="disclosure-meta">{meta}</span>}<span className="disclosure-chevron" aria-hidden="true" /></summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

function ToolCallRow({ call, result }: { call: ToolCall; result?: Message }) {
  const meta = result ? `${result.isError ? '失败 · ' : ''}${outputSummary(result.text)}` : '未返回结果';
  return <Disclosure label={call.name} hint={argumentHint(call.arguments)} meta={meta} tone={result?.isError ? 'danger' : undefined}>
    <div className="tool-section-label">调用参数</div><pre>{prettyArguments(call.arguments)}</pre>
    <div className="tool-section-label">执行结果{result && !result.complete ? '（输出中）' : ''}</div>
    <pre>{result ? result.text || '（空输出）' : '尚未收到工具结果。'}</pre>
    {result?.error && <p className="message-error">{result.error}</p>}
  </Disclosure>;
}

const auxiliaryLabels: Record<string, string> = { toolResult: '工具结果', bashExecution: '命令', system: '系统', custom: '扩展消息', branchSummary: '分支摘要', compactionSummary: '压缩摘要' };
const auxiliaryLabel = (message: Message) => message.role === 'toolResult' && message.toolName ? `工具 · ${message.toolName}` : auxiliaryLabels[message.role] || `消息 · ${message.role}`;

function MessageItem({ message, tools }: TranscriptMessage) {
  const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (message.role === 'user') return <article className="message user">
    <header className="message-label"><span>指令</span><time>{time}</time></header>
    <MarkdownText text={message.text} />
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  if (message.role === 'assistant') return <article className="message assistant">
    <header className="message-label"><span>PI</span><time>{time}</time>{!message.complete && <i className="typing" aria-label="正在输出" />}</header>
    {message.text ? <MarkdownText text={message.text} /> : !message.complete ? <div className="message-text placeholder">…</div> : null}
    {tools.map(({ call, result }, index) => <ToolCallRow key={call.id || `${message.id}-${index}`} call={call} result={result} />)}
    {!message.text && message.complete && !tools.length && <div className="message-text placeholder">(无文本)</div>}
    {message.error && <p className="message-error">{message.error}</p>}
  </article>;
  return <article className={`message auxiliary${message.isError ? ' is-error' : ''}`}>
    <Disclosure label={auxiliaryLabel(message)} hint={message.command ? `$ ${message.command}` : compactLine(message.text)} meta={outputSummary(message.text)} tone={message.isError ? 'danger' : undefined}>
      {message.command && <pre className="command-line"><span aria-hidden="true">$ </span>{message.command}</pre>}
      {['tool', 'toolResult', 'bashExecution'].includes(message.role)
        ? <pre>{message.text || '（空输出）'}</pre>
        : <MarkdownText text={message.text || '（空输出）'} />}
    </Disclosure>
  </article>;
}

export function Transcript({ messages }: { messages: Message[] }) {
  return <>{transcriptMessages(messages).map(item => <MessageItem key={item.message.id} {...item} />)}</>;
}
