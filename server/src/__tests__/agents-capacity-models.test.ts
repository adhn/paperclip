import type { Db } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installExecutionCapacity } from "../services/execution-capacity-context.js";

const discovery = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: "dynamic", label: "Dynamic" }]),
  refresh: vi.fn(async () => [{ id: "refreshed", label: "Refreshed" }]),
  detect: vi.fn(async () => "detected"),
  openrouter: vi.fn(),
  pools: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  agentService: () => ({}), agentInstructionsService: () => ({}), accessService: () => ({}),
  approvalService: () => ({}), builtInAgentService: () => ({}), companySkillService: () => ({}),
  budgetService: () => ({}), heartbeatService: () => ({}), ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}), issueRecoveryActionService: () => ({}), issueService: () => ({}),
  logActivity: vi.fn(), syncInstructionsBundleConfigFromFilePath: vi.fn(), workspaceOperationService: () => ({}),
}));
vi.mock("../adapters/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/index.js")>(),
  listAdapterModels: discovery.list, refreshAdapterModels: discovery.refresh, detectAdapterModel: discovery.detect,
}));
vi.mock("../services/openrouter-models.js", () => ({ listOpenRouterModels: discovery.openrouter }));
vi.mock("../services/ai-connection-router.js", () => ({ aiConnectionRouterService: discovery.pools, poolMemberRuntimeConfig: vi.fn() }));
let routes: typeof import("../routes/agents.js").agentRoutes;
beforeAll(async () => { routes = (await import("../routes/agents.js")).agentRoutes; });
beforeEach(() => vi.clearAllMocks());

function app(capacity: boolean, companyId = "company") {
  const db = {} as Db;
  if (capacity) installExecutionCapacity(db, {} as never);
  const server = express();
  server.use((req, _res, next) => { req.actor = { type: "agent", agentId: "agent", companyId }; next(); });
  server.use(routes(db));
  return server;
}
const base = "/companies/company/adapters";
describe("capacity model discovery routes", () => {
  it("serves only static metadata even with refresh, environment, provider and pool overrides", async () => {
    const server = app(true);
    for (const type of ["codex_local", "claude_local", "gemini_local", "opencode_local"]) {
      const result = await request(server).get(`${base}/${type}/models?refresh=true&environmentId=untrusted&provider=openrouter&poolId=untrusted`);
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body).not.toContainEqual({ id: "dynamic", label: "Dynamic" });
    }
    for (const spy of Object.values(discovery)) expect(spy).not.toHaveBeenCalled();
  });
  it("disables executable detection and retains company and adapter validation", async () => {
    expect((await request(app(true)).get(`${base}/codex_local/detect-model`)).body).toBeNull();
    expect((await request(app(true, "other")).get(`${base}/codex_local/models`)).status).toBe(403);
    expect((await request(app(true)).get(`${base}/unknown/models`)).status).toBe(422);
    expect(discovery.detect).not.toHaveBeenCalled();
  });
  it("preserves dynamic discovery and detection when capacity is absent", async () => {
    const server = app(false);
    expect((await request(server).get(`${base}/codex_local/models`)).body).toEqual([{ id: "dynamic", label: "Dynamic" }]);
    expect((await request(server).get(`${base}/codex_local/detect-model`)).body).toBe("detected");
    expect(discovery.list).toHaveBeenCalledOnce();
    expect(discovery.detect).toHaveBeenCalledOnce();
  });
});
