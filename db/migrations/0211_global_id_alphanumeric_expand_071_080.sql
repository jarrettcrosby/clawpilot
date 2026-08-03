SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

SELECT expand_global_id_compatibility_constraint_batch(71, 80);
