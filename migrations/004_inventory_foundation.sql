WITH ledger AS (
    SELECT
        business_id,
        stock_location_id,
        variant_id,
        SUM(quantity_delta) AS ledger_quantity
    FROM inventory_movements
    GROUP BY business_id, stock_location_id, variant_id
)
SELECT
    COALESCE(l.business_id, b.business_id) AS business_id,
    COALESCE(l.stock_location_id, b.stock_location_id) AS stock_location_id,
    COALESCE(l.variant_id, b.variant_id) AS variant_id,
    l.ledger_quantity,
    b.quantity_on_hand AS projected_quantity,
    COALESCE(l.ledger_quantity, 0) - COALESCE(b.quantity_on_hand, 0) AS difference,
    CASE
        WHEN l.business_id IS NULL THEN 'unexpected_balance_row'
        WHEN b.business_id IS NULL THEN 'missing_balance_row'
        ELSE 'quantity_mismatch'
    END AS discrepancy
FROM ledger AS l
FULL OUTER JOIN inventory_balances AS b
  ON b.business_id = l.business_id
 AND b.stock_location_id = l.stock_location_id
 AND b.variant_id = l.variant_id
WHERE l.business_id IS NULL
   OR b.business_id IS NULL
   OR l.ledger_quantity IS DISTINCT FROM b.quantity_on_hand;