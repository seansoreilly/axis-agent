/** Extract error message from unknown catch value */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Get current time as ISO string */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Require an environment variable, throwing if missing */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
