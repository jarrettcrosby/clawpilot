ALTER TABLE quickbooks_write_requests
  DROP CONSTRAINT IF EXISTS quickbooks_write_requests_operation_kind_check;

ALTER TABLE quickbooks_write_requests
  ADD CONSTRAINT quickbooks_write_requests_operation_kind_check CHECK (
    operation_kind IN (
      'customer.create', 'item.create', 'item.update', 'invoice.create',
      'sales_receipt.create', 'journal_entry.create'
    )
  );
