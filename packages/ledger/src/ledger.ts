import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  AccountNotFoundError,
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidEntryError,
  UnbalancedEntryError,
  isUniqueViolation,
  translateDbError,
} from './errors.js';
import type { AccountsTable, Direction, LedgerDatabase } from './schema.js';

export type Account = Selectable<AccountsTable>;

export interface CreateAccountInput {
  code: string;
  currency: string;
  normalBalance: Direction;
  allowNegative?: boolean;
}

export interface PostingInput {
  accountId: string;
  direction: Direction;
  /** Amount in minor units (e.g. cents). Always positive; direction gives the sign. */
  amount: bigint;
}

export interface PostEntryInput {
  description: string;
  postings: PostingInput[];
  /** When present, retrying the same request returns the original entry instead of posting twice. */
  idempotencyKey?: string;
}

export interface Posting {
  accountId: string;
  direction: Direction;
  amount: bigint;
  currency: string;
}

export interface JournalEntry {
  id: string;
  description: string;
  idempotencyKey: string | null;
  createdAt: Date;
  postings: Posting[];
}

export interface PostEntryResult {
  entry: JournalEntry;
  /** True when the entry already existed for this idempotency key and nothing new was posted. */
  replayed: boolean;
}

export interface BalanceMismatch {
  accountId: string;
  cached: bigint;
  derived: bigint;
}

const IDEMPOTENCY_CONSTRAINT = 'journal_entries_idempotency_key_key';
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export class Ledger {
  constructor(private readonly db: Kysely<LedgerDatabase>) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    return this.db
      .insertInto('accounts')
      .values({
        code: input.code,
        currency: input.currency,
        normal_balance: input.normalBalance,
        allow_negative: input.allowNegative ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getAccount(accountId: string): Promise<Account> {
    const account = await this.db.selectFrom('accounts').selectAll().where('id', '=', accountId).executeTakeFirst();
    if (!account) throw new AccountNotFoundError([accountId]);
    return account;
  }

  async getBalance(accountId: string): Promise<bigint> {
    return (await this.getAccount(accountId)).balance;
  }

  /**
   * Posts a balanced journal entry atomically.
   *
   * Concurrency: every touched account row is locked with SELECT ... FOR UPDATE in a
   * deterministic order (by id), so concurrent entries over the same accounts serialize
   * instead of racing, and opposite-direction transfers cannot deadlock.
   *
   * Idempotency: the entry row (holding the unique idempotency key) is inserted first.
   * A concurrent duplicate blocks on that unique index until the first transaction ends,
   * then fails with a unique violation and replays the committed entry.
   */
  async postEntry(input: PostEntryInput): Promise<PostEntryResult> {
    assertWellFormed(input);
    const requestHash = input.idempotencyKey === undefined ? null : hashRequest(input);

    try {
      const entry = await this.db.transaction().execute((trx) => this.writeEntry(trx, input, requestHash));
      return { entry, replayed: false };
    } catch (error) {
      if (input.idempotencyKey !== undefined && requestHash !== null && isUniqueViolation(error, IDEMPOTENCY_CONSTRAINT)) {
        return { entry: await this.replay(input.idempotencyKey, requestHash), replayed: true };
      }
      throw translateDbError(error);
    }
  }

  /** Compares each cached balance against the balance derived from its postings. */
  async verifyBalances(): Promise<BalanceMismatch[]> {
    const { rows } = await sql<{ account_id: string; cached: bigint; derived: bigint }>`
      SELECT a.id AS account_id,
             a.balance AS cached,
             COALESCE(SUM(CASE WHEN p.direction = a.normal_balance THEN p.amount ELSE -p.amount END), 0)::bigint AS derived
        FROM accounts a
        LEFT JOIN postings p ON p.account_id = a.id
       GROUP BY a.id, a.balance
      HAVING a.balance <> COALESCE(SUM(CASE WHEN p.direction = a.normal_balance THEN p.amount ELSE -p.amount END), 0)
    `.execute(this.db);
    return rows.map((row) => ({ accountId: row.account_id, cached: row.cached, derived: row.derived }));
  }

  private async writeEntry(
    trx: Transaction<LedgerDatabase>,
    input: PostEntryInput,
    requestHash: string | null,
  ): Promise<JournalEntry> {
    const entryRow = await trx
      .insertInto('journal_entries')
      .values({
        description: input.description,
        idempotency_key: input.idempotencyKey ?? null,
        request_hash: requestHash,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const accountIds = [...new Set(input.postings.map((posting) => posting.accountId))];
    const accounts = await trx
      .selectFrom('accounts')
      .selectAll()
      .where('id', 'in', accountIds)
      .orderBy('id')
      .forUpdate()
      .execute();

    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const missing = accountIds.filter((id) => !accountsById.has(id));
    if (missing.length > 0) throw new AccountNotFoundError(missing);

    const postings: Posting[] = input.postings.map((posting) => ({
      ...posting,
      currency: accountsById.get(posting.accountId)!.currency,
    }));
    assertBalancedPerCurrency(postings);

    const deltas = new Map<string, bigint>();
    for (const posting of postings) {
      const account = accountsById.get(posting.accountId)!;
      const signed = posting.direction === account.normal_balance ? posting.amount : -posting.amount;
      deltas.set(account.id, (deltas.get(account.id) ?? 0n) + signed);
    }

    for (const [accountId, delta] of deltas) {
      const account = accountsById.get(accountId)!;
      const newBalance = account.balance + delta;
      if (!account.allow_negative && newBalance < 0n) throw new InsufficientFundsError(accountId);
      await trx.updateTable('accounts').set({ balance: newBalance }).where('id', '=', accountId).execute();
    }

    await trx
      .insertInto('postings')
      .values(
        postings.map((posting) => ({
          entry_id: entryRow.id,
          account_id: posting.accountId,
          direction: posting.direction,
          amount: posting.amount,
          currency: posting.currency,
        })),
      )
      .execute();

    return {
      id: entryRow.id,
      description: entryRow.description,
      idempotencyKey: entryRow.idempotency_key,
      createdAt: entryRow.created_at,
      postings,
    };
  }

  private async replay(idempotencyKey: string, requestHash: string): Promise<JournalEntry> {
    const entryRow = await this.db
      .selectFrom('journal_entries')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();

    if (entryRow.request_hash !== requestHash) throw new IdempotencyConflictError(idempotencyKey);

    const postingRows = await this.db
      .selectFrom('postings')
      .select(['account_id', 'direction', 'amount', 'currency'])
      .where('entry_id', '=', entryRow.id)
      .orderBy('id')
      .execute();

    return {
      id: entryRow.id,
      description: entryRow.description,
      idempotencyKey: entryRow.idempotency_key,
      createdAt: entryRow.created_at,
      postings: postingRows.map((row) => ({
        accountId: row.account_id,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
      })),
    };
  }
}

function assertWellFormed(input: PostEntryInput): void {
  if (input.description.trim().length === 0) throw new InvalidEntryError('Description is required');
  if (input.postings.length < 2) throw new InvalidEntryError('An entry needs at least two postings');
  if (input.idempotencyKey !== undefined) {
    const length = input.idempotencyKey.length;
    if (length === 0 || length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new InvalidEntryError(`Idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
  }
  for (const posting of input.postings) {
    if (typeof posting.amount !== 'bigint' || posting.amount <= 0n) {
      throw new InvalidEntryError('Posting amounts must be positive bigint minor units');
    }
  }
}

function assertBalancedPerCurrency(postings: readonly Posting[]): void {
  const net = new Map<string, bigint>();
  for (const posting of postings) {
    const signed = posting.direction === 'debit' ? posting.amount : -posting.amount;
    net.set(posting.currency, (net.get(posting.currency) ?? 0n) + signed);
  }
  if (net.size > 1) {
    throw new CurrencyMismatchError(`An entry must use a single currency; got ${[...net.keys()].join(', ')}`);
  }
  for (const [currency, amount] of net) {
    if (amount !== 0n) throw new UnbalancedEntryError(`Entry is unbalanced in ${currency} by ${amount}`);
  }
}

function hashRequest(input: PostEntryInput): string {
  const canonical = JSON.stringify({
    description: input.description,
    postings: input.postings.map((posting) => [posting.accountId, posting.direction, posting.amount.toString()]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
