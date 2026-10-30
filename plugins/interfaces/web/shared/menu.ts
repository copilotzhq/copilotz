/**
 * The person's menu, at the foot of the sidebar: what front ends put there
 * (the `userMenu` resource), pages of the person's own, in their order.
 */
import type { IconName } from "../../../../hosts/web/mod.ts";

/** A `userMenu` resource: a page of the person's own, in their menu (Connected accounts). */
export type UserMenuEntry = { label: string; icon?: IconName; href: string; order?: number };

/** The entries front ends give, in their order, without those taken away (`null`). */
export const userMenuOf = (given: unknown): UserMenuEntry[] =>
  Object.values((given ?? {}) as Record<string, UserMenuEntry | null>)
    .filter((entry): entry is UserMenuEntry => !!entry?.label && !!entry.href)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
