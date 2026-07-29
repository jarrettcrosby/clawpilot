-- Migration 0143 widened the explicitly named quote-purpose constraint, but
-- PostgreSQL also retained the inline constraint that migration 0137
-- auto-named from the rate_purpose column. Remove that legacy single-package
-- guard so the purpose-aware constraint installed by 0143 is authoritative.

ALTER TABLE operations_cartonization_rate_evidence_quotes
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_quote_rate_purpose_check;

