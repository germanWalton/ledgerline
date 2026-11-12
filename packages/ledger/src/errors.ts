export abstract class LedgerError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidEntryError extends LedgerError {
  readonly code = 'INVALID_ENTRY';
}

export class UnbalancedEntryError extends LedgerError {
  readonly code = 'UNBALANCED_ENTRY';
}

export class AccountNotFoundError extends LedgerError {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor(readonly accountIds: readonly string[]) {
    super(`Account(s) not found: ${accountIds.join(', ')}`);
  }
}

export class CurrencyMismatchError extends LedgerError {
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends LedgerError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(readonly accountId: string) {
    super(`Insufficient funds in account ${accountId}`);
  }
}

/** The same idempotency key was reused with a different request body. */
export class IdempotencyConflictError extends LedgerError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different request`);
  }
}

export class AppendOnlyViolationError extends LedgerError {
  readonly code = 'APPEND_ONLY_VIOLATION';
}

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

function asPgError(error: unknown): PgError | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as PgError) : undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = asPgError(error);
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

/** Maps database invariant violations (the last line of defense) to domain errors. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof LedgerError) return error;
  const pgError = asPgError(error);
  if (!pgError) return error;

  switch (pgError.code) {
    case 'LL001':
      return new CurrencyMismatchError(pgError.message);
    case 'LL002':
      return new InvalidEntryError(pgError.message);
    case 'LL003':
      return new UnbalancedEntryError(pgError.message);
    case 'LL004':
      return new AppendOnlyViolationError(pgError.message);
    case '23514':
      if (pgError.constraint === 'accounts_balance_non_negative') {
        return new InsufficientFundsError('unknown');
      }
      return error;
    default:
      return error;
  }
}
