UPDATE short_links
SET disabled_at = COALESCE(disabled_at, now()),
    deleted_at = COALESCE(deleted_at, now()),
    updated_at = now()
WHERE destination_url !~ '^https://';
