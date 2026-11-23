
import express from "express";
import productRoutes from "./routes/productRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";

const app = express();

app.use(express.json());

app.get("/api", (req, res) => {
  res.json({
    name: "StockFlow API",
    version: "1.0.0",
    message: "Welcome to StockFlow"
  });
});

app.get("/api/health", async (req, res) => {
  res.json({
    success: true,
    message: "StockFlow API is running"
  });
});

app.use("/api/products", productRoutes);
app.use("/api/inventory", inventoryRoutes);

export default app;
