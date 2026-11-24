
import express from "express";

import {
  createSupplier,
  getSuppliers,
  getSupplierById,
  updateSupplier,
  deactivateSupplier
} from "../controllers/supplierController.js";

const router = express.Router();

// Register a supplier
router.post("/", createSupplier);

// Get all suppliers
router.get("/", getSuppliers);

// Get one supplier
router.get("/:id", getSupplierById);

// Update supplier details
router.put("/:id", updateSupplier);

// Deactivate supplier
router.patch("/:id/deactivate", deactivateSupplier);

export default router;
