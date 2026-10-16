import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, Dialog, Message } from '../src/types.js';
import { call, connect, demo } from './bridge.js';
import { activityLabel, compactTokens, elapsed, statusLabel } from './format.js';
import './style.css';

const active = (agent: Agent) => ['queued', 'starting', 'running', 'waiting_input'].includes(agent.status);
function StatusDot({ agent }: { agent: Agent }) { return <span aria-label={statusLabel[agent.status]} className={`status-dot ${agent.status}`}>{agent.status === 'completed' ? '✓' : agent.status === 'waiting_input' ? '!' : ['failed', 'interrupted'].includes(agent.status) ? '×' : ''}</span>; }

function Panel() {
  const [agents, setAgents] = useState<Agent[]>([]), [selected, setSelected] = useState<string>(), [connected, setConnected] = useState(false);
  const [error, setError] = useState(''), [pending, setPending] = useState(0), [completedOpen, setCompletedOpen] = useState(false), [listOpen, setListOpen] = useState(true);
  const [draft, setDraft] = useState(''), [mode, setMode] = useState('steer'), [sending, setSending] = useState(false), [models, setModels] = useState<any>();
  const [older, setOlder] = useState<Record<string, Message[]>>({}), [loadingOlder, setLoadingOlder] = useState(false), [noMore, setNoMore] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0), [, tick] = useState(0), [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const agent = agents.find(agent => agent.id === selected);
  const visibleMessages = agent ? [...(older[agent.id] || []).filter(message => !agent.messages.some(current => current.id === message.id)), ...agent.messages] : [];
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const updateContext = (context: any) => {
      if (context.theme) document.documentElement.dataset.theme = context.theme;
      const variables = context.styles?.variables || {};
      for (const [key, value] of Object.entries(variables)) if (typeof value === 'string' && key.startsWith('--')) document.documentElement.style.setProperty(key, value);
    };
    (async () => {
      try {
        await connect(updateContext); if (disposed) return;
        setConnected(true); let cursor: string | undefined;
        while (!disposed) {
          try {
            const snapshot = await call('pi_poll', { cursor, waitMs: cursor ? 20_000 : 0 }, controller.signal);
            if (disposed) return;
            setAgents(previous => snapshot.full ? snapshot.agents || [] : [...previous.filter(agent => !snapshot.agents.some((updated: Agent) => updated.id === agent.id)), ...snapshot.agents].sort((a, b) => a.createdAt - b.createdAt));
            setPending(snapshot.pendingCompletions || 0); cursor = snapshot.cursor;
            setError('');
          } catch (e) { if (disposed) return; setError((e as Error).message); cursor = undefined; await new Promise(resolve => setTimeout(resolve, 2000)); }
        }
      } catch (e) { if (!disposed) setError((e as Error).message); }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [attempt]);
  useEffect(() => { setSelected(previous => previous && agents.some(agent => agent.id === previous) ? previous : agents[0]?.id); }, [agents]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [agent?.messages, older, follow]);
  const choose = (id: string) => { setSelected(id); setDraft(''); setModels(undefined); setFollow(true); };
  async function action(name: string, args: any) { try { await call(name, args); setError(''); } catch (e) { setError((e as Error).message); } }
  async function send() {
    if (!agent || !draft.trim() || sending) return;
    setSending(true);
    try { await call('pi_send', { agentId: agent.id, message: draft.trim(), mode }); setDraft(''); setError(''); setFollow(true); }
    catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  const running = agents.filter(agent => agent.status !== 'completed').sort((a, b) => a.createdAt - b.createdAt);
  const completed = agents.filter(agent => agent.status === 'completed').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const row = (item: Agent) => <button key={item.id} className={`agent-row ${selected === item.id ? 'selected' : ''}`} onClick={() => choose(item.id)}>
    <StatusDot agent={item} /><span className="agent-info"><span className="row-top"><strong>{item.name}</strong><time>{elapsed(item.startedAt, item.finishedAt)}</time></span>
      <span className="row-bottom"><span>{activityLabel(item.activity)}</span><span>{compactTokens(item.tokens)} tokens · {item.toolUses} tools</span></span></span>
  </button>;
  return <main>
    <header className="topbar"><div className="brand"><span className="pi-symbol">π</span><div><strong>Pi agents</strong><small>当前会话 · 独立子对话</small></div></div><span className="connection"><i className={connected && !error ? 'online' : ''} />{demo ? '演示数据' : connected ? '已连接' : '连接中'}</span></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => { setError(''); setAttempt(value => value + 1); }}>重试</button></div>}
    <section className={`floating-list ${listOpen ? '' : 'minimized'}`} aria-label="子对话列表">
      <button className="list-heading" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}><span>子对话 <b>{agents.filter(active).length}</b><em>进行中</em></span><span>{listOpen ? '⌃' : '⌄'}</span></button>
      {listOpen && <div className="list-body">{running.length ? running.map(row) : <div className="list-empty">当前没有运行中的子对话</div>}
        {completed.length > 0 && <><button className="completed-heading" onClick={() => setCompletedOpen(!completedOpen)} aria-expanded={completedOpen}><span>{completedOpen ? '⌄' : '›'} 已完成</span><span>{completed.length}</span></button>{completedOpen && completed.map(row)}</>}
      </div>}
    </section>
    {pending > 0 && <div className="delivery-note"><span>↗</span> {pending} 个结果待主对话接收或确认</div>}
    {!agent ? <div className="empty-state"><div className="empty-icon">π</div><h1>把一部分任务交给 Pi</h1><p>让 Codex 调用 pi_spawn，子对话会出现在这里。每个聊天都有自己的列表。</p><code>“用 pi 子 agent 检查这个模块”</code></div> : <section className="conversation">
      <div className="conversation-heading"><div><h1>{agent.name}</h1><p><StatusDot agent={agent} />{statusLabel[agent.status]}<span>·</span>{elapsed(agent.startedAt, agent.finishedAt)}</p></div>
        {active(agent) && <button className="stop-button" onClick={() => action('pi_stop', { agentId: agent.id })}>■ 停止</button>}
      </div>
      <button className="model-button" title={agent.cwd} onClick={async () => { try { setModels(models ? undefined : await call('pi_models', { agentId: agent.id })); } catch (e) { setError((e as Error).message); } }}>{agent.model ? `${agent.model.provider} / ${agent.model.id}${agent.model.thinking ? ` · ${agent.model.thinking}` : ''}` : '使用 pi 默认模型'} <span>⌄</span></button>
      {models && <div className="model-details"><strong>pi 可用思考档位</strong><p>{models.thinkingLevels?.join(' · ') || '未提供'}</p><small>{models.models?.length || 0} 个已配置模型 · 模型由 Codex 在创建时指定</small></div>}
      <div className="messages" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 60); }}>
        {agent.messages.length >= 200 && !noMore[agent.id] && <button className="load-older" disabled={loadingOlder} onClick={async () => {
          setLoadingOlder(true); try { const page = await call('pi_read', { agentId: agent.id, limit: 200, includeTools: true, before: visibleMessages[0]?.id }); setOlder(previous => ({ ...previous, [agent.id]: [...page.messages, ...(previous[agent.id] || [])] })); setNoMore(previous => ({ ...previous, [agent.id]: !page.hasMore })); setFollow(false); } catch (e) { setError((e as Error).message); } finally { setLoadingOlder(false); }
        }}>加载更早的消息</button>}
        {visibleMessages.length === 0 && <p className="no-messages">{agent.status === 'queued' ? '任务已排队，等待可用运行名额。' : '等待 Pi 的第一条消息…'}</p>}
        {visibleMessages.map(message => <article key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === 'assistant' ? 'PI' : message.role === 'user' ? '指令' : message.toolName || message.role}<span>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{!message.complete && <i className="typing">●</i>}</div><div className="message-text">{message.text || (!message.complete ? '…' : '(无文本)')}</div>{message.error && <small className="message-error">{message.error}</small>}</article>)}
        {agent.error && <p className="run-error">{agent.error}</p>}
        {!!agent.undelivered?.length && <div className="run-error">未确认送达的排队消息：{agent.undelivered.map((text, index) => <p key={index}>{text}</p>)}</div>}
      </div>
      {!follow && <button className="jump-latest" onClick={() => setFollow(true)}>↓ 回到最新消息</button>}
      {agent.dialogs.map(dialog => <InputRequest key={dialog.id} agent={agent} dialog={dialog} onReply={args => action('pi_reply', args)} />)}
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea aria-label="追加指令" placeholder={active(agent) ? '追加指令，继续推进这项任务…' : '发送新消息，继续这个子对话…'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
        <div className="composer-footer"><select aria-label="消息发送方式" value={mode} onChange={event => setMode(event.target.value)}><option value="steer">运行中引导</option><option value="followUp">结束后跟进</option></select><button className="send-button" type="submit" disabled={!draft.trim() || sending}>{sending ? '发送中' : '发送'} <span>↑</span></button></div>
      </form>
    </section>}
    <footer className="bottom-note">仅显示当前聊天的 Pi 子对话</footer>
  </main>;
}
function InputRequest({ agent, dialog, onReply }: { agent: Agent; dialog: Dialog; onReply: (args: any) => Promise<void> }) {
  const [value, setValue] = useState(dialog.prefill || ''), [busy, setBusy] = useState(false);
  const reply = async (extra: any) => { setBusy(true); await onReply({ agentId: agent.id, requestId: dialog.id, ...extra }); setBusy(false); };
  return <section className="input-request"><strong>{dialog.title || 'Pi 需要输入'}</strong>{dialog.message && <p>{dialog.message}</p>}
    {dialog.method === 'confirm' ? <div><button disabled={busy} onClick={() => reply({ confirmed: true })}>确认</button><button disabled={busy} onClick={() => reply({ confirmed: false })}>拒绝</button></div> : <>
      {dialog.method === 'select' ? <select aria-label={dialog.title || '选择'} value={value} onChange={event => setValue(event.target.value)}><option value="">请选择</option>{dialog.options?.map(option => <option key={option}>{option}</option>)}</select> : <textarea aria-label={dialog.title || '输入'} placeholder={dialog.placeholder} value={value} onChange={event => setValue(event.target.value)} />}
      <button disabled={busy || (dialog.method === 'select' && !value)} onClick={() => reply({ value })}>提交</button>
    </>}<button className="cancel-input" disabled={busy} onClick={() => reply({ cancelled: true })}>取消</button>
  </section>;
}
createRoot(document.getElementById('root')!).render(<Panel />);
