ALTER TABLE organization_quickbooks_connections
  ADD COLUMN IF NOT EXISTS company_profile jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS quickbooks_financial_reports (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  report_key text NOT NULL,
  period_key text NOT NULL,
  report_name text NOT NULL,
  report_basis text,
  start_period date,
  end_period date,
  currency_code text,
  generated_at timestamptz,
  columns_payload jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows_payload jsonb NOT NULL DEFAULT '[]'::jsonb,
  report_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
  last_error_code text,
  last_attempted_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  PRIMARY KEY (organization_id, report_key, period_key),
  CONSTRAINT quickbooks_financial_reports_key_valid CHECK (
    report_key IN ('profit_loss', 'balance_sheet', 'cash_flow', 'ar_aging', 'ap_aging')
  ),
  CONSTRAINT quickbooks_financial_reports_period_valid CHECK (
    period_key IN ('mtd', 'qtd', 'ytd', 'six_months', 'as_of_today')
  ),
  CONSTRAINT quickbooks_financial_reports_name_present CHECK (length(btrim(report_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_financial_reports_explorer
  ON quickbooks_financial_reports (organization_id, report_key, period_key, status, synced_at DESC);
