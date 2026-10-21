import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { legacyHoldFingerprint, type LegacyEvidenceVerifier } from "./execution-legacy-reconciliation.js";
import { capacityFingerprint } from "./execution-capacity-policy.js";

function protectedPath(path: string, directory: boolean) {
  if (!isAbsolute(path) || path.split("/").some(part => part === "." || part === ".."))
    throw Error("legacy_bridge_protected_path_required");
  let current = path;
  for (;;) {
    const entry = lstatSync(current);
    if (entry.uid !== 0 || (entry.mode & 0o022) || entry.isSymbolicLink() ||
        (current === path && !directory ? !entry.isFile() || (path.endsWith(".py") && entry.size > 2 * 1024 * 1024) : !entry.isDirectory()))
      throw Error("legacy_bridge_protected_path_required");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Host-only adapter for the mandatory native evidence callback. No signer,
 * append caller, authority issuer or lifecycle writer. Paths come from protected
 * host installation, never decisions. Missing installer/current evidence holds.
 * Python separately fd-walks all configured evidence/key paths without symlinks.
 */
export function legacyEvidenceBridge(options: {
  python: string; moduleRoot: string; deadlineMs?: number;
}): LegacyEvidenceVerifier {
  const python = options.python, moduleRoot = options.moduleRoot;
  const deadlineMs = options.deadlineMs ?? 3000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000)
    throw Error("legacy_bridge_bounded_deadline_required");
  return async input => {
    let body: Buffer;
    const challenge = randomBytes(32).toString("hex");
    try {
      protectedPath(python, false);
      protectedPath(moduleRoot, true);
      // The complete executable dependency surface is independently installed;
      // no working-directory imports from a provider/runner checkout are allowed.
      for (const name of ["legacy_review.py", "production", "production/__init__.py", "production/evidence_bridge.py"])
        protectedPath(join(moduleRoot, name), name === "production");
      if (input.holds.length < 1 || input.holds.length > 256) throw Error();
      const holds = input.holds.map(hold => {
        if (!/^lease:[a-f0-9-]{36}$/.test(hold.source) || !hold.companyId || !hold.agentId ||
            !hold.runId || !hold.environmentId) throw Error();
        return { source: hold.source, holdHash: legacyHoldFingerprint(hold), companyId: hold.companyId,
          agentId: hold.agentId, runId: hold.runId, leaseId: hold.source.slice(6), environmentId: hold.environmentId,
          scopes: structuredClone(hold.scopes), policyHash: hold.policyHash, epoch: input.decision.epoch };
      }).sort((a, b) => a.source.localeCompare(b.source));
      if (new Set(holds.map(hold => hold.source)).size !== holds.length ||
          capacityFingerprint(holds.map(({ source, holdHash }) => ({ source, holdHash }))) !== input.inventoryHash)
        throw Error();
      body = Buffer.from(JSON.stringify({ operation: "review", decision: structuredClone(input.decision),
        holds, inventoryHash: input.inventoryHash, now: input.now, challenge }));
      if (body.length > 2 * 1024 * 1024) throw Error();
    } catch { throw Error("legacy_bridge_protected_inputs_unavailable"); }
    return new Promise((resolve, reject) => {
      let finished = false;
      let child: ReturnType<typeof spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        child?.kill("SIGKILL");
        reject(Error("legacy_bridge_review_held"));
      };
      try {
        // -B alone still READS existing pyc. Compile the two verified source
        // files directly, with no project import search/cache or package init.
        // -I excludes cwd/user/PYTHONPATH; stdlib is the trusted interpreter.
        const loader = "import os,sys,types;root=sys.argv[1];" +
          "m=types.ModuleType('legacy_review');m.__file__=os.path.join(root,'legacy_review.py');" +
          "sys.modules['legacy_review']=m;" +
          "exec(compile(open(m.__file__,'rb').read(2097153),m.__file__,'exec',dont_inherit=True),m.__dict__);" +
          "p=os.path.join(root,'production','evidence_bridge.py');" +
          "exec(compile(open(p,'rb').read(2097153),p,'exec',dont_inherit=True),{'__name__':'__main__','__file__':p})";
        child = spawn(python, ["-I", "-B", "-c", loader, moduleRoot], {
          cwd: moduleRoot, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
        });
        timer = setTimeout(fail, deadlineMs);
        const chunks: Buffer[] = []; let bytes = 0, errors = 0;
        child.on("error", fail);
        child.stdin!.on("error", fail);
        child.stdout!.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) { fail(); return; }
          chunks.push(chunk);
        });
        child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 16384) fail(); });
        child.on("close", code => {
          if (finished) return;
          if (code !== 0) { fail(); return; }
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!result || Object.keys(result).sort().join(",") !== "challenge,decisionHash,expiresAt,inventoryHash,operationalAcceptance" ||
                result.challenge !== challenge || result.operationalAcceptance !== false ||
                result.decisionHash !== capacityFingerprint(input.decision) || result.inventoryHash !== input.inventoryHash ||
                !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() ||
                result.expiresAt > input.now + 60000 || result.expiresAt > input.decision.expiresAt) throw Error();
            finished = true; clearTimeout(timer);
            resolve({ decisionHash: result.decisionHash, inventoryHash: result.inventoryHash, expiresAt: result.expiresAt });
          } catch { fail(); }
        });
        child.stdin!.end(body);
      } catch { fail(); }
    });
  };
}
