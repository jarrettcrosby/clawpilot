-- Replace only the exact generated starter-material names from the original
-- imperial-only seed. Stable codes, canonical measurements, stock, cost,
-- status, and organization ownership remain unchanged. Any operator-edited
-- name is outside this correction.

WITH starter_name_corrections(code, previous_name, next_name) AS (
  VALUES
    ('STARTER-BOX-06X06X04', '6 × 6 × 4 in carton', 'Compact starter carton'),
    ('STARTER-BOX-08X06X04', '8 × 6 × 4 in carton', 'Small starter carton'),
    ('STARTER-BOX-10X08X06', '10 × 8 × 6 in carton', 'Medium starter carton'),
    ('STARTER-BOX-12X10X08', '12 × 10 × 8 in carton', 'Large starter carton'),
    ('STARTER-POLY-10X13', '10 × 13 in poly mailer', 'Starter poly mailer'),
    ('STARTER-PADDED-08X12', '8.5 × 12 in padded mailer', 'Starter padded mailer')
)
UPDATE operations_packaging_materials material
SET name = correction.next_name,
    row_version = material.row_version + 1,
    updated_at = now()
FROM starter_name_corrections correction
WHERE material.source = 'starter_assortment'
  AND material.code = correction.code
  AND material.name = correction.previous_name;
