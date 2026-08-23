import type { FinanceDataProvider } from "./types.ts";
import { createYahooProvider } from "./yahoo.ts";
import { FinanceError } from "../client/errors.ts";

export type FinanceProviderRegistry = Readonly<{
  get(name?: string): FinanceDataProvider;
  register(name: string, provider: FinanceDataProvider): void;
  names(): readonly string[];
}>;

export function createFinanceProviderRegistry(
  initial: Readonly<Record<string, FinanceDataProvider>> = {
    yahoo: createYahooProvider(),
  },
): FinanceProviderRegistry {
  const providers = new Map(
    Object.entries(initial).map(([name, provider]) => [
      name.toLowerCase(),
      provider,
    ]),
  );
  const names = (): readonly string[] => Object.freeze([...providers.keys()]);
  return Object.freeze({
    get(name = "yahoo") {
      const provider = providers.get(name.toLowerCase());
      if (!provider) {
        throw new FinanceError({
          code: "unsupported",
          message: `Provider '${name}' is not supported. Available providers: ${
            names().join(", ")
          }`,
        });
      }
      return provider;
    },
    register(name, provider) {
      providers.set(name.toLowerCase(), provider);
    },
    names,
  });
}

const defaultRegistry = createFinanceProviderRegistry();

export function getProvider(name = "yahoo"): FinanceDataProvider {
  return defaultRegistry.get(name);
}

export function registerProvider(
  name: string,
  provider: FinanceDataProvider,
): void {
  defaultRegistry.register(name, provider);
}
