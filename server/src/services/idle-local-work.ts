import { inspectPending as inspectPendingSetupMessages } from "./connectors/slack/setup/setup-message-recovery.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { idleWorkSnapshot } from "./task-admission.js";

export type IdleLocalWork = "none" | "present" | "unknown";
const spoolDirectories = new Set<string>();
export function registerIdleSpoolDirectory(directory: string): void { spoolDirectories.add(path.resolve(directory)); }
export const idleAccountingSpoolPath = () => path.join(resolvePaperclipInstanceRoot(), "accounting-receipts");
export const idleOrphanSpoolPath = () => process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR ??
  path.join(resolvePaperclipInstanceRoot(), "data", "sandbox-orphan-cleanup");
export const idleRegistrationCleanupRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-registration-cleanup-recovery");
export const idleStagedCleanupRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-staged-cleanup-recovery");
export const idleManagedInstallRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-managed-install-recovery");
export const idleManagerRevokeRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-revoke-recovery");
export const idleManagerClaimRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-claim-recovery");
export const idleManagerRefreshRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-manager-refresh-recovery");
export const idleSlackInstallRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "slack-install-recovery");
export const idleQuotaRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "quota-credential-recovery");
let startupComplete = false;
let ingressTracked = false;
let scheduledBackups = false;
export function markIdleIngressTracked() { ingressTracked = true; }
export function markIdleStartupComplete(options: { scheduledBackups: boolean }) {
  scheduledBackups = options.scheduledBackups;
  startupComplete = true;
}

/** Any entry, including malformed JSON, a temp file or a failed probe, is
 * evidence to retain. Recovery readers intentionally skip some such files;
 * they cannot certify that stopping the process is safe. */
export async function inspectIdleSpool(directory: string): Promise<IdleLocalWork> {
  return inspectSpool(directory, true);
}

async function inspectSpool(directory: string, allowAbsent: boolean): Promise<IdleLocalWork> {
  let info;
  try { info = await fs.lstat(directory); }
  catch (error) { return allowAbsent && (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown"; }
  try {
    if (!info.isDirectory() || info.isSymbolicLink()) return "unknown";
    const dir = await fs.opendir(directory);
    let state: IdleLocalWork;
    try { state = (await dir.read()) === null ? "none" : "present"; }
    finally { await dir.close(); }
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) return "unknown";
    return state;
  } catch (error) {
    return "unknown";
  }
}

/** Credential journals are grouped by company. Successful recovery leaves its
 * empty company directory behind; every file, probe or unexpected entry still
 * blocks. Never decrypt journals or follow directory symlinks during a scan. */
export async function inspectIdleQuotaRecovery(directory: string): Promise<IdleLocalWork> {
  let info;
  try { info = await fs.lstat(directory); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown"; }
  try {
    if (!info.isDirectory() || info.isSymbolicLink()) return "unknown";
    const dir = await fs.opendir(directory);
    try {
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        if (!entry.isDirectory() || entry.isSymbolicLink()
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) return "present";
        const state = await inspectSpool(path.join(directory, entry.name), false);
        if (state !== "none") return state;
      }
    } finally { await dir.close(); }
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) return "unknown";
    return "none";
  } catch (error) {
    return "unknown";
  }
}

export async function readIdleLocalWork(options: { backupCheckpoint?: boolean } = {}): Promise<IdleLocalWork> {
  if (!startupComplete || !ingressTracked) return "unknown";
  // This exemption belongs only to a scan which will finish a new backup
  // under the same admission hold before it can return an empty report.
  if ((scheduledBackups && !options.backupCheckpoint) || idleWorkSnapshot().active !== 0) return "present";
  const directories = new Set([...spoolDirectories, idleAccountingSpoolPath(), idleOrphanSpoolPath()]);
  const results = await Promise.all([
    ...[...directories].map(inspectIdleSpool),
    inspectIdleQuotaRecovery(idleQuotaRecoveryPath()),
    inspectIdleQuotaRecovery(idleSlackInstallRecoveryPath()),
    inspectIdleQuotaRecovery(idleManagerRefreshRecoveryPath()),
    inspectIdleQuotaRecovery(idleManagerClaimRecoveryPath()),
    inspectIdleQuotaRecovery(idleManagerRevokeRecoveryPath()),
    inspectIdleQuotaRecovery(idleManagedInstallRecoveryPath()),
    inspectIdleQuotaRecovery(idleStagedCleanupRecoveryPath()),
    inspectIdleQuotaRecovery(idleRegistrationCleanupRecoveryPath()),
    inspectPendingSetupMessages(),
  ]);
  if (results.includes("unknown")) return "unknown";
  return results.includes("present") ? "present" : "none";
}
