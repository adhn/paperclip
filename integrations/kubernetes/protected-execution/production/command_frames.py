"""Bounded binary command-output framing, without transport or execution authority.

One instance belongs to one command/connection lifetime. One global sequence
orders both channels, EOFs and the terminal. Connection-token binding to exact
command/invocation/stream is supplied by the protected external owner. No reset, resume or
reconnect API exists. A new instance cannot detect replay globally: protected
operation ownership must refuse reconnection and reuse of the connection token.
Token equality is attribution only, not authentication. Transport must supply
integrity/authentication and retain remote uncertainty after any codec failure.
"""
from dataclasses import dataclass
import struct

from production.gateway import Held

_HEADER = struct.Struct('!4s32sBQI')
_MAGIC = b'PCF1'
KINDS = {'stdout': 1, 'stderr': 2, 'stdout-eof': 3, 'stderr-eof': 4,
         'exit': 5, 'signal': 6}
_NAMES = {value: key for key, value in KINDS.items()}
MAX_PAYLOAD = 65536
MAX_FEED = _HEADER.size + MAX_PAYLOAD
_MAX_SEQUENCE = (1 << 63) - 1


@dataclass(frozen=True)
class CommandFrame:
    sequence: int
    kind: str
    payload: bytes


class _State:
    def __init__(self, connection_token):
        if type(connection_token) is not bytes or len(connection_token) != 32:
            raise Held('command_frame_token_required')
        self._token = connection_token
        self._sequence = 0
        self._eof = set()
        self._terminal = False
        self._failed = False

    def _fail(self):
        self._failed = True
        raise Held('command_frame_held')

    def _open(self):
        if self._failed or self._terminal:
            self._fail()

    def _validate(self, sequence, kind, payload):
        self._open()
        if (type(sequence) is not int or sequence != self._sequence
                or sequence > _MAX_SEQUENCE or type(kind) is not str or kind not in KINDS
                or type(payload) is not bytes or len(payload) > MAX_PAYLOAD):
            self._fail()
        if kind in ('stdout', 'stderr'):
            if not payload or kind in self._eof:
                self._fail()
        elif kind.endswith('-eof'):
            if payload or kind[:-4] in self._eof:
                self._fail()
        elif kind in ('exit', 'signal'):
            limit = 64 if kind == 'signal' else 255
            minimum = 1 if kind == 'signal' else 0
            if (self._eof != {'stdout', 'stderr'} or len(payload) != 4
                    or not minimum <= int.from_bytes(payload, 'big') <= limit):
                self._fail()

    def _commit(self, kind):
        if kind.endswith('-eof'):
            self._eof.add(kind[:-4])
        elif kind in ('exit', 'signal'):
            self._terminal = True
        self._sequence += 1


class CommandFrameEncoder(_State):
    def encode(self, kind, payload=b''):
        self._validate(self._sequence, kind, payload)
        wire = _HEADER.pack(_MAGIC, self._token, KINDS[kind], self._sequence, len(payload)) + payload
        self._commit(kind)
        return wire


class CommandFrameDecoder(_State):
    """Incremental decoder with fixed input/buffer/output work per feed.

    Transport must read at most MAX_FEED bytes and stop reading while the caller
    consumes the returned tuple. Oversized feed refuses before copying. Partial
    buffer never exceeds MAX_FEED; no unbounded output queue is owned here.
    Both EOF frames then one exit/signal are required; socket EOF is insufficient.
    """
    def __init__(self, connection_token):
        super().__init__(connection_token)
        self._buffer = bytearray()

    def _fail(self):
        self._buffer.clear()
        super()._fail()

    def feed(self, chunk):
        self._open()
        if type(chunk) is not bytes or len(chunk) > MAX_FEED:
            self._fail()
        results = []
        offset = 0
        while offset < len(chunk):
            needed = _HEADER.size - len(self._buffer)
            if needed > 0:
                take = min(needed, len(chunk) - offset)
                self._buffer.extend(chunk[offset:offset + take]); offset += take
                if len(self._buffer) < _HEADER.size:
                    break
            magic, token, kind_id, sequence, length = _HEADER.unpack(self._buffer[:_HEADER.size])
            if magic != _MAGIC or token != self._token or kind_id not in _NAMES or length > MAX_PAYLOAD:
                self._fail()
            total = _HEADER.size + length
            take = min(total - len(self._buffer), len(chunk) - offset)
            self._buffer.extend(chunk[offset:offset + take]); offset += take
            if len(self._buffer) < total:
                break
            kind, payload = _NAMES[kind_id], bytes(self._buffer[_HEADER.size:])
            self._validate(sequence, kind, payload)
            self._commit(kind)
            results.append(CommandFrame(sequence, kind, payload))
            self._buffer.clear()
            if self._terminal and offset != len(chunk):
                self._fail()
        return tuple(results)

    def finish(self):
        """Validate transport EOF, never infer remote retirement from it."""
        if self._failed or self._buffer or not self._terminal:
            self._fail()
        return None
