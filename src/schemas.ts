import { z } from 'zod';
import { MAX_WAIT_MS } from './wait.js';
const text = z.string().trim().min(1);
const agentId = text.max(200).describe('Agent UUID or unique task path in this chat');
const requestId = text.max(200).optional().describe('Stable retry key; reuse only for an identical operation');
const path = text.max(200).regex(/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u);
export const schemas = {
  pi_spawn: z.object({ name: text.max(120), task: text, context: z.string().optional(), cwd: text.optional(), model: z.object({ provider: text, id: text, thinking: text.optional() }).optional(), profile: z.enum(['worker', 'reviewer', 'explorer']).optional(), path: path.optional(), group: text.max(120).optional(), requestId }),
  pi_list: z.object({ pathPrefix: path.optional(), group: text.optional(), includeArchived: z.boolean().default(false) }),
  pi_read: z.object({ agentId, limit: z.number().int().min(1).max(200).default(5), includeTools: z.boolean().default(false), includePartial: z.boolean().default(true), before: z.string().optional() }),
  pi_send: z.object({ agentId, message: text, mode: z.enum(['steer', 'followUp']).default('steer'), requestId }),
  pi_message: z.object({ agentId, message: text, requestId }),
  pi_follow_up: z.object({ agentId, message: text, requestId }),
  pi_interrupt: z.object({ agentId }),
  pi_stop: z.object({ agentId }),
  pi_wait: z.object({ agentIds: z.array(agentId).min(1).max(50), timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).describe('Custom maximum wait, 0–3600000 milliseconds; choose from the estimated task duration'), runIds: z.record(z.string(), z.string().uuid()).optional(), afterCursor: text.optional(), mode: z.enum(['any', 'all']).default('any'), wakeOnMessages: z.boolean().default(true) }),
  pi_events: z.object({ afterCursor: text.optional(), limit: z.number().int().min(1).max(100).default(50), eventId: z.string().uuid().optional() }),
  pi_result: z.object({ completionId: z.string().uuid(), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(50_000).default(12_000) }),
  pi_ack: z.object({ completionIds: z.array(z.string().uuid()).max(100).default([]), eventIds: z.array(z.string().uuid()).max(100).default([]) }),
  pi_archive: z.object({ agentId, archived: z.boolean().default(true) }),
  pi_panel: z.object({}),
  pi_poll: z.object({ cursor: z.string().optional(), waitMs: z.number().int().min(0).max(25_000).default(20_000), panelId: z.string().uuid().optional() }),
  pi_reply: z.object({ agentId, requestId: text, value: z.string().optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().default(false) }),
  pi_models: z.object({ agentId: agentId.optional(), model: z.object({ provider: text, id: text }).optional() }),
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
