#!/bin/sh
set -eu
# Build locally only. No push and no Flux activation.
[ "$#" -eq 3 ] || { echo 'Usage: build-images.sh NEW_CONTROLLER_CONTEXT REGISTRY_PREFIX linux/amd64|linux/arm64' >&2; exit 2; }
context=$1
prefix=$2
platform=$3
case "$platform" in linux/amd64|linux/arm64) ;; *) exit 2;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python3 "$root/scripts/prepare-controller.py" "$context"
revision=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sourceRevision"])' "$root/images/inputs.json")
docker buildx build --load --label org.opencontainers.image.source=https://github.com/adhn/homelab --platform "$platform" --target production --build-arg "PAPERCLIP_BUILD_COMMIT=$revision" -f "$context/Dockerfile.evaluation" -t "$prefix/controller:eval-${revision}" "$context"
for provider in codex claude gemini; do
  docker buildx build --load --label org.opencontainers.image.source=https://github.com/adhn/homelab --platform "$platform" --build-arg "PROVIDER=$provider" -t "$prefix/runner-$provider:eval-${revision}" "$root/images/runner"
  docker run --rm --entrypoint sh "$prefix/runner-$provider:eval-${revision}" -c "node --version; python3 --version; tsc --version; $provider --version; cat /opt/runner/os-packages.txt"
done
docker buildx build --load --label org.opencontainers.image.source=https://github.com/adhn/homelab --platform "$platform" -t "$prefix/lan-proxy:eval-${revision}" "$root/images/lan-proxy"
printf '%s\n' 'Builds completed locally. Push explicitly, record registry digests and verify SSH before activation.'
