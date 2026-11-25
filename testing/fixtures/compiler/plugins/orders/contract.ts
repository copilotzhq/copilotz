export type OrderId = string;

export interface Invoice {
  /** The customer to bill. */
  customerId: string;
  /** @minimum 1 */
  quantity: number;
}
