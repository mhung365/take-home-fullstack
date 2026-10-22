CREATE SEQUENCE claim_number_seq;

CREATE TABLE claims (
  id               text PRIMARY KEY,               -- 'c-' || nextval('claim_number_seq')
  member_id        text NOT NULL,
  status           text NOT NULL,
  state_entered_at timestamptz NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  policy_limit     numeric(14,2) NOT NULL CHECK (policy_limit > 0),
  created_at       timestamptz NOT NULL,
  created_by       text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  data             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX claims_status_idx ON claims (status);

CREATE TABLE audit_entries (
  id                   uuid PRIMARY KEY,
  claim_id             text NOT NULL REFERENCES claims(id),
  seq                  integer NOT NULL,
  type                 text NOT NULL,
  timestamp            timestamptz NOT NULL,
  from_state           text,
  to_state             text,
  transition_id        text,
  triggered_by_user_id text NOT NULL,
  triggered_by_role    text NOT NULL,
  reason               text NOT NULL,
  notes                text,
  data                 jsonb,
  UNIQUE (claim_id, seq)
);
CREATE INDEX audit_transition_idx ON audit_entries (claim_id, transition_id) WHERE type = 'TRANSITION';

-- Audit is append-only, even for hand-written SQL. TRUNCATE ... CASCADE from claims
-- also fires this. Tests reset data with DROP SCHEMA, which triggers do not block.
CREATE FUNCTION audit_entries_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_entries_reject_change();

CREATE TRIGGER audit_entries_no_truncate
  BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_reject_change();
