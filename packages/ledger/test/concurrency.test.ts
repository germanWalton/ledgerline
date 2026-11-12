import { afterAll, describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '../src/errors.js';
import type { PostEntryResult } from '../src/ledger.js';
import { connectLedger, createExternalAccount, createWallet, fund } from './helpers.js';

const { db, ledger } = connectLedger(20);
afterAll(() => db.destroy());

function settle<T>(promises: Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(promises);
}

describe('concurrency', () => {
  it('never overdraws a wallet under 1000 concurrent withdrawals', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    await fund(ledger, external, wallet, 100_00n);

    // 1000 withdrawals of 1.00 against a 100.00 balance: exactly 100 can succeed.
    const results = await settle(
      Array.from({ length: 1000 }, () =>
        ledger.postEntry({
          description: 'withdrawal',
          postings: [
            { accountId: wallet.id, direction: 'debit', amount: 1_00n },
            { accountId: external.id, direction: 'credit', amount: 1_00n },
          ],
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(fulfilled).toHaveLength(100);
    expect(rejected).toHaveLength(900);
    for (const failure of rejected) expect(failure.reason).toBeInstanceOf(InsufficientFundsError);
    expect(await ledger.getBalance(wallet.id)).toBe(0n);
    expect(await ledger.verifyBalances()).toEqual([]);
  });

  it('does not deadlock on concurrent transfers in opposite directions', async () => {
    const external = await createExternalAccount(ledger);
    const alice = await createWallet(ledger);
    const bob = await createWallet(ledger);
    await fund(ledger, external, alice, 1_000_00n);
    await fund(ledger, external, bob, 1_000_00n);

    const results = await settle(
      Array.from({ length: 400 }, (_, index) => {
        const [from, to] = index % 2 === 0 ? [alice, bob] : [bob, alice];
        return ledger.postEntry({
          description: 'p2p transfer',
          postings: [
            { accountId: from.id, direction: 'debit', amount: 1_00n },
            { accountId: to.id, direction: 'credit', amount: 1_00n },
          ],
        });
      }),
    );

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(failures.map((failure) => String(failure.reason))).toEqual([]);
    expect((await ledger.getBalance(alice.id)) + (await ledger.getBalance(bob.id))).toBe(2_000_00n);
    expect(await ledger.getBalance(alice.id)).toBe(1_000_00n);
    expect(await ledger.verifyBalances()).toEqual([]);
  });

  it('posts exactly once when the same idempotent request arrives 50 times at once', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    const request = {
      idempotencyKey: `charge-${wallet.id}`,
      description: 'card charge settled',
      postings: [
        { accountId: external.id, direction: 'debit' as const, amount: 25_00n },
        { accountId: wallet.id, direction: 'credit' as const, amount: 25_00n },
      ],
    };

    const results = await settle(Array.from({ length: 50 }, () => ledger.postEntry(request)));

    const fulfilled = results
      .filter((result): result is PromiseFulfilledResult<PostEntryResult> => result.status === 'fulfilled')
      .map((result) => result.value);
    expect(fulfilled).toHaveLength(50);
    expect(fulfilled.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(fulfilled.map((result) => result.entry.id)).size).toBe(1);
    expect(await ledger.getBalance(wallet.id)).toBe(25_00n);

    const stored = await db
      .selectFrom('journal_entries')
      .select(db.fn.countAll<bigint>().as('count'))
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(stored.count).toBe(1n);
  });
});
