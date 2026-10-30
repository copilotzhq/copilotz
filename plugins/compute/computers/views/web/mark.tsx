/**
 * A computer's mark: its icon in a tile (a kind's own, for a cloud
 * computer), with a dot that says whether it's online (awake).
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../../../../../hosts/web/mod.ts";

export function ComputerMark(
  { online, size = "sm", icon = "computer" }: {
    online: boolean;
    size?: "sm" | "lg";
    icon?: IconName;
  },
): ReactNode {
  return (
    <span className={`computer-mark computer-mark-${size}`} data-online={online || undefined}>
      <Icon name={icon} size={size === "lg" ? 22 : 14} />
      <span className="computer-dot" aria-hidden="true" />
    </span>
  );
}
