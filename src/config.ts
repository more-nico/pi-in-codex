import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const dataRoot = () => process.env.PI_IN_CODEX_DATA_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'pi_in_codex');
export const socketPath = (root = dataRoot()) => process.env.PI_IN_CODEX_SOCKET || join('/tmp', `pi-in-codex-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.sock`);
export const errorText = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\bsk-[\w-]+/g, '[redacted]')
  .replace(/((?:api[_-]?key|authorization|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
