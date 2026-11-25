import type { Infer } from "../../../runtime/define.ts";

/** The customer's account code.
 * @minLength 2
 * @maxLength 6
 * @pattern ^[A-Z]+$
 * @examples ["AC", "WEST"]
 */
export type Code = string;

interface Product {
  sku: Code;
  name: string;
  discontinued: boolean;
}

export type Line = Pick<Product, "sku"> & Partial<Omit<Product, "sku" | "discontinued">> & {
  /** Units on this line.
   * @minimum 1
   * @maximum 20
   * @integer
   * @default 1
   */
  quantity: number;
};

export const productSchema = {
  type: "object",
  description: "A catalog product.",
  properties: {
    code: { type: "string", pattern: "^[A-Z]{2}$", description: "Two capital letters." },
    price: { type: "integer", minimum: 1 },
    note: { type: "string", maxLength: 15 },
  },
  required: ["code", "price"],
  additionalProperties: false,
} as const;

export type CatalogProduct = Infer<typeof productSchema>;

/** How an order will reach its customer. */
export type Delivery = { kind: "collect"; location: string } | { kind: "ship"; postalCode: string };

/** An order placed for a customer. */
export interface Order {
  /** Who placed the order. */
  customerId: Code;
  /** Each product once.
   * @minItems 1
   * @maxItems 3
   * @uniqueItems
   */
  lines: readonly Line[];
  delivery: Delivery;
  window?: readonly [Date, Date?];
  counts?: [label: string, ...counts: number[]];
  marker?: [];
  weights?: Record<string, number>;
  priority: 1 | 2 | 3;
  status?: "draft" | "sent";
  approved: boolean;
  prepaid?: true;
  discount: number | null;
  reason: string | undefined;
  canceled?: null;
  /** @type integer */
  cents?: number;
  /** @exclusiveMinimum 0
   * @exclusiveMaximum 1
   */
  ratio?: number;
  /** @format email */
  receipt?: string;
}
