# ledgerline

A learning-oriented payments platform built to explore the hard parts of moving money correctly:
double-entry ledgering, idempotency, concurrency, queues and retries, webhook handling,
recurring billing, reconciliation, and security.

Everything runs locally: PostgreSQL for the ledger and [AWS Emulator](https://github.com/aws/aws-emulator)
for SQS, S3 and friends — no AWS account required.

## Status

Work in progress. Phase 1 (ledger core) is done; see the roadmap below.

## Getting started

Requirements: Node.js 22+ and Docker.

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

Design decisions are documented in [docs/adr](docs/adr).

## Roadmap

1. Double-entry ledger with database-enforced invariants and concurrency tests
2. Idempotent payments API
3. Fake PSP with chaos injection and webhook ingestion
4. Retries, DLQ and transactional outbox
5. Recurring billing and dunning
6. Daily reconciliation against settlement files
7. Load simulation and observability
