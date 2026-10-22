import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../migrate';

// dist/cli/migrate.js → repo root .env. Variables already set in the environment win.
const envFile = resolve(__dirname, '..', '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { applied, skipped } = await migrate(client);
    const target = `${client.host}:${client.port}/${client.database}`;
    for (const name of applied) console.log(`applied  ${name}`);
    console.log(
      applied.length === 0
        ? `${target}: up to date (${skipped.length} migration(s) already applied)`
        : `${target}: applied ${applied.length}, already applied ${skipped.length}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
