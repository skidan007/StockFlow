import express from "express";
import pool from "./db.js";

const app = express();

const PORT = 5000;

app.use(express.json());

app.get("/api", (req, res) => {
  res.json({
    name: "StockFlow API",
    version: "1.0.0",
    message: "Welcome to StockFlow",
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      success: true,
      message: "StockFlow API is running",
      databaseTime: result.rows[0].now,
    });
  } catch (error) {
    console.error("DATABASE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

app.get("/api/products", async (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`StockFlow API running on port ${PORT}`);
});
