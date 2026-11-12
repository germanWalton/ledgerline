import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { inject } from 'vitest';
import { createLedgerDb } from '../src/db.js';
import { Ledger, type Account } from '../src/ledger.js';
import type { LedgerDatabase } from '../src/schema.js';

export interface TestLedger {
  db: Kysely<LedgerDatabase>;
  ledger: Ledger;
}

export function connectLedger(poolSize = 20): TestLedger {
  const db = createLedgerDb({ connectionString: inject('databaseUrl'), poolSize });
  return { db, ledger: new Ledger(db) };
}

/**
 * Accounts are created with unique codes per test, so tests stay isolated without
 * cleaning tables (the ledger is append-only and refuses DELETE / TRUNCATE anyway).
 */
export function uniqueCode(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

/** A platform-side account representing money outside the system (bank, card network). */
export function createExternalAccount(ledger: Ledger, currency = 'USD'): Promise<Account> {
  return ledger.createAccount({
    code: uniqueCode('external'),
    currency,
    normalBalance: 'debit',
    allowNegative: true,
  });
}

/** A customer wallet: a liability for the platform, so it is credit-normal and cannot go negative. */
export function createWallet(ledger: Ledger, currency = 'USD'): Promise<Account> {
  return ledger.createAccount({ code: uniqueCode('wallet'), currency, normalBalance: 'credit' });
}

export async function fund(ledger: Ledger, external: Account, wallet: Account, amount: bigint): Promise<void> {
  await ledger.postEntry({
    description: 'top-up',
    postings: [
      { accountId: external.id, direction: 'debit', amount },
      { accountId: wallet.id, direction: 'credit', amount },
    ],
  });
}
