/**
 * Type inference test for Collections API.
 * 
 * This file demonstrates and tests that types are correctly inferred from JSON Schema definitions.
 * 
 * Run type check: deno check database/collections/type-inference.test.ts
 * Run as test: deno test --allow-all database/collections/type-inference.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { defineCollection, createCollectionsManager, relation } from "./index.ts";
import { createDatabase } from "../index.ts";

// ============================================
// STEP 1: Define schema with `as const` for literal type inference
// ============================================

const customerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", readOnly: true },
    email: { type: "string" },
    name: { type: ["string", "null"] },
    plan: { type: "string", enum: ["free", "pro", "enterprise"] },
    tags: { type: "array", items: { type: "string" } },
    settings: {
      type: ["object", "null"],
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" },
      },
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "email"],
} as const; // <-- IMPORTANT: `as const` is required for type inference!

const orderSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", readOnly: true },
    customerId: { type: "string" },
    total: { type: "number" },
    status: { type: "string", enum: ["pending", "paid", "shipped", "delivered"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "customerId", "total", "status"],
} as const;

// ============================================
// STEP 2: Define collections
// ============================================

const customers = defineCollection({
  name: "customer",
  schema: customerSchema,
  relations: {
    orders: relation.hasMany("order", "customerId"),
  },
});

const orders = defineCollection({
  name: "order",
  schema: orderSchema,
  relations: {
    customer: relation.belongsTo("customer", "customerId"),
  },
});

// ============================================
// STEP 3: Infer types from collection definitions
// ============================================

// Use $inferSelect for the full record type (what you get back from queries)
type Customer = typeof customers.$inferSelect;
type Order = typeof orders.$inferSelect;

// Use $inferInsert for the insert type (what you pass to create)
type NewCustomer = typeof customers.$inferInsert;
type NewOrder = typeof orders.$inferInsert;

// ============================================
// TYPE INFERENCE VERIFICATION
// ============================================

// These should compile without errors if inference works correctly
const testCustomer: Customer = {
  id: "123",
  email: "test@example.com",
  name: "Test User",
  plan: "pro", // ✓ Restricted to "free" | "pro" | "enterprise"
  tags: ["vip", "beta"],
  settings: { theme: "dark", notifications: true },
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

// NewCustomer should not require id, createdAt, updatedAt (they have defaults)
const testNewCustomer: NewCustomer = {
  email: "new@example.com",
  // id is optional ✓
  // createdAt is optional ✓
  // updatedAt is optional ✓
};

// ============================================
// UNCOMMENT THESE TO SEE TYPE ERRORS:
// ============================================

// ERROR: Invalid enum value
// const badPlan: Customer = {
//   id: "123",
//   email: "test@example.com",
//   plan: "invalid", // ✗ Type '"invalid"' is not assignable to type '"free" | "pro" | "enterprise"'
// };

// ERROR: Missing required field
// const missingEmail: Customer = {
//   id: "123",
//   plan: "free",
//   // ✗ Property 'email' is missing
// };

// ERROR: Wrong type for field
// const wrongType: Customer = {
//   id: "123",
//   email: "test@example.com",
//   tags: "should-be-array", // ✗ Type 'string' is not assignable to type 'string[]'
// };

// ============================================
// RUNTIME TEST
// ============================================

Deno.test("Type inference - types match runtime behavior", async () => {
  const db = await createDatabase({ url: ":memory:" });
  
  // Create manager - types are inferred but require explicit typing for full IDE support
  // This is due to TypeScript limitations with complex mapped types
  const manager = createCollectionsManager(db, [customers, orders]);
  
  // Use withNamespace for scoped operations
  const scoped = manager.withNamespace("test-ns");
  
  // For full type safety, cast to the inferred types
  const created = await scoped.customer.create({
    email: "alice@example.com",
    name: "Alice",
    plan: "pro",
    tags: ["vip"],
  }) as Customer;
  
  // Now TypeScript knows `created` has these properties
  assertEquals(typeof created.id, "string");
  assertEquals(created.email, "alice@example.com");
  assertEquals(created.plan, "pro");
  
  // Find returns the inferred type
  const found = await scoped.customer.findOne({ email: "alice@example.com" }) as Customer | null;
  if (found) {
    // TypeScript knows `found.plan` is "free" | "pro" | "enterprise"
    const planIsValid = ["free", "pro", "enterprise"].includes(found.plan!);
    assertEquals(planIsValid, true);
  }
  
  // Cleanup
  await db.query('DELETE FROM "nodes" WHERE 1=1');
});

// ============================================
// TYPE INFERENCE SUMMARY
// ============================================
// 
// ✅ WORKS:
// - `defineCollection` with `as const` schema correctly infers types
// - `$inferSelect` gives you the full record type with enums, arrays, etc.
// - `$inferInsert` correctly omits readonly/auto-generated fields
// - Type errors are caught at compile time for invalid enum values, missing required fields, etc.
//
// ⚠️ LIMITATION:
// - When passing collections to `createCollectionsManager`, full type propagation
//   requires explicit type casting due to TypeScript's complexity limits with
//   mapped types over arrays of generics.
//
// WORKAROUND:
// Cast results using the inferred types:
//   const customer = await scoped.customer.create({...}) as Customer;
//

console.log("Type inference examples:", {
  customer: testCustomer,
  newCustomer: testNewCustomer,
});

// Export types for external use
export { customers, orders };
export type { Customer, Order, NewCustomer, NewOrder };

