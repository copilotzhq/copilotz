/** A file as a chip: its name, kind and size; a link that saves it (from where it's served). */
import type { ReactNode } from "react";
import { Card, Icon } from "../../../../../hosts/web/mod.ts";

export function Download(
  { name, type, size, href }: { name: string; type: string; size: string; href: string },
): ReactNode {
  const kind = (name.includes(".") ? name.split(".").pop()! : type.split("/").pop() ?? "file")
    .slice(0, 5).toUpperCase();
  return (
    <Card
      as="a"
      interactive
      padding="none"
      className="file-chip"
      href={href}
      download={name}
      aria-label={`Download ${name}, ${size}`}
    >
      <span className="file-chip-icon" aria-hidden="true">
        <Icon name="file" size={18} />
      </span>
      <span className="file-chip-text">
        <span className="file-chip-name">{name}</span>
        <small>
          {kind} · {size}
        </small>
      </span>
      <span className="file-chip-save" aria-hidden="true">
        <Icon name="download" size={16} />
      </span>
    </Card>
  );
}
