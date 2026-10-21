"""Bounded non-executing transfer primitive, not canonical-root activation.

Call only after independent storage ownership/whole-attempt stop verification.
No shell, Git, archive extraction, profiles or symlink following is involved.
Full multi-root stage/restore and native ownership wiring remain separate gates.
"""
import hashlib
import os
from pathlib import Path
import stat
from authority import Held, canonical, digest, protected_directory


def capture(root, max_files=10000, max_bytes=64 * 1024 * 1024):
    """Read a detached tree through O_NOFOLLOW dirfds, bounded by count/bytes.

    Includes empty directories and uncommitted files. Reject links, devices,
    sockets, FIFOs, cross-device traversal and hardlinks. Do not trust a preceding
    realpath/stat of untrusted tree entries (they can be swapped between calls).
    """
    root_fd = open_directory(root)
    device = os.fstat(root_fd).st_dev
    files, modes, directories, total = {}, {}, [], 0

    def walk(directory_fd, prefix):
        nonlocal total
        original_directory = os.fstat(directory_fd)
        for name in sorted(os.listdir(directory_fd)):
            if name in (".", "..") or "/" in name or "\x00" in name:
                raise Held("unsafe_transfer_name")
            relative = prefix + name
            if len(relative.encode()) > 4096 or relative.count("/") > 64:
                raise Held("transfer_depth_limit")
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if before.st_dev != device:
                raise Held("transfer_mount_boundary")
            if stat.S_ISDIR(before.st_mode):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    opened = os.fstat(fd)
                    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                        raise Held("transfer_entry_changed")
                    directories.append(relative)
                    if len(files) + len(directories) > max_files:
                        raise Held("transfer_count_limit")
                    walk(fd, relative + "/")
                finally:
                    os.close(fd)
            elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                try:
                    opened = os.fstat(fd)
                    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink) != (before.st_dev, before.st_ino, before.st_mode, 1):
                        raise Held("transfer_entry_changed")
                    if opened.st_size > max_bytes - total:
                        raise Held("transfer_byte_limit")
                    data = bytearray()
                    while True:
                        part = os.read(fd, min(65536, max_bytes - total + 1))
                        if not part:
                            break
                        total += len(part)
                        if total > max_bytes:
                            raise Held("transfer_byte_limit")
                        data.extend(part)
                    after = os.fstat(fd)
                    if (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) != (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns, 1):
                        raise Held("transfer_entry_changed")
                    files[relative] = bytes(data)
                    # Preserve repository executable intent while stripping
                    # setuid/setgid and group/other permissions.
                    modes[relative] = 0o700 if opened.st_mode & 0o111 else 0o600
                    if len(files) + len(directories) > max_files:
                        raise Held("transfer_count_limit")
                finally:
                    os.close(fd)
            else:
                raise Held("unsafe_transfer_entry")
        final_directory = os.fstat(directory_fd)
        if (original_directory.st_mtime_ns, original_directory.st_ctime_ns) != (final_directory.st_mtime_ns, final_directory.st_ctime_ns):
            raise Held("transfer_directory_changed")

    try:
        walk(root_fd, "")
    finally:
        os.close(root_fd)
    manifest = {"directories": directories, "files": {path: hashlib.sha256(data).hexdigest() for path, data in files.items()}, "modes": modes}
    return {"version": digest(manifest), "manifest": manifest, "files": files}


def materialize(snapshot, destination):
    """Create a new private detached copy only; never overwrite canonical state.

    Retain this destination on failure for diagnosis/recovery. Caller must keep
    it detached from provider writes until staging journal commits.
    """
    manifest = snapshot["manifest"]
    if digest(manifest) != snapshot["version"] or set(manifest["files"]) != set(snapshot["files"]):
        raise Held("transfer_snapshot_mismatch")
    for path in (*manifest["directories"], *manifest["files"]):
        if not path or path.startswith("/") or any(part in ("", ".", "..") for part in path.split("/")):
            raise Held("unsafe_transfer_path")
    if set(manifest["modes"]) != set(manifest["files"]) or any(mode not in (0o600, 0o700) for mode in manifest["modes"].values()):
        raise Held("unsafe_transfer_mode")
    destination = Path(destination)
    protected_directory(destination.parent)
    destination.mkdir(mode=0o700)  # refuses reuse/overwrite after ambiguous stage
    root_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def parent(path):
        fd = os.dup(root_fd)
        try:
            for component in path.split("/")[:-1]:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    try:
        for path in sorted(manifest["directories"], key=lambda p: (p.count("/"), p)):
            fd = parent(path)
            try:
                os.mkdir(path.split("/")[-1], 0o700, dir_fd=fd)
                os.fsync(fd)
            finally:
                os.close(fd)
        for path, content_hash in manifest["files"].items():
            data = snapshot["files"][path]
            if hashlib.sha256(data).hexdigest() != content_hash:
                raise Held("transfer_content_mismatch")
            fd = parent(path)
            try:
                output = os.open(path.split("/")[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, manifest["modes"][path], dir_fd=fd)
                try:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(output, view):]
                    os.fsync(output)
                finally:
                    os.close(output)
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(root_fd)
    finally:
        os.close(root_fd)
    fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return snapshot["version"]


def capture_file(path, max_bytes=64 * 1024 * 1024):
    """Capture one file through its verified no-follow parent, never whole home."""
    path = Path(path)
    parent = open_directory(path.parent)
    try:
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise Held("unsafe_transfer_entry")
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise Held("transfer_entry_changed")
            data = bytearray()
            while True:
                part = os.read(fd, min(65536, max_bytes - len(data) + 1))
                if not part:
                    break
                data.extend(part)
                if len(data) > max_bytes:
                    raise Held("transfer_byte_limit")
            after = os.fstat(fd)
            if (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) != (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns, 1):
                raise Held("transfer_entry_changed")
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    data = bytes(data)
    manifest = {"directories": [], "files": {"content": hashlib.sha256(data).hexdigest()},
                "modes": {"content": 0o700 if opened.st_mode & 0o111 else 0o600}}
    return {"version": digest(manifest), "manifest": manifest, "files": {"content": data}}


def open_directory(path):
    """Resolve each absolute path component without following any symlink."""
    path = Path(path).absolute()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if part in (".", "..", ""):
                raise Held("unsafe_transfer_path")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
