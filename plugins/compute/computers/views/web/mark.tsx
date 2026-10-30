/** A computer's mark: its icon in a tile, with a dot that says whether it's online. */
import type { ReactNode } from "react";
import { Icon } from "../../../../../hosts/web/mod.ts";

export function ComputerMark(
  { online, size = "sm" }: { online: boolean; size?: "sm" | "lg" },
): ReactNode {
  return (
    <span className={`computer-mark computer-mark-${size}`} data-online={online || undefined}>
      <Icon name="computer" size={size === "lg" ? 22 : 14} />
      <span className="computer-dot" aria-hidden="true" />
    </span>
  );
}
