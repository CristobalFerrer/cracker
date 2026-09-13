"""Safe file resolution under a root directory."""
from __future__ import annotations

from pathlib import Path


def safe_file_under_root(name: str, root: Path) -> Path | None:
    """
    Return a resolved path inside `root` if `name` is a single-segment safe filename.
    Rejects path traversal and odd names.
    """
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        return None
    if not all(c.isalnum() or c in "._- " for c in name):
        return None
    candidate = (root / name).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate
