"""The isolated analysis subprocess (§6, §7, §105, §106).

PDFium is not thread-safe and it is native code being handed a file a stranger
uploaded. Both facts point the same way: one analysis, one process, and a
process that dies takes nothing with it.

So the parent never calls the parser. It spawns this module, writes the bytes
to its stdin, and reads one JSON document from its stdout. A segmentation fault
becomes a non-zero exit code; an infinite loop becomes a timeout and a kill; a
memory explosion is bounded by the child's own rlimits. In every case the
document-engine service is still serving, and exactly one analysis failed (§7).

The child opens no sockets, reads no files and writes nothing to disk. The PDF
arrives on a pipe and stays in memory, which is also why there is no temporary
file to name, secure or delete (§105). External URI references inside the
document are data; nothing here resolves one (§106).

Run as::

    python -m app.pdf.worker

stdin:  8-byte big-endian length, then that many bytes of JSON request, then
        the PDF bytes.
stdout: one JSON document - the artifact, or an error with a stable code.
"""

from __future__ import annotations

import json
import os
import resource
import sys
from typing import Any

from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.limits import PdfLimits

#: Address space the child may map. Generous enough for a 300-page document
#: with figures, small enough that a decompression bomb hits it rather than the
#: machine's swap.
ADDRESS_SPACE_BYTES = 3 * 1024 * 1024 * 1024


def apply_child_limits(limits: PdfLimits) -> None:
    """Bound the child from inside, so a bomb fails in the child (§7, §104)."""
    with_cpu = max(1, limits.timeout_ms // 1000)
    for what, soft, hard in (
        (resource.RLIMIT_AS, ADDRESS_SPACE_BYTES, ADDRESS_SPACE_BYTES),
        # A CPU limit the parent's wall-clock timeout cannot express: a child
        # spinning without allocating would otherwise only be caught by the
        # parent, and this makes it self-limiting.
        (resource.RLIMIT_CPU, with_cpu + 5, with_cpu + 10),
        # Nothing here writes a file; make that structural rather than a
        # convention someone can break later.
        (resource.RLIMIT_FSIZE, 0, 0),
        (resource.RLIMIT_CORE, 0, 0),
    ):
        try:
            resource.setrlimit(what, (soft, hard))
        except (ValueError, OSError):
            # A platform that refuses one limit still gets the others; the
            # parent's timeout remains the backstop.
            continue


def _read_exactly(count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining > 0:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def main() -> int:
    header = _read_exactly(8)
    if len(header) != 8:
        json.dump(
            {"error": {"code": str(PdfFailure.DOCUMENT_INVALID), "detail": "no request"}},
            sys.stdout,
        )
        return 2
    length = int.from_bytes(header, "big")
    request: dict[str, Any] = json.loads(_read_exactly(length).decode("utf-8"))
    data = sys.stdin.buffer.read()

    limits = PdfLimits.from_json(request.get("limits"))
    apply_child_limits(limits)

    # Imported here, after the limits are in place: the parser must never run
    # unbounded, not even while loading.
    from app.pdf.analyzer import analyze

    try:
        artifact = analyze(
            data,
            expected_sha256=str(request["sha256"]),
            document_id=str(request["documentId"]),
            limits=limits,
        )
    except PdfAnalysisError as error:
        json.dump({"error": {"code": str(error.code), "detail": error.detail}}, sys.stdout)
        return 0
    except MemoryError:
        json.dump(
            {"error": {"code": str(PdfFailure.LIMIT_EXCEEDED), "detail": "memory limit"}},
            sys.stdout,
        )
        return 0
    except Exception as error:
        json.dump(
            {
                "error": {
                    "code": str(PdfFailure.DOCUMENT_INVALID),
                    # The type, never the message: a parser error can quote
                    # document content, and that must not leave the child (§107).
                    "detail": type(error).__name__,
                }
            },
            sys.stdout,
        )
        return 0

    json.dump({"artifact": artifact}, sys.stdout, separators=(",", ":"), sort_keys=False)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONHASHSEED", "0")
    sys.exit(main())
