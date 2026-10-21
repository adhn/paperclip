import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** A local transcript barrier only. Neither result proves original deletion,
 * provider termination, descendant exclusion or physical session retirement. */
export async function retirePoisonedLocalTranscript(input: { claudeConfigDir: string; cwd: string; sessionId: string }): Promise<"local-unlink-returned" | "local-absence-observed"> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.sessionId) || input.sessionId.includes("\0"))
    throw new Error("Claude transcript session identity requires inspection");
  const encodedCwd = input.cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  if (!encodedCwd) throw new Error("Claude transcript project identity requires inspection");
  const parent = path.join(input.claudeConfigDir, "projects", encodedCwd);
  const file = path.join(parent, `${input.sessionId}.jsonl`);
  const observed = await fs.lstat(parent); // Missing parent cannot acknowledge cleanup.
  if (!observed.isDirectory() || observed.isSymbolicLink()) throw new Error("Claude transcript parent requires inspection");
  const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const failures: unknown[] = [];
  let result: "local-unlink-returned" | "local-absence-observed" = "local-absence-observed";
  const assertParent = async () => {
    const current = await fs.lstat(parent);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino)
      throw new Error("Claude transcript parent changed during cleanup");
  };
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || held.dev !== observed.dev || held.ino !== observed.ino) throw new Error("Claude transcript parent changed before cleanup");
    await assertParent();
    let present = true;
    try {
      const target = await fs.lstat(file);
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error("Claude transcript target requires inspection");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") throw error;
      present = false;
    }
    await assertParent();
    if (present) {
      try { await fs.unlink(file); result = "local-unlink-returned"; }
      catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") throw error; }
    }
    await assertParent();
    await handle.sync();
    await assertParent();
  } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Claude transcript cleanup and descriptor close failed");
  return result;
}
