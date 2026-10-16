import type { ProfileName } from './types.js';

export const profiles: Record<ProfileName, { instructions: string; tools?: string[] }> = {
  worker: { instructions: 'Implement the assigned task, validate your changes, and report the result and any remaining limitations.' },
  reviewer: { instructions: 'Review only. Do not change files. Prioritize correctness and regressions, with file references and actionable findings.', tools: ['read', 'grep', 'find', 'ls', 'pi_report'] },
  explorer: { instructions: 'Explore only. Do not change files. Trace relevant code and return concise evidence with file references.', tools: ['read', 'grep', 'find', 'ls', 'pi_report'] },
};
