"""Non-root, dedicated child close/exec boundary; no launch authority.

Run only as a fresh process in an externally isolated provider identity/mount
namespace, never in the canonical owner or an authority worker. This code neither
creates that isolation nor authorizes an effect. A trusted installer supplies an
immutable interpreter/module/executable, detached cwd, explicit environment and
stdio pipes. Every setup/control/transfer/recovery route still needs integration
with its real effect owner. Same-UID proc access, existing mappings, credentials,
old aliases and stale writers require external exclusion; closing FDs cannot
revoke them. No UID switch, privilege exception or runtime hook is supplied.

The command-line form deliberately supplies only PATH/HOME/LANG. It is a bounded
local preparation interface, not a complete provider-home or credential contract.
The --group form consumes exactly workspace/session/config directories, selects
workspace as cwd, session as HOME and config as XDG_CONFIG_HOME. It suppresses
ambient global/system Git config, but does not resolve provider-specific settings,
credential aliases, single-file configs, active sessions or launcher authorization.
"""
import ctypes
import errno
import fcntl
import os
import signal
import stat
import sys


class BoundaryError(RuntimeError):
    pass


def _replace_with_detached(argv, environment, directory_fd):
    """Replace this dedicated single-threaded child; success never returns.

    directory_fd must belong to a trusted fresh detached attempt. Local inode
    checks do not authenticate its placement, ancestors, aliases or generation.
    Caller must not reuse this function inside a long-lived Python authority.
    """
    if (os.getuid() == 0 or len(set(os.getresuid())) != 1
            or os.getgid() == 0 or len(set(os.getresgid())) != 1
            or any(group != os.getgid() for group in os.getgroups())):
        raise BoundaryError('nonroot_single_identity_required')
    if len(os.listdir('/proc/self/task')) != 1:
        raise BoundaryError('dedicated_single_thread_required')
    if (type(argv) not in (list, tuple) or not 1 <= len(argv) <= 256
            or any(type(arg) is not str or '\x00' in arg or len(os.fsencode(arg)) > 4096 for arg in argv)
            or not os.path.isabs(argv[0])):
        raise BoundaryError('bounded_absolute_exec_required')
    if (type(environment) is not dict or len(environment) > 128
            or any(type(key) is not str or not key or '=' in key or '\x00' in key
                   or type(value) is not str or '\x00' in value for key, value in environment.items())
            or sum(len(os.fsencode(key)) + len(os.fsencode(value)) + 2
                   for key, value in environment.items()) > 65536):
        raise BoundaryError('bounded_explicit_environment_required')
    argv, environment = tuple(argv), dict(environment)
    if type(directory_fd) is not int or directory_fd <= 2:
        raise BoundaryError('private_detached_directory_required')
    info = os.fstat(directory_fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BoundaryError('private_detached_directory_required')
    # A canonical regular file/directory must not survive as stdio. This narrow
    # entrypoint supports pipes and /dev/null only, not PTYs or arbitrary sockets.
    null_device = os.stat('/dev/null').st_rdev
    for fd in (0, 1, 2):
        info = os.fstat(fd)
        access = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
        expected = os.O_RDONLY if fd == 0 else os.O_WRONLY
        if not os.get_inheritable(fd) or not ((stat.S_ISFIFO(info.st_mode) and access == expected)
                or (stat.S_ISCHR(info.st_mode) and info.st_rdev == null_device)):
            raise BoundaryError('trusted_pipe_or_null_stdio_required')
    # No privilege may be gained by a later setuid/capability-bearing executable.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # Linux PR_SET_NO_NEW_PRIVS
        raise BoundaryError('no_new_privileges_required')
    os.umask(0o077)
    # The dedicated trusted child must have no handlers that could reopen FDs
    # after closure. Reset dispositions before the final enumeration/exec.
    for number in signal.valid_signals() - {signal.SIGKILL, signal.SIGSTOP}:
        signal.signal(number, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, set())
    os.fchdir(directory_fd)
    # Enumerate actual open FDs, including those above a lowered soft limit.
    # No caller-supplied list of known dangerous descriptors is accepted.
    descriptors = [int(name) for name in os.listdir('/proc/self/fd')]
    for fd in descriptors:
        if fd > 2:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    os.execve(argv[0], argv, environment)


def _open_directory_path(path):
    """Descriptor walk refuses lexical traversal and symlinks at every component.

    Does not authenticate mount aliases or exclude existing ancestor writers.
    """
    if (type(path) is not str or not os.path.isabs(path) or path == '/'
            or os.path.normpath(path) != path or path.startswith('//')
            or '\x00' in path or len(os.fsencode(path)) > 4096):
        raise BoundaryError('canonical_absolute_directory_required')
    parts = path[1:].split('/')
    if len(parts) > 64:
        raise BoundaryError('directory_depth_bound')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def _group_target(path):
    """Open an already detached group; no publication/export or new authority."""
    group_fd = _open_directory_path(path)
    group_info = os.fstat(group_fd)
    if group_info.st_uid != os.getuid() or group_info.st_mode & 0o077:
        raise BoundaryError('private_detached_group_required')
    roots = {'workspace', 'session', 'config'}
    names = set()
    with os.scandir(group_fd) as entries:
        for entry in entries:
            if entry.name not in roots or entry.name in names:
                raise BoundaryError('exact_complete_detached_group_required')
            names.add(entry.name)
    if names != roots:
        raise BoundaryError('exact_complete_detached_group_required')
    identities = {(group_info.st_dev, group_info.st_ino)}
    descriptors = {}
    for root in sorted(roots):
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=group_fd)
        descriptors[root] = fd
        info = os.fstat(fd)
        identity = (info.st_dev, info.st_ino)
        if (info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_dev != group_info.st_dev or identity in identities):
            raise BoundaryError('private_independent_detached_roots_required')
        identities.add(identity)
    # Trusted installation must keep these names/ancestors stable across exec;
    # descriptors do not freeze the paths later used by application code.
    return descriptors['workspace'], {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
        'HOME': path + '/session', 'XDG_CONFIG_HOME': path + '/config',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
    }


def main(arguments):
    """Dedicated child entrypoint: every failure exits silently with status125."""
    try:
        if arguments and arguments[0] == '--group':
            if len(arguments) < 3:
                raise BoundaryError('group_and_absolute_command_required')
            directory, environment = _group_target(arguments[1])
            command = arguments[2:]
        else:
            if len(arguments) < 2:
                raise BoundaryError('absolute_detached_directory_and_command_required')
            directory = _open_directory_path(arguments[0])
            environment = {
                'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': arguments[0], 'LANG': 'C.UTF-8',
            }
            command = arguments[1:]
        _replace_with_detached(command, environment, directory)
    except BaseException:
        # Even stderr may be a rejected canonical capability: never write an
        # error through unvalidated channels. Kernel cleanup closes remaining FDs.
        os._exit(125)


if __name__ == '__main__':
    main(sys.argv[1:])
