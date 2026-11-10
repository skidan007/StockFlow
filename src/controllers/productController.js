import pool from "../db.js";

export const getProducts = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );

    res.json({
      success: true,
      products: result.rows
    });
  } catch (error) {
    console.error("DATABASE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch products"
    });
  }
};

export const createProduct = async (req, res) => {
  try {
    const {
      businessId,
      name,
      sku,
      baseUnit,
      unitsPerPackage,
      costPrice,
      sellingPrice,
      lowStockThreshold
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO products (
        business_id,
        name,
        sku,
        base_unit,
        units_per_package,
        cost_price,
        selling_price,
        low_stock_threshold
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        businessId,
        name,
        sku,
        baseUnit,
        unitsPerPackage,
        costPrice,
        sellingPrice,
        lowStockThreshold
      ]
    );

    res.status(201).json({
      success: true,
      product: result.rows[0]
    });
  } catch (error) {
    console.error("DATABASE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create product"
    });
  }
};