import { afterAll, describe, expect, it } from 'vitest';
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidEntryError,
  UnbalancedEntryError,
} from '../src/errors.js';
import { connectLedger, createExternalAccount, createWallet, fund } from './helpers.js';

const { db, ledger } = connectLedger();
afterAll(() => db.destroy());

describe('Ledger.postEntry', () => {
  it('posts a balanced entry and updates both cached balances', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);

    const { entry, replayed } = await ledger.postEntry({
      description: 'top-up',
      postings: [
        { accountId: external.id, direction: 'debit', amount: 10_00n },
        { accountId: wallet.id, direction: 'credit', amount: 10_00n },
      ],
    });

    expect(replayed).toBe(false);
    expect(entry.postings).toHaveLength(2);
    expect(await ledger.getBalance(wallet.id)).toBe(10_00n);
    expect(await ledger.getBalance(external.id)).toBe(10_00n);
  });

  it('rejects an unbalanced entry without moving money', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);

    await expect(
      ledger.postEntry({
        description: 'broken',
        postings: [
          { accountId: external.id, direction: 'debit', amount: 10_00n },
          { accountId: wallet.id, direction: 'credit', amount: 9_99n },
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);

    expect(await ledger.getBalance(wallet.id)).toBe(0n);
  });

  it('rejects entries mixing currencies', async () => {
    const usd = await createExternalAccount(ledger, 'USD');
    const clp = await createWallet(ledger, 'CLP');

    await expect(
      ledger.postEntry({
        description: 'fx without conversion',
        postings: [
          { accountId: usd.id, direction: 'debit', amount: 100n },
          { accountId: clp.id, direction: 'credit', amount: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('rejects a debit that would overdraw a non-negative account', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    await fund(ledger, external, wallet, 5_00n);

    await expect(
      ledger.postEntry({
        description: 'withdrawal',
        postings: [
          { accountId: wallet.id, direction: 'debit', amount: 5_01n },
          { accountId: external.id, direction: 'credit', amount: 5_01n },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await ledger.getBalance(wallet.id)).toBe(5_00n);
  });

  it('rejects unknown accounts', async () => {
    const wallet = await createWallet(ledger);
    await expect(
      ledger.postEntry({
        description: 'ghost',
        postings: [
          { accountId: '00000000-0000-0000-0000-000000000000', direction: 'debit', amount: 1n },
          { accountId: wallet.id, direction: 'credit', amount: 1n },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it.each([
    ['a single posting', [{ direction: 'debit' as const, amount: 1n }]],
    ['a zero amount', [{ direction: 'debit' as const, amount: 0n }, { direction: 'credit' as const, amount: 0n }]],
    ['a negative amount', [{ direction: 'debit' as const, amount: -1n }, { direction: 'credit' as const, amount: -1n }]],
  ])('rejects malformed input: %s', async (_label, postings) => {
    const wallet = await createWallet(ledger);
    await expect(
      ledger.postEntry({
        description: 'malformed',
        postings: postings.map((posting) => ({ ...posting, accountId: wallet.id })),
      }),
    ).rejects.toBeInstanceOf(InvalidEntryError);
  });
});

describe('Ledger idempotency', () => {
  it('replays the original entry when the same key and body are retried', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    const request = {
      idempotencyKey: `topup-${wallet.id}`,
      description: 'top-up',
      postings: [
        { accountId: external.id, direction: 'debit' as const, amount: 7_00n },
        { accountId: wallet.id, direction: 'credit' as const, amount: 7_00n },
      ],
    };

    const first = await ledger.postEntry(request);
    const second = await ledger.postEntry(request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.postings).toEqual(first.entry.postings);
    expect(await ledger.getBalance(wallet.id)).toBe(7_00n);
  });

  it('refuses to reuse a key with a different body', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    const key = `topup-${wallet.id}`;
    const postings = (amount: bigint) => [
      { accountId: external.id, direction: 'debit' as const, amount },
      { accountId: wallet.id, direction: 'credit' as const, amount },
    ];

    await ledger.postEntry({ idempotencyKey: key, description: 'top-up', postings: postings(7_00n) });

    await expect(
      ledger.postEntry({ idempotencyKey: key, description: 'top-up', postings: postings(8_00n) }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledger.getBalance(wallet.id)).toBe(7_00n);
  });

  it('does not burn the key when the first attempt fails', async () => {
    const external = await createExternalAccount(ledger);
    const wallet = await createWallet(ledger);
    const request = {
      idempotencyKey: `withdraw-${wallet.id}`,
      description: 'withdrawal',
      postings: [
        { accountId: wallet.id, direction: 'debit' as const, amount: 3_00n },
        { accountId: external.id, direction: 'credit' as const, amount: 3_00n },
      ],
    };

    await expect(ledger.postEntry(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    await fund(ledger, external, wallet, 3_00n);

    const retry = await ledger.postEntry(request);
    expect(retry.replayed).toBe(false);
    expect(await ledger.getBalance(wallet.id)).toBe(0n);
  });
});
