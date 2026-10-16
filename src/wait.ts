export const MAX_WAIT_MS = 60 * 60 * 1000;
export const WAIT_RESPONSE_GRACE_MS = 10_000;

export function validateWaitTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
    throw new Error('timeoutMs must be an integer between 0 and 3600000 (60 minutes)');
  }
  return timeoutMs;
}

/** Keep the socket open until the requested wait ends, with time to return its result. */
export function daemonRequestTimeout(method: string, args: Record<string, any>): number {
  return method === 'pi_wait'
    ? validateWaitTimeout(args.timeoutMs) + WAIT_RESPONSE_GRACE_MS
    : 70_000;
}
