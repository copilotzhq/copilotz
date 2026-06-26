type JsonSchema = {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  example?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  patternProperties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  prefixItems?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minProperties?: number;
  maxProperties?: number;
  propertyNames?: JsonSchema;
  [key: string]: unknown;
};

type GeneratorOptions = {
  rootName: string;
  moduleName?: string;
  commentMaxChars: number;
  strictAdditionalProperties: boolean;
};

type GeneratedNamedType = {
  name: string;
  code: string;
  kind: "interface" | "type";
};

type LiteralCondition = {
  prop: string;
  values: unknown[];
  required: boolean;
};

type VariantInfo = {
  index: number;
  title: string;
  validWhen: LiteralCondition[];
  interfaceOrTypeName: string;
  schema: JsonSchema;
  typeExpression?: string;
  isObjectVariant: boolean;
};

const DEFAULT_OPTIONS: GeneratorOptions = {
  rootName: "ToolInput",
  moduleName: undefined,
  commentMaxChars: 140,
  strictAdditionalProperties: true,
};

class GenericJsonSchemaToAgentTs {
  private readonly schema: JsonSchema;
  private readonly options: GeneratorOptions;
  private readonly named = new Map<string, GeneratedNamedType>();
  private readonly emittedAliases = new Map<string, string>();
  private readonly reservedNames = new Set<string>();
  private readonly refStack = new Set<string>();

  constructor(schema: JsonSchema, options: Partial<GeneratorOptions> = {}) {
    this.schema = schema;
    const inferredRoot = schema.title
      ? pascalCase(schema.title)
      : DEFAULT_OPTIONS.rootName;
    this.options = { ...DEFAULT_OPTIONS, rootName: inferredRoot, ...options };
  }

  generate(): string {
    const root = this.resolveAndMerge(this.schema);
    const moduleDoc = this.moduleDoc(root);
    this.emitInterface(this.uniqueTypeName(this.options.rootName), root, {
      path: "$",
      description: root.description ||
        "Root input object generated from JSON Schema.",
    });

    const interfacesAndObjectTypes = Array.from(this.named.values()).map((
      entry,
    ) => entry.code).join("\n\n");
    const aliases = Array.from(this.emittedAliases.values()).join("\n\n");

    return [moduleDoc, interfacesAndObjectTypes, aliases]
      .filter(Boolean)
      .join("\n\n")
      .trim() + "\n";
  }

  private moduleDoc(root: JsonSchema): string {
    const title = this.options.moduleName || root.title || "Agent Tool Input";
    const rootRequired = root.required ?? [];
    const unionCount = this.countUnions(root);
    const lines = [
      "/**",
      ` * ${escapeComment(title)}`,
      " *",
      " * Generated from JSON Schema as compact TypeScript for agent tool-call construction.",
      " * - Required fields are non-optional; optional fields may be omitted.",
      " * - String literals and literal unions are validity conditions.",
      " * - `oneOf`/`anyOf` schemas become named TypeScript unions.",
    ];
    if (rootRequired.length > 0) {
      lines.push(
        ` * - Root required fields: ${
          rootRequired.map((x) => `\`${escapeComment(x)}\``).join(", ")
        }.`,
      );
    }
    if (unionCount > 0) {
      lines.push(
        ` * - Detected ${unionCount} union variant${
          unionCount === 1 ? "" : "s"
        }.`,
      );
    }
    if (root.additionalProperties === false) {
      lines.push(" * - Root schema rejects undeclared properties.");
    }
    lines.push(" */");
    return lines.join("\n");
  }

  private countUnions(
    schema: JsonSchema | undefined,
    seen = new Set<JsonSchema>(),
  ): number {
    if (!schema || seen.has(schema)) return 0;
    seen.add(schema);
    const s = this.resolveAndMerge(schema);
    let count = (s.oneOf?.length ?? 0) + (s.anyOf?.length ?? 0);
    for (const child of Object.values(s.properties ?? {})) {
      count += this.countUnions(child, seen);
    }
    const items = this.itemsOf(s);
    for (const item of items) count += this.countUnions(item, seen);
    for (
      const child of [...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.allOf ?? [])]
    ) count += this.countUnions(child, seen);
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      count += this.countUnions(s.additionalProperties, seen);
    }
    for (const child of Object.values(s.patternProperties ?? {})) {
      count += this.countUnions(child, seen);
    }
    return count;
  }

  private emitInterface(
    name: string,
    schemaRaw: JsonSchema,
    meta: {
      path: string;
      description?: string;
      validWhen?: LiteralCondition[];
    },
  ): string {
    const schema = this.resolveAndMerge(schemaRaw);

    if (this.named.has(name)) return this.named.get(name)!.code;

    this.named.set(name, {
      name,
      code: `export interface ${name} {}`,
      kind: "interface",
    });

    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const lines: string[] = [];
    const docs = [
      meta.description,
      this.validWhenText(meta.validWhen),
      this.objectRuleText(schema),
      this.objectConstraintText(schema),
    ].filter(Boolean) as string[];

    const interfaceDoc = this.jsDoc(docs);
    if (interfaceDoc) lines.push(interfaceDoc);
    lines.push(`export interface ${name} {`);

    for (const [propName, propSchemaRaw] of Object.entries(props)) {
      const propSchema = this.resolveAndMerge(propSchemaRaw);
      const optional = required.has(propName) ? "" : "?";
      const childPreferredName = this.childTypeName(name, propName);
      const typeExpression = this.typeFor(
        propSchema,
        childPreferredName,
        `${meta.path}.${propName}`,
      );
      const propDoc = this.jsDoc(
        this.commentPartsForProperty(
          propName,
          propSchema,
          required.has(propName),
          typeExpression,
        ),
      );
      if (propDoc) lines.push(this.indent(propDoc, 2));
      lines.push(`  ${propertyKey(propName)}${optional}: ${typeExpression};`);
    }

    for (
      const [pattern, patternSchema] of Object.entries(
        schema.patternProperties ?? {},
      )
    ) {
      const valueType = this.typeFor(
        patternSchema,
        `${name}PatternProperty`,
        `${meta.path}.{${pattern}}`,
      );
      lines.push(`  /** Dynamic keys matching ${JSON.stringify(pattern)}. */`);
      lines.push(`  [key: string]: ${valueType};`);
      break;
    }

    const indexLine = this.dynamicIndexLine(
      schema,
      `${name}AdditionalProperty`,
      `${meta.path}.{key}`,
    );
    if (indexLine) {
      lines.push("  /** Additional dynamic keys allowed by the JSON Schema. */");
      lines.push(`  ${indexLine}`);
    }

    lines.push("}");
    const code = lines.join("\n");
    this.named.set(name, { name, code, kind: "interface" });
    return code;
  }

  private typeFor(
    schemaRaw: JsonSchema,
    preferredNameRaw: string,
    path: string,
  ): string {
    const schema = this.resolveAndMerge(schemaRaw);
    const preferredName = pascalCase(preferredNameRaw);

    if (schema.const !== undefined) return literal(schema.const);
    if (schema.enum) return enumToTs(schema.enum);
    if (schema.oneOf?.length) {
      return this.emitUnion(preferredName, schema.oneOf, path, "oneOf");
    }
    if (schema.anyOf?.length) {
      return this.emitUnion(preferredName, schema.anyOf, path, "anyOf");
    }

    const types = this.normalizedTypes(schema);
    const tsTypes = types.map((t) =>
      this.singleTypeFor(t, schema, preferredName, path)
    );
    return unique(tsTypes).join(" | ") || "unknown";
  }

  private singleTypeFor(
    type: string,
    schema: JsonSchema,
    preferredName: string,
    path: string,
  ): string {
    switch (type) {
      case "string":
        return "string";
      case "integer":
        return "number";
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return this.arrayTypeFor(schema, preferredName, path);
      case "object":
        return this.objectTypeFor(schema, preferredName, path);
      default:
        return "unknown";
    }
  }

  private arrayTypeFor(
    schema: JsonSchema,
    preferredName: string,
    path: string,
  ): string {
    const tupleItems = schema.prefixItems ??
      (Array.isArray(schema.items) ? schema.items : undefined);
    if (tupleItems?.length) {
      return `[${
        tupleItems.map((item, index) =>
          this.typeFor(item, `${preferredName}${index + 1}`, `${path}[${index}]`)
        ).join(", ")
      }]`;
    }

    const itemSchema = !Array.isArray(schema.items) ? schema.items : undefined;
    if (!itemSchema) return "unknown[]";
    const itemName = isProbablyPlural(preferredName)
      ? singularize(preferredName)
      : preferredName;
    const itemType = this.typeFor(itemSchema, itemName, `${path}[]`);
    return itemType.includes(" | ") ? `Array<${itemType}>` : `${itemType}[]`;
  }

  private objectTypeFor(
    schema: JsonSchema,
    preferredName: string,
    path: string,
  ): string {
    const hasNamedProps = Object.keys(schema.properties ?? {}).length > 0;
    if (hasNamedProps) {
      if (!this.named.has(preferredName)) {
        this.emitInterface(preferredName, schema, {
          path,
          description: schema.description,
        });
      }
      return preferredName;
    }

    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      const valueType = this.typeFor(
        schema.additionalProperties,
        `${preferredName}Value`,
        `${path}.{key}`,
      );
      return `Record<string, ${valueType}>`;
    }

    if (schema.additionalProperties === true) return "Record<string, unknown>";
    if (
      schema.patternProperties &&
      Object.keys(schema.patternProperties).length > 0
    ) {
      const first = Object.values(schema.patternProperties)[0];
      const valueType = this.typeFor(
        first,
        `${preferredName}PatternValue`,
        `${path}.{patternKey}`,
      );
      return `Record<string, ${valueType}>`;
    }
    return this.options.strictAdditionalProperties
      ? "Record<string, never>"
      : "Record<string, unknown>";
  }

  private emitUnion(
    preferredNameRaw: string,
    variantsRaw: JsonSchema[],
    path: string,
    unionKind: "oneOf" | "anyOf",
  ): string {
    const unionName = pascalCase(preferredNameRaw.replace(/Union$/, ""));
    const variants = variantsRaw.map((v) => this.resolveAndMerge(v));
    const variantInfos = this.variantInfos(unionName, variants, path);

    for (const info of variantInfos) {
      if (info.isObjectVariant) {
        this.emitInterface(info.interfaceOrTypeName, info.schema, {
          path,
          description: info.title,
          validWhen: info.validWhen,
        });
      }
    }

    const aliasLines = [
      this.jsDoc([
        `${unionKind} from JSON Schema. ${
          unionKind === "oneOf"
            ? "Choose exactly one compatible shape."
            : "Choose a compatible shape; JSON Schema anyOf may allow overlap."
        }`,
        `Options: ${variantInfos.map((v) => v.title).join("; ")}.`,
      ]),
      `export type ${unionName} =`,
      ...variantInfos.map((v, i) =>
        `  ${i === 0 ? "" : "| "}${v.typeExpression ?? v.interfaceOrTypeName}`
      ),
      ";",
    ].filter(Boolean);

    const aliasCode = aliasLines.join("\n");
    if (!this.emittedAliases.has(unionName)) {
      this.emittedAliases.set(unionName, aliasCode);
    }
    return unionName;
  }

  private variantInfos(
    unionName: string,
    variants: JsonSchema[],
    path: string,
  ): VariantInfo[] {
    const allConditions = variants.map((variant) =>
      this.literalConditions(variant)
    );
    const disambiguatingProps = this.disambiguatingConditionProps(allConditions);
    const usedNames = new Set<string>();

    return variants.map((schema, index) => {
      const conditions = allConditions[index].filter((c) =>
        disambiguatingProps.has(c.prop) || c.required
      );
      const title = this.variantTitle(conditions, index);
      const baseName = this.variantTypeName(unionName, conditions, index);
      const interfaceOrTypeName = uniqueWithin(baseName, usedNames);
      const objectLike = this.normalizedTypes(schema).includes("object") ||
        !!schema.properties;
      const isObjectVariant = objectLike &&
        Object.keys(schema.properties ?? {}).length > 0;
      const typeExpression = isObjectVariant
        ? undefined
        : this.typeForNonUnionVariant(
          schema,
          `${interfaceOrTypeName}Value`,
          `${path}<variant${index + 1}>`,
        );
      return {
        index,
        title,
        validWhen: conditions,
        interfaceOrTypeName,
        schema,
        typeExpression,
        isObjectVariant,
      };
    });
  }

  private typeForNonUnionVariant(
    schemaRaw: JsonSchema,
    preferredName: string,
    path: string,
  ): string {
    const schema = this.resolveAndMerge({
      ...schemaRaw,
      oneOf: undefined,
      anyOf: undefined,
    });
    if (schema.const !== undefined) return literal(schema.const);
    if (schema.enum) return enumToTs(schema.enum);
    const types = this.normalizedTypes(schema);
    const tsTypes = types.map((t) =>
      this.singleTypeFor(t, schema, preferredName, path)
    );
    return unique(tsTypes).join(" | ") || "unknown";
  }

  private literalConditions(schema: JsonSchema): LiteralCondition[] {
    const required = new Set(schema.required ?? []);
    const out: LiteralCondition[] = [];
    for (const [prop, propSchemaRaw] of Object.entries(schema.properties ?? {})) {
      const propSchema = this.resolveAndMerge(propSchemaRaw);
      const values = this.literalValues(propSchema);
      if (values.length > 0) {
        out.push({ prop, values, required: required.has(prop) });
      }
    }
    return out;
  }

  private literalValues(schema: JsonSchema): unknown[] {
    if (schema.const !== undefined) return [schema.const];
    if (
      Array.isArray(schema.enum) && schema.enum.length > 0 &&
      schema.enum.length <= 8 && schema.enum.every(isPrimitiveLiteral)
    ) {
      return schema.enum;
    }
    return [];
  }

  private disambiguatingConditionProps(
    allConditions: LiteralCondition[][],
  ): Set<string> {
    const valuesByProp = new Map<string, Set<string>>();
    for (const conditions of allConditions) {
      for (const condition of conditions) {
        if (!valuesByProp.has(condition.prop)) {
          valuesByProp.set(condition.prop, new Set<string>());
        }
        valuesByProp.get(condition.prop)!.add(
          condition.values.map(stableValue).join("|"),
        );
      }
    }
    const out = new Set<string>();
    for (const [prop, values] of valuesByProp) {
      if (values.size > 1) out.add(prop);
    }
    return out;
  }

  private variantTitle(conditions: LiteralCondition[], index: number): string {
    if (!conditions.length) return `Variant ${index + 1}`;
    return `Variant where ${
      conditions.map((c) => `${c.prop}=${conditionValueText(c.values)}`).join(
        ", ",
      )
    }`;
  }

  private variantTypeName(
    unionName: string,
    conditions: LiteralCondition[],
    index: number,
  ): string {
    if (!conditions.length) return `${unionName}Variant${index + 1}`;
    const maybeUnionProp = lowerFirst(stripSuffix(unionName, "Item"));
    const suffix = conditions.map((c) => {
      const propPart = c.prop.toLowerCase() === maybeUnionProp.toLowerCase()
        ? ""
        : pascalCase(c.prop);
      const valuePart = c.values.map((v) => pascalCase(String(v))).join("Or");
      return `${propPart}${valuePart}`;
    }).join("");
    return `${unionName}${suffix || `Variant${index + 1}`}`;
  }

  private commentPartsForProperty(
    propName: string,
    schema: JsonSchema,
    required: boolean,
    typeExpression: string,
  ): string[] {
    const parts: string[] = [];
    const literalValues = this.literalValues(schema);
    const isOnlyLiteral = schema.const !== undefined ||
      (schema.enum?.length === 1);

    if (schema.description) parts.push(schema.description);
    else if (isOnlyLiteral) {
      parts.push(
        `Literal validity field: ${propName} must be ${
          conditionValueText(literalValues)
        }.`,
      );
    } else if (schema.oneOf?.length || schema.anyOf?.length) {
      parts.push(`Choose one compatible ${typeExpression} union member.`);
    }

    const meta: string[] = [];
    if (schema.default !== undefined) {
      meta.push(`default ${literal(schema.default)}`);
    }
    if (schema.example !== undefined) {
      meta.push(`example ${literal(schema.example)}`);
    }
    if (schema.examples?.length) meta.push(`example ${literal(schema.examples[0])}`);
    if (schema.enum && schema.enum.length > 1) {
      meta.push(`allowed ${schema.enum.map(literal).join(" | ")}`);
    }

    const constraints = this.constraints(schema);
    if (constraints.length) meta.push(constraints.join(", "));
    if (meta.length) parts.push(meta.join("; "));

    if (!required && !parts.length) parts.push("Optional.");
    return parts;
  }

  private constraints(schema: JsonSchema): string[] {
    const out: string[] = [];
    if (
      typeof schema.minimum === "number" && typeof schema.maximum === "number"
    ) out.push(`${schema.minimum}..${schema.maximum}`);
    else {
      if (typeof schema.minimum === "number") out.push(`>=${schema.minimum}`);
      if (typeof schema.maximum === "number") out.push(`<=${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number") {
      out.push(`>${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number") {
      out.push(`<${schema.exclusiveMaximum}`);
    }
    if (typeof schema.multipleOf === "number") {
      out.push(`multipleOf ${schema.multipleOf}`);
    }
    if (typeof schema.minLength === "number") {
      out.push(`minLen ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number") {
      out.push(`maxLen ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      out.push(`pattern ${JSON.stringify(schema.pattern)}`);
    }
    if (typeof schema.format === "string") out.push(`format ${schema.format}`);
    if (
      typeof schema.minItems === "number" && typeof schema.maxItems === "number"
    ) out.push(`${schema.minItems}..${schema.maxItems} items`);
    else {
      if (typeof schema.minItems === "number") {
        out.push(`>=${schema.minItems} items`);
      }
      if (typeof schema.maxItems === "number") {
        out.push(`<=${schema.maxItems} items`);
      }
    }
    if (schema.uniqueItems === true) out.push("unique items");
    if (typeof schema.minProperties === "number") {
      out.push(`minProps ${schema.minProperties}`);
    }
    if (typeof schema.maxProperties === "number") {
      out.push(`maxProps ${schema.maxProperties}`);
    }
    return out;
  }

  private objectRuleText(schema: JsonSchema): string | undefined {
    if (schema.additionalProperties === false) {
      return "No extra keys according to JSON Schema.";
    }
    if (schema.additionalProperties === true) {
      return "Additional dynamic keys are allowed.";
    }
    if (
      schema.additionalProperties && typeof schema.additionalProperties === "object"
    ) {
      return "Additional dynamic keys are allowed with a constrained value type.";
    }
    return undefined;
  }

  private objectConstraintText(schema: JsonSchema): string | undefined {
    const constraints = this.constraints(schema);
    return constraints.length ? constraints.join(", ") : undefined;
  }

  private validWhenText(conditions?: LiteralCondition[]): string | undefined {
    if (!conditions?.length) return undefined;
    return `Valid when ${
      conditions.map((c) => `${c.prop}=${conditionValueText(c.values)}`).join(
        ", ",
      )
    }.`;
  }

  private dynamicIndexLine(
    schema: JsonSchema,
    valueName: string,
    path: string,
  ): string | undefined {
    if (
      schema.additionalProperties === undefined ||
      schema.additionalProperties === false
    ) return undefined;
    if (schema.additionalProperties === true) return `[key: string]: unknown;`;
    const valueType = this.typeFor(schema.additionalProperties, valueName, path);
    return `[key: string]: ${valueType};`;
  }

  private normalizedTypes(schema: JsonSchema): string[] {
    if (Array.isArray(schema.type)) return schema.type;
    if (schema.type) return [schema.type];
    if (schema.const !== undefined) return [primitiveTypeOf(schema.const)];
    if (schema.enum?.length) return unique(schema.enum.map(primitiveTypeOf));
    if (
      schema.properties || schema.additionalProperties !== undefined ||
      schema.patternProperties
    ) return ["object"];
    if (schema.items || schema.prefixItems) return ["array"];
    if (schema.oneOf || schema.anyOf) return ["object"];
    return ["unknown"];
  }

  private resolveAndMerge(schema: JsonSchema): JsonSchema {
    return this.mergeAllOf(this.resolve(schema));
  }

  private resolve(schema: JsonSchema): JsonSchema {
    if (!schema?.$ref) return schema ?? {};
    const ref = schema.$ref;
    if (!ref.startsWith("#/")) return schema;
    if (this.refStack.has(ref)) {
      return {
        type: "object",
        additionalProperties: true,
        description: `Circular reference ${ref}`,
      };
    }
    this.refStack.add(ref);
    const target = ref.slice(2).split("/").reduce<unknown>(
      (acc, part) => (acc as Record<string, unknown>)?.[unescapePointer(part)],
      this.schema,
    );
    const resolved = this.resolve((target ?? {}) as JsonSchema);
    this.refStack.delete(ref);

    const siblings = { ...schema } as JsonSchema;
    delete siblings.$ref;
    return Object.keys(siblings).length
      ? this.mergeSchemas(resolved, siblings)
      : resolved;
  }

  private mergeAllOf(schema: JsonSchema): JsonSchema {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
      return schema;
    }
    const mergedBase = { ...schema } as JsonSchema;
    delete mergedBase.allOf;
    return schema.allOf.reduce(
      (acc, part) => this.mergeSchemas(acc, this.resolveAndMerge(part)),
      mergedBase,
    );
  }

  private mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
    const merged: JsonSchema = { ...a, ...b };
    merged.properties = { ...(a.properties ?? {}), ...(b.properties ?? {}) };
    merged.required = unique([...(a.required ?? []), ...(b.required ?? [])]);
    merged.patternProperties = {
      ...(a.patternProperties ?? {}),
      ...(b.patternProperties ?? {}),
    };
    return merged;
  }

  private itemsOf(schema: JsonSchema): JsonSchema[] {
    if (schema.prefixItems?.length) return schema.prefixItems;
    if (Array.isArray(schema.items)) return schema.items;
    return schema.items ? [schema.items] : [];
  }

  private childTypeName(parent: string, prop: string): string {
    const propName = pascalCase(prop);
    if (parent === this.options.rootName) {
      return isProbablyPlural(propName) ? singularize(propName) : propName;
    }
    return `${parent}${propName}`;
  }

  private uniqueTypeName(name: string): string {
    const base = pascalCase(name) || "GeneratedType";
    if (!this.reservedNames.has(base)) {
      this.reservedNames.add(base);
      return base;
    }
    if (this.named.has(base) || this.emittedAliases.has(base)) return base;
    let i = 2;
    while (this.reservedNames.has(`${base}${i}`)) i++;
    const out = `${base}${i}`;
    this.reservedNames.add(out);
    return out;
  }

  private jsDoc(parts: Array<string | undefined>): string {
    const clean = parts.filter(Boolean).map((part) => this.compact(String(part)))
      .filter(Boolean);
    if (!clean.length) return "";
    return `/** ${clean.join(" ")} */`;
  }

  private compact(text: string): string {
    const oneLine = escapeComment(text.replace(/\s+/g, " ").trim());
    if (!oneLine) return "";
    if (oneLine.length <= this.options.commentMaxChars) return oneLine;
    const firstSentence = oneLine.match(/^(.+?[.!?])\s/)?.[1];
    const candidate = firstSentence &&
        firstSentence.length <= this.options.commentMaxChars
      ? firstSentence
      : oneLine;
    return candidate.slice(0, this.options.commentMaxChars - 1).trimEnd() + "…";
  }

  private indent(text: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return text.split("\n").map((line) => pad + line).join("\n");
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function uniqueWithin(base: string, used: Set<string>): string {
  let out = base;
  let i = 2;
  while (used.has(out)) out = `${base}${i++}`;
  used.add(out);
  return out;
}

function pascalCase(input: string): string {
  const parts = String(input)
    .replace(/[\[\].{}]/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const out = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return out || "Anonymous";
}

function lowerFirst(input: string): string {
  return input ? input.charAt(0).toLowerCase() + input.slice(1) : input;
}

function stripSuffix(input: string, suffix: string): string {
  return input.endsWith(suffix) ? input.slice(0, -suffix.length) : input;
}

function isProbablyPlural(name: string): boolean {
  return /ies$/.test(name) || /s$/.test(name);
}

function singularize(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function enumToTs(values: unknown[]): string {
  return values.map(literal).join(" | ");
}

function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" || typeof value === "boolean" || value === null
  ) return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return "unknown";
}

function conditionValueText(values: unknown[]): string {
  if (values.length === 1) return literal(values[0]);
  return values.map(literal).join(" | ");
}

function primitiveTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (["string", "boolean"].includes(typeof value)) return typeof value;
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

function isPrimitiveLiteral(value: unknown): boolean {
  return value === null ||
    ["string", "number", "boolean"].includes(typeof value);
}

function stableValue(value: unknown): string {
  return JSON.stringify(value);
}

function unescapePointer(part: string): string {
  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

function escapeComment(text: string): string {
  return text.replace(/\*\//g, "*\\/").replace(/`/g, "\\`");
}

/** Render JSON Schema as compact TypeScript types for agent tool-call prompts. */
export function generateAgentTypesFromSchema(
  schema: Record<string, unknown>,
  options?: { rootName?: string; moduleName?: string },
): string {
  const generator = new GenericJsonSchemaToAgentTs(schema as JsonSchema, {
    rootName: options?.rootName ?? "ToolInput",
    moduleName: options?.moduleName,
  });
  return generator.generate();
}
