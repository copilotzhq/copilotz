# Compile Copilotz Apps with Deno

Use this playbook when you want to ship a Copilotz project as an executable
instead of requiring users to install Deno and run source files.

## Terminal CLI

Copilotz includes a helper script that generates a small terminal entrypoint and
compiles it with `deno compile`.

```bash
deno run -A jsr:@copilotz/copilotz/scripts/compile-cli \
  --resources ./resources \
  --imports agents.copilotz \
  --out ./copilotz-cli
```

By default, the generated CLI:

- starts `createCopilotz(...)`
- uses `copilotz.start({ banner })`
- stores local PGlite data in `file://~/.copilotz/<namespace>.db`
- writes a customizable `scripts/ascii-logo.ts`
- writes the generated entrypoint to `.copilotz/cli-entry.ts`
- includes local resource paths in the executable

For non-interactive setup, pass `--yes`. To only generate files and skip
compilation, pass `--setup-only`.

```bash
deno run -A jsr:@copilotz/copilotz/scripts/compile-cli \
  --yes \
  --setup-only \
  --namespace my-app \
  --resources ./resources \
  --imports agents.copilotz
```

The generated CLI exits explicitly after `quit`, including after
`copilotz.shutdown()`, so compiled binaries do not stay open because of
lingering runtime handles.

## Native Desktop Window

For a lightweight desktop app, pair the compiled backend/frontend with
`npm:@rcompat/webview`. The recommended template shape is:

```text
desktop.ts
desktop/native/.gitignore
desktop/native/.gitkeep
scripts/prepare-desktop-native.ts
web/dist/
```

`scripts/prepare-desktop-native.ts` copies the correct `webview.bin` from
`@rcompat/webview` into `desktop/native/<platform>/webview.bin` before compile.
Generated binaries should stay out of git; keep only `.gitignore` and
`.gitkeep`.

Example tasks:

```json
{
  "tasks": {
    "desktop": "deno run -A --env --config=deno.json desktop.ts",
    "prepare:desktop-native": "deno run -A --config=deno.json scripts/prepare-desktop-native.ts",
    "compile:desktop": "deno task prepare:desktop-native && deno compile -A --env --no-check --config=deno.json --include desktop/native --include web/dist --include api --include oxian.config.ts --include resources --include lib -o copilotz-desktop desktop.ts"
  }
}
```

The preparation script can accept a Deno compile target or a platform name:

```bash
deno task prepare:desktop-native --target=darwin-arm64
deno task prepare:desktop-native --target=x86_64-unknown-linux-gnu
deno task prepare:desktop-native --target=all
```

When cross-compiling, make sure the native WebView binary matches the target
platform. `deno compile --target=...` changes the executable target, but it does
not automatically rewrite native FFI assets for you.

## Secrets

`deno compile --env` embeds values from `.env` into the executable. That is
convenient for local testing, but for distributed builds prefer runtime
environment variables or a deployment-specific secret flow.

## Validation

After compiling a CLI:

```bash
./copilotz-cli
# type: quit
```

The process should exit with code `0`.

After compiling a desktop app:

```bash
./copilotz-desktop
```

The native window should open, serve the embedded frontend, and close its local
server when the app exits.
