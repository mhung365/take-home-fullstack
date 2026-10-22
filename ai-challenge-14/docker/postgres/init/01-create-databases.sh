#!/bin/sh
# claims: demo data, claims_test: integration tests, claims_scenarios: `pnpm scenarios`.
set -eu

for db in claims claims_test claims_scenarios; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	SELECT 'CREATE DATABASE $db OWNER "$POSTGRES_USER"'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
done
