# ADR 0001: Double-entry ledger with database-enforced invariants

- Status: Accepted
- Date: 2026-11-12

## Context

Every other part of ledgerline (payments API, webhooks, retries, reconciliation) exists to
record money movements. If the ledger can be corrupted — by a bug, a race, or a retried
request — nothing built on top of it can be trusted. The failure modes we must rule out:

| Failure | Example |
| --- | --- |
| Money created or destroyed | An entry debits 10.00 but credits 9.99 |
| Lost update | Two concurrent withdrawals both read balance 100 and both write 99 |
| Overdraft | 1000 concurrent 1.00 withdrawals against a 100.00 wallet |
| Deadlock | A→B and B→A transfers lock rows in opposite order |
| Double posting | A client retries a request whose response timed out |
| History tampering | Someone "fixes" a wrong amount with UPDATE |
| Float rounding | `0.1 + 0.2 !== 0.3` |

## Decision

1. **Double-entry model.** `accounts`, `journal_entries` and `postings`. Every entry has at least
   two postings and its debits equal its credits per currency.
2. **The database is the last line of defense.** Invariants live in PostgreSQL, not only in
   TypeScript: deferred constraint triggers check balance at COMMIT, a trigger checks posting
   currency, a CHECK constraint forbids negative balances on non-negative accounts, and
   triggers make entries and postings append-only (corrections are reversing entries).
   Custom SQLSTATEs (`LL001`–`LL004`) map back to domain errors.
3. **Integer minor units as `bigint`.** `int8` is parsed into JS `bigint`; amounts never touch `number`.
4. **Pessimistic locking in a deterministic order.** Each entry locks its accounts with
   `SELECT ... FOR UPDATE ORDER BY id` before reading balances. Concurrent entries over the
   same account serialize; the global lock order prevents deadlocks.
5. **Cached balances, postings as source of truth.** `accounts.balance` is updated in the same
   transaction for O(1) reads. `verifyBalances()` recomputes from postings to detect drift
   (groundwork for reconciliation).
6. **Ledger-level idempotency.** The entry row carrying a unique `idempotency_key` is inserted
   first. A concurrent duplicate blocks on the unique index, then gets a unique violation and
   replays the committed entry. Reusing a key with a different body (compared by SHA-256 of the
   canonical request) is rejected. A failed attempt rolls back and does not consume the key.

## Evidence

`packages/ledger/test/concurrency.test.ts` runs against a real PostgreSQL (Testcontainers):

- 1000 concurrent 1.00 withdrawals against 100.00 → exactly 100 succeed, balance 0.
- 400 interleaved A→B / B→A transfers → no deadlock, totals preserved.
- 50 concurrent identical idempotent requests → one entry, 49 replays.

Mutation check: removing `.forUpdate()` makes all 1000 withdrawals succeed against a 100.00
balance (lost update) and the other two scenarios hang. Note that the non-negative CHECK did
**not** catch it: each racing transaction wrote a valid-looking stale balance. Constraints
protect single writes; only locking (or serializable isolation) protects read-modify-write.

## Consequences

- Hot accounts (e.g. a single platform settlement account touched by every payment) become a
  serialization point. Throughput on one account is bounded by lock hold time. Options to
  revisit later: sharded sub-accounts, batching, or append-only balances computed asynchronously.
- Append-only history means mistakes are fixed with reversing entries, which is what auditors expect.
- Tests cannot clean tables (TRUNCATE is refused), so each test creates uniquely coded accounts.

## Alternatives considered

- **Optimistic locking (version column + retry):** fewer blocked connections at low contention,
  but under heavy contention on one wallet most attempts retry. Worth benchmarking in phase 7.
- **SERIALIZABLE isolation:** correct without explicit locks, but every conflict surfaces as a
  40001 serialization failure that the caller must retry. Explicit locks make the intent visible.
- **Balance computed only from postings (no cache):** no drift possible, but O(n) reads and the
  overdraft check still needs a lock on something.
