-- Which PayPal endpoint this database's payment actions talk to: the real PayPal Sandbox API or a local stub.
--
-- The binding is recorded the first time the server runs payment actions against a database and can never change,
-- so records produced by the local stub can never sit beside, or be presented as, genuine PayPal Sandbox records.

CREATE TABLE paypal_target_binding (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  target    TEXT NOT NULL CHECK (target IN ('paypal_sandbox', 'local_stub')),
  api_host  TEXT NOT NULL CHECK (length(api_host) BETWEEN 1 AND 255),
  bound_at  TEXT NOT NULL
) STRICT;

CREATE TRIGGER paypal_target_binding_no_update BEFORE UPDATE ON paypal_target_binding
BEGIN
  SELECT RAISE(ABORT, 'the PayPal target of a database cannot change');
END;

CREATE TRIGGER paypal_target_binding_no_delete BEFORE DELETE ON paypal_target_binding
BEGIN
  SELECT RAISE(ABORT, 'the PayPal target of a database cannot change');
END;
