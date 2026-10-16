import { z } from 'zod';
const agentId = z.string().uuid();
const text = z.string().trim().min(1);
export const schemas = {
  pi_spawn: z.object({ name: text.max(120), task: text, context: z.string().optional(), cwd: text.optional(), model: z.object({ provider: text, id: text, thinking: text.optional() }).optional() }),
  pi_list: z.object({}),
  pi_read: z.object({ agentId, limit: z.number().int().min(1).max(200).default(5), includeTools: z.boolean().default(false), includePartial: z.boolean().default(true), before: z.string().optional() }),
  pi_send: z.object({ agentId, message: text, mode: z.enum(['steer', 'followUp']).default('steer') }),
  pi_stop: z.object({ agentId }),
  pi_wait: z.object({ agentIds: z.array(agentId).min(1).max(50), timeoutMs: z.number().int().min(0).max(60_000).default(20_000) }),
  pi_ack: z.object({ completionIds: z.array(z.string().uuid()).min(1).max(100) }),
  pi_panel: z.object({}),
  pi_poll: z.object({ cursor: z.string().optional(), waitMs: z.number().int().min(0).max(25_000).default(20_000) }),
  pi_reply: z.object({ agentId, requestId: text, value: z.string().optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().default(false) }),
  pi_models: z.object({ agentId }),
};
export type ToolName = keyof typeof schemas;
export function resolveThread(metadata: Record<string, unknown> | undefined) {
  const meta = metadata || {};
  let turn: any = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { throw new Error('Invalid Codex turn metadata'); } }
  const candidates = [turn?.thread_id, meta['openai/threadId'], meta['openai/thread_id'], meta.codexThreadId, meta.codex_thread_id, meta.threadId, meta.thread_id, (meta.thread as any)?.id]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!candidates.length) throw new Error('Codex did not supply a thread ID for this call. Conversation isolation is required; no project/global fallback is used.');
  if (new Set(candidates).size !== 1) throw new Error('Conflicting conversation IDs in host metadata');
  return candidates[0];
}
