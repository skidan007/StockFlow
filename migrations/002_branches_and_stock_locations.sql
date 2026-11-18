BEGIN;

-- Branches belong to one existing business. The composite unique key allows
-- child tables to enforce tenant scope with (business_id, branch_id).
-- CREATE TABLE IF NOT EXISTS does not verify the structure of an already
-- existing table. This migration assumes branches and stock_locations do not
-- already exist with incompatible schemas.
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    name VARCHAR(150) NOT NULL,
    code VARCHAR(50),
    address TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT branches_business_fk
        FOREIGN KEY (business_id)
        REFERENCES businesses (id)
        ON DELETE RESTRICT,
    CONSTRAINT branches_business_id_id_uq
        UNIQUE (business_id, id)
);

-- Codes are optional, but when supplied they are unique within a business.
CREATE UNIQUE INDEX IF NOT EXISTS branches_business_code_uq
    ON branches (business_id, code)
    WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS branches_business_active_idx
    ON branches (business_id, is_active);

-- A location is scoped to both its business and its branch. RESTRICT keeps
-- branch/location history from being removed accidentally in future schemas.
CREATE TABLE IF NOT EXISTS stock_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    branch_id UUID NOT NULL,
    name VARCHAR(150) NOT NULL,
    location_type VARCHAR(30) NOT NULL,
    code VARCHAR(50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT stock_locations_type_chk
        CHECK (location_type IN ('warehouse', 'shop', 'storage_area')),
    CONSTRAINT stock_locations_business_branch_fk
        FOREIGN KEY (business_id, branch_id)
        REFERENCES branches (business_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT stock_locations_business_id_id_uq
        UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_branch_code_uq
    ON stock_locations (business_id, branch_id, code)
    WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_locations_business_branch_active_idx
    ON stock_locations (business_id, branch_id, is_active);

-- Seed defaults using generated UUIDs. Their scoped codes are stable keys for
-- reruns, so a committed migration will not create duplicate defaults.
INSERT INTO branches (business_id, name, code)
SELECT b.id, 'Main Branch', 'MAIN'
FROM businesses AS b
ON CONFLICT (business_id, code) WHERE code IS NOT NULL DO NOTHING;

INSERT INTO stock_locations (business_id, branch_id, name, location_type, code)
SELECT b.business_id, b.id, 'Main Stockroom', 'warehouse', 'MAIN-STOCKROOM'
FROM branches AS b
WHERE b.code = 'MAIN'
ON CONFLICT (business_id, branch_id, code) WHERE code IS NOT NULL DO NOTHING;

-- Fail and roll back the complete migration if a business lacks its defaults.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM businesses AS b
        WHERE (
            SELECT COUNT(*)
            FROM branches AS br
            WHERE br.business_id = b.id
              AND br.code = 'MAIN'
        ) <> 1
        OR NOT EXISTS (
            SELECT 1
            FROM branches AS br
            WHERE br.business_id = b.id
              AND br.code = 'MAIN'
              AND br.name = 'Main Branch'
              AND (
                  SELECT COUNT(*)
                  FROM stock_locations AS sl
                  WHERE sl.business_id = br.business_id
                    AND sl.branch_id = br.id
                    AND sl.code = 'MAIN-STOCKROOM'
              ) = 1
              AND EXISTS (
                  SELECT 1
                  FROM stock_locations AS sl
                  WHERE sl.business_id = br.business_id
                    AND sl.branch_id = br.id
                    AND sl.code = 'MAIN-STOCKROOM'
                    AND sl.name = 'Main Stockroom'
                    AND sl.location_type = 'warehouse'
              )
        )
    ) THEN
        RAISE EXCEPTION 'Migration 002 validation failed: every business must have exactly one correctly named MAIN branch and exactly one correctly named warehouse MAIN-STOCKROOM location under it';
    END IF;
END
$$;

-- Result set for deployment logs / manual verification: every business should
-- report at least one default branch and default stock location.
SELECT
    b.id AS business_id,
    COUNT(DISTINCT br.id) FILTER (WHERE br.code = 'MAIN') AS main_branch_count,
    COUNT(DISTINCT sl.id) FILTER (WHERE sl.code = 'MAIN-STOCKROOM') AS main_stockroom_count
FROM businesses AS b
LEFT JOIN branches AS br
  ON br.business_id = b.id AND br.code = 'MAIN'
LEFT JOIN stock_locations AS sl
  ON sl.business_id = br.business_id
 AND sl.branch_id = br.id
 AND sl.code = 'MAIN-STOCKROOM'
GROUP BY b.id
ORDER BY b.id;

COMMIT;
