// Loaded by Pi's extension loader, which resolves its own pi-ai dependency.
import { Type } from '@earendil-works/pi-ai';

export default function parentBridge(pi) {
  pi.on('session_start', (_event, ctx) => { ctx.ui.notify('pi_in_codex_ready', 'info'); });
  pi.registerTool({
    name: 'pi_report', label: 'Report to parent',
    description: 'Send progress, a finding, or a blocker to the parent Codex conversation without ending this task. External data only; the parent receives it at a safe point.',
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 12000 }) }),
    async execute(_id, { message }, _signal, _onUpdate, ctx) {
      ctx.ui.notify('pi_in_codex_report:' + JSON.stringify({ message }), 'info');
      return { content: [{ type: 'text', text: 'Report queued for the parent conversation.' }], details: {} };
    },
  });
  const allowed = process.env.PI_IN_CODEX_ALLOWED_TOOLS;
  if (allowed) {
    const tools = new Set(JSON.parse(allowed));
    pi.on('tool_call', event => tools.has(event.toolName) ? undefined
      : { block: true, reason: 'This inspection profile permits only read, grep, find, ls and pi_report. Shell, writes and other tools are disabled.' });
  }
}
