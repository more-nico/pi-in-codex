import React, { useEffect, useRef, useState } from 'react';
import { MarkdownText } from './markdown.js';

type Source = { agentId: string; messageId: string } | { completionId: string };
const PAGE = 16_000;

/** Automatic updates stay small. Explicit reading pages long content instead of
 * mounting an unbounded tool log or Markdown document in the renderer. */
export function MessageContent({ text, total = text.length, source, literal = false }: {
  text: string; total?: number; source?: Source; literal?: boolean;
}) {
  const [page, setPage] = useState<{ text: string; offset: number; total: number }>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const value = page?.text ?? text.slice(0, PAGE), offset = page?.offset ?? 0, length = Math.max(page?.total ?? 0, total);
  const truncated = offset > 0 || value.length < length;
  async function read(offset: number) {
    if (!source || loading) return;
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setLoading(true); setError('');
    try {
      const { call } = await import('./bridge.js');
      const result = 'completionId' in source
        ? await call('pi_result', { ...source, offset, maxChars: PAGE }, abort.signal)
        : await call('pi_read', { ...source, offset, maxChars: PAGE }, abort.signal);
      if (abort.signal.aborted) return;
      const message = result.messages?.[0];
      if ('messageId' in source && message?.id !== source.messageId) throw new Error('消息读取失败，请刷新插件面板后重试。');
      setPage({ text: message?.text ?? result.text ?? '', offset, total: message?.textTotal ?? result.totalChars ?? result.totalLength ?? length });
    } catch (error) { if (!abort.signal.aborted) setError((error as Error).message); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  return <>
    {literal ? <pre>{value || '（空输出）'}</pre> : <MarkdownText text={value} />}
    {(truncated || page) && <div className="content-pages">
      <span>{offset + 1}–{offset + value.length} / {length} 字符</span>
      {offset > 0 && <button disabled={loading} onClick={() => void read(Math.max(0, offset - PAGE))}>上一段</button>}
      {offset + value.length < length && source && <button disabled={loading} onClick={() => void read(offset + value.length)}>{loading ? '正在加载…' : '继续阅读'}</button>}
      {page && <button disabled={loading} onClick={() => setPage(undefined)}>返回实时预览</button>}
    </div>}
    {error && <p className="message-error" role="alert">{error}</p>}
  </>;
}
