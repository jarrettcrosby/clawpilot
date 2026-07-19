CREATE TABLE IF NOT EXISTS toast_pos_orders (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  order_guid text NOT NULL,
  business_date date NOT NULL,
  display_number text,
  source text,
  dining_option text,
  approval_status text,
  payment_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  paid_at timestamptz,
  guest_count integer NOT NULL DEFAULT 0,
  check_count integer NOT NULL DEFAULT 0,
  item_count numeric(12, 3) NOT NULL DEFAULT 0,
  gross_sales numeric(16, 2) NOT NULL DEFAULT 0,
  net_sales numeric(16, 2) NOT NULL DEFAULT 0,
  discounts numeric(16, 2) NOT NULL DEFAULT 0,
  tax numeric(16, 2) NOT NULL DEFAULT 0,
  service_charges numeric(16, 2) NOT NULL DEFAULT 0,
  tips numeric(16, 2) NOT NULL DEFAULT 0,
  refunds numeric(16, 2) NOT NULL DEFAULT 0,
  tendered numeric(16, 2) NOT NULL DEFAULT 0,
  total numeric(16, 2) NOT NULL DEFAULT 0,
  cash_tender numeric(16, 2) NOT NULL DEFAULT 0,
  card_tender numeric(16, 2) NOT NULL DEFAULT 0,
  other_tender numeric(16, 2) NOT NULL DEFAULT 0,
  voided boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, order_guid),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_pos_orders_guid_valid CHECK (
    order_guid = btrim(order_guid)
    AND char_length(order_guid) BETWEEN 1 AND 200
    AND order_guid !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS idx_toast_pos_orders_business_date
  ON toast_pos_orders (organization_id, business_date DESC, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_toast_pos_orders_location_date
  ON toast_pos_orders (organization_id, restaurant_guid, business_date DESC);

ALTER TABLE toast_daily_sales
  ADD COLUMN IF NOT EXISTS standard_gross_sales numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_net_sales numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_discounts numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_voids numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_refunds numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_tax numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_tips numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_service_charges numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_tendered numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_total numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_cash numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_card numeric(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS standard_other_tender numeric(16, 2) NOT NULL DEFAULT 0;
