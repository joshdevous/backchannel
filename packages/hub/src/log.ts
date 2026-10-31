/** One line per action. Never pass tokens here. */
export function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`${new Date().toISOString()} ERROR ${message}: ${detail}`);
}
