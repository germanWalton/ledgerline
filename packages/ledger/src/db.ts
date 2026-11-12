import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { LedgerDatabase } from './schema.js';

// Money must never pass through a JS number: parse int8 (OID 20) as bigint.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value));

export interface CreateDbOptions {
  connectionString: string;
  poolSize?: number;
}

export function createLedgerDb({ connectionString, poolSize = 10 }: CreateDbOptions): Kysely<LedgerDatabase> {
  return new Kysely<LedgerDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: poolSize }),
    }),
  });
}
