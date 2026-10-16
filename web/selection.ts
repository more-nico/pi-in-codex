import type { Agent } from '../src/types.js';

const priority: Record<Agent['status'], number> = {
  running: 0, waiting_input: 1, starting: 2, queued: 3,
  interrupted: 4, failed: 4, stopped: 4, completed: 4,
};

/** Pick live work on first open; updates must never steal an existing selection. */
export function selectAgent(agents: Agent[], selected?: string): string | undefined {
  const visible = agents.filter(agent => !agent.archivedAt);
  if (visible.some(agent => agent.id === selected)) return selected;
  return visible.toSorted((a, b) => priority[a.status] - priority[b.status]
    || (b.finishedAt || b.startedAt || b.createdAt) - (a.finishedAt || a.startedAt || a.createdAt)
    || b.createdAt - a.createdAt)[0]?.id;
}
