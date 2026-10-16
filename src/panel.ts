export const PANEL_LEASE_MS = 45_000;
export const PANEL_OPENING_MS = 10_000;
export type PanelHint = { state: 'open' | 'opening' | 'closed'; shouldOpen: boolean; tool: 'pi_panel' };
type Lease = { at: number; token: symbol };

/** Transient, chat-scoped UI presence. An old poll cannot close a newer instance. */
export class PanelPresence {
  private chats = new Map<string, { instances: Map<string, Lease>; requestedAt?: number }>();
  constructor(private now = Date.now) {}
  private chat(threadId: string) {
    let chat = this.chats.get(threadId);
    if (!chat) { chat = { instances: new Map() }; this.chats.set(threadId, chat); }
    for (const [id, lease] of chat.instances) if (this.now() - lease.at >= PANEL_LEASE_MS) chat.instances.delete(id);
    return chat;
  }
  status(threadId: string): PanelHint {
    const chat = this.chat(threadId);
    const state = chat.instances.size ? 'open' : chat.requestedAt !== undefined && this.now() - chat.requestedAt < PANEL_OPENING_MS ? 'opening' : 'closed';
    return { state, shouldOpen: state === 'closed', tool: 'pi_panel' };
  }
  request(threadId: string): PanelHint {
    if (this.status(threadId).shouldOpen) this.chat(threadId).requestedAt = this.now();
    return this.status(threadId);
  }
  poll(threadId: string, panelId = 'legacy') {
    const chat = this.chat(threadId), token = Symbol();
    chat.instances.set(panelId, { at: this.now(), token }); chat.requestedAt = undefined;
    return (aborted: boolean) => {
      const lease = chat.instances.get(panelId);
      if (lease?.token !== token) return;
      if (aborted) chat.instances.delete(panelId); else lease.at = this.now();
    };
  }
}
