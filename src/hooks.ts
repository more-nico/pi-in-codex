import { randomUUID } from 'node:crypto';
import { ensureDaemon, request } from './client.js';
import { formatDelivery } from './manager.js';
import { errorText } from './config.js';
import type { Completion, MailEvent } from './types.js';

export async function runHook(input: Record<string, any>) {
  const event = input.hook_event_name;
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string') throw new Error('Hook session_id and cwd are required');
  await ensureDaemon();
  await request('hook_register', input.session_id, { cwd: input.cwd, permissionMode: input.permission_mode, turnId: input.turn_id });
  // Turn-scoped events must agree on the same key; session-only events get a fresh receipt opportunity.
  const turn = input.turn_id || `${event}:${randomUUID()}`;
  const results: Array<Completion | MailEvent> = await request('hook_deliver', input.session_id, { turn });
  if (!results.length) return {};
  const context = results.map(formatDelivery).join('\n\n');
  if (event === 'Stop') return { decision: 'block', reason: context };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}
export async function hookMain() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 8 * 1024 * 1024) throw new Error('Hook input too large'); }
  try { process.stdout.write(JSON.stringify(await runHook(JSON.parse(input))) + '\n'); }
  catch (error) {
    // An optional Pi integration must not block unrelated Codex work on startup failure.
    process.stderr.write(`pi_in_codex hook: ${errorText(error)}\n`); process.stdout.write('{}\n');
  }
}
