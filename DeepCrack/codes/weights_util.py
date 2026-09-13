"""Load DeepCrack checkpoints with or without DataParallel key prefixes."""
from __future__ import annotations

from collections import OrderedDict

import torch


def load_state_dict_from_file(path: str, map_location, use_data_parallel: bool) -> OrderedDict | dict:
    try:
        state = torch.load(path, map_location=map_location, weights_only=False)
    except TypeError:
        state = torch.load(path, map_location=map_location)
    if not isinstance(state, dict) or not state:
        raise ValueError(f"Invalid checkpoint: {path}")

    ck0 = next(iter(state.keys()))
    if use_data_parallel and not ck0.startswith("module."):
        state = OrderedDict((f"module.{k}", v) for k, v in state.items())
    elif (not use_data_parallel) and ck0.startswith("module."):
        state = OrderedDict((k.replace("module.", "", 1), v) for k, v in state.items())
    return state
