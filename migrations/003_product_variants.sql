BEGIN;

-- products.id is already a primary key, but the composite variant foreign key
-- requires a matching unique key on (business_id, id). Add it transactionally
-- and verify a same-named constraint has the expected definition if present.
DO $$
DECLARE
    existing_definition TEXT;
BEGIN
    SELECT pg_get_constraintdef(c.oid)
      INTO existing_definition
    FROM pg_constraint AS c
    WHERE c.conrelid = 'products'::regclass
      AND c.conname = 'products_business_id_id_uq';

    IF existing_definition IS NULL THEN
        ALTER TABLE products
            ADD CONSTRAINT products_business_id_id_uq
            UNIQUE (business_id, id);
    ELSIF existing_definition <> 'UNIQUE (business_id, id)' THEN
        RAISE EXCEPTION
            'Migration 003 cannot continue: products_business_id_id_uq exists with an unexpected definition: %',
            existing_definition;
    END IF;
END
$$;

-- CREATE TABLE IF NOT EXISTS does not verify the structure of an existing
-- table. This migration assumes product_variants does not already exist with
-- an incompatible schema.
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    product_id UUID NOT NULL,
    variant_name VARCHAR(150) NOT NULL DEFAULT 'Default',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    sku VARCHAR(100),
    base_unit VARCHAR(50) NOT NULL,
    units_per_package INTEGER NOT NULL DEFAULT 1,
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    selling_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT product_variants_product_fk
        FOREIGN KEY (business_id, product_id)
        REFERENCES products (business_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT product_variants_business_id_id_uq
        UNIQUE (business_id, id),

    CONSTRAINT product_variants_name_chk
        CHECK (BTRIM(variant_name) <> ''),

    CONSTRAINT product_variants_base_unit_chk
        CHECK (BTRIM(base_unit) <> ''),

    CONSTRAINT product_variants_units_per_package_chk
        CHECK (units_per_package > 0),

    CONSTRAINT product_variants_cost_price_chk
        CHECK (cost_price >= 0),

    CONSTRAINT product_variants_selling_price_chk
        CHECK (selling_price >= 0),

    CONSTRAINT product_variants_low_stock_threshold_chk
        CHECK (low_stock_threshold >= 0)
);

-- Future application rules: every product must always have exactly one
-- default variant. The first variant must be created in the same database
-- transaction as its product. A default variant cannot be deactivated or
-- deleted while it is the product's only default. The partial unique index
-- below limits a product to at most one default; application behavior must
-- ensure at least one remains after product creation.
-- All variants of a product must share one common base inventory unit.
-- units_per_package is the number of common base units in one sellable
-- package. Future inventory posting must normalize quantities to that common
-- base unit. low_stock_threshold is measured in the common base inventory
-- unit. These cross-row and lifecycle rules are not enforced by this table.

CREATE INDEX IF NOT EXISTS product_variants_business_product_idx
    ON product_variants (business_id, product_id);

-- A product can have multiple variants but no more than one default variant.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_one_default_per_product_uq
    ON product_variants (business_id, product_id)
    WHERE is_default;

-- Detect legacy data conflicts before copying SKUs or creating the unique
-- variant SKU index. Values are compared as stored (case-sensitive).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM products AS p
        WHERE p.sku IS NOT NULL
        GROUP BY p.business_id, p.sku
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migration 003 cannot continue: duplicate non-null product SKUs exist within a business; existing product SKUs must be reviewed before migration';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM products AS p
        WHERE BTRIM(p.base_unit) = ''
    ) THEN
        RAISE EXCEPTION
            'Migration 003 cannot continue: one or more products have a blank base_unit';
    END IF;
END
$$;

-- Preserve every product ID and legacy value while creating its default
-- variant. Products and their legacy columns remain unchanged.
INSERT INTO product_variants (
    business_id,
    product_id,
    variant_name,
    is_default,
    sku,
    base_unit,
    units_per_package,
    cost_price,
    selling_price,
    low_stock_threshold
)
SELECT
    p.business_id,
    p.id,
    'Default',
    TRUE,
    p.sku,
    p.base_unit,
    p.units_per_package,
    p.cost_price,
    p.selling_price,
    p.low_stock_threshold
FROM products AS p
WHERE NOT EXISTS (
    SELECT 1
    FROM product_variants AS pv
    WHERE pv.business_id = p.business_id
      AND pv.product_id = p.id
      AND pv.is_default
);

-- Enforce non-null SKU uniqueness per business after source-data preflight and
-- the default-variant backfill. No duplicate SKU is silently altered or lost.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_business_sku_uq
    ON product_variants (business_id, sku)
    WHERE sku IS NOT NULL;

-- Every existing product must have exactly one default variant, and its
-- copied fields must still match the retained legacy product columns.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM products AS p
        WHERE (
            SELECT COUNT(*)
            FROM product_variants AS pv
            WHERE pv.business_id = p.business_id
              AND pv.product_id = p.id
              AND pv.is_default
        ) <> 1
        OR NOT EXISTS (
            SELECT 1
            FROM product_variants AS pv
            WHERE pv.business_id = p.business_id
              AND pv.product_id = p.id
              AND pv.is_default
              AND pv.sku IS NOT DISTINCT FROM p.sku
              AND pv.base_unit = p.base_unit
              AND pv.units_per_package = p.units_per_package
              AND pv.cost_price = p.cost_price
              AND pv.selling_price = p.selling_price
              AND pv.low_stock_threshold = p.low_stock_threshold
        )
    ) THEN
        RAISE EXCEPTION
            'Migration 003 validation failed: every product must have exactly one default variant matching its legacy values';
    END IF;
END
$$;

-- Validation result for deployment logs or manual review; each product should
-- report default_variant_count = 1.
SELECT
    p.id AS product_id,
    p.business_id,
    COUNT(pv.id) FILTER (WHERE pv.is_default) AS default_variant_count
FROM products AS p
LEFT JOIN product_variants AS pv
  ON pv.business_id = p.business_id
 AND pv.product_id = p.id
GROUP BY p.id, p.business_id
ORDER BY p.business_id, p.id;

COMMIT;
