ALTER TABLE short_links
  ADD COLUMN public_domain text;

ALTER TABLE short_links
  ADD CONSTRAINT short_links_public_domain_allowed
  CHECK (public_domain IS NULL OR public_domain = 'bpo');
