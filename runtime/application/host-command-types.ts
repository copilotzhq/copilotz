/** Bounded immutable JSON captured at the trusted host admission boundary. */
export type HostCommandJson =
  | null
  | boolean
  | number
  | string
  | readonly HostCommandJson[]
  | { readonly [key: string]: HostCommandJson };
