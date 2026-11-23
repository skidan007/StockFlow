
import pool from "../db.js";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// STOCK IN
export const stockIn = async (req, res) => {
  const {
    businessId,
    stockLocationId,
    variantId,
    cartonsReceived,
    idempotencyKey,
    notes
  } = req.body;

  // 1. Validate required fields
  if (
    !businessId ||
    !stockLocationId ||
    !variantId ||
    !idempotencyKey ||
    cartonsReceived === undefined
  ) {
    return res.status(400).json({
      success: false,
      message: "All required fields must be provided."
    });
  }

  // 2. Validate UUIDs
  if (
    typeof businessId !== "string" ||
    typeof stockLocationId !== "string" ||
    typeof variantId !== "string" ||
    !uuidRegex.test(businessId) ||
    !uuidRegex.test(stockLocationId) ||
    !uuidRegex.test(variantId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Business ID, stock location ID and variant ID must be valid UUIDs."
    });
  }

  // 3. Validate idempotency key
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() === "" ||
    idempotencyKey.length > 200
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid idempotency key is required (maximum 200 characters)."
    });
  }

  // 4. Validate carton quantity
  const cartons = Number(cartonsReceived);

  if (!Number.isSafeInteger(cartons) || cartons <= 0) {
    return res.status(400).json({
      success: false,
      message: "Cartons received must be a positive whole number."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    // 5. Get a dedicated database connection
    client = await pool.connect();

    // 6. Start transaction
    await client.query("BEGIN");
    transactionStarted = true;

    // 7. Verify business, location and variant
    const variantResult = await client.query(
      `
      SELECT
        pv.id,
        pv.business_id,
        pv.units_per_package,
        pv.base_unit
      FROM product_variants pv
      JOIN stock_locations sl
        ON sl.business_id = pv.business_id
      WHERE pv.id = $1
        AND pv.business_id = $2
        AND sl.id = $3
        AND pv.is_active = TRUE
      `,
      [variantId, businessId, stockLocationId]
    );

    if (variantResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Product variant or stock location not found for this business."
      });
    }

    const variant = variantResult.rows[0];

    // 8. Calculate quantity in base units
    const quantityReceived =
      cartons * variant.units_per_package;

    if (
      !Number.isSafeInteger(quantityReceived) ||
      quantityReceived > 99999999999
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        success: false,
        message: "Calculated stock quantity is too large."
      });
    }

    // 9. Lock requests with the same business and idempotency key
    await client.query(
      `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )
      `,
      [`${businessId}:${idempotencyKey.trim()}`]
    );

    // 10. Check for an existing movement
    const existingMovement = await client.query(
      `
      SELECT *
      FROM inventory_movements
      WHERE business_id = $1
        AND idempotency_key = $2
      `,
      [businessId, idempotencyKey.trim()]
    );

    if (existingMovement.rows.length > 0) {
      const existing = existingMovement.rows[0];

      const matches =
        existing.stock_location_id === stockLocationId &&
        existing.variant_id === variantId &&
        existing.movement_type === "purchase_receipt" &&
        Number(existing.quantity_delta) === quantityReceived;

      await client.query("ROLLBACK");
      transactionStarted = false;

      if (!matches) {
        return res.status(409).json({
          success: false,
          message: "This idempotency key has already been used for a different stock movement."
        });
      }

      return res.status(200).json({
        success: true,
        message: "This stock receipt was already processed.",
        movement: existing,
        duplicate: true
      });
    }

    // 11. Create balance row if it doesn't exist
    await client.query(
      `
      INSERT INTO inventory_balances (
        business_id,
        stock_location_id,
        variant_id
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (
        business_id,
        stock_location_id,
        variant_id
      ) DO NOTHING
      `,
      [businessId, stockLocationId, variantId]
    );

    // 12. Lock the balance row
    await client.query(
      `
      SELECT quantity_on_hand
      FROM inventory_balances
      WHERE business_id = $1
        AND stock_location_id = $2
        AND variant_id = $3
      FOR UPDATE
      `,
      [businessId, stockLocationId, variantId]
    );

    // 13. Record stock movement
    const movementResult = await client.query(
      `
      INSERT INTO inventory_movements (
        business_id,
        stock_location_id,
        variant_id,
        movement_type,
        quantity_delta,
        idempotency_key,
        notes
      )
      VALUES ($1, $2, $3, 'purchase_receipt', $4, $5, $6)
      RETURNING *
      `,
      [
        businessId,
        stockLocationId,
        variantId,
        quantityReceived,
        idempotencyKey.trim(),
        notes || null
      ]
    );

    // 14. Update inventory balance
    const updatedBalance = await client.query(
      `
      UPDATE inventory_balances
      SET
        quantity_on_hand = quantity_on_hand + $4,
        updated_at = NOW()
      WHERE business_id = $1
        AND stock_location_id = $2
        AND variant_id = $3
      RETURNING *
      `,
      [
        businessId,
        stockLocationId,
        variantId,
        quantityReceived
      ]
    );

    // 15. Commit transaction
    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Stock received successfully.",
      movement: movementResult.rows[0],
      balance: updatedBalance.rows[0],
      cartonsReceived: cartons,
      baseUnitsReceived: quantityReceived,
      baseUnit: variant.base_unit
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("STOCK-IN ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record stock receipt."
    });

  } finally {
    if (client) {
      client.release();
    }
  }
};


// STOCK OUT
export const stockOut = async (req, res) => {
  const {
    businessId,
    stockLocationId,
    variantId,
    quantitySold,
    idempotencyKey,
    notes
  } = req.body;

  // 1. Validate required fields
  if (
    !businessId ||
    !stockLocationId ||
    !variantId ||
    !idempotencyKey ||
    quantitySold === undefined
  ) {
    return res.status(400).json({
      success: false,
      message: "All required fields must be provided."
    });
  }

  // 2. Validate UUIDs
  if (
    typeof businessId !== "string" ||
    typeof stockLocationId !== "string" ||
    typeof variantId !== "string" ||
    !uuidRegex.test(businessId) ||
    !uuidRegex.test(stockLocationId) ||
    !uuidRegex.test(variantId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Business ID, stock location ID and variant ID must be valid UUIDs."
    });
  }

  // 3. Validate idempotency key
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim() === "" ||
    idempotencyKey.length > 200
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid idempotency key is required."
    });
  }

  // 4. Validate quantity sold
  const quantity = Number(quantitySold);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 99999999999.999 ||
    Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001
  ) {
    return res.status(400).json({
      success: false,
      message: "Quantity sold must be positive and have no more than 3 decimal places."
    });
  }

  let client;
  let transactionStarted = false;

  try {
    // 5. Get a dedicated database connection
    client = await pool.connect();

    // 6. Start transaction
    await client.query("BEGIN");
    transactionStarted = true;

    // 7. Serialize requests using the same idempotency key
    await client.query(
      `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1, 0)
      )
      `,
      [`${businessId}:${idempotencyKey.trim()}`]
    );

    // 8. Check for an existing movement
    const existingMovement = await client.query(
      `
      SELECT *
      FROM inventory_movements
      WHERE business_id = $1
        AND idempotency_key = $2
      `,
      [businessId, idempotencyKey.trim()]
    );

    if (existingMovement.rows.length > 0) {
      const existing = existingMovement.rows[0];

      const matches =
        existing.stock_location_id === stockLocationId &&
        existing.variant_id === variantId &&
        existing.movement_type === "sale" &&
        Number(existing.quantity_delta) === -quantity;

      await client.query("ROLLBACK");
      transactionStarted = false;

      if (!matches) {
        return res.status(409).json({
          success: false,
          message: "This idempotency key has already been used for a different stock movement."
        });
      }

      return res.status(200).json({
        success: true,
        message: "This sale was already processed.",
        movement: existing,
        duplicate: true
      });
    }

    // 9. Verify business, location and active variant
    const variantResult = await client.query(
      `
      SELECT
        pv.id,
        pv.business_id,
        pv.base_unit
      FROM product_variants pv
      JOIN stock_locations sl
        ON sl.business_id = pv.business_id
      WHERE pv.id = $1
        AND pv.business_id = $2
        AND sl.id = $3
        AND pv.is_active = TRUE
      `,
      [variantId, businessId, stockLocationId]
    );

    if (variantResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        success: false,
        message: "Product variant or stock location not found for this business."
      });
    }

    const variant = variantResult.rows[0];

    // 10. Ensure a balance row exists
    await client.query(
      `
      INSERT INTO inventory_balances (
        business_id,
        stock_location_id,
        variant_id
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (
        business_id,
        stock_location_id,
        variant_id
      ) DO NOTHING
      `,
      [businessId, stockLocationId, variantId]
    );

    // 11. Lock the balance row
    const balanceResult = await client.query(
      `
      SELECT quantity_on_hand
      FROM inventory_balances
      WHERE business_id = $1
        AND stock_location_id = $2
        AND variant_id = $3
      FOR UPDATE
      `,
      [businessId, stockLocationId, variantId]
    );

    const availableStock = Number(
      balanceResult.rows[0].quantity_on_hand
    );

    // 12. Prevent selling more stock than available
    if (availableStock < quantity) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        success: false,
        message: "Insufficient stock available.",
        availableStock,
        requestedQuantity: quantity,
        baseUnit: variant.base_unit
      });
    }

    // 13. Record the sale as a negative movement
    const movementResult = await client.query(
      `
      INSERT INTO inventory_movements (
        business_id,
        stock_location_id,
        variant_id,
        movement_type,
        quantity_delta,
        idempotency_key,
        notes
      )
      VALUES ($1, $2, $3, 'sale', $4, $5, $6)
      RETURNING *
      `,
      [
        businessId,
        stockLocationId,
        variantId,
        -quantity,
        idempotencyKey.trim(),
        notes || null
      ]
    );

    // 14. Deduct stock from the balance
    const updatedBalance = await client.query(
      `
      UPDATE inventory_balances
      SET
        quantity_on_hand = quantity_on_hand - $4,
        updated_at = NOW()
      WHERE business_id = $1
        AND stock_location_id = $2
        AND variant_id = $3
        AND quantity_on_hand >= $4
      RETURNING *
      `,
      [
        businessId,
        stockLocationId,
        variantId,
        quantity
      ]
    );

    // 15. Safety check
    if (updatedBalance.rows.length === 0) {
      throw new Error("Stock balance could not be safely updated.");
    }

    // 16. Commit transaction
    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Sale recorded and stock deducted successfully.",
      movement: movementResult.rows[0],
      balance: updatedBalance.rows[0],
      quantitySold: quantity,
      remainingStock: Number(
        updatedBalance.rows[0].quantity_on_hand
      ),
      baseUnit: variant.base_unit
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("ROLLBACK ERROR:", rollbackError);
      }
    }

    console.error("STOCK-OUT ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record stock sale."
    });

  } finally {
    if (client) {
      client.release();
    }
  }
};



// GET INVENTORY BALANCES
export const getInventoryBalances = async (req, res) => {
  const { businessId, stockLocationId } = req.query;

  // 1. Validate business ID
  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid businessId UUID is required."
    });
  }

  // 2. Validate optional stock location ID
  if (
    stockLocationId !== undefined &&
    (
      typeof stockLocationId !== "string" ||
      !uuidRegex.test(stockLocationId)
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Stock location ID must be a valid UUID."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        pv.id AS variant_id,
        pv.variant_name,
        pv.sku,
        pv.base_unit,
        pv.units_per_package,
        sl.id AS stock_location_id,
        sl.name AS stock_location_name,
        COALESCE(ib.quantity_on_hand, 0) AS quantity_on_hand,
        pv.low_stock_threshold,
        CASE
          WHEN COALESCE(ib.quantity_on_hand, 0)
               <= pv.low_stock_threshold
          THEN TRUE
          ELSE FALSE
        END AS is_low_stock
      FROM product_variants pv
      JOIN products p
        ON p.id = pv.product_id
       AND p.business_id = pv.business_id
      JOIN stock_locations sl
        ON sl.business_id = pv.business_id
      LEFT JOIN inventory_balances ib
        ON ib.business_id = pv.business_id
       AND ib.stock_location_id = sl.id
       AND ib.variant_id = pv.id
      WHERE pv.business_id = $1
        AND pv.is_active = TRUE
        AND ($2::uuid IS NULL OR sl.id = $2)
      ORDER BY p.name, pv.variant_name, sl.name
      `,
      [businessId, stockLocationId || null]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      balances: result.rows
    });

  } catch (error) {
    console.error("GET INVENTORY BALANCES ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inventory balances."
    });
  }
};


// GET INVENTORY MOVEMENT HISTORY
export const getInventoryMovements = async (req, res) => {
  const {
    businessId,
    stockLocationId,
    variantId,
    movementType
  } = req.query;

  // 1. Validate business ID
  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid businessId UUID is required."
    });
  }

  // 2. Validate optional UUID filters
  if (
    stockLocationId !== undefined &&
    (
      typeof stockLocationId !== "string" ||
      !uuidRegex.test(stockLocationId)
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Stock location ID must be a valid UUID."
    });
  }

  if (
    variantId !== undefined &&
    (
      typeof variantId !== "string" ||
      !uuidRegex.test(variantId)
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Variant ID must be a valid UUID."
    });
  }

  // 3. Validate pagination
  const limit = req.query.limit === undefined
    ? 50
    : Number(req.query.limit);

  const offset = req.query.offset === undefined
    ? 0
    : Number(req.query.offset);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Limit must be 1–100 and offset must be a non-negative whole number."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        im.id,
        im.business_id,
        im.stock_location_id,
        sl.name AS stock_location_name,
        im.variant_id,
        p.name AS product_name,
        pv.variant_name,
        pv.base_unit,
        im.movement_type,
        im.quantity_delta,
        im.occurred_at,
        im.created_at,
        im.reference_type,
        im.reference_id,
        im.notes,
        im.idempotency_key,
        im.reversal_of_movement_id
      FROM inventory_movements im
      JOIN stock_locations sl
        ON sl.business_id = im.business_id
       AND sl.id = im.stock_location_id
      JOIN product_variants pv
        ON pv.business_id = im.business_id
       AND pv.id = im.variant_id
      JOIN products p
        ON p.business_id = pv.business_id
       AND p.id = pv.product_id
      WHERE im.business_id = $1
        AND ($2::uuid IS NULL OR im.stock_location_id = $2)
        AND ($3::uuid IS NULL OR im.variant_id = $3)
        AND ($4::varchar IS NULL OR im.movement_type = $4)
      ORDER BY im.occurred_at DESC, im.created_at DESC
      LIMIT $5
      OFFSET $6
      `,
      [
        businessId,
        stockLocationId || null,
        variantId || null,
        movementType || null,
        limit,
        offset
      ]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      limit,
      offset,
      movements: result.rows
    });

  } catch (error) {
    console.error("GET INVENTORY MOVEMENTS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve inventory movements."
    });
  }
};


// GET LOW STOCK ALERTS
export const getLowStock = async (req, res) => {
  const { businessId, stockLocationId } = req.query;

  // 1. Validate business ID
  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid businessId UUID is required."
    });
  }

  // 2. Validate optional stock location ID
  if (
    stockLocationId !== undefined &&
    (
      typeof stockLocationId !== "string" ||
      !uuidRegex.test(stockLocationId)
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Stock location ID must be a valid UUID."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        pv.id AS variant_id,
        pv.variant_name,
        pv.sku,
        pv.base_unit,
        sl.id AS stock_location_id,
        sl.name AS stock_location_name,
        COALESCE(ib.quantity_on_hand, 0) AS quantity_on_hand,
        pv.low_stock_threshold,
        pv.low_stock_threshold -
          COALESCE(ib.quantity_on_hand, 0) AS quantity_below_threshold
      FROM product_variants pv
      JOIN products p
        ON p.id = pv.product_id
       AND p.business_id = pv.business_id
      JOIN stock_locations sl
        ON sl.business_id = pv.business_id
      LEFT JOIN inventory_balances ib
        ON ib.business_id = pv.business_id
       AND ib.stock_location_id = sl.id
       AND ib.variant_id = pv.id
      WHERE pv.business_id = $1
        AND pv.is_active = TRUE
        AND ($2::uuid IS NULL OR sl.id = $2)
        AND COALESCE(ib.quantity_on_hand, 0)
            <= pv.low_stock_threshold
      ORDER BY quantity_below_threshold DESC, p.name
      `,
      [businessId, stockLocationId || null]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      lowStockItems: result.rows
    });

  } catch (error) {
    console.error("GET LOW STOCK ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve low-stock items."
    });
  }
};
