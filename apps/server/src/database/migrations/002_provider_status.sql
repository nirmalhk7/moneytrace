ALTER TABLE payout_attempts
  ADD COLUMN provider_status TEXT,
  ADD COLUMN provider_request JSONB,
  ADD COLUMN unknown_since TIMESTAMPTZ;

CREATE FUNCTION prevent_provider_request_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_request IS NOT NULL AND NEW.provider_request IS DISTINCT FROM OLD.provider_request THEN
    RAISE EXCEPTION 'Provider request snapshot is immutable.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payout_attempt_provider_request_immutable
  BEFORE UPDATE ON payout_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_provider_request_change();
