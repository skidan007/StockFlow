
import express from "express";

import {
  stockIn,
  stockOut,
  getInventoryBalances,
  getInventoryMovements,
  getLowStock
} from "../controllers/inventoryController.js";

const router = express.Router();

// Record incoming stock
router.post("/stock-in", stockIn);

// Record outgoing stock / sales
router.post("/stock-out", stockOut);

// View current inventory balances
router.get("/balances", getInventoryBalances);

// View inventory movement history
router.get("/movements", getInventoryMovements);

// View low-stock alerts
router.get("/low-stock", getLowStock);

export default router;
