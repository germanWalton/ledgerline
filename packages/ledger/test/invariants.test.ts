import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { connectLedger, createExternalAccount, createWallet, fund } from './helpers.js';

/**
 * These tests bypass the Ledger service and write SQL directly, proving the database
 * itself refuses to store an invalid ledger even if application code has a bug.
 */
const { db, ledger } = connectLedger(5);
afterAll(() => db.destroy());

async function expectSqlState(promise: Promise<unknown>, sqlState: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: sqlState });
}

describe('database-enforced invariants', () => {
  it('rejects an unbalanced entry at commit time', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);

    await expectSqlState(
      db.transaction().execute(async (trx) => {
        const entry = await trx
          .insertInto('journal_entries')
          .values({ description: 'raw', idempotency_key: null, request_hash: null })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('postings')
          .values([
            { entry_id: entry.id, account_id: external.id, direction: 'debit', amount: 100n, currency: 'USD' },
            { entry_id: entry.id, account_id: wallet.id, direction: 'credit', amount: 99n, currency: 'USD' },
          ])
          .execute();
      }),
      'LL003',
    );
  });

  it('rejects an entry with fewer than two postings', async () => {
    await expectSqlState(
      db.insertInto('journal_entries').values({ description: 'empty', idempotency_key: null, request_hash: null }).execute(),
      'LL002',
    );
  });

  it('rejects a posting whose currency differs from its account', async () => {
    const external = await createExternalAccount(ledger, 'USD');
    const wallet = await createWallet(ledger, 'USD');

    await expectSqlState(
      db.transaction().execute(async (trx) => {
        const entry = await trx
          .insertInto('journal_entries')
          .values({ description: 'raw', idempotency_key: null, request_hash: null })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('postings')
          .values([
            { entry_id: entry.id, account_id: external.id, direction: 'debit', amount: 100n, currency: 'EUR' },
            { entry_id: entry.id, account_id: wallet.id, direction: 'credit', amount: 100n, currency: 'EUR' },
          ])
          .execute();
      }),
      'LL001',
    );
  });

  it.each([
    ['UPDATE postings', sql`UPDATE postings SET amount = amount + 1`],
    ['DELETE FROM postings', sql`DELETE FROM postings`],
    ['TRUNCATE postings', sql`TRUNCATE postings CASCADE`],
    ['UPDATE journal_entries', sql`UPDATE journal_entries SET description = 'tampered'`],
    ['DELETE FROM journal_entries', sql`DELETE FROM journal_entries`],
  ])('keeps history append-only: %s', async (_label, statement) => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    await fund(ledger, external, wallet, 1_00n);

    await expectSqlState(statement.execute(db), 'LL004');
  });

  it('refuses a negative cached balance on a non-negative account', async () => {
    const wallet = await createWallet(ledger);
    await expectSqlState(
      db.updateTable('accounts').set({ balance: -1n }).where('id', '=', wallet.id).execute(),
      '23514',
    );
  });
});
