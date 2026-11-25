import type { CatalogProduct } from "./contracts.ts";
export default {
  run(_ctx: unknown, _input: {
    original: CatalogProduct;
    patch: Partial<Omit<CatalogProduct, "code">>;
    key: Pick<CatalogProduct, "code">;
  }) {},
};
