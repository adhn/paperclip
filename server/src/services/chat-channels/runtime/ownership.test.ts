import { describe, expect, it, vi } from "vitest";
import { createChatReceiverOwnership } from "./ownership.js";
import type { DiscordGatewayOwnership } from "../runtime-types.js";

function fixture() {
  const endpointRuntime = {};
  const ownership = {
    companyId: "company", endpointId: "endpoint", leaseKey: "receiver", token: "original-token",
    context: { endpointRuntime, discordGatewayOwned: true },
    expiresAt: new Date(Date.now() + 60_000), stopping: false,
    stopPromise: null, renewal: null, renewTimer: null,
  } as unknown as DiscordGatewayOwnership;
  const ownerships = new Map([[ownership.endpointId, ownership]]);
  const removeEndpoint = vi.fn(async () => true);
  const release = vi.fn(async () => {});
  const runtime = { get: vi.fn(() => endpointRuntime), removeEndpoint };
  const tasks = new Set<Promise<void>>();
  const api = createChatReceiverOwnership({ delete: () => ({ where: release }) } as never, {
    runtime: runtime as never, runtimeVersions: new Map([["endpoint", "old"]]),
    runtimeCallbackEndpoint: vi.fn() as never, redactError: String,
    leasedChatProvider: () => true, discordGatewayOwnerships: ownerships,
    discordGatewayStopTasks: tasks, isShuttingDown: () => false,
  });
  return { api, ownership, ownerships, runtime, removeEndpoint, release, tasks };
}

describe("receiver ownership cleanup retention", () => {
  it("retains original lease on failed endpoint cleanup and retries the retiring instance", async () => {
    const f = fixture();
    f.removeEndpoint.mockRejectedValueOnce(new Error("disconnect failed"));
    await expect(f.api.stopDiscordGatewayOwnership(f.ownership)).rejects.toThrow("disconnect failed");
    expect(f.release).not.toHaveBeenCalled();
    expect(f.ownerships.get("endpoint")).toBe(f.ownership);
    expect(f.ownership.stopping).toBe(true);
    expect(f.ownership.stopPromise).toBeNull();
    f.runtime.get.mockReturnValue(null as never);
    await f.api.stopDiscordGatewayOwnership(f.ownership);
    expect(f.removeEndpoint).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.ownerships.has("endpoint")).toBe(false);
  });

  it("retains exact identity when database release fails", async () => {
    const f = fixture();
    f.release.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.api.stopDiscordGatewayOwnership(f.ownership)).rejects.toThrow("database unavailable");
    expect(f.ownerships.get("endpoint")).toBe(f.ownership);
    expect(f.ownership.token).toBe("original-token");
    await f.api.stopDiscordGatewayOwnership(f.ownership);
    expect(f.ownerships.has("endpoint")).toBe(false);
  });

  it("refuses to release an old token by stopping a different runtime", async () => {
    const f = fixture();
    f.runtime.get.mockReturnValue({});
    await expect(f.api.stopDiscordGatewayOwnership(f.ownership)).rejects.toThrow("different endpoint runtime");
    expect(f.removeEndpoint).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.ownerships.get("endpoint")).toBe(f.ownership);
  });
});
