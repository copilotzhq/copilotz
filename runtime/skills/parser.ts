import { parse } from "../../dependencies/std-yaml.ts";
import type { SkillManifest } from "../resources/index.ts";

const FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ParsedSkillMarkdown = Readonly<{
  manifest: SkillManifest;
  body: string;
}>;

export type ParseSkillMarkdownOptions = Readonly<{
  /** Enforces the specification rule that name matches its directory. */
  directoryName?: string;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a YAML mapping.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Skill ${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new TypeError(
      `Skill ${field} must not exceed ${maximum} characters.`,
    );
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maximum?: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Skill ${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (maximum !== undefined && normalized.length > maximum) {
    throw new TypeError(
      `Skill ${field} must not exceed ${maximum} characters.`,
    );
  }
  return normalized;
}

function metadata(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Skill metadata");
  const entries = Object.entries(input);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new TypeError("Skill metadata values must be strings.");
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

export function validateSkillManifest(
  value: unknown,
  options: ParseSkillMarkdownOptions = {},
): SkillManifest {
  const input = record(value, "Skill frontmatter");
  const unsupported = Object.keys(input).filter((key) =>
    !FRONTMATTER_FIELDS.has(key)
  );
  if (unsupported.length) {
    throw new TypeError(
      `Unsupported SKILL.md frontmatter field '${unsupported[0]}'. ` +
        "Use metadata for implementation-specific values.",
    );
  }

  const name = requiredString(input.name, "name", 64);
  if (!SKILL_NAME.test(name)) {
    throw new TypeError(
      "Skill name must contain lowercase letters, numbers, and single hyphens only.",
    );
  }
  if (options.directoryName !== undefined && options.directoryName !== name) {
    throw new TypeError(
      `Skill name '${name}' must match directory '${options.directoryName}'.`,
    );
  }

  const description = requiredString(input.description, "description", 1_024);
  const license = optionalString(input.license, "license");
  const compatibility = optionalString(
    input.compatibility,
    "compatibility",
    500,
  );
  const skillMetadata = metadata(input.metadata);
  const allowedTools = optionalString(input["allowed-tools"], "allowed-tools");

  return Object.freeze({
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(skillMetadata ? { metadata: skillMetadata } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  });
}

function frontmatter(raw: string): Readonly<{ yaml: string; body: string }> {
  const normalized = raw.replaceAll("\r\n", "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new TypeError("SKILL.md must begin with YAML frontmatter.");
  }
  const closing = lines.findIndex((line, index) =>
    index > 0 && line.trim() === "---"
  );
  if (closing < 0) {
    throw new TypeError(
      "SKILL.md frontmatter is missing its closing delimiter.",
    );
  }
  return Object.freeze({
    yaml: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n").trim(),
  });
}

/** Strictly parses and validates an Agent Skills `SKILL.md` file. */
export function parseSkillMarkdown(
  raw: string,
  options: ParseSkillMarkdownOptions = {},
): ParsedSkillMarkdown {
  if (typeof raw !== "string") {
    throw new TypeError("SKILL.md content must be text.");
  }
  const document = frontmatter(raw);
  let parsed: unknown;
  try {
    parsed = parse(document.yaml, {
      allowDuplicateKeys: false,
      schema: "core",
    });
  } catch (cause) {
    throw new TypeError("SKILL.md contains invalid YAML frontmatter.", {
      cause,
    });
  }
  return Object.freeze({
    manifest: validateSkillManifest(parsed, options),
    body: document.body,
  });
}
