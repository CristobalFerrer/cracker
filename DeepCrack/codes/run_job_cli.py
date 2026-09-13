"""
Run DeepCrack POC from a JSON params file (used by the platform job worker).

Usage:
  python run_job_cli.py path/to/params.json

Keys match poc_inference.run_poc() keyword arguments (omit or null for defaults).
"""
from __future__ import annotations

import json
import os
import sys

_CDIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(_CDIR)
if _CDIR not in sys.path:
    sys.path.insert(0, _CDIR)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python run_job_cli.py params.json", file=sys.stderr)
        return 2
    raw = open(sys.argv[1], encoding="utf-8").read()
    data = json.loads(raw)
    # Remove nulls so run_poc uses module defaults
    kwargs = {k: v for k, v in data.items() if v is not None}
    from poc_inference import run_poc

    return int(run_poc(**kwargs))


if __name__ == "__main__":
    raise SystemExit(main())
