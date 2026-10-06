# MCP resource authoring

`await defineMcp` discovers one server catalog, validates selected tool names,
closes discovery, and contributes compiled tools with their default runtime
connection. Runtime calls do not rediscover the catalog.
