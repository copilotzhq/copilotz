import { assertEquals } from "@std/assert";

import {
  buildSessionKey,
  buildWorkspaceRoot,
  resolveBaseDir,
} from "@/resources/tools/persistent_terminal/index.ts";

Deno.test("persistent_terminal defaults its base dir to the current cwd", () => {
  const previous = Deno.env.get("COPILOTZ_WORKSPACES_DIR");
  try {
    Deno.env.delete("COPILOTZ_WORKSPACES_DIR");
    assertEquals(resolveBaseDir(), Deno.cwd());
  } finally {
    if (previous === undefined) Deno.env.delete("COPILOTZ_WORKSPACES_DIR");
    else Deno.env.set("COPILOTZ_WORKSPACES_DIR", previous);
  }
});

Deno.test("persistent_terminal uses isolated workspace roots when COPILOTZ_WORKSPACES_DIR is set", () => {
  const previous = Deno.env.get("COPILOTZ_WORKSPACES_DIR");
  try {
    Deno.env.set("COPILOTZ_WORKSPACES_DIR", "/tmp/copilotz-workspaces");
    assertEquals(resolveBaseDir(), "/tmp/copilotz-workspaces");
    assertEquals(
      buildWorkspaceRoot("tenant 1", "project 1", "agent-1", "agent"),
      "/tmp/copilotz-workspaces/tenant-1/project-1/agent-1",
    );
    assertEquals(
      buildWorkspaceRoot("tenant 1", "project 1", "agent-1", "project"),
      "/tmp/copilotz-workspaces/tenant-1/project-1",
    );
    assertEquals(
      buildWorkspaceRoot("tenant 1", "project 1", "agent-1", "tenant"),
      "/tmp/copilotz-workspaces/tenant-1",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("COPILOTZ_WORKSPACES_DIR");
    else Deno.env.set("COPILOTZ_WORKSPACES_DIR", previous);
  }
});

Deno.test("persistent_terminal uses the project root for all scopes when no isolated workspace base is configured", () => {
  const previous = Deno.env.get("COPILOTZ_WORKSPACES_DIR");
  try {
    Deno.env.delete("COPILOTZ_WORKSPACES_DIR");
    const cwd = Deno.cwd();
    assertEquals(
      buildWorkspaceRoot("tenant", "project", "agent-a", "agent"),
      cwd,
    );
    assertEquals(
      buildWorkspaceRoot("tenant", "project", "agent-a", "project"),
      cwd,
    );
    assertEquals(
      buildWorkspaceRoot("tenant", "project", "agent-a", "tenant"),
      cwd,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("COPILOTZ_WORKSPACES_DIR");
    else Deno.env.set("COPILOTZ_WORKSPACES_DIR", previous);
  }
});

Deno.test("persistent_terminal shares project and tenant session keys across agents", () => {
  const agentKeyA = buildSessionKey("tenant", "project", "agent-a", "agent");
  const agentKeyB = buildSessionKey("tenant", "project", "agent-b", "agent");
  const projectKeyA = buildSessionKey(
    "tenant",
    "project",
    "agent-a",
    "project",
  );
  const projectKeyB = buildSessionKey(
    "tenant",
    "project",
    "agent-b",
    "project",
  );
  const tenantKeyA = buildSessionKey(
    "tenant",
    "project-a",
    "agent-a",
    "tenant",
  );
  const tenantKeyB = buildSessionKey(
    "tenant",
    "project-b",
    "agent-b",
    "tenant",
  );

  assertEquals(agentKeyA === agentKeyB, false);
  assertEquals(projectKeyA, projectKeyB);
  assertEquals(tenantKeyA, tenantKeyB);
});
