import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, Message } from '../src/types.js';
import { call, connect, demo } from './bridge.js';
import { activityLabel, compactTokens, elapsed, statusLabel } from './format.js';
import { MessageContent } from './content.js';
import { PANEL_INTERVAL_MS, pausePanel } from '../src/panel-feed.js';
import { BrandMark } from './brand.js';
import { selectAgent } from './selection.js';
import { completedProcessMessages, completedSummary, hasEarlierMessages, mergeAgents, mergeOlder, MESSAGE_PAGE, recentMessages, visibleMessages } from './messages.js';
import { Transcript } from './transcript.js';
import './style.css';

type PanelAgent = Agent & { messageTotal?: number };
const EMPTY_MESSAGES: Message[] = [];
const active = (agent: Agent) => ['queued', 'starting', 'running', 'waiting_input'].includes(agent.status);
const finished = (agent: Agent) => agent.status === 'completed' || agent.status === 'failed';
const nearTop = 80;
const nearBottom = 60;
const duration = (agent: Agent) => elapsed(agent.startedAt || agent.createdAt, agent.finishedAt).replace(/h/g, '小时').replace(/m/g, '分').replace(/s/g, '秒').replace(/\s+/g, '');

function StatusDot({ agent }: { agent: Agent }) {
  const symbol = agent.status === 'completed' ? '✓' : agent.status === 'waiting_input' ? '!' : ['failed', 'interrupted'].includes(agent.status) ? '×' : '';
  return <span aria-label={statusLabel[agent.status]} className={`status-dot ${agent.status}`}>{symbol}</span>;
}

function PinIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 2h6M6 2v4L4 9v1h8V9l-2-3V2M8 10v4" /></svg>;
}

function Panel() {
  const [agents, setAgents] = useState<PanelAgent[]>([]), [selected, setSelected] = useState<string | undefined>(demo ? new URLSearchParams(location.search).has('completed') ? 'demo-done' : new URLSearchParams(location.search).has('markdown') ? 'demo-markdown' : undefined : undefined);
  const agentsRef = useRef<PanelAgent[]>([]);
  const updateAgents = (update: (previous: PanelAgent[]) => PanelAgent[]) => {
    const next = update(agentsRef.current); agentsRef.current = next; setAgents(next);
  };
  const [error, setError] = useState(''), [pending, setPending] = useState(0), [completedOpen, setCompletedOpen] = useState(false), [listOpen, setListOpen] = useState(false);
  const [listPinned, setListPinned] = useState(false);
  const [older, setOlder] = useState<Record<string, Message[]>>({}), [loadingOlder, setLoadingOlder] = useState(false);
  const [historyIds, setHistoryIds] = useState<string[]>([]);
  const [processView, setProcessView] = useState<string>();
  const [attempt, setAttempt] = useState(0), [, tick] = useState(0), [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ agentId: string; height: number; top: number } | undefined>(undefined);
  const inFlight = useRef(new Set<string>());
  const historyRef = useRef(new Set<string>());
  const selectedRef = useRef<string | undefined>(undefined);
  const programmatic = useRef(false);
  const userScroll = useRef(false);
  const touchY = useRef(0);
  const listAnchor = useRef<HTMLDivElement>(null);
  selectedRef.current = selected;
  const agent = agents.find(item => item.id === selected);
  const summaryOnly = agent?.status === 'completed' && processView !== `${agent.id}:${agent.runId}`;
  const inHistory = agent ? historyIds.includes(agent.id) : false;
  const history = agent ? older[agent.id] || EMPTY_MESSAGES : EMPTY_MESSAGES;
  const visible = useMemo(() => agent ? (inHistory ? visibleMessages(history, agent.messages) : recentMessages(agent.messages)) : EMPTY_MESSAGES, [agent?.messages, history, inHistory]);
  const processMessages = useMemo(() => agent && !summaryOnly ? completedProcessMessages(agent, visible) : EMPTY_MESSAGES, [agent?.id, agent?.runId, visible, summaryOnly]);
  const earlier = agent && !summaryOnly ? hasEarlierMessages(agent.messageTotal, visible.length) : false;
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!listOpen) return;
    const outside = (event: PointerEvent) => { if (!listPinned && event.target instanceof Node && !listAnchor.current?.contains(event.target)) setListOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setListOpen(false); listAnchor.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [listOpen, listPinned]);
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
        let cursor: string | undefined;
        while (!disposed) {
          try {
            const started = performance.now();
            const snapshot = await call('pi_poll', { cursor, waitMs: cursor ? 20_000 : 0 }, controller.signal);
            if (disposed) return;
            updateAgents(previous => {
              const next = mergeAgents(previous, snapshot, id => historyRef.current.has(id));
              return next.some(agent => agent.archivedAt) ? next.filter(agent => !agent.archivedAt) : next;
            });
            setPending(snapshot.pendingCompletions || 0); cursor = snapshot.cursor;
            setError('');
            await pausePanel(PANEL_INTERVAL_MS - (performance.now() - started), controller.signal);
          } catch (e) { if (disposed) return; setError((e as Error).message); cursor = undefined; await pausePanel(2000, controller.signal); }
        }
      } catch (e) { if (!disposed) setError((e as Error).message); }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [attempt]);
  useEffect(() => { if (agents.length) setSelected(previous => selectAgent(agents, previous)); }, [agents]);
  // Keep the reading position while history is prepended; only follow new output when already at the bottom.
  useLayoutEffect(() => {
    const node = scroll.current, pendingAnchor = anchor.current;
    if (!node || !pendingAnchor || pendingAnchor.agentId !== selectedRef.current) return;
    anchor.current = undefined;
    writeScroll(node, node.scrollHeight - pendingAnchor.height + pendingAnchor.top);
  });
  useEffect(() => {
    const node = scroll.current;
    if (follow && node && !anchor.current) writeScroll(node, node.scrollHeight);
  }, [agent?.id, agent?.messages, older, follow, inHistory, summaryOnly]);
  const enterHistory = (id: string) => { if (!historyRef.current.has(id)) { historyRef.current.add(id); setHistoryIds([...historyRef.current]); } };
  const leaveHistory = (id: string) => { if (historyRef.current.delete(id)) setHistoryIds([...historyRef.current]); };
  const writeScroll = (node: HTMLDivElement, top: number) => {
    programmatic.current = true; userScroll.current = false;
    node.scrollTop = top;
    requestAnimationFrame(() => { programmatic.current = false; });
  };
  const choose = (id: string) => {
    if (id !== selectedRef.current) {
      // Switching conversations resets paging: leave history mode and show exactly the newest page.
      const reset = [id, selectedRef.current].filter((value): value is string => !!value);
      for (const value of reset) leaveHistory(value);
      setOlder(previous => Object.fromEntries(Object.entries(previous).map(([key, messages]) => [key, reset.includes(key) ? EMPTY_MESSAGES : messages])));
      updateAgents(previous => previous.map(item => reset.includes(item.id) ? { ...item, messages: recentMessages(item.messages) } : item));
    }
    setSelected(id); setProcessView(undefined); if (!listPinned) setListOpen(false); setFollow(true); setLoadingOlder(false);
  };
  async function loadOlder() {
    const current = agent;
    const before = visible[0]?.id;
    if (!current || summaryOnly || !before || inFlight.current.has(current.id)) return;
    inFlight.current.add(current.id);
    // Enter history mode before awaiting so windows that arrive meanwhile merge instead of sliding away.
    enterHistory(current.id);
    setLoadingOlder(true); setFollow(false);
    try {
      const page = await call('pi_read', { agentId: current.id, limit: MESSAGE_PAGE, includeTools: true, before, preview: true });
      if (selectedRef.current !== current.id || !historyRef.current.has(current.id)) return;
      const node = scroll.current;
      if (node && selectedRef.current === current.id) anchor.current = { agentId: current.id, height: node.scrollHeight, top: node.scrollTop };
      setOlder(previous => ({ ...previous, [current.id]: mergeOlder(previous[current.id] || [], page.messages || []) }));
    } catch (e) { leaveHistory(current.id); setError((e as Error).message); }
    finally { inFlight.current.delete(current.id); if (selectedRef.current === current.id) setLoadingOlder(false); }
  }
  const running = agents.filter(agent => !finished(agent)).sort((a, b) => a.createdAt - b.createdAt);
  const completed = agents.filter(finished).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  const row = (item: Agent) => <button key={item.id} className={`agent-row ${selected === item.id ? 'selected' : ''}`} onClick={() => choose(item.id)}>
    <StatusDot agent={item} /><span className="agent-info"><span className="row-top"><strong>{item.name}</strong>{selected === item.id && <span className="selected-mark" aria-label="当前任务">✓</span>}</span>
      <span className="row-bottom">{activityLabel(item.activity)}</span></span>
  </button>;
  return <main>
    <header className="topbar">
      <div className="brand"><BrandMark /></div>
      <div className="task-switcher" ref={listAnchor}>
        <button className="task-switcher-button" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen} aria-controls="agent-navigation" title={listPinned ? '列表已固定，点击展开或折叠' : '切换子对话'}><span>子对话</span><b>{agents.filter(active).length}</b>{listPinned && <PinIcon />}<span className="switcher-chevron" aria-hidden="true" /></button>
        {listOpen && <section id="agent-navigation" className="floating-list" aria-label="子对话列表">
          <div className="list-caption"><span>当前聊天 · {agents.length} 个任务</span><div className="list-actions"><button className="pin-list" aria-label="固定悬浮" aria-pressed={listPinned} title={listPinned ? '取消固定，点击正文时自动收起' : '保持列表悬浮，切换任务时不收起'} onClick={() => setListPinned(!listPinned)}><PinIcon /><span>{listPinned ? '已固定' : '固定'}</span></button><button className="collapse-list" aria-label="折叠子对话列表" title="折叠列表" onClick={() => setListOpen(false)}><span aria-hidden="true">⌃</span></button></div></div>
          <div className="list-body">{running.length ? running.map(row) : <div className="list-empty">没有进行中的任务</div>}
            {completed.length > 0 && <><button className="completed-heading" onClick={() => setCompletedOpen(!completedOpen)} aria-expanded={completedOpen}><span>{completedOpen ? '⌄' : '›'} 已完成</span><span>{completed.length}</span></button>{completedOpen && completed.map(row)}</>}
          </div>
        </section>}
      </div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => { setError(''); setAttempt(value => value + 1); }}>重试</button></div>}
    {!agent ? <div className="empty-state"><div className="empty-icon">π</div><h1>子对话会出现在这里</h1><p>在 Codex 主会话中分派任务，这里会同步展示 Pi 的进度和结果。</p></div> : <section className="conversation">
      <div className="conversation-heading"><h1>{agent.name}</h1><span className={`task-status ${agent.status}`}><StatusDot agent={agent} />{statusLabel[agent.status]}</span></div>
      {agent.model && <div className="task-model" title={`${agent.model.provider} · ${agent.cwd}`}>{agent.model.id}{agent.model.thinking && <span> · {agent.model.thinking}</span>}</div>}
      {agent.status !== 'completed' && <div className="run-progress"><span>{activityLabel(agent.activity)}</span><time>{agent.status === 'queued' ? '已等待' : '已运行'} {duration(agent)}</time></div>}
      {!!agent.dialogs.length && <p className="waiting-note" role="status">等待 Codex 主会话处理交互请求：{agent.dialogs.map(dialog => dialog.title || dialog.message || dialog.method).join('；')}</p>}
      <div className="messages" ref={scroll}
        onWheel={event => { if (event.deltaY < 0) userScroll.current = true; }}
        onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? 0; }}
        onTouchMove={event => { const y = event.touches[0]?.clientY ?? 0; if (y > touchY.current + 2) userScroll.current = true; }}
        onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) userScroll.current = true; }}
        onScroll={() => {
          const node = scroll.current;
          if (!node || !agent || programmatic.current) return;
          setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < nearBottom);
          // Auto-load only for a real user gesture: initial layout, anchor adjustments and details toggles are ignored.
          if (userScroll.current && node.scrollTop < nearTop && earlier) { userScroll.current = false; void loadOlder(); }
        }}>
        {agent.status === 'completed' ? <>
          <section className="completed-process">
            <button className="process-heading" aria-expanded={!summaryOnly} aria-controls={`process-${agent.id}`} onClick={() => { setProcessView(summaryOnly ? `${agent.id}:${agent.runId}` : undefined); setFollow(false); }}>
              <span>用时 {duration(agent)}</span><span className="process-chevron" aria-hidden="true" />
            </button>
            <div id={`process-${agent.id}`} className="process-collapse" data-open={!summaryOnly} aria-hidden={summaryOnly} inert={summaryOnly}>
              <div className="process-body">
                <div className="process-stats">{agent.toolUses} 次工具调用<span>·</span>{compactTokens(agent.tokens)} tokens</div>
                {earlier && <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在加载更早消息…' : `↑ 加载更早的 ${MESSAGE_PAGE} 条`}</button>}
                {!summaryOnly && <Transcript messages={processMessages} agentId={agent.id} />}
              </div>
            </div>
          </section>
          <article className="message assistant task-summary"><MessageContent key={`${agent.id}:${agent.runId}`} text={completedSummary(agent)} total={agent.finalTextTotal} source={agent.completionId ? { completionId: agent.completionId } : undefined} /></article>
        </> : <>
          {earlier && <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在加载更早消息…' : `↑ 加载更早的 ${MESSAGE_PAGE} 条`}</button>}
          {visible.length === 0 && <p className="no-messages">{agent.status === 'queued' ? '任务已排队，等待可用运行名额。' : '等待 Pi 的第一条消息…'}</p>}
          <Transcript messages={visible} agentId={agent.id} />
        </>}
        {agent.error && <p className="run-error">{agent.error}</p>}
        {!!agent.undelivered?.length && <div className="run-error">未确认送达的排队消息：{agent.undelivered.map((text, index) => <p key={index}>{text}</p>)}</div>}
      </div>
      {!follow && !summaryOnly && <button className="jump-latest" onClick={() => setFollow(true)}>↓ 回到最新消息</button>}
    </section>}
    <footer className="bottom-note"><span>由 Codex 主会话调度</span>{pending > 0 && <span className="pending-note">{pending} 个结果待接收</span>}</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Panel />);
