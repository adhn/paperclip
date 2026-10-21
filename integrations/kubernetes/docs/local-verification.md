# Local verification, 2026-10-13

This is jail-side evidence only. No SSH connection to homelab nodes, cluster inventory, Kubernetes mutation, image push, provider login/model invocation, backup configuration or Telegram message occurred. The active Flux root is unchanged; this package is unreferenced and left uncommitted.

| Check | Observed result | Scope |
| --- | --- | --- |
| Source preparation | PASS: fetched exact revision `252d9b5077f4eee98ec48225641ef1a02d824158`, generated patched build context | Source/recipe preparation only |
| Original upstream frozen pnpm lock | FAIL: server declares OpenTelemetry context-async-hooks/sdk-trace 2.10.0 absent from original lock | Upstream reproducibility defect |
| Included pnpm lock override | PASS: pinned pnpm 9.15.4 resolves a 52-line addition; subsequent frozen lock-only validation passes across 36 workspace projects | No installation scripts, compilation or image build executed |
| Runner npm locks | PASS: exact provider/TypeScript versions, registry URLs and integrity hashes; static manifest/lock consistency passes | Actual installation/binary compatibility pending |
| Kustomize v5.8.0 rendering | PASS | Standalone evaluation base only; does not validate live Flux reconciliation |
| Kubeconform v0.7.0 strict Kubernetes 1.32.0 schemas | PASS: 19 resources valid, no errors/skips | Static built-in API schemas; no server admission |
| Restriction/configuration validator | PASS | Four separate claims, restricted pod settings, no runner token/controller secrets, explicit SSH/CLI, inactive root path |
| Readiness and local execution guard | PASS: mocked ok succeeds; starting/unhealthy/HTTP errors/connection errors fail; local provider guard returns 126 | Mocked health responses, not real application health |
| Disposable fixture baseline | PASS: TypeScript 5.9.3 compilation, one Node test and one Python unittest | Host Node 25.9.0/Python; not built runner toolchain or agent-authored changes |
| Shell/Python syntax | PASS | Does not establish runtime behavior |
| Docker access | BLOCKED: Unix socket permission denied | Images not built; rootless SSH image fixture NOT RUN |
| Kubectl access | BLOCKED: snap-confine missing required permitted cap_dac_override | No cluster context/inventory obtained |
| All live provider/cancellation/containment/recovery gates | NOT RUN | Workstation handoff required |

Kustomize and kubeconform temporary binaries were downloaded from their official GitHub releases and verified against release checksums. They are not added to the repository. npm/pnpm resolution was done without installation scripts. pnpm reports a better-auth/vitest peer-range warning (better-auth accepts vitest through v4, workspace declares v5); it remains a build/test input to inspect, not a demonstrated runtime defect.

Build inputs use a digest-pinned multi-architecture Node base and signed Debian archive dated 20261001. A resulting controller or runner image digest, Python/OS package versions, CLI native architecture support and full build remain **unverified**. Do not label these image recipes production-ready.

The included Docker SSH fixture is ready to run on a build host and deliberately uses disposable volumes/keys, no provider credentials and loopback-only published SSH. It can prove rootless sshd/CLI discovery and container-replacement persistence; it cannot prove Kubernetes fsGroup/fencing, provider renewal, remote descendants stopping or CNI isolation.
