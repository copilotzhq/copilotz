/**
 * Element refs for an accessibility snapshot. A ref follows its DOM node
 * (backend node ids survive snapshot refreshes), and a new document never
 * reuses an old one's refs.
 */
import { randomUUID } from "node:crypto";
import { browserError } from "./async.ts";

export type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: { name: string; value: { value?: unknown } }[];
};

export type Refs = {
  reset(): void;
  /** A ref's node, or a stale_ref error. */
  resolve(ref: string): number;
  snapshot(nodes: AXNode[], maxChars?: number): {
    snapshot: string;
    refs: Record<string, { role: string; name: string }>;
    snapshotTruncated: boolean;
  };
};

export function createRefs(): Refs {
  const prefix = randomUUID().slice(0, 8);
  let next = 0;
  const nodes = new Map<number, string>();
  const refs = new Map<string, number>();
  return {
    reset() {
      nodes.clear();
      refs.clear();
    },
    resolve(ref) {
      const id = refs.get(ref.replace(/^@/, ""));
      if (!id) {
        throw browserError(
          "stale_ref",
          `Unknown or stale element ref ${ref}; read a fresh snapshot`,
        );
      }
      return id;
    },
    snapshot(tree, maxChars = 100_000) {
      const active = new Set<number>();
      const byId = new Map(tree.map((node) => [node.nodeId, node]));
      const children = new Set(tree.flatMap((node) => node.childIds ?? []));
      const lines: string[] = [];
      const found: Record<string, { role: string; name: string }> = {};
      const visited = new Set<string>();
      let size = 0;
      let truncated = false;
      const visit = (node: AXNode, depth: number) => {
        if (visited.has(node.nodeId) || truncated) return;
        visited.add(node.nodeId);
        const role = node.role?.value ?? "unknown";
        const name = node.name?.value ?? "";
        const meaningful = !node.ignored && !["none", "generic", "InlineTextBox"].includes(role);
        if (meaningful) {
          let ref: string | undefined;
          if (node.backendDOMNodeId) {
            active.add(node.backendDOMNodeId);
            ref = nodes.get(node.backendDOMNodeId) ?? `${prefix}:e${++next}`;
            nodes.set(node.backendDOMNodeId, ref);
            refs.set(ref, node.backendDOMNodeId);
            found[ref] = { role, name };
          }
          const props = (node.properties ?? [])
            .filter((p) =>
              ["checked", "selected", "disabled", "expanded", "required", "level"].includes(p.name)
            )
            .map((p) => `${p.name}=${JSON.stringify(p.value.value)}`);
          const line = `${"  ".repeat(Math.min(depth, 12))}${ref ? `[${ref}] ` : ""}${role}${
            name ? ` ${JSON.stringify(name)}` : ""
          }${node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : ""}${
            props.length ? ` (${props.join(", ")})` : ""
          }`;
          if (size + line.length > maxChars) {
            truncated = true;
            return;
          }
          lines.push(line);
          size += line.length + 1;
        }
        for (const id of node.childIds ?? []) {
          const child = byId.get(id);
          if (child) visit(child, depth + (meaningful ? 1 : 0));
        }
      };
      for (const node of tree) if (!children.has(node.nodeId)) visit(node, 0);
      for (const [id, ref] of nodes) {
        if (!active.has(id)) {
          nodes.delete(id);
          refs.delete(ref);
        }
      }
      return { snapshot: lines.join("\n"), refs: found, snapshotTruncated: truncated };
    },
  };
}
