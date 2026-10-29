CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contractors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  column_counterparty_id TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  gross_minor BIGINT NOT NULL CHECK (gross_minor > 0),
  platform_fee_minor BIGINT NOT NULL CHECK (platform_fee_minor >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE job_allocations (
  job_id UUID NOT NULL REFERENCES jobs(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (job_id, contractor_id)
);

CREATE TABLE obligations (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'due'
    CHECK (status IN ('due', 'in_progress', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, contractor_id)
);

CREATE TABLE payout_batches (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'partially_failed')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payout_attempts (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES payout_batches(id),
  obligation_id UUID NOT NULL REFERENCES obligations(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_transfer_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'submitting', 'unknown', 'initiated', 'submitted',
      'settled', 'completed', 'returned', 'failed', 'canceled'
    )),
  return_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, attempt_number)
);

CREATE INDEX payout_attempts_work_queue
  ON payout_attempts (created_at)
  WHERE status IN ('queued', 'unknown');

CREATE TABLE ledger_journals (
  id UUID PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE TABLE ledger_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id UUID NOT NULL REFERENCES ledger_journals(id),
  account TEXT NOT NULL CHECK (account IN (
    'bank_cash', 'unallocated_customer_funds', 'contractor_payable',
    'money_in_transit', 'fee_revenue'
  )),
  debit_minor BIGINT NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  obligation_id UUID REFERENCES obligations(id),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);

CREATE INDEX ledger_entries_account ON ledger_entries (account);
CREATE INDEX ledger_entries_obligation ON ledger_entries (obligation_id)
  WHERE obligation_id IS NOT NULL;

CREATE FUNCTION ensure_journal_balanced() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_journal_id UUID;
  entry_count BIGINT;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    target_journal_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);
  END IF;

  SELECT count(*), COALESCE(sum(debit_minor), 0), COALESCE(sum(credit_minor), 0)
    INTO entry_count, debit_total, credit_total
    FROM ledger_entries
    WHERE journal_id = target_journal_id;

  IF entry_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Journal must contain at least two entries and balance.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_header_balance
  AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_journal_balanced();

CREATE CONSTRAINT TRIGGER journal_entry_balance
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_journal_balanced();

CREATE FUNCTION prevent_ledger_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger history is append-only.';
END;
$$;

CREATE TRIGGER ledger_journals_immutable
  BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TABLE event_inbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  transfer_id TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_inbox_transfer ON event_inbox (transfer_id)
  WHERE transfer_id IS NOT NULL;

CREATE TABLE settlement_reports (
  report_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  bank_account_id TEXT NOT NULL,
  transfer_id TEXT,
  transaction_type TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  amount_minor BIGINT NOT NULL,
  payload JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, row_number)
);

INSERT INTO contractors (id, name) VALUES
  ('contractor_mara', 'Mara Electrical'),
  ('contractor_northstar', 'Northstar Repairs'),
  ('contractor_lee', 'Lee Heating & Air');

INSERT INTO ledger_journals (id, source_type, source_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'opening_funds', 'demo-opening');

INSERT INTO ledger_entries (journal_id, account, debit_minor, credit_minor)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'bank_cash', 1000000, 0),
  ('00000000-0000-4000-8000-000000000001', 'unallocated_customer_funds', 0, 1000000);
