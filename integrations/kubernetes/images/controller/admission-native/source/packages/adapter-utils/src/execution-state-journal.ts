import { AsyncLocalStorage } from "node:async_hooks";

export type ExecutionStateKind = "workspace" | "session" | "credential";
export interface ExecutionStateJournal {
  require(kind: ExecutionStateKind, descriptor: Record<string, unknown>): Promise<string>;
  mutate?<T>(body: () => Promise<T>): Promise<T>;
  checkpoint?(id: string, kind: ExecutionStateKind, descriptor: Record<string, unknown>): Promise<void>;
  restore<T>(id: string, kind: ExecutionStateKind, body: () => Promise<T>): Promise<T>;
}
const state = new AsyncLocalStorage<ExecutionStateJournal>();
export function withExecutionStateJournal<T>(journal: ExecutionStateJournal, body: () => Promise<T>) {
  return state.run(journal, body);
}
export async function requireExecutionStateRestoration(kind: ExecutionStateKind, descriptor: Record<string, unknown>) {
  const journal = state.getStore();
  const id = journal ? await journal.require(kind, structuredClone(descriptor)) : undefined;
  return Object.assign(<T>(body: () => Promise<T>) => journal && id ? journal.restore(id, kind, body) : body(), {
    checkpoint: async (next: Record<string, unknown>) => {
      if (journal && id) {
        if (!journal.checkpoint) throw new Error("execution_state_checkpoint_unavailable");
        await journal.checkpoint(id, kind, structuredClone(next));
      }
    },
  });
}

/** Called inside the destination writer lock, around local mutations only.
 * Never hold this fence while making SSH calls or writing admission records. */
export function withExecutionStateMutation<T>(body: () => Promise<T>): Promise<T> {
  const journal = state.getStore();
  if (!journal) return body();
  if (!journal.mutate) throw new Error("execution_state_mutation_unavailable");
  return journal.mutate(body);
}
