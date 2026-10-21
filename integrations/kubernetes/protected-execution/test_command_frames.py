"""Pure byte-level framing; no provider/runtime/transport acceptance."""
import struct
import unittest
from production.gateway import Held
from production.command_frames import CommandFrameEncoder, CommandFrameDecoder, MAX_FEED, MAX_PAYLOAD

TOKEN = b'c' * 32


def transcript(terminal='exit', value=0):
    encoder = CommandFrameEncoder(TOKEN)
    values = [('stdout', b'\x00\xffraw\r\n'), ('stderr', b'error\x80'),
              ('stdout-eof', b''), ('stderr-eof', b''), (terminal, value.to_bytes(4, 'big'))]
    return b''.join(encoder.encode(k, v) for k, v in values), values


class CommandFrameTests(unittest.TestCase):
    def test_exact_binary_roundtrip_at_every_split(self):
        wire, values = transcript()
        for split in range(len(wire) + 1):
            decoder = CommandFrameDecoder(TOKEN)
            frames = decoder.feed(wire[:split])
            if split != len(wire):
                frames += decoder.feed(wire[split:])
            self.assertEqual([(f.kind, f.payload) for f in frames], values)
            self.assertEqual([f.sequence for f in frames], list(range(5)))
            self.assertIsNone(decoder.finish())

    def test_one_byte_reads_and_signal_terminal(self):
        wire, values = transcript('signal', 15)
        decoder = CommandFrameDecoder(TOKEN)
        frames = tuple(f for byte in wire for f in decoder.feed(bytes([byte])))
        self.assertEqual([(f.kind, f.payload) for f in frames], values)
        decoder.finish()

    def test_largest_payload_and_bounded_coalescing(self):
        encoder = CommandFrameEncoder(TOKEN); decoder = CommandFrameDecoder(TOKEN)
        first = encoder.encode('stdout', b'x' * MAX_PAYLOAD)
        second = encoder.encode('stderr', b'y' * MAX_PAYLOAD)
        self.assertEqual(decoder.feed(first[:1]), ())
        frames = decoder.feed(first[1:] + second[:1])
        self.assertEqual(frames[0].payload, b'x' * MAX_PAYLOAD)
        self.assertEqual(decoder.feed(second[1:])[0].payload, b'y' * MAX_PAYLOAD)

    def test_oversized_read_and_payload_fail_permanently(self):
        for chunk in (b'x' * (MAX_FEED + 1), bytearray(b'x')):
            decoder = CommandFrameDecoder(TOKEN)
            with self.assertRaises(Held): decoder.feed(chunk)
            with self.assertRaises(Held): decoder.feed(b'')
        with self.assertRaises(Held): CommandFrameEncoder(TOKEN).encode('stdout', b'x' * (MAX_PAYLOAD + 1))

    def test_malformed_headers_refuse_without_payload_allocation(self):
        for magic, token, kind, seq, length in (
            (b'BAD!', TOKEN, 1, 0, 1), (b'PCF1', b'z' * 32, 1, 0, 1),
            (b'PCF1', TOKEN, 99, 0, 1), (b'PCF1', TOKEN, 1, 0, MAX_PAYLOAD + 1)):
            decoder = CommandFrameDecoder(TOKEN)
            with self.assertRaises(Held): decoder.feed(struct.pack('!4s32sBQI', magic, token, kind, seq, length))
            self.assertEqual(len(decoder._buffer), 0)

    def test_replay_skip_reorder_sequence_refuse(self):
        wire = CommandFrameEncoder(TOKEN).encode('stdout', b'one')
        decoder = CommandFrameDecoder(TOKEN); decoder.feed(wire)
        with self.assertRaises(Held): decoder.feed(wire)
        for sequence in (1, 8, 2**63):
            with self.assertRaises(Held):
                CommandFrameDecoder(TOKEN).feed(struct.pack('!4s32sBQI', b'PCF1', TOKEN, 1, sequence, 1) + b'x')

    def test_missing_eof_or_partial_frame_cannot_complete(self):
        wire, _ = transcript()
        for cut in range(len(wire)):
            decoder = CommandFrameDecoder(TOKEN); decoder.feed(wire[:cut])
            with self.assertRaises(Held): decoder.finish()

    def test_terminal_requires_both_eof_and_valid_status(self):
        for kind, payload in (('exit', b'\x00'*4), ('signal', b'\x00\x00\x00\x0f')):
            with self.assertRaises(Held): CommandFrameEncoder(TOKEN).encode(kind, payload)
        for kind, value in (('exit', 256), ('signal', 0), ('signal', 65)):
            encoder = CommandFrameEncoder(TOKEN)
            encoder.encode('stdout-eof'); encoder.encode('stderr-eof')
            with self.assertRaises(Held): encoder.encode(kind, value.to_bytes(4, 'big'))

    def test_data_after_eof_duplicate_eof_and_empty_data_refuse(self):
        for kind, payload in (('stdout', b'late'), ('stdout-eof', b'')):
            encoder = CommandFrameEncoder(TOKEN); encoder.encode('stdout-eof')
            with self.assertRaises(Held): encoder.encode(kind, payload)
        for kind, payload in (('stdout', b''), ('stderr-eof', b'extra'), ('unknown', b'')):
            with self.assertRaises(Held): CommandFrameEncoder(TOKEN).encode(kind, payload)

    def test_terminal_closes_lifetime_and_trailing_bytes_refuse(self):
        wire, _ = transcript()
        decoder = CommandFrameDecoder(TOKEN); decoder.feed(wire); decoder.finish()
        with self.assertRaises(Held): decoder.feed(b'')
        with self.assertRaises(Held): CommandFrameDecoder(TOKEN).feed(wire + b'x')
        encoder = CommandFrameEncoder(TOKEN)
        encoder.encode('stdout-eof'); encoder.encode('stderr-eof'); encoder.encode('exit', b'\x00'*4)
        with self.assertRaises(Held): encoder.encode('stdout', b'x')

    def test_decoder_refuses_invalid_eof_terminal_and_post_eof_bytes(self):
        def raw(kind, sequence, payload):
            return struct.pack('!4s32sBQI', b'PCF1', TOKEN, kind, sequence, len(payload)) + payload
        for wire in (raw(5, 0, b'\x00'*4), raw(1, 0, b''), raw(3, 0, b'extra'),
                     raw(3, 0, b'') + raw(3, 1, b''),
                     raw(3, 0, b'') + raw(1, 1, b'late'),
                     raw(3, 0, b'') + raw(4, 1, b'') + raw(6, 2, b'\x00'*4)):
            with self.subTest(wire=wire), self.assertRaises(Held):
                CommandFrameDecoder(TOKEN).feed(wire)

    def test_identity_required_and_no_reconnect_api(self):
        for token in (b'', b'x'*31, 'x'*32, bytearray(TOKEN)):
            with self.assertRaises(Held): CommandFrameDecoder(token)
        decoder = CommandFrameDecoder(TOKEN)
        self.assertFalse(hasattr(decoder, 'reset'))
        self.assertFalse(hasattr(decoder, 'resume'))
