import "zod";

// SDK 1.x exports map ./* to dist/esm/* for code and dist/esm/*.d.ts
// for types: runtime needs .js, while the declaration path must omit it.
// @ts-types="@modelcontextprotocol/sdk/client/stdio"
export * from "@modelcontextprotocol/sdk/client/stdio.js";
