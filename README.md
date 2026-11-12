# ledgerline

A learning-oriented payments platform built to explore the hard parts of moving money correctly:
double-entry ledgering, idempotency, concurrency, queues and retries, webhook handling,
recurring billing, reconciliation, and security.

Everything runs locally: PostgreSQL for the ledger and [AWS Emulator](https://github.com/aws/aws-emulator)
for SQS, S3 and friends — no AWS account required.

## Status

Work in progress. See the roadmap below.

## Roadmap

1. Double-entry ledger with database-enforced invariants and concurrency tests
2. Idempotent payments API
3. Fake PSP with chaos injection and webhook ingestion
4. Retries, DLQ and transactional outbox
5. Recurring billing and dunning
6. Daily reconciliation against settlement files
7. Load simulation and observability
