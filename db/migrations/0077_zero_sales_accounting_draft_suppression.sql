DO $$
BEGIN
  IF to_regclass('public.pos_accounting_issue_states') IS NOT NULL
    AND to_regclass('public.pos_accounting_notification_outbox') IS NOT NULL
  THEN
    EXECUTE $sql$
      UPDATE pos_accounting_notification_outbox notification
      SET status = 'cancelled',
          last_error = 'Zero-activity accounting draft was removed',
          locked_at = NULL,
          locked_by = NULL,
          lock_token = NULL,
          updated_at = now()
      FROM pos_accounting_issue_states issue
      JOIN toast_accounting_export_drafts draft
        ON draft.organization_id = issue.organization_id
       AND draft.restaurant_guid = issue.restaurant_guid
       AND draft.business_date = issue.business_date
      JOIN toast_daily_sales sales
        ON sales.organization_id = draft.organization_id
       AND sales.restaurant_guid = draft.restaurant_guid
       AND sales.business_date = draft.business_date
      WHERE notification.issue_state_id = issue.id
        AND issue.status = 'open'
        AND notification.status IN ('pending', 'failed', 'processing')
        AND draft.status NOT IN ('approved', 'posting', 'posted')
        AND sales.orders_count = 0
        AND sales.standard_orders_count = 0
        AND sales.gross_sales = 0
        AND sales.net_sales = 0
        AND sales.discounts = 0
        AND sales.voids = 0
        AND sales.refunds = 0
        AND sales.standard_gross_sales = 0
        AND sales.standard_net_sales = 0
        AND sales.standard_discounts = 0
        AND sales.standard_voids = 0
        AND sales.standard_refunds = 0
        AND sales.standard_tax = 0
        AND sales.standard_tips = 0
        AND sales.standard_service_charges = 0
        AND sales.standard_tendered = 0
        AND sales.standard_total = 0
        AND sales.standard_cash = 0
        AND sales.standard_card = 0
        AND sales.standard_other_tender = 0
    $sql$;

    EXECUTE $sql$
      UPDATE pos_accounting_issue_states issue
      SET status = 'resolved',
          last_seen_at = now(),
          resolved_at = now(),
          updated_at = now()
      FROM toast_accounting_export_drafts draft
      JOIN toast_daily_sales sales
        ON sales.organization_id = draft.organization_id
       AND sales.restaurant_guid = draft.restaurant_guid
       AND sales.business_date = draft.business_date
      WHERE issue.organization_id = draft.organization_id
        AND issue.restaurant_guid = draft.restaurant_guid
        AND issue.business_date = draft.business_date
        AND issue.status = 'open'
        AND draft.status NOT IN ('approved', 'posting', 'posted')
        AND sales.orders_count = 0
        AND sales.standard_orders_count = 0
        AND sales.gross_sales = 0
        AND sales.net_sales = 0
        AND sales.discounts = 0
        AND sales.voids = 0
        AND sales.refunds = 0
        AND sales.standard_gross_sales = 0
        AND sales.standard_net_sales = 0
        AND sales.standard_discounts = 0
        AND sales.standard_voids = 0
        AND sales.standard_refunds = 0
        AND sales.standard_tax = 0
        AND sales.standard_tips = 0
        AND sales.standard_service_charges = 0
        AND sales.standard_tendered = 0
        AND sales.standard_total = 0
        AND sales.standard_cash = 0
        AND sales.standard_card = 0
        AND sales.standard_other_tender = 0
    $sql$;
  END IF;
END
$$;

DELETE FROM toast_accounting_export_drafts draft
USING toast_daily_sales sales
WHERE sales.organization_id = draft.organization_id
  AND sales.restaurant_guid = draft.restaurant_guid
  AND sales.business_date = draft.business_date
  AND draft.status NOT IN ('approved', 'posting', 'posted')
  AND sales.orders_count = 0
  AND sales.standard_orders_count = 0
  AND sales.gross_sales = 0
  AND sales.net_sales = 0
  AND sales.discounts = 0
  AND sales.voids = 0
  AND sales.refunds = 0
  AND sales.standard_gross_sales = 0
  AND sales.standard_net_sales = 0
  AND sales.standard_discounts = 0
  AND sales.standard_voids = 0
  AND sales.standard_refunds = 0
  AND sales.standard_tax = 0
  AND sales.standard_tips = 0
  AND sales.standard_service_charges = 0
  AND sales.standard_tendered = 0
  AND sales.standard_total = 0
  AND sales.standard_cash = 0
  AND sales.standard_card = 0
  AND sales.standard_other_tender = 0;
