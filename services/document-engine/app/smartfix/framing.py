"""Carrying a JSON document and a DOCX in one request body.

The analyzer's boundary puts the document in the raw body and its two
identifiers in headers, which works because those identifiers are short
strings. SmartFix cannot do that: a plan is a JSON document with up to a
hundred thousand actions in it, and a change manifest is the same size again.

The two obvious alternatives are both worse. `multipart/form-data` means
adding a parser dependency and a second way for PalCert's own bytes to be
misframed, which Phase 6 declined for exactly that reason. Base64 inside a
JSON envelope inflates a 200 MB thesis by a third and forces the whole
document through a string.

So the body is framed explicitly: eight bytes of big-endian length, that many
bytes of UTF-8 JSON, and the document immediately after. There is nothing to
guess at, nothing to sniff, and no boundary token that could occur inside the
payload.
"""

from __future__ import annotations

import json
import struct
from typing import Any

HEADER_BYTES = 8
#: A JSON header larger than this is not a plan, it is an attack or a bug.
MAX_JSON_BYTES = 64 * 1024 * 1024


class FramingError(ValueError):
    """The body was not a well-formed SmartFix frame."""


def encode(payload: dict[str, Any], document: bytes) -> bytes:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return struct.pack(">Q", len(body)) + body + document


def decode(data: bytes) -> tuple[dict[str, Any], bytes]:
    if len(data) < HEADER_BYTES:
        raise FramingError("the body is shorter than its length prefix")
    (length,) = struct.unpack(">Q", data[:HEADER_BYTES])
    if length > MAX_JSON_BYTES:
        raise FramingError("the JSON header exceeds the permitted size")
    end = HEADER_BYTES + length
    if len(data) < end:
        raise FramingError("the body is shorter than its JSON header claims")
    try:
        payload = json.loads(data[HEADER_BYTES:end].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FramingError("the JSON header is not valid JSON") from error
    if not isinstance(payload, dict):
        raise FramingError("the JSON header is not an object")
    return payload, data[end:]
