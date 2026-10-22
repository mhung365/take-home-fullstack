import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientBase } from 'pg';

/** `<package>/migrations`, resolved from both `src/` and `dist/`. */
export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const FILE_PATTERN = /^(\d+)_[\w-]+\.sql$/;

/** Serializes concurrent runners (e.g. parallel test files) on the same database. */
const ADVISORY_LOCK_KEY = 7_340_001;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new Error(`Invalid migration file name ${name}; expected NNN_description.sql`);
    const sql = readFileSync(join(dir, name), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(`Duplicate migration version ${migrations[i].version}: ${migrations[i - 1].name}, ${migrations[i].name}`);
    }
  }
  return migrations;
}

/**
 * Applies pending migrations in version order, each in its own transaction together with
 * its `schema_migrations` row. Fails if an already-applied file was edited afterwards.
 */
export async function migrate(client: ClientBase, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    const appliedByVersion = new Map(rows.map((row) => [row.version, row]));

    const result: MigrateResult = { applied: [], skipped: [] };
    for (const migration of migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.name} was modified after being applied; add a new migration instead`);
        }
        result.skipped.push(migration.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
      }
      result.applied.push(migration.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
