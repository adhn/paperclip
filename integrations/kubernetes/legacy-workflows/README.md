# Inactive historical workflow definitions

These six YAML files were extracted from the homelab repository for reference. They are deliberately stored here, **not** under `.github/workflows/`, so GitHub Actions does not discover or execute them. Their preserved `on:` triggers and permission declarations do not activate them in this location.

- `paperclip-admission-fixtures.yaml`
- `paperclip-custody-crypto.yaml`
- `paperclip-evaluation-images.yaml`
- `paperclip-image-pvc-rehearsal.yaml`
- `paperclip-production-contracts.yaml`
- `paperclip-protected-execution.yaml`

The files retain historical repository paths, branch conditions, runner assumptions, image names and artifact conventions. Some workflows include publishing permissions or operations involving Kubernetes, storage or credentials. Their presence is not authorization to execute those operations. Do not copy them into `.github/workflows/`, dispatch an old workflow, replay a historical command or publish an image as part of the extraction.

An explicit workflow port must review the selected native source and revision, replace old path/build-context assumptions, identify required dependencies and credentials, preserve bounded verification containment, and separate verification from publication or live operations. Check historical overlay recipes against the native implementation before applying them. Review triggers, token permissions, artifact provenance, image destinations and resource limits before any activation. A runnable port and its verification evidence are future work, not a result claimed by this move.

See the [integration overview](../README.md) for source ownership and deployment boundaries. Existing historical passes remain evidence only for their recorded inputs and scope.
