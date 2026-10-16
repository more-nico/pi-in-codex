import type { Agent, Completion, Message } from './types.js';

export const PANEL_INTERVAL_MS = 250;
export const PANEL_PREVIEW_CHARS = 8_000;
export const PANEL_WINDOW = 50;

export function previewMessage(message: Message): Message {
  return message.text.length > PANEL_PREVIEW_CHARS
    ? { ...message, text: message.text.slice(0, PANEL_PREVIEW_CHARS), textTotal: message.text.length }
    : message;
}

/** Keep only the current window's references/versions, never a growing snapshot log.
 * Messages are immutable, so unchanged bodies need no hashing or serialization. */
export class PanelFeed {
  private windows = new Map<string, Map<string, { message: Message; revision: number }>>();
  agent(agent: Agent, revision: number, after: number | undefined, completion?: Completion): Agent {
    const previous = this.windows.get(agent.id), window = agent.messages.slice(-PANEL_WINDOW);
    const current = new Map(window.map(message => {
      const held = previous?.get(message.id);
      return [message.id, held?.message === message ? held : { message, revision }] as const;
    }));
    this.windows.set(agent.id, current);
    // Task/background, session paths and queued instructions are not panel data.
    const { task, context, sessionFile, queued, inbox, undelivered, messages, ...metadata } = agent;
    return { ...metadata, task: '', queued: [], messageTotal: messages.length,
      undelivered: undelivered?.length ? [
        ...undelivered.slice(0, 8).map(text => text.slice(0, 1000)),
        ...(undelivered.length > 8 ? [`另有 ${undelivered.length - 8} 条未确认送达的消息，请在主会话中查看。`] : []),
      ] : undefined,
      dialogs: agent.dialogs.map(({ id, method, title, message, expiresAt }) => ({ id, method, title: title?.slice(0, 500), message: message?.slice(0, 1000), expiresAt })),
      messageIds: window.map(message => message.id),
      messages: [...current.values()].filter(item => after === undefined || item.revision > after).map(item => previewMessage(item.message)),
      finalText: completion?.text.slice(0, PANEL_PREVIEW_CHARS), finalTextTotal: completion?.text.length,
      completionId: completion?.id };
  }
}

export async function pausePanel(ms: number, signal?: AbortSignal) {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
