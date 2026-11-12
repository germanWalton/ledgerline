import type { ColumnType, Generated } from 'kysely';

export type Direction = 'debit' | 'credit';

export interface AccountsTable {
  id: Generated<string>;
  code: string;
  currency: string;
  normal_balance: Direction;
  allow_negative: Generated<boolean>;
  balance: ColumnType<bigint, never, bigint>;
  created_at: ColumnType<Date, never, never>;
}

export interface JournalEntriesTable {
  id: Generated<string>;
  idempotency_key: string | null;
  request_hash: string | null;
  description: string;
  created_at: ColumnType<Date, never, never>;
}

export interface PostingsTable {
  id: ColumnType<bigint, never, never>;
  entry_id: string;
  account_id: string;
  direction: Direction;
  amount: bigint;
  currency: string;
  created_at: ColumnType<Date, never, never>;
}

export interface LedgerDatabase {
  accounts: AccountsTable;
  journal_entries: JournalEntriesTable;
  postings: PostingsTable;
}
