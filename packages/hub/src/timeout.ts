export const TIMED_OUT = Symbol('timed out');

/**
 * Settles with `promise`, or with `TIMED_OUT` once `ms` passes first. The promise keeps running
 * either way; the timer is cleared as soon as it settles so nothing is left holding the process.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
  const timer = setTimeout(() => resolve(TIMED_OUT), ms);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
