export interface PostgresEnv {
  databaseUrl: string;
  /** DB_LOCK_TIMEOUT_MS: lock_timeout for withClaim. */
  lockTimeoutMs: number;
  /** DB_POOL_MAX: pg.Pool max connections. */
  poolMax: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export function readPostgresEnv(env: NodeJS.ProcessEnv = process.env): PostgresEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  return {
    databaseUrl,
    lockTimeoutMs: positiveInt(env, 'DB_LOCK_TIMEOUT_MS', 5000),
    poolMax: positiveInt(env, 'DB_POOL_MAX', 10),
  };
}
