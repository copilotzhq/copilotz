/** Build-time schemas for Actions and collections. The app's modules are type-checked, never loaded. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { pathToFileURL } from "node:url";
import type ts from "typescript";
import type { JSONSchema } from "../runtime/define.ts";

type TS = typeof ts;
type Schema = Exclude<JSONSchema, boolean> & { prefixItems?: Schema[] };
type Result = { schema: JSONSchema; error?: never } | { error: string; schema?: never };
type Source = { file: string; kind: "actions" | "collections" };
type Options = { tsconfig?: string; ts?: TS };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

async function appCompiler(file: string): Promise<TS> {
  try {
    const fromApp = createRequire(resolve(file));
    if ("Deno" in globalThis) {
      // createRequire on Deno may find a compiler cached for the CLI's own module graph.
      // Look from the Action instead. A Deno app may keep its npm packages in the global cache.
      for (let dir = dirname(resolve(file));; dir = dirname(dir)) {
        const local = join(dir, "node_modules", "typescript");
        if (existsSync(join(local, "package.json"))) return fromApp(local);
        if (dirname(dir) === dir) break;
      }
      // Ask the app's resolver about its npm devDependency or import map (including JSONC).
      const graph = JSON.parse(
        execFileSync(execPath, ["info", "--json", "--frozen", "typescript"], {
          cwd: dirname(resolve(file)),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      const pkg = graph.npmPackages?.[graph.modules?.[0]?.npmPackage];
      if (pkg?.name !== "typescript") throw new Error("No app TypeScript installation");
      return (await import(`npm:typescript@${pkg.version}`)).default;
    }
    const entry = fromApp.resolve("typescript");
    return (await import(pathToFileURL(entry).href)).default;
  } catch (cause) {
    throw new Error(
      "Add typescript as a devDependency of the app to generate schemas from types.",
      {
        cause,
      },
    );
  }
}

function literal(type: ts.Type, { api, checker }: Reader) {
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  if (type.flags & api.TypeFlags.BooleanLiteral) {
    return checker.typeToString(type) === "true";
  }
  if (type.flags & api.TypeFlags.Null) return null;
  return undefined;
}

type Reader = ReturnType<typeof reader>;

function reader(api: TS, program: ts.Program) {
  const checker = program.getTypeChecker();
  const standard = (symbol: ts.Symbol) =>
    symbol.declarations?.some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()));
  function symbolAt(node: ts.Node) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & api.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }
  return { api, checker, standard, symbolAt };
}

/** Read a singleton type (the value of an `as const` schema) without evaluating any initializer. */
function constValue(type: ts.Type, at: ts.Node, r: Reader): unknown {
  const value = literal(type, r);
  if (value !== undefined) return value;
  if (r.checker.isTupleType(type)) {
    const items = r.checker.getTypeArguments(type as ts.TypeReference).map((t) =>
      constValue(t, at, r)
    );
    if (!items.includes(undefined)) return items;
  } else if (type.isClassOrInterface() || !(type.flags & r.api.TypeFlags.Object)) {
    return undefined;
  } else if (type.getCallSignatures().length === 0 && !r.checker.getIndexInfosOfType(type).length) {
    const entries = [];
    for (const field of [...type.getProperties()].sort((a, b) => compare(a.name, b.name))) {
      const child = r.checker.getTypeOfSymbolAtLocation(field, at);
      // A widened or computed value can still be used through its inferred TypeScript shape.
      if (
        !field.declarations?.some((d) =>
          r.api.isPropertyAssignment(d) ||
          r.api.isShorthandPropertyAssignment(d) || r.api.isPropertySignature(d)
        )
      ) return undefined;
      const v = constValue(child, at, r);
      if (v === undefined) return undefined;
      entries.push([field.name, v]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

/** Follow aliases to the collection's literal schema. Project simple closed objects field by field. */
function collectionSchema(
  node: ts.TypeNode,
  r: Reader,
  seen = new Set<ts.Node>(),
): Schema | undefined {
  const { api, checker } = r;
  if (!api.isTypeReferenceNode(node) || seen.has(node)) return;
  seen.add(node);
  const symbol = r.symbolAt(node.typeName);
  const args = node.typeArguments ?? [];
  if (!symbol) return;
  if (
    symbol.name === "Infer" && args[0] && api.isTypeQueryNode(args[0]) &&
    symbol.declarations?.some((d) =>
      /[/\\]runtime[/\\]define(?:\.d)?\.ts$/.test(d.getSourceFile().fileName)
    )
  ) {
    const schema = constValue(checker.getTypeFromTypeNode(args[0]), args[0], r);
    if (schema && typeof schema === "object" && !Array.isArray(schema)) return schema as Schema;
    return;
  }
  if (r.standard(symbol) && ["Partial", "Pick", "Omit"].includes(symbol.name) && args[0]) {
    const base = collectionSchema(args[0], r, seen);
    if (
      base?.type !== "object" || !base.properties || base.additionalProperties !== false ||
      Object.keys(base).some((k) =>
        !["type", "properties", "additionalProperties", "required", "description", "title"]
          .includes(k)
      )
    ) return;
    let keys: string[] = [];
    if (symbol.name !== "Partial") {
      if (!args[1]) return;
      const selection = checker.getTypeFromTypeNode(args[1]);
      const members = selection.isUnion() ? selection.types : [selection];
      if (!members.every((t) => t.isStringLiteral())) return;
      keys = members.map((t) => t.value);
    }
    const fields = Object.keys(base.properties).filter((key) =>
      symbol.name === "Partial" ||
      (symbol.name === "Pick" ? keys.includes(key) : !keys.includes(key))
    );
    const properties = Object.fromEntries(
      Object.entries(base.properties).filter(([key]) => fields.includes(key)),
    );
    const { required, ...rest } = base;
    const needed = symbol.name === "Partial" ? [] : required?.filter((k) => fields.includes(k));
    return { ...rest, properties, ...(needed?.length ? { required: needed } : {}) };
  }
  const alias = symbol.declarations?.find(api.isTypeAliasDeclaration);
  if (alias && !alias.typeParameters) return collectionSchema(alias.type, r, seen);
}

function documented(
  schema: Schema,
  symbol: ts.Symbol | undefined,
  r: Reader,
  path: string,
): Schema {
  if (!symbol || r.standard(symbol)) return schema;
  const description = r.api.displayPartsToString(symbol.getDocumentationComment(r.checker));
  const tags: Record<string, unknown> = description ? { description } : {};
  for (const { name, text } of symbol.getJsDocTags(r.checker)) {
    const value = r.api.displayPartsToString(text).trim();
    const invalid = () => {
      throw new Error(`${path}: invalid @${name} ${value}`);
    };
    if (
      [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
      ].includes(name)
    ) {
      const n = Number(value);
      if (
        !value || !Number.isFinite(n) ||
        (/(Length|Items)$/.test(name) && (!Number.isInteger(n) || n < 0))
      ) invalid();
      tags[name] = name === "minItems"
        ? Math.max(n, schema.minItems ?? 0)
        : name === "maxItems"
        ? Math.min(n, schema.maxItems ?? Infinity)
        : n;
    } else if (name === "pattern" || name === "format") {
      if (name === "pattern") {
        try {
          new RegExp(value, "u");
        } catch {
          invalid();
        }
      }
      tags[name] = value;
    } else if (name === "uniqueItems") {
      if (!["", "true", "false"].includes(value)) invalid();
      tags[name] = value !== "false";
    } else if (name === "default" || name === "examples") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        if (name === "examples") invalid();
        parsed = value;
      }
      if (name === "examples" && !Array.isArray(parsed)) invalid();
      tags[name] = parsed;
    } else if (name === "integer" || (name === "type" && /^\{?integer\}?$/.test(value))) {
      // An integer constraint also applies when the property's type includes null.
      if (schema.type === "number") tags.type = "integer";
      else tags.multipleOf = 1;
    }
  }
  return { ...schema, ...tags };
}

function unresolved(type: ts.Type, api: TS): boolean {
  return !!(type.flags & api.TypeFlags.Instantiable) ||
    (type.isUnionOrIntersection() && type.types.some((t) => unresolved(t, api)));
}

function converter(r: Reader, input: ts.TypeNode, document: boolean) {
  const { api, checker } = r;
  const F = api.TypeFlags;
  const active = new Set<ts.Type>();

  function convert(type: ts.Type, path: string, node?: ts.TypeNode): Schema {
    if (active.has(type)) throw new Error(`${path}: recursive type ${checker.typeToString(type)}`);
    active.add(type);
    try {
      // A mapped or intersected property can have a different type than its declaration.
      // Only reuse that declaration's schema when it still describes this value.
      const declared = node && checker.getTypeFromTypeNode(node);
      const matches = declared === type || (declared && type.isUnion() &&
        checker.getNullableType(declared, F.Undefined) === type);
      let written = matches ? node : undefined;
      const names = new Set<ts.Symbol>();
      // Primitive aliases disappear from the checked type. Read their docs from the annotation.
      while (written) {
        if (
          api.isParenthesizedTypeNode(written) ||
          (api.isTypeOperatorNode(written) && written.operator === api.SyntaxKind.ReadonlyKeyword)
        ) {
          written = written.type;
          continue;
        }
        if (!api.isTypeReferenceNode(written)) break;
        const name = r.symbolAt(written.typeName);
        if (!name || names.has(name)) break;
        names.add(name);
        const alias = name.declarations?.find(api.isTypeAliasDeclaration);
        if (!alias || alias.typeParameters) break;
        written = alias.type;
      }
      const kept = written && collectionSchema(written, r);
      // The description of Infer itself describes the helper, not the input.
      if (kept && written && api.isTypeReferenceNode(written)) {
        const helper = r.symbolAt(written.typeName);
        if (helper) names.delete(helper);
      }
      let schema = kept ?? shape(type, path, written);
      if (
        document && path === "schema" && schema.properties &&
        Object.hasOwn(schema.properties, "_id")
      ) {
        // The owner validates the fields after stripping the top-level _id.
        // Nested ids and Action inputs are ordinary user fields.
        const field = type.getProperty("_id");
        if (field) {
          const id = checker.getTypeOfSymbolAtLocation(field, input);
          const parts = id.isUnion() ? id.types : [id];
          if (
            !parts.some((p) => p.flags & F.String) ||
            parts.some((p) => !(p.flags & (F.String | F.Undefined)))
          ) {
            throw new Error("schema._id: use string or omit the runtime's id");
          }
        }
        const { _id, ...properties } = schema.properties;
        const { required, ...rest } = schema;
        const fields = required?.filter((name) => name !== "_id");
        schema = { ...rest, properties, ...(fields?.length ? { required: fields } : {}) };
      }
      const resolved = type.aliasSymbol ?? type.symbol;
      if (!kept && resolved) names.add(resolved);
      for (const name of [...names].reverse()) schema = documented(schema, name, r, path);
      return schema;
    } finally {
      active.delete(type);
    }
  }

  function shape(type: ts.Type, path: string, node?: ts.TypeNode): Schema {
    const fail = (reason: string): never => {
      throw new Error(`${path}: ${reason}`);
    };
    if (type.flags & F.Boolean) return { type: "boolean" };
    const value = literal(type, r);
    if (value === null) return { type: "null" };
    if (value !== undefined) return { const: value };
    if (type.flags & F.String) return { type: "string" };
    if (type.flags & F.Number) return { type: "number" };
    if (type.isUnion()) {
      const variants = type.types.filter((t) => !(t.flags & F.Undefined));
      if (variants.length === 1) return convert(variants[0], path, node);
      const values = variants.map((t) => literal(t, r));
      const order = (a: unknown, b: unknown) => compare(JSON.stringify(a), JSON.stringify(b));
      if (values.every((v) => v !== undefined)) return { enum: values.sort(order) };
      const nodes = node && api.isUnionTypeNode(node) ? node.types : [];
      return {
        anyOf: variants.map((t) =>
          convert(t, path, nodes.find((n) => checker.getTypeFromTypeNode(n) === t))
        ).sort(order),
      };
    }
    if (type.getCallSignatures().length || type.getConstructSignatures().length) {
      return fail("functions cannot be sent as JSON");
    }
    const members = type.isIntersection() ? type.types : [type];
    if (members.some((t) => t.symbol?.name === "Date" && r.standard(t.symbol))) {
      return fail("Date cannot be sent as JSON: use `string` with `/** @format date-time */`");
    }
    if (type.isIntersection()) {
      if (!type.types.every((t) => t.flags & F.Object)) {
        return fail(`unsupported intersection ${checker.typeToString(type)}`);
      }
      for (const member of type.types) {
        if ((member.symbol?.flags ?? 0) & api.SymbolFlags.Class) {
          return fail(`class instance ${checker.typeToString(member)}`);
        }
      }
    } else if (!(type.flags & F.Object)) {
      const reason = type.flags & F.Instantiable ? "unresolved generic" : "unsupported type";
      return fail(`${reason} ${checker.typeToString(type)}`);
    }
    if (checker.isTupleType(type)) {
      const tuple = type as ts.TupleTypeReference;
      const { fixedLength, minLength, elementFlags } = tuple.target;
      const args = checker.getTypeArguments(tuple);
      if (elementFlags.slice(fixedLength).some((f) => f !== api.ElementFlags.Rest)) {
        return fail("tuple needs a fixed prefix followed by an optional rest");
      }
      const elements = node && api.isTupleTypeNode(node) ? node.elements : [];
      const prefixItems = args.slice(0, fixedLength).map((t, i) => {
        const element = elements[i];
        const annotation =
          element && (api.isNamedTupleMember(element) || api.isOptionalTypeNode(element))
            ? element.type
            : element;
        return convert(t, `${path}[${i}]`, annotation);
      });
      return {
        type: "array",
        ...(prefixItems.length ? { prefixItems } : {}),
        minItems: minLength,
        ...(args.length > fixedLength
          ? { items: convert(args[fixedLength], `${path}[]`) }
          : { maxItems: fixedLength }),
      };
    }
    if (checker.isArrayType(type)) {
      const itemNode = node &&
        (api.isArrayTypeNode(node)
          ? node.elementType
          : api.isTypeReferenceNode(node)
          ? node.typeArguments?.[0]
          : undefined);
      return {
        type: "array",
        items: convert(
          checker.getTypeArguments(type as ts.TypeReference)[0],
          `${path}[]`,
          itemNode,
        ),
      };
    }
    if ((type.symbol?.flags ?? 0) & api.SymbolFlags.Class) {
      return fail(`class instance ${checker.typeToString(type)}`);
    }
    if (
      type.aliasTypeArguments?.some((t) => unresolved(t, api)) ||
      (node && api.isMappedTypeNode(node) && node.typeParameter.constraint &&
        unresolved(checker.getTypeFromTypeNode(node.typeParameter.constraint), api))
    ) {
      return fail(`unresolved generic ${checker.typeToString(type)}`);
    }
    const entries = [];
    const required = [];
    for (const field of [...type.getProperties()].sort((a, b) => compare(a.name, b.name))) {
      if (field.escapedName.toString().startsWith("__@")) {
        return fail(`symbol property ${field.name}`);
      }
      const at = field.valueDeclaration ?? field.declarations?.[0] ?? input;
      const child = checker.getTypeOfSymbolAtLocation(field, at);
      const fieldPath = `${path}.${field.name}`;
      const annotation = at && (api.isPropertySignature(at) || api.isPropertyDeclaration(at))
        ? at.type
        : undefined;
      entries.push([
        field.name,
        documented(convert(child, fieldPath, annotation), field, r, fieldPath),
      ]);
      if (
        !(field.flags & api.SymbolFlags.Optional) &&
        !(child.isUnion() && child.types.some((t) => t.flags & F.Undefined))
      ) required.push(field.name);
    }
    const indexes = checker.getIndexInfosOfType(type);
    if (indexes.some((i) => !(i.keyType.flags & F.String))) {
      return fail("only string index signatures can be generated");
    }
    return {
      type: "object",
      properties: Object.fromEntries(entries),
      ...(required.length ? { required } : {}),
      additionalProperties: indexes.length
        ? convert(
          indexes[0].type,
          `${path}[*]`,
          indexes[0].declaration?.type ??
            (node && api.isTypeReferenceNode(node) && r.symbolAt(node.typeName)?.name === "Record"
              ? node.typeArguments?.[1]
              : undefined),
        )
        : false,
    };
  }
  return convert;
}

function declarationSchema(
  source: ts.SourceFile,
  kind: Source["kind"],
  r: Reader,
): Schema | undefined {
  const { api, checker } = r;
  const module = checker.getSymbolAtLocation(source);
  const symbol = module && checker.getExportsOfModule(module).find((s) => s.name === "default");
  const exported = symbol &&
    (symbol.flags & api.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
      .valueDeclaration;
  const collection = kind === "collections";
  const key = collection ? "schema" : "input";
  const initial = exported &&
    (api.isExportAssignment(exported)
      ? exported.expression
      : api.isVariableDeclaration(exported)
      ? exported.initializer
      : undefined);
  if (!initial) throw new Error(`${key}: expected a default export`);
  let expr = initial;
  const seen = new Set<ts.Expression>();
  while (!seen.has(expr)) {
    seen.add(expr);
    if (
      api.isAsExpression(expr) || api.isSatisfiesExpression(expr) ||
      api.isParenthesizedExpression(expr)
    ) expr = expr.expression;
    else if (api.isIdentifier(expr)) {
      const decl = r.symbolAt(expr)?.valueDeclaration;
      if (!decl || !api.isVariableDeclaration(decl) || !decl.initializer) break;
      expr = decl.initializer;
    } else break;
  }
  const call = api.isCallExpression(expr) ? expr : undefined;
  const factory = collection ? "defineCollection" : "defineAction";
  const definition = call?.arguments[0] ?? expr;
  const object = checker.getTypeAtLocation(definition);
  if (object.getProperty(key)) return;
  if (
    call && r.symbolAt(call.expression)?.name !== factory && call.expression.getText() !== factory
  ) {
    // Existing factories can return complete declarations of their own.
    if (checker.getTypeAtLocation(call).getProperty(key)) return;
    throw new Error(`${key}: expected ${factory}({...}) or a declaration object`);
  }
  if (collection) {
    if (!call) return; // A plain { indexes } extends an earlier collection.
    const type = call.typeArguments?.[0];
    if (!type) throw new Error("schema: give defineCollection a document type or a schema");
    const doc = checker.getTypeFromTypeNode(type);
    const members = doc.isUnion() ? doc.types : [doc];
    if (
      members.some((t) =>
        !(t.flags & (api.TypeFlags.Object | api.TypeFlags.Intersection)) ||
        checker.isArrayType(t) || checker.isTupleType(t)
      )
    ) {
      throw new Error("schema: a document must be an object");
    }
    return converter(r, type, true)(doc, key, type);
  }
  const run = object.getProperty("run");
  const signatures = run && checker.getTypeOfSymbolAtLocation(run, expr).getCallSignatures();
  const decl = signatures?.length === 1 && signatures[0].getDeclaration();
  if (!decl) throw new Error("input: expected a single run signature");
  const input = decl.parameters.filter((p) => p.name.getText() !== "this")[1];
  if (!input) return;
  if (!input.type) throw new Error("input: declare the type of run's second parameter");
  return converter(r, input.type, false)(
    checker.getTypeFromTypeNode(input.type),
    "input",
    input.type,
  );
}

/** Read Action input annotations and collection type arguments with one app TypeScript program.
 * Results use the supplied file paths. Explicit schemas and declarations needing none are skipped.
 */
export async function schemasFromTypes(
  sources: readonly Source[],
  options: Options = {},
): Promise<Map<string, Result | undefined>> {
  const files = sources.map((s) => s.file);
  const results = new Map<string, Result | undefined>();
  if (!files.length) return results;
  const api = options.ts ?? await appCompiler(options.tsconfig ?? files[0]);
  const config = options.tsconfig
    ? resolve(options.tsconfig)
    : api.findConfigFile(dirname(resolve(files[0])), api.sys.fileExists);
  let compilerOptions: ts.CompilerOptions = { module: api.ModuleKind.NodeNext, types: [] };
  let ambient: string[] = [];
  if (config) {
    const read = api.readConfigFile(config, api.sys.readFile);
    const parsed = api.parseJsonConfigFileContent(
      read.config ?? {},
      api.sys,
      dirname(config),
      {},
      config,
    );
    const error = read.error ?? parsed.errors.find((d) => d.code !== 18003);
    if (error) {
      throw new Error(`${config}: ${api.flattenDiagnosticMessageText(error.messageText, "\n")}`);
    }
    compilerOptions = { ...compilerOptions, ...parsed.options };
    ambient = parsed.fileNames.filter((f) => /\.d\.[cm]?ts$/.test(f));
  }
  const program = api.createProgram([...files.map((f) => resolve(f)).sort(), ...ambient], {
    ...compilerOptions,
    strictNullChecks: true,
    noEmit: true,
  });
  const r = reader(api, program);
  for (const { file, kind } of sources) {
    const key = kind === "actions" ? "input" : "schema";
    try {
      const source = program.getSourceFile(resolve(file));
      if (!source) throw new Error(`${key}: cannot read the file`);
      const syntax = program.getSyntacticDiagnostics(source)[0];
      if (syntax) {
        throw new Error(`${key}: ${api.flattenDiagnosticMessageText(syntax.messageText, "\n")}`);
      }
      const schema = declarationSchema(source, kind, r);
      results.set(file, schema ? { schema } : undefined);
    } catch (error) {
      const hint = kind === "actions"
        ? "write `input` by hand for this Action"
        : "write `schema` by hand for this collection";
      results.set(file, {
        error: `${file}: ${error instanceof Error ? error.message : error}; ${hint}`,
      });
    }
  }
  return results;
}

/** Read only Action inputs. Each result is keyed by the supplied Action path. */
export function inputSchemas(
  files: readonly string[],
  options: Options = {},
): Promise<Map<string, Result | undefined>> {
  return schemasFromTypes(files.map((file) => ({ file, kind: "actions" })), options);
}
