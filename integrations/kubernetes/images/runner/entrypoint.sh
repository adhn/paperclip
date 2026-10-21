#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME/.ssh" "$HOME/workspaces" "$HOME/.cache" "$HOME/.local/bin"
chmod 700 "$HOME/.ssh"
if [ ! -f "$HOME/.ssh/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$HOME/.ssh/ssh_host_ed25519_key"
fi
[ -s /etc/runner-ssh/authorized_keys ] || { echo 'Missing controller authorized key' >&2; exit 1; }
printf '%s\n' "${RUNNER_PROVIDER:?}" > "$HOME/runner-marker"
/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
