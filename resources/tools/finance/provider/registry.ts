import { FinanceDataProvider } from './types.ts';
import { YahooProvider } from './yahoo.ts';
import { FinanceError } from '../client/errors.ts';

const providers: Record<string, FinanceDataProvider> = {
  yahoo: new YahooProvider(),
};

export function getProvider(name = 'yahoo'): FinanceDataProvider {
  const provider = providers[name.toLowerCase()];
  if (!provider) {
    throw new FinanceError({
      code: 'unsupported',
      message: `Provider '${name}' is not supported. Available providers: ${Object.keys(providers).join(', ')}`,
    });
  }
  return provider;
}

export function registerProvider(name: string, provider: FinanceDataProvider): void {
  providers[name.toLowerCase()] = provider;
}
