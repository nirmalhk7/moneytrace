CREATE TABLE incident_runs (
  id UUID PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('lost_response', 'missing_ledger', 'late_return')),
  source TEXT NOT NULL CHECK (source IN ('replay', 'column_sandbox')),
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_incident_run_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Incident run evidence is immutable.';
END;
$$;

CREATE TRIGGER incident_runs_immutable
  BEFORE UPDATE OR DELETE ON incident_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_incident_run_mutation();
