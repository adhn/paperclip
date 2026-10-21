#!/bin/sh
set -eu
# Disposable image/SSH fixture only: no provider login, models, cluster or registry writes.
[ "$#" -eq 2 ] || { echo 'Usage: test-runner-image.sh IMAGE codex|claude|gemini' >&2; exit 2; }
image=$1
provider=$2
case "$provider" in codex|claude|gemini) ;; *) exit 2;; esac
fixture_dir=$(mktemp -d)
fixture_name=paperclip-ssh-fixture-$$
state_volume=$fixture_name-state
key_volume=$fixture_name-key
cleanup() {
  docker rm -f "$fixture_name" >/dev/null 2>&1 || true
  docker volume rm "$state_volume" "$key_volume" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM
umask 077
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/client"
docker volume create "$state_volume" >/dev/null
docker volume create "$key_volume" >/dev/null
# Fixture storage setup emulates volume ownership provided by Kubernetes fsGroup.
# This helper has no host mount, token or provider credential; it is not a runner pod.
docker run --rm --user 0 --entrypoint sh --mount "type=volume,src=$state_volume,dst=/state" --mount "type=volume,src=$key_volume,dst=/key" -i "$image" -c 'chown 1000:1000 /state; chmod 700 /state; cat > /key/authorized_keys; chmod 444 /key/authorized_keys' < "$fixture_dir/client.pub"
start_runner() {
  docker run -d --name "$fixture_name" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 1 --pids-limit 256 --tmpfs /tmp:rw,nosuid,nodev,size=64m --mount "type=volume,src=$state_volume,dst=/home/node" --mount "type=volume,src=$key_volume,dst=/etc/runner-ssh,readonly" -e "RUNNER_PROVIDER=$provider" -p 127.0.0.1::2222 "$image" >/dev/null
  port=$(docker port "$fixture_name" 2222/tcp | sed 's/.*://')
  attempt=0
  until docker exec "$fixture_name" test -s /home/node/.ssh/ssh_host_ed25519_key.pub; do
    attempt=$((attempt+1))
    [ "$attempt" -lt 30 ] || { docker logs "$fixture_name"; exit 1; }
    sleep 1
  done
  docker exec "$fixture_name" cat /home/node/.ssh/ssh_host_ed25519_key.pub > "$fixture_dir/host.pub"
  printf '[127.0.0.1]:%s ' "$port" > "$fixture_dir/known_hosts"
  cat "$fixture_dir/host.pub" >> "$fixture_dir/known_hosts"
}
remote() {
  ssh -F /dev/null -o GlobalKnownHostsFile=/dev/null -o "UserKnownHostsFile=$fixture_dir/known_hosts" -o StrictHostKeyChecking=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -i "$fixture_dir/client" -p "$port" node@127.0.0.1 "$@"
}
start_runner
# Retry listener startup, without relaxing key verification.
wait_login() {
  attempt=0
  until remote true; do
    attempt=$((attempt+1))
    [ "$attempt" -lt 15 ] || { docker logs "$fixture_name"; exit 1; }
    sleep 1
  done
}
wait_login
remote 'test "$(id -u)" = 1000 && test "$HOME" = /home/node && test -w "$HOME/workspaces"'
remote "test \"\$(cat /home/node/runner-marker)\" = $provider && $provider --version && node --version && python3 --version && tsc --version"
remote 'printf persistent > "$HOME/workspaces/fixture-state"'
# Workspace transfer must work through the configured internal SFTP subsystem.
printf sftp-transfer > "$fixture_dir/upload"
printf 'put %s /home/node/workspaces/sftp-state\nget /home/node/workspaces/sftp-state %s\n' "$fixture_dir/upload" "$fixture_dir/download" | sftp -q -b - -F /dev/null -o GlobalKnownHostsFile=/dev/null -o "UserKnownHostsFile=$fixture_dir/known_hosts" -o StrictHostKeyChecking=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -i "$fixture_dir/client" -P "$port" node@127.0.0.1
cmp "$fixture_dir/upload" "$fixture_dir/download"
# Exercise an actual reverse-forwarded callback, without external endpoints.
# The host HTTP fixture is bound only to loopback and exits after one request.
python3 -u - "$fixture_dir/http-port" <<'HTTP' &
import http.server, pathlib, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'bridge-fixture')
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
server.timeout = 15
pathlib.Path(sys.argv[1]).write_text(str(server.server_port))
server.handle_request()
server.server_close()
HTTP
http_pid=$!
attempt=0
until [ -s "$fixture_dir/http-port" ]; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 15 ] || exit 1
  sleep 1
done
http_port=$(cat "$fixture_dir/http-port")
ssh -F /dev/null -o GlobalKnownHostsFile=/dev/null -o "UserKnownHostsFile=$fixture_dir/known_hosts" -o StrictHostKeyChecking=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -o ExitOnForwardFailure=yes -i "$fixture_dir/client" -p "$port" -R "127.0.0.1:31991:127.0.0.1:$http_port" node@127.0.0.1 'test "$(curl --fail --silent --max-time 5 http://127.0.0.1:31991/)" = bridge-fixture'
wait "$http_pid"
cp "$fixture_dir/host.pub" "$fixture_dir/host.before"
docker rm -f "$fixture_name" >/dev/null
start_runner
cmp "$fixture_dir/host.before" "$fixture_dir/host.pub"
wait_login
remote 'test "$(cat "$HOME/workspaces/fixture-state")" = persistent'
printf '%s\n' 'PASS: image uses rootless key-only SSH with read-only rootfs and dropped capabilities; CLI discovery, SFTP, reverse callback forwarding, durable marker and host identity survive container replacement. Kubernetes/CNI/provider auth/cancellation NOT TESTED.'
