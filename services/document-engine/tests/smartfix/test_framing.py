"""The request framing.

A plan with a hundred thousand actions does not fit in an HTTP header, and
base64 inside a JSON envelope would inflate a 200 MB thesis by a third. So the
body is framed explicitly, and the frame has to be unambiguous about where the
JSON ends and the document begins.
"""

from __future__ import annotations

import struct

import pytest

from app.smartfix.framing import HEADER_BYTES, MAX_JSON_BYTES, FramingError, decode, encode


def test_a_frame_round_trips() -> None:
    payload = {"planHash": "a" * 64, "nested": {"actions": [1, 2, 3]}}
    document = b"PK\x03\x04binary\x00bytes"
    assert decode(encode(payload, document)) == (payload, document)


def test_arabic_survives_the_frame() -> None:
    payload = {"note": "محجوز"}
    assert decode(encode(payload, b"x"))[0] == payload


def test_a_document_containing_the_length_prefix_is_not_confused() -> None:
    # There is no boundary token to collide with, which is the point of
    # framing by length rather than by delimiter.
    document = struct.pack(">Q", 99) + b"not a header"
    assert decode(encode({"a": 1}, document))[1] == document


def test_a_truncated_body_is_refused() -> None:
    with pytest.raises(FramingError):
        decode(b"\x00\x00")


def test_a_body_shorter_than_its_header_claims_is_refused() -> None:
    with pytest.raises(FramingError):
        decode(struct.pack(">Q", 1000) + b"{}")


def test_an_absurd_header_length_is_refused_without_allocating() -> None:
    with pytest.raises(FramingError):
        decode(struct.pack(">Q", MAX_JSON_BYTES + 1))


def test_a_header_that_is_not_json_is_refused() -> None:
    body = b"not json"
    with pytest.raises(FramingError):
        decode(struct.pack(">Q", len(body)) + body)


def test_a_header_that_is_not_an_object_is_refused() -> None:
    body = b"[1,2,3]"
    with pytest.raises(FramingError):
        decode(struct.pack(">Q", len(body)) + body)


def test_the_header_is_exactly_eight_bytes() -> None:
    assert len(encode({}, b"")) == HEADER_BYTES + len(b"{}")
