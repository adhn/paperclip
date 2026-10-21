#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: test-lan-proxy-image.sh IMAGE' >&2; exit 2; }
image=$1
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir=$(mktemp -d)
fixture_name=paperclip-lan-fixture-$$
fixture_volume=$fixture_name-tls
cleanup() {
  docker rm -f "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$fixture_volume" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM
umask 077
# Ephemeral fixture certificate only; it is not the CA to trust on devices.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=paperclip.home -addext subjectAltName=DNS:paperclip.home -keyout "$fixture_dir/tls.key" -out "$fixture_dir/tls.crt" >/dev/null 2>&1
python3 - "$root/private-ingress/proxy.yaml" "$fixture_dir/Caddyfile" <<'PY'
import pathlib, sys, yaml
objects=list(yaml.safe_load_all(pathlib.Path(sys.argv[1]).read_text()))
config=next(x['data']['Caddyfile'] for x in objects if x['kind']=='ConfigMap')
pathlib.Path(sys.argv[2]).write_text(config)
PY
# Model projected Secret ownership independently of the host runner's UID.
# The ephemeral TLS key stays private; only the public config is world-readable.
chmod 644 "$fixture_dir/Caddyfile"
docker volume create "$fixture_volume" >/dev/null
docker run --rm --user 0 --entrypoint sh -v "$fixture_dir:/fixture:ro" --mount "type=volume,src=$fixture_volume,dst=/tls" "$image" -c 'cp /fixture/tls.key /fixture/tls.crt /tls/; chown 0:1000 /tls/tls.key; chmod 440 /tls/tls.key; chmod 444 /tls/tls.crt'
# Docker bridge clients are outside the real LAN allowlist and must be denied.
docker run -d --name "$fixture_name" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=32m -e XDG_DATA_HOME=/tmp/data -e XDG_CONFIG_HOME=/tmp/config --mount "type=volume,src=$fixture_volume,dst=/etc/paperclip-tls,readonly" -v "$fixture_dir/Caddyfile:/etc/caddy/Caddyfile:ro" -p 127.0.0.1::8443 "$image" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
port=$(docker port "$fixture_name" 8443/tcp | sed 's/.*://')
attempt=0
while :; do
  status=$(curl --silent --show-error --noproxy '*' --max-time 3 --cacert "$fixture_dir/tls.crt" --resolve "paperclip.home:$port:127.0.0.1" -o "$fixture_dir/body" -w '%{http_code}' "https://paperclip.home:$port/" 2>/dev/null || true)
  [ "$status" = 403 ] && break
  attempt=$((attempt+1))
  [ "$attempt" -lt 15 ] || { docker logs "$fixture_name"; exit 1; }
  sleep 1
done
status=$(curl --silent --show-error --noproxy '*' --max-time 5 --cacert "$fixture_dir/tls.crt" --resolve "paperclip.home:$port:127.0.0.1" -H 'X-Forwarded-For: 192.168.1.42' -H 'X-Real-IP: 192.168.1.42' -H 'Forwarded: for=192.168.1.42;proto=https' -o "$fixture_dir/spoof-body" -w '%{http_code}' "https://paperclip.home:$port/")
[ "$status" = 403 ]
grep -q 'LAN access required' "$fixture_dir/spoof-body"
printf '%s\n' 'PASS: UID-1000 LAN proxy runs with read-only rootfs and no capabilities; TLS hostname verifies with fixture CA; non-LAN direct peer remains denied with forged forwarding headers. Real LAN routing/tunnel/CA trust NOT TESTED.'
