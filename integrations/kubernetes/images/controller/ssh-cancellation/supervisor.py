"""Linux evaluation SSH supervisor: own/reap descendants, including setsid children.

Invoked with an unpredictable invocation directory and the shell command. The
separate stop client and startup synchronize using flock. A cancellation before
startup leaves a tombstone, preventing a late SSH command from starting work.
No provider credentials or prompt contents are written into control state.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(sys.argv[1])
root.mkdir(mode=0o700, parents=True, exist_ok=True)
# Fail before launching work if descendant ownership is unavailable.
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
requested = False

def request_stop(signum, frame):
    global requested
    requested = True

for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, request_stop)

def write_state(name, value):
    temporary = root / (name + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(root / name)

with (root / 'lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if (root / 'requested').exists():
        write_state('stopped.json', {'stopped': True, 'reason': 'cancelled_before_start'})
        sys.exit(125)
    write_state('started.json', {'pid': os.getpid()})
    child = subprocess.Popen(['sh', '-c', sys.argv[2]], start_new_session=True)
    # The provider receives the original SSH stdin. The supervisor must not read it.

leader_status = None
stop_at = None

def descendants():
    parents = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            parents[int(entry.name)] = int(stat[1])
        except FileNotFoundError:
            continue
    owned = {os.getpid()}
    while True:
        more = {pid for pid, parent in parents.items() if parent in owned}
        if more <= owned:
            return owned - {os.getpid()}
        owned |= more

def signal_descendants(signum):
    for pid in descendants():
        # pidfd pins process identity across exit/reuse. Recheck parentage after
        # opening it; process exit/reparenting is normal, other errors are fatal.
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            if pid in descendants():
                signal.pidfd_send_signal(fd, signum)
        except ProcessLookupError:
            pass
        finally:
            os.close(fd)

try:
    while True:
        # Reap every child. Once all descendants are dead, the subreaper sees
        # ECHILD; a process cannot fork after this proof has been obtained.
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                no_children = True
                break
            if pid == 0:
                break
            if pid == child.pid:
                leader_status = os.waitstatus_to_exitcode(status)
        if no_children:
            cancelled = requested or (root / 'requested').exists()
            write_state('stopped.json', {'stopped': True, 'exitCode': leader_status,
                                         'reason': 'cancelled' if cancelled else 'exited'})
            sys.exit(125 if cancelled else (leader_status if leader_status is not None and leader_status >= 0 else 1))
        # Normal provider exit also drains background descendants before success.
        if requested or (root / 'requested').exists() or leader_status is not None:
            if stop_at is None:
                stop_at = time.monotonic()
            signal_descendants(signal.SIGKILL if time.monotonic() - stop_at >= 2 else signal.SIGTERM)
        time.sleep(0.05)
except BaseException as error:
    if not isinstance(error, SystemExit):
        # Never issue a stop receipt after an ownership/procfs failure.
        write_state('error.json', {'error': type(error).__name__})
    raise
