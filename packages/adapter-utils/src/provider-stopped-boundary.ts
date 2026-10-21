/** Per-adapter invocation fence. A failed later attempt invalidates an earlier
 * stop receipt; a late callback from that earlier attempt cannot restore it. */
type StopProof = { sshInvocationId: string };
export function createProviderStoppedBoundary(onProviderStopped?: (proof?: StopProof) => Promise<void>) {
  let proof: StopProof | undefined;
  let invocation = 0;
  let stopped = false;
  let collected = false;
  return {
    beginInvocation(): (value?: StopProof) => void {
      const current = ++invocation;
      stopped = false;
      proof = undefined;
      return (value) => { if (invocation === current) { stopped = true; proof = value; } };
    },
    async collectBeforeRestore() {
      if (!stopped || collected || !onProviderStopped) return;
      collected = true;
      await onProviderStopped(proof);
    },
  };
}
