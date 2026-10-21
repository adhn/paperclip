# Kubernetes integration material

This directory preserves the Paperclip-specific material extracted from the homelab repository on 2026-10-21. The migration branch is based on Paperclip revision `252d9b5077f4eee98ec48225641ef1a02d824158`; extraction does not establish compatibility with a different upstream revision or change deployed behavior.

## Source ownership

Actual Paperclip implementation belongs at its normal repository paths: [`server/`](../../server/), [`packages/adapters/`](../../packages/adapters/), [`packages/adapter-utils/`](../../packages/adapter-utils/) and [`packages/db/`](../../packages/db/). Review and change those sources directly. The preserved overlay patches and transformation recipes here describe earlier image assembly; they are not an additional source of truth to apply automatically over the native implementation.

| Directory | Preserved purpose |
| --- | --- |
| [`images/`](images/) | Image support files, historical overlay recipes, source expectations and candidate metadata. |
| [`scripts/`](scripts/) | Historical verification, assembly and operational helpers. |
| [`protected-execution/`](protected-execution/) | Candidate protected-execution implementation, fixtures and design/review records; its own README records unresolved integration prerequisites. |
| [`fixture/`](fixture/), [`fixtures/`](fixtures/) | Disposable verification inputs and test harnesses, distinct from live deployment authority. |
| [`docs/`](docs/) | Dated design, review and evidence records. Historical statuses retain their original scope. |
| [`legacy-workflows/`](legacy-workflows/) | Six inactive workflow definitions preserved for review, outside GitHub Actions discovery. |

## Reading historical commands

The extracted files retain their original bytes and directory structure. Embedded commands and links may still refer to `clusters/homelab/infrastructure/paperclip-evaluation/`, an old checkout, historical branches, CI jobs, images or operator-specific paths. They are historical instructions, not immediately executable commands from this fork. Do not infer that a successful old fixture qualifies the current native source, a new image or the live cluster.

Before adapting a recipe, identify its exact source revision, working directory, inputs, expected generated outputs, dependencies, resource containment and external effects. Check whether the native source already contains the overlay change; reapplying an old patch may duplicate or conflict with it. Any replacement recipe needs its own review and verification against exact current inputs. This README intentionally supplies no automatic replay or publishing command.

## Deployment boundary

This extraction moves ownership of development material. It does not enable CI, build or publish images, install dependencies, provision credentials, migrate data, reconcile historical holds or change any running workload. The homelab repository remains responsible for cluster-specific GitOps configuration and reviewed digest pins. Preserve existing holds, paused agents, disabled timers and deployment/backup prerequisites until their separately authorized resolution.

Workflow activation requires an explicit reviewed port; see the [inactive workflow notes](legacy-workflows/README.md). Deployment or migration requires a separately reviewed concrete rollout and recovery plan. Candidate labels, cached images, local fixtures and historical reports are not operational acceptance.
