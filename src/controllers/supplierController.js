
import pool from "../db.js";

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalString = (value) =>
  value === undefined || value === null || typeof value === "string";

// CREATE SUPPLIER
export const createSupplier = async (req, res) => {
  const {
    businessId,
    supplierName,
    contactPerson,
    phone,
    email,
    address,
    notes
  } = req.body;

  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid businessId UUID is required."
    });
  }

  if (
    typeof supplierName !== "string" ||
    supplierName.trim() === "" ||
    supplierName.trim().length > 150
  ) {
    return res.status(400).json({
      success: false,
      message: "Supplier name is required and must not exceed 150 characters."
    });
  }

  if (
    !optionalString(contactPerson) ||
    !optionalString(phone) ||
    !optionalString(email) ||
    !optionalString(address) ||
    !optionalString(notes)
  ) {
    return res.status(400).json({
      success: false,
      message: "Supplier details must be valid text values."
    });
  }

  if (contactPerson && contactPerson.trim().length > 150) {
    return res.status(400).json({
      success: false,
      message: "Contact person must not exceed 150 characters."
    });
  }

  if (phone && phone.trim().length > 30) {
    return res.status(400).json({
      success: false,
      message: "Phone number must not exceed 30 characters."
    });
  }

  if (email && email.trim().length > 255) {
    return res.status(400).json({
      success: false,
      message: "Email must not exceed 255 characters."
    });
  }

  if (
    email &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid email address."
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO suppliers (
        business_id,
        supplier_name,
        contact_person,
        phone,
        email,
        address,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        businessId,
        supplierName.trim(),
        contactPerson?.trim() || null,
        phone?.trim() || null,
        email?.trim().toLowerCase() || null,
        address?.trim() || null,
        notes?.trim() || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Supplier registered successfully.",
      supplier: result.rows[0]
    });

  } catch (error) {
    console.error("CREATE SUPPLIER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to register supplier."
    });
  }
};


// GET ALL SUPPLIERS
export const getSuppliers = async (req, res) => {
  const { businessId, search, isActive } = req.query;

  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid businessId UUID is required."
    });
  }

  if (search !== undefined && typeof search !== "string") {
    return res.status(400).json({
      success: false,
      message: "Search must be text."
    });
  }

  if (
    isActive !== undefined &&
    !["true", "false"].includes(isActive)
  ) {
    return res.status(400).json({
      success: false,
      message: "isActive must be true or false."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM suppliers
      WHERE business_id = $1
        AND ($2::boolean IS NULL OR is_active = $2)
        AND (
          $3::text IS NULL
          OR supplier_name ILIKE '%' || $3 || '%'
          OR contact_person ILIKE '%' || $3 || '%'
        )
      ORDER BY created_at DESC
      `,
      [
        businessId,
        isActive === undefined ? null : isActive === "true",
        search?.trim() || null
      ]
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      suppliers: result.rows
    });

  } catch (error) {
    console.error("GET SUPPLIERS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve suppliers."
    });
  }
};


// GET ONE SUPPLIER
export const getSupplierById = async (req, res) => {
  const { businessId } = req.query;
  const { id } = req.params;

  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId) ||
    !uuidRegex.test(id)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid businessId and supplier ID UUIDs are required."
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM suppliers
      WHERE business_id = $1
        AND id = $2
      `,
      [businessId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found."
      });
    }

    return res.status(200).json({
      success: true,
      supplier: result.rows[0]
    });

  } catch (error) {
    console.error("GET SUPPLIER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve supplier."
    });
  }
};


// UPDATE SUPPLIER
export const updateSupplier = async (req, res) => {
  const { businessId } = req.body;
  const { id } = req.params;

  const allowedFields = {
    supplierName: "supplier_name",
    contactPerson: "contact_person",
    phone: "phone",
    email: "email",
    address: "address",
    notes: "notes"
  };

  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId) ||
    !uuidRegex.test(id)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid businessId and supplier ID UUIDs are required."
    });
  }

  const entries = Object.entries(allowedFields)
    .filter(([key]) => Object.hasOwn(req.body, key));

  if (entries.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Provide at least one supplier field to update."
    });
  }

  for (const [key, column] of entries) {
    const value = req.body[key];

    if (value !== null && typeof value !== "string") {
      return res.status(400).json({
        success: false,
        message: `${key} must be text.`
      });
    }

    if (key === "supplierName" && (!value || value.trim() === "")) {
      return res.status(400).json({
        success: false,
        message: "Supplier name cannot be empty."
      });
    }

    const maximumLengths = {
      supplierName: 150,
      contactPerson: 150,
      phone: 30,
      email: 255
    };

    if (
      value !== null &&
      maximumLengths[key] &&
      value.length > maximumLengths[key]
    ) {
      return res.status(400).json({
        success: false,
        message: `${key} exceeds its maximum length.`
      });
    }

    if (
      key === "email" &&
      value !== null &&
      value.trim() !== "" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address."
      });
    }
  }

  try {
    const values = entries.map(([key]) => {
      const value = req.body[key];

      if (value === null || value.trim() === "") {
        return null;
      }

      return key === "email"
        ? value.trim().toLowerCase()
        : value.trim();
    });

    const setClause = entries
      .map(([key], index) =>
        `${allowedFields[key]} = $${index + 3}`
      )
      .join(", ");

    const result = await pool.query(
      `
      UPDATE suppliers
      SET ${setClause},
          updated_at = NOW()
      WHERE business_id = $1
        AND id = $2
      RETURNING *
      `,
      [businessId, id, ...values]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Supplier updated successfully.",
      supplier: result.rows[0]
    });

  } catch (error) {
    console.error("UPDATE SUPPLIER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update supplier."
    });
  }
};


// DEACTIVATE SUPPLIER
export const deactivateSupplier = async (req, res) => {
  const { businessId } = req.body;
  const { id } = req.params;

  if (
    typeof businessId !== "string" ||
    !uuidRegex.test(businessId) ||
    !uuidRegex.test(id)
  ) {
    return res.status(400).json({
      success: false,
      message: "Valid businessId and supplier ID UUIDs are required."
    });
  }

  try {
    const result = await pool.query(
      `
      UPDATE suppliers
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE business_id = $1
        AND id = $2
      RETURNING *
      `,
      [businessId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Supplier deactivated successfully.",
      supplier: result.rows[0]
    });

  } catch (error) {
    console.error("DEACTIVATE SUPPLIER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to deactivate supplier."
    });
  }
};
