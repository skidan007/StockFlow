CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(150) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    business_id UUID NOT NULL
        REFERENCES businesses(id)
        ON DELETE CASCADE,

    name VARCHAR(150) NOT NULL,

    sku VARCHAR(100),

    base_unit VARCHAR(50) NOT NULL,

    units_per_package INTEGER NOT NULL DEFAULT 1
        CHECK (units_per_package > 0),

    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (cost_price >= 0),

    selling_price NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (selling_price >= 0),

    low_stock_threshold INTEGER NOT NULL DEFAULT 0
        CHECK (low_stock_threshold >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);