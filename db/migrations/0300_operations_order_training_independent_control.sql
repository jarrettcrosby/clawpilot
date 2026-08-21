-- Rolling-deployment compatibility marker for exact-order training.
--
-- Release A deliberately leaves the 0290 safety-profile-bound trigger
-- functions unchanged so the previously deployed runtime's exact health
-- attestation remains valid while this release rolls through the fleet.
-- The independent-control replacements are frozen byte-for-byte in
-- scripts/fixtures/0306_operations_order_training_independent_control_contract.sql
-- and may be installed only by the later 0306 contract migration after every
-- Release A runtime is active and the previous runtime has drained.

DO $compatibility_marker$
BEGIN
  NULL;
END;
$compatibility_marker$;
