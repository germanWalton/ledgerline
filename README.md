# ledgerline

A payments core built around one rule: **money is never created, lost, or moved twice.**

ledgerline is a double-entry ledger and payment processing system designed for the failure modes
production payment systems actually face: concurrent writes against the same balance, client retries,
duplicated and out-of-order webhooks, partial failures between services, and reconciliation against
processor settlement files.

Correctness is enforced where it cannot be bypassed — in PostgreSQL constraints and triggers — and
proven with adversarial tests: 1,000 concurrent withdrawals against a 100.00 balance, 50 simultaneous
retries of the same request, and opposing transfers designed to deadlock.

## Guarantees

| Guarantee | How | Status | Proof |
| --- | --- | --- | --- |
| Every entry balances (debits = credits per currency) | Deferred constraint trigger checked at COMMIT | ✅ Implemented | [invariants.test.ts](packages/ledger/test/invariants.test.ts) |
| History is immutable | Append-only triggers; corrections are reversing entries | ✅ Implemented | [invariants.test.ts](packages/ledger/test/invariants.test.ts) |
| No overdraft under concurrency | Row locks acquired in deterministic order | ✅ Implemented | [concurrency.test.ts](packages/ledger/test/concurrency.test.ts) |
| No deadlocks on opposing transfers | Global lock ordering by account id | ✅ Implemented | [concurrency.test.ts](packages/ledger/test/concurrency.test.ts) |
| A retried request posts exactly once | Unique idempotency key + request hash | ✅ Implemented | [concurrency.test.ts](packages/ledger/test/concurrency.test.ts) |
| No floating-point money | `bigint` minor units end to end | ✅ Implemented | [ledger.ts](packages/ledger/src/ledger.ts) |
| Idempotent payments API | `Idempotency-Key` header over HTTP | Planned | — |
| Duplicate / out-of-order webhooks are harmless | Event deduplication + payment state machine | Planned | — |
| No lost events between DB and queue | Transactional outbox, retries, DLQ | Planned | — |
| Recurring billing with failed-payment recovery | Scheduled charges and dunning | Planned | — |
| Ledger matches the processor | Daily reconciliation against settlement files | Planned | — |

Design decisions, tradeoffs and evidence are recorded in [docs/adr](docs/adr) —
start with [ADR 0001](docs/adr/0001-double-entry-ledger.md).

## Getting started

Requirements: Node.js 22+ and Docker. Runs fully offline: PostgreSQL in Docker and
[AWS Emulator](https://github.com/aws/aws-emulator) for SQS and S3.

```bash
npm install
npm test            # spins up a disposable PostgreSQL via Testcontainers
```

To run a local database for development:

```bash
npm run db:up
DATABASE_URL=postgres://ledgerline:ledgerline@localhost:5432/ledgerline npm run db:migrate
```

## Layout

```
packages/ledger   Double-entry ledger: schema, invariants, locking, idempotency (framework-free)
docs/adr          Architecture decision records
```

## Roadmap

1. ✅ Double-entry ledger with database-enforced invariants
2. Idempotent payments API (NestJS)
3. Simulated payment processor with fault injection, and webhook ingestion
4. Retries, dead-letter queue and transactional outbox
5. Recurring billing and dunning
6. Daily reconciliation against settlement files
7. Load testing and observability
