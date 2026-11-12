-- Double-entry ledger schema.
--
-- Invariants enforced by the database (not only by application code):
--   1. Every journal entry has at least two postings.
--   2. Every journal entry is balanced per currency: sum(debits) = sum(credits).
--   3. A posting's currency matches its account's currency.
--   4. Journal entries and postings are append-only (no UPDATE / DELETE / TRUNCATE).
--   5. Accounts that do not allow negative balances can never go below zero.
--
-- Custom SQLSTATE codes (class LL) let the application map failures to domain errors:
--   LL001 currency mismatch, LL002 too few postings, LL003 unbalanced entry, LL004 append-only violation.

CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  allow_negative boolean NOT NULL DEFAULT false,
  -- Cached balance in minor units, signed in the account's normal direction.
  -- The postings table is the source of truth; see verifyBalances().
  balance        bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_balance_non_negative CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  request_hash    text,
  description     text NOT NULL CHECK (length(description) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_idempotency_pair CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
);

CREATE TABLE postings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  direction  text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount     bigint NOT NULL CHECK (amount > 0),
  currency   char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX postings_entry_id_idx ON postings (entry_id);
CREATE INDEX postings_account_id_idx ON postings (account_id);

-- Invariant 3: posting currency must match account currency.
CREATE FUNCTION ledger_posting_currency_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_currency char(3);
BEGIN
  SELECT currency INTO account_currency FROM accounts WHERE id = NEW.account_id;
  IF account_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'posting currency % does not match account currency %', NEW.currency, account_currency
      USING ERRCODE = 'LL001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER postings_currency_matches
  BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_posting_currency_matches();

-- Invariants 1 and 2, checked at COMMIT time so an entry can be built row by row.
CREATE FUNCTION ledger_assert_entry_balanced(target_entry_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  posting_count integer;
  offending record;
BEGIN
  SELECT count(*) INTO posting_count FROM postings WHERE entry_id = target_entry_id;
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'journal entry % has % posting(s); at least 2 are required', target_entry_id, posting_count
      USING ERRCODE = 'LL002';
  END IF;

  SELECT currency,
         sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS net
    INTO offending
    FROM postings
   WHERE entry_id = target_entry_id
   GROUP BY currency
  HAVING sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'journal entry % is unbalanced in %: net %', target_entry_id, offending.currency, offending.net
      USING ERRCODE = 'LL003';
  END IF;
END;
$$;

CREATE FUNCTION ledger_check_entry_from_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION ledger_check_entry_from_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_entry_balanced(NEW.entry_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_from_entry();

CREATE CONSTRAINT TRIGGER postings_entry_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_from_posting();

-- Invariant 4: append-only history. Corrections are new reversing entries, never edits.
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversing entry instead', TG_TABLE_NAME
    USING ERRCODE = 'LL004';
END;
$$;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();

CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();

CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();

CREATE TRIGGER postings_no_truncate
  BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
