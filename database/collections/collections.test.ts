/**
 * Tests for the Collections API.
 * 
 * Run with: deno test --allow-all database/collections/collections.test.ts
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createDatabase } from "../index.ts";
import { defineCollection, createCollectionsManager, relation, index } from "./index.ts";
import type { ScopedCollectionCrud, CollectionCrud } from "./types.ts";
import { ulid } from "ulid";

// ============================================
// TEST TYPES
// ============================================

interface Customer {
  id: string;
  email: string;
  name?: string | null;
  plan?: string;
  tags?: string[];
  settings?: { theme?: string; notifications?: boolean } | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface Order {
  id: string;
  customerId: string;
  total: number;
  status: string;
  customer?: Customer;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================
// TEST SCHEMAS
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
    metadata: { type: ["object", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "email"],
} as const;

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
// TEST COLLECTIONS
// ============================================

const customers = defineCollection({
  name: "customer",
  schema: customerSchema,
  keys: [{ property: "id" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  defaults: {
    id: () => ulid(),
    plan: "free",
    tags: () => [],
  },
  indexes: [
    "email",
    ["plan", "createdAt"],
    index.gin("tags"),
  ],
  relations: {
    orders: relation.hasMany("order", "customerId"),
  },
});

const orders = defineCollection({
  name: "order",
  schema: orderSchema,
  keys: [{ property: "id" }],
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  defaults: {
    id: () => ulid(),
    status: "pending",
  },
  indexes: ["customerId", "status"],
  relations: {
    customer: relation.belongsTo("customer", "customerId"),
  },
});

// ============================================
// TEST HELPER
// ============================================

interface TestManager {
  customer: CollectionCrud<Customer, Partial<Customer>>;
  order: CollectionCrud<Order, Partial<Order>>;
  withNamespace: (ns: string) => {
    customer: ScopedCollectionCrud<Customer, Partial<Customer>>;
    order: ScopedCollectionCrud<Order, Partial<Order>>;
  };
  getCollectionNames: () => string[];
  hasCollection: (name: string) => boolean;
}

async function withTestDb(
  fn: (db: Awaited<ReturnType<typeof createDatabase>>, manager: TestManager) => Promise<void>
) {
  const db = await createDatabase({ url: ":memory:" });
  const manager = createCollectionsManager(db, [customers, orders]) as unknown as TestManager;
  try {
    await fn(db, manager);
  } finally {
    // Cleanup
    try {
      await db.query('DELETE FROM "nodes" WHERE 1=1');
      await db.query('DELETE FROM "edges" WHERE 1=1');
    } catch {
      // Ignore cleanup errors
    }
  }
}

const TEST_NAMESPACE = "test:collections";

// ============================================
// TESTS
// ============================================

Deno.test("defineCollection - creates collection with defaults", () => {
  const collection = defineCollection({
    name: "test",
    schema: { type: "object", properties: { id: { type: "string" } } },
  });

  assertEquals(collection.name, "test");
  assertExists(collection.keys);
  assertExists(collection.timestamps);
  assertExists(collection.defaults);
  assertExists(collection.indexes);
});

Deno.test("defineCollection - throws on missing name", () => {
  try {
    defineCollection({
      name: "",
      schema: { type: "object" },
    });
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals((e as Error).message, "Collection name is required");
  }
});

Deno.test("createCollectionsManager - creates manager with collections", async () => {
  await withTestDb(async (_db, manager) => {
    assertExists(manager.customer);
    assertExists(manager.order);
    assertExists(manager.withNamespace);
    assertExists(manager.getCollectionNames);
    assertExists(manager.hasCollection);

    assertEquals(manager.getCollectionNames().sort(), ["customer", "order"]);
    assertEquals(manager.hasCollection("customer"), true);
    assertEquals(manager.hasCollection("nonexistent"), false);
  });
});

Deno.test("CRUD - create single record", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const customer = await scoped.customer.create({
      email: "alice@example.com",
      name: "Alice",
      plan: "pro",
    });

    assertExists(customer.id);
    assertEquals(customer.email, "alice@example.com");
    assertEquals(customer.name, "Alice");
    assertEquals(customer.plan, "pro");
    assertExists(customer.createdAt);
    assertExists(customer.updatedAt);
  });
});

Deno.test("CRUD - create with defaults applied", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const customer = await scoped.customer.create({
      email: "bob@example.com",
    });

    assertExists(customer.id);
    assertEquals(customer.plan, "free"); // Default
    assertEquals(customer.tags, []); // Default
  });
});

Deno.test("CRUD - createMany", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const customers = await scoped.customer.createMany([
      { email: "user1@example.com", plan: "free" },
      { email: "user2@example.com", plan: "pro" },
      { email: "user3@example.com", plan: "enterprise" },
    ]);

    assertEquals(customers.length, 3);
    assertEquals(customers[0].email, "user1@example.com");
    assertEquals(customers[1].email, "user2@example.com");
    assertEquals(customers[2].email, "user3@example.com");
  });
});

Deno.test("CRUD - findById", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const created = await scoped.customer.create({
      email: "findme@example.com",
      name: "Find Me",
    });

    const found = await scoped.customer.findById(created.id);

    assertExists(found);
    assertEquals(found!.id, created.id);
    assertEquals(found!.email, "findme@example.com");
  });
});

Deno.test("CRUD - findById returns null for nonexistent", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const found = await scoped.customer.findById("nonexistent-id");
    assertEquals(found, null);
  });
});

Deno.test("CRUD - findOne", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.create({ email: "unique@example.com", plan: "pro" });

    const found = await scoped.customer.findOne({ email: "unique@example.com" });

    assertExists(found);
    assertEquals(found!.email, "unique@example.com");
    assertEquals(found!.plan, "pro");
  });
});

Deno.test("CRUD - find with filters", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "free1@example.com", plan: "free" },
      { email: "free2@example.com", plan: "free" },
      { email: "pro1@example.com", plan: "pro" },
      { email: "enterprise1@example.com", plan: "enterprise" },
    ]);

    const freeCustomers = await scoped.customer.find({ plan: "free" });
    assertEquals(freeCustomers.length, 2);

    const proCustomers = await scoped.customer.find({ plan: "pro" });
    assertEquals(proCustomers.length, 1);
  });
});

Deno.test("CRUD - find with $in operator", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "pro" },
      { email: "c@example.com", plan: "enterprise" },
    ]);

    const results = await scoped.customer.find({
      plan: { $in: ["pro", "enterprise"] },
    });

    assertEquals(results.length, 2);
  });
});

Deno.test("CRUD - find with $like operator", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
      { email: "alice@other.com" },
    ]);

    const results = await scoped.customer.find({
      email: { $like: "alice%" },
    });

    assertEquals(results.length, 2);
  });
});

Deno.test("CRUD - find with limit and offset", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com" },
      { email: "b@example.com" },
      { email: "c@example.com" },
      { email: "d@example.com" },
      { email: "e@example.com" },
    ]);

    const page1 = await scoped.customer.find({}, { limit: 2 });
    assertEquals(page1.length, 2);

    const page2 = await scoped.customer.find({}, { limit: 2, offset: 2 });
    assertEquals(page2.length, 2);

    const page3 = await scoped.customer.find({}, { limit: 2, offset: 4 });
    assertEquals(page3.length, 1);
  });
});

Deno.test("CRUD - find with sort", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "c@example.com", name: "Charlie" },
      { email: "a@example.com", name: "Alice" },
      { email: "b@example.com", name: "Bob" },
    ]);

    const sorted = await scoped.customer.find({}, { 
      sort: [["email", "asc"]] 
    });

    assertEquals(sorted[0].email, "a@example.com");
    assertEquals(sorted[1].email, "b@example.com");
    assertEquals(sorted[2].email, "c@example.com");
  });
});

Deno.test("CRUD - update single record", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const created = await scoped.customer.create({
      email: "update@example.com",
      plan: "free",
    });

    const updated = await scoped.customer.update(
      { id: created.id },
      { plan: "pro" }
    );

    assertExists(updated);
    assertEquals(updated!.plan, "pro");
    assertEquals(updated!.email, "update@example.com");
  });
});

Deno.test("CRUD - updateMany", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "free" },
      { email: "c@example.com", plan: "pro" },
    ]);

    const result = await scoped.customer.updateMany(
      { plan: "free" },
      { plan: "legacy" }
    );

    assertEquals(result.updated, 2);

    const legacy = await scoped.customer.find({ plan: "legacy" });
    assertEquals(legacy.length, 2);
  });
});

Deno.test("CRUD - delete single record", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const created = await scoped.customer.create({
      email: "delete@example.com",
    });

    const result = await scoped.customer.delete({ id: created.id });
    assertEquals(result.deleted, 1);

    const found = await scoped.customer.findById(created.id);
    assertEquals(found, null);
  });
});

Deno.test("CRUD - deleteMany", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "free" },
      { email: "c@example.com", plan: "pro" },
    ]);

    const result = await scoped.customer.deleteMany({ plan: "free" });
    assertEquals(result.deleted, 2);

    const remaining = await scoped.customer.find({});
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].plan, "pro");
  });
});

Deno.test("CRUD - upsert creates when not exists", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const result = await scoped.customer.upsert(
      { email: "upsert@example.com" },
      { email: "upsert@example.com", plan: "pro" }
    );

    assertExists(result.id);
    assertEquals(result.email, "upsert@example.com");
    assertEquals(result.plan, "pro");
  });
});

Deno.test("CRUD - upsert updates when exists", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.create({
      email: "existing@example.com",
      plan: "free",
    });

    const result = await scoped.customer.upsert(
      { email: "existing@example.com" },
      { email: "existing@example.com", plan: "enterprise" }
    );

    assertEquals(result.plan, "enterprise");

    const all = await scoped.customer.find({ email: "existing@example.com" });
    assertEquals(all.length, 1);
  });
});

Deno.test("CRUD - count", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "free" },
      { email: "c@example.com", plan: "pro" },
    ]);

    const total = await scoped.customer.count();
    assertEquals(total, 3);

    const freeCount = await scoped.customer.count({ plan: "free" });
    assertEquals(freeCount, 2);
  });
});

Deno.test("CRUD - exists", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.create({ email: "exists@example.com" });

    const exists = await scoped.customer.exists({ email: "exists@example.com" });
    assertEquals(exists, true);

    const notExists = await scoped.customer.exists({ email: "notexists@example.com" });
    assertEquals(notExists, false);
  });
});

Deno.test("Namespace isolation - records in different namespaces are isolated", async () => {
  await withTestDb(async (_db, manager) => {
    const ns1 = manager.withNamespace("tenant-1");
    const ns2 = manager.withNamespace("tenant-2");

    await ns1.customer.create({ email: "alice@tenant1.com" });
    await ns2.customer.create({ email: "bob@tenant2.com" });

    const tenant1Customers = await ns1.customer.find({});
    assertEquals(tenant1Customers.length, 1);
    assertEquals(tenant1Customers[0].email, "alice@tenant1.com");

    const tenant2Customers = await ns2.customer.find({});
    assertEquals(tenant2Customers.length, 1);
    assertEquals(tenant2Customers[0].email, "bob@tenant2.com");
  });
});

Deno.test("Relations - belongsTo creates edge", async () => {
  await withTestDb(async (db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const customer = await scoped.customer.create({
      email: "customer@example.com",
    });

    const order = await scoped.order.create({
      customerId: customer.id,
      total: 99.99,
      status: "pending",
    });

    // Check edge was created
    const edges = await db.query(
      `SELECT * FROM "edges" WHERE "target_node_id" = $1`,
      [order.id]
    );

    assertEquals(edges.rows.length, 1);
    assertEquals((edges.rows[0] as { source_node_id: string }).source_node_id, customer.id);
  });
});

Deno.test("Relations - populate belongsTo", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    const customer = await scoped.customer.create({
      email: "parent@example.com",
      name: "Parent Customer",
    });

    await scoped.order.create({
      customerId: customer.id,
      total: 50.00,
      status: "paid",
    });

    const ordersWithCustomer = await scoped.order.find(
      {},
      { populate: ["customer"] }
    );

    assertEquals(ordersWithCustomer.length, 1);
    assertExists(ordersWithCustomer[0].customer);
    assertEquals(ordersWithCustomer[0].customer.email, "parent@example.com");
  });
});

Deno.test("Query operators - $ne", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "pro" },
      { email: "c@example.com", plan: "enterprise" },
    ]);

    const notFree = await scoped.customer.find({
      plan: { $ne: "free" },
    });

    assertEquals(notFree.length, 2);
  });
});

Deno.test("Query operators - $or", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.createMany([
      { email: "a@example.com", plan: "free" },
      { email: "b@example.com", plan: "pro" },
      { email: "c@example.com", plan: "enterprise" },
    ]);

    const freeOrEnterprise = await scoped.customer.find({
      $or: [
        { plan: "free" },
        { plan: "enterprise" },
      ],
    });

    assertEquals(freeOrEnterprise.length, 2);
  });
});

Deno.test("Query operators - nested field access", async () => {
  await withTestDb(async (_db, manager) => {
    const scoped = manager.withNamespace(TEST_NAMESPACE);

    await scoped.customer.create({
      email: "nested@example.com",
      settings: { theme: "dark", notifications: true },
    });

    await scoped.customer.create({
      email: "light@example.com",
      settings: { theme: "light", notifications: false },
    });

    // Note: Nested field access requires the full path
    const darkTheme = await scoped.customer.find({
      "settings.theme": "dark",
    });

    assertEquals(darkTheme.length, 1);
    assertEquals(darkTheme[0].email, "nested@example.com");
  });
});

Deno.test("Explicit namespace - works without withNamespace", async () => {
  await withTestDb(async (_db, manager) => {
    const customer = await manager.customer.create(
      { email: "explicit@example.com" },
      { namespace: "explicit-ns" }
    );

    assertExists(customer.id);

    const found = await manager.customer.findById(customer.id, { namespace: "explicit-ns" });
    assertExists(found);
    assertEquals(found!.email, "explicit@example.com");

    // Should not find in different namespace
    const notFound = await manager.customer.findById(customer.id, { namespace: "other-ns" });
    assertEquals(notFound, null);
  });
});

console.log("All collection tests defined. Run with: deno test --allow-all database/collections/collections.test.ts");

