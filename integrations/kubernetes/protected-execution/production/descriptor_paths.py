"""Trusted-path descriptor walk; no mount/alias/writer exclusion authority.

Callers must keep trusted names and ancestors stable. Successful traversal only
refuses lexical aliases and symlinks; it does not establish physical ownership.
"""
import os


class DescriptorPathError(ValueError):
    pass


def open_directory(path):
    if (type(path) is not str or not os.path.isabs(path) or path == '/'
            or os.path.normpath(path) != path or path.startswith('//')
            or '\x00' in path or len(os.fsencode(path)) > 4096):
        raise DescriptorPathError('canonical absolute directory required')
    parts = path[1:].split('/')
    if len(parts) > 64:
        raise DescriptorPathError('directory depth bound')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise
