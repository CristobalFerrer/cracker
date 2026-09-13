"""
POC: run DeepCrack on a folder of images (ortho crops / UAV tiles).

- **Small images** (both sides ≤ SIZE): resize to SIZE×SIZE, one forward pass, optional
  warp of the prob map back to input size.
- **Large images** (either side > SIZE): **sliding windows** of SIZE×SIZE with overlap
  (configurable as a **percent of tile width**; converted to pixels for the grid),
  predictions **averaged** where tiles overlap, then full-resolution outputs.

The network always sees SIZE×SIZE inputs; tiling preserves local GSD instead of squashing
the whole ortho into one thumbnail.
"""

from __future__ import annotations

import glob
import os
import sys
import time

CODES_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(CODES_DIR)
if CODES_DIR not in sys.path:
    sys.path.insert(0, CODES_DIR)

import cv2
import numpy as np
import torch
import torch.nn as nn
from tqdm import tqdm

from model.deepcrack import DeepCrack
from weights_util import load_state_dict_from_file

# =============================================================================
# POC settings — edit these, then Run this file (F5)
# =============================================================================
INPUT_DIR = os.path.join(CODES_DIR, "input_crops")
OUTPUT_DIR = os.path.join(CODES_DIR, "poc_results")
CHECKPOINT = os.path.join(CODES_DIR, "checkpoints", "DeepCrack_CT260_FT1.pth")
DEVICE = "auto"
SIZE = 512

# Large orthos: overlap between adjacent windows as a fraction of tile width (SIZE).
# 25% at SIZE=512 → 128px stride-related overlap (see _tile_starts_1d).
TILE_OVERLAP_PERCENT = 25.0
# Use sliding-window inference when max(height, width) > SIZE (recommended for UAV mosaics).
USE_TILING_FOR_LARGE_IMAGES = False
# Run this many tiles per forward pass (GPU memory permitting). 1 = safest.
TILE_BATCH_SIZE = 4
# Uniform resize before inference when target_long_edge_px is not set: 1.0 = native; <1 coarser; >1 upscales (rare).
INFERENCE_SCALE = 1.0

# Small / non-tiled: warp prob map back to input W×H for exports.
OUTPUT_AT_INPUT_RESOLUTION = True
PROB_UPSCALE_INTERP = cv2.INTER_LINEAR

OVERLAY_MAX_ALPHA = 0.65

# Print phase timings (where time goes / if something “hangs”). Set False for quiet runs.
DEBUG_TIMING = True
# On CUDA, wait for GPU to finish each batch so logged times match real work (tiny overhead).
DEBUG_CUDA_SYNC = True
# =============================================================================


def _now() -> float:
    return time.perf_counter()


def _log(msg: str, t0: float | None = None) -> None:
    if not DEBUG_TIMING:
        return
    if t0 is not None:
        print(f"[poc +{_now() - t0:.3f}s] {msg}", flush=True)
    else:
        print(f"[poc] {msg}", flush=True)


def _per_image_inference_scale(
    target_long_edge_px: int | None,
    base_inference_scale: float,
    h: int,
    w: int,
) -> float:
    """
    Uniform scale applied to both axes before tiling/single-patch.
    If target_long_edge_px > 0: scale = target / max(h, w) (other side follows aspect ratio).
    Otherwise use base_inference_scale (clamped).
    """
    t = int(target_long_edge_px or 0)
    if t > 0:
        m = max(int(h), int(w), 1)
        s = float(t) / float(m)
        return max(0.01, min(4.0, s))
    return max(0.01, min(4.0, float(base_inference_scale)))


def _resolve_overlap_px(
    sq: int,
    tile_overlap: int | None,
    tile_overlap_percent: float | None,
) -> tuple[int, float]:
    """
    Returns (overlap_px, overlap_percent_used) with overlap_px in [0, sq-1].
    Legacy: if tile_overlap (px) is set, it wins. Otherwise use percent of sq.
    """
    if tile_overlap is not None:
        o = int(tile_overlap)
        pct = 100.0 * o / sq if sq else 0.0
    elif tile_overlap_percent is not None:
        pct = float(tile_overlap_percent)
        o = int(round(sq * pct / 100.0))
    else:
        pct = float(TILE_OVERLAP_PERCENT)
        o = int(round(sq * pct / 100.0))
    o = max(0, min(o, sq - 1))
    return o, pct


def _tile_starts_1d(length: int, tile: int, overlap: int) -> list[int]:
    """Start indices for sliding windows of length `tile` covering [0, length)."""
    if length <= tile:
        return [0]
    stride = max(1, tile - min(overlap, tile - 1))
    starts: list[int] = []
    pos = 0
    while pos + tile <= length:
        starts.append(pos)
        nxt = pos + stride
        if nxt + tile > length:
            break
        pos = nxt
    last = length - tile
    if not starts:
        return [last]
    if starts[-1] < last:
        starts.append(last)
    return sorted(set(starts))


def _infer_tiles_stitched(
    img_bgr: np.ndarray,
    model: nn.Module,
    dev: torch.device,
    sq: int,
    overlap: int,
    batch_size: int,
    t_run0: float | None = None,
    image_label: str = "",
) -> tuple[np.ndarray, int]:
    """
    Stitch probability map [0,1] at full image resolution by averaging overlapping tiles.
    Returns (prob_h_w, num_tiles).
    """
    t0 = _now()
    h0, w0 = img_bgr.shape[:2]
    ys = _tile_starts_1d(h0, sq, overlap)
    xs = _tile_starts_1d(w0, sq, overlap)
    coords = [(y, x) for y in ys for x in xs]
    n_tiles = len(coords)

    sum_prob = np.zeros((h0, w0), dtype=np.float32)
    weight = np.zeros((h0, w0), dtype=np.float32)
    if DEBUG_TIMING:
        _log(
            f"tiling setup {image_label}: {h0}x{w0}, {len(ys)}x{len(xs)} grid -> {n_tiles} tiles "
            f"(alloc {(2 * h0 * w0 * 4) / 1e6:.1f} MB float buffers) in {_now() - t0:.3f}s",
            t_run0,
        )

    bs = max(1, batch_size)
    n_batches = (n_tiles + bs - 1) // bs
    with torch.no_grad():
        for bi, i in enumerate(range(0, n_tiles, bs)):
            t_b = _now()
            batch_coords = coords[i : i + bs]
            tiles_np = [img_bgr[y : y + sq, x : x + sq] for y, x in batch_coords]
            t_cat = _now()
            batch = torch.cat([_to_tensor_bgr(t) for t in tiles_np], dim=0).to(dev)
            t_gpu = _now()
            pred_output, *_ = model(batch)
            if dev.type == "cuda" and DEBUG_CUDA_SYNC:
                torch.cuda.synchronize()
            t_fwd = _now()
            for j, (y, x) in enumerate(batch_coords):
                p = torch.sigmoid(pred_output[j, 0]).cpu().numpy()
                sum_prob[y : y + sq, x : x + sq] += p
                weight[y : y + sq, x : x + sq] += 1.0
            t_done = _now()
            if DEBUG_TIMING:
                _log(
                    f"  batch {bi + 1}/{n_batches} tiles {i}-{i + len(batch_coords) - 1}: "
                    f"stack+H2D {t_gpu - t_cat:.3f}s | forward+sync {t_fwd - t_gpu:.3f}s | "
                    f"cpu stitch {t_done - t_fwd:.3f}s | batch total {t_done - t_b:.3f}s",
                    t_run0,
                )

    t_after_batches = _now()
    prob = sum_prob / np.maximum(weight, 1.0)
    if DEBUG_TIMING:
        _log(
            f"tiling finalize {image_label}: avg divide {_now() - t_after_batches:.4f}s | "
            f"batch loop wall {_now() - t0:.3f}s",
            t_run0,
        )
    return prob, n_tiles


def _red_crack_overlay(img_bgr: np.ndarray, prob_01: np.ndarray, max_alpha: float) -> np.ndarray:
    base = img_bgr.astype(np.float32)
    a = np.clip(prob_01.astype(np.float32) * float(max_alpha), 0.0, 1.0)
    a3 = a[:, :, np.newaxis]
    red = np.zeros_like(base, dtype=np.float32)
    red[:, :, 2] = 255.0
    out = base * (1.0 - a3) + red * a3
    return np.clip(out, 0.0, 255.0).astype(np.uint8)


def _to_tensor_bgr(img_bgr: np.ndarray) -> torch.Tensor:
    t = img_bgr.transpose(2, 0, 1).astype(np.float32) / 255.0
    return torch.from_numpy(t).unsqueeze(0)


def load_checkpoint_into_model(model: nn.Module, checkpoint_path: str, map_location) -> None:
    use_dp = isinstance(model, nn.DataParallel)
    state = load_state_dict_from_file(checkpoint_path, map_location, use_data_parallel=use_dp)
    model.load_state_dict(state, strict=True)


def _process_one_image(
    img_orig: np.ndarray,
    model: nn.Module,
    dev: torch.device,
    sq: int,
    out_full_res: bool,
    use_tiling: bool,
    tile_overlap: int,
    tile_batch: int,
    inference_scale: float,
    t_run0: float | None = None,
    image_label: str = "",
) -> tuple[np.ndarray, np.ndarray, str]:
    """
    Returns (img_out_bgr, prob_01, mode_label) where mode_label is 'tiling' or 'single'.
    If inference_scale != 1, resize a working copy before tiling/single; map prob back to img_orig size when out_full_res.
    """
    h_orig, w_orig = img_orig.shape[:2]
    if inference_scale != 1.0:
        w1 = max(1, int(round(w_orig * inference_scale)))
        h1 = max(1, int(round(h_orig * inference_scale)))
        img_full = cv2.resize(img_orig, (w1, h1), interpolation=cv2.INTER_LINEAR)
    else:
        img_full = img_orig

    h0, w0 = img_full.shape[:2]
    large = (h0 > sq) or (w0 > sq)

    if use_tiling and large:
        prob, n_tiles = _infer_tiles_stitched(
            img_full,
            model,
            dev,
            sq,
            tile_overlap,
            tile_batch,
            t_run0=t_run0,
            image_label=image_label,
        )
        img_out = img_full
        mode = f"tiling ({n_tiles} tiles)"
    else:
        # Single patch: resize to sq×sq for the network
        t0 = _now()
        img_model = (
            img_full
            if h0 == sq and w0 == sq
            else cv2.resize(img_full, (sq, sq), interpolation=cv2.INTER_LINEAR)
        )
        if DEBUG_TIMING:
            _log(f"single resize {image_label}: {_now() - t0:.3f}s", t_run0)
        with torch.no_grad():
            t1 = _now()
            x = _to_tensor_bgr(img_model).to(dev)
            pred_output, *_ = model(x)
            if dev.type == "cuda" and DEBUG_CUDA_SYNC:
                torch.cuda.synchronize()
            prob_small = torch.sigmoid(pred_output[0, 0]).cpu().numpy()
        if DEBUG_TIMING:
            _log(f"single forward {image_label}: {_now() - t1:.3f}s", t_run0)

        t2 = _now()
        if out_full_res and (h0 != sq or w0 != sq):
            prob = cv2.resize(prob_small, (w0, h0), interpolation=PROB_UPSCALE_INTERP)
            img_out = img_full
        else:
            prob = prob_small
            img_out = img_model
        if DEBUG_TIMING and (out_full_res and (h0 != sq or w0 != sq)):
            _log(f"single prob resize {image_label}: {_now() - t2:.3f}s", t_run0)
        mode = "single patch"

    if out_full_res and (prob.shape[0] != h_orig or prob.shape[1] != w_orig):
        prob = cv2.resize(prob, (w_orig, h_orig), interpolation=PROB_UPSCALE_INTERP)
        img_out = img_orig

    return img_out, prob, mode


def run_poc(
    input_dir: str | None = None,
    output_dir: str | None = None,
    checkpoint: str | None = None,
    device: str | None = None,
    size: int | None = None,
    use_tiling_for_large_images: bool | None = None,
    output_at_input_resolution: bool | None = None,
    tile_overlap: int | None = None,
    tile_overlap_percent: float | None = None,
    tile_batch_size: int | None = None,
    inference_scale: float | None = None,
    target_long_edge_px: int | None = None,
    debug_timing: bool | None = None,
) -> int:
    input_dir = input_dir or INPUT_DIR
    output_dir = output_dir or OUTPUT_DIR
    checkpoint = checkpoint or CHECKPOINT
    device_s = device or DEVICE
    sq = size if size is not None else SIZE
    out_full_res = (
        output_at_input_resolution
        if output_at_input_resolution is not None
        else OUTPUT_AT_INPUT_RESOLUTION
    )
    use_tiling = (
        use_tiling_for_large_images
        if use_tiling_for_large_images is not None
        else USE_TILING_FOR_LARGE_IMAGES
    )
    tovl, overlap_pct = _resolve_overlap_px(sq, tile_overlap, tile_overlap_percent)
    tile_batch = max(1, tile_batch_size if tile_batch_size is not None else TILE_BATCH_SIZE)
    base_inf_scale = float(inference_scale if inference_scale is not None else INFERENCE_SCALE)
    target_edge = int(target_long_edge_px or 0)
    global DEBUG_TIMING
    _debug_prev = DEBUG_TIMING
    if debug_timing is not None:
        DEBUG_TIMING = bool(debug_timing)

    try:
        if device_s == "cuda" and not torch.cuda.is_available():
            print("DEVICE is 'cuda' but torch.cuda.is_available() is False.")
            print("Install CUDA PyTorch: from codes\\ run .\\use_cuda_torch.ps1")
            return 1

        if device_s == "auto":
            dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            dev = torch.device(device_s)

        print(f"PyTorch {torch.__version__} | torch.version.cuda = {torch.version.cuda!s}")
        print(f"cuda.is_available()={torch.cuda.is_available()} | Using device: {dev}")
        if target_edge > 0:
            print(
                f"Tiling: {use_tiling} (overlap={tovl}px ~{overlap_pct:.1f}% of tile, batch={tile_batch}) "
                f"| SIZE={sq} | OUTPUT_AT_INPUT_RESOLUTION={out_full_res} "
                f"| TARGET_LONG_EDGE_PX={target_edge} (inference scale = target/max(w,h) per image)"
            )
        else:
            print(
                f"Tiling: {use_tiling} (overlap={tovl}px ~{overlap_pct:.1f}% of tile, batch={tile_batch}) "
                f"| SIZE={sq} | OUTPUT_AT_INPUT_RESOLUTION={out_full_res} "
                f"| INFERENCE_SCALE={base_inf_scale} (uniform for all images)"
            )
        if dev.type == "cpu" and "cpu" in torch.__version__.lower():
            print(
                "GPU: This install is CPU-only (+cpu). From codes\\ run: .\\use_cuda_torch.ps1 "
                "(or recreate venv with .\\setup_venv.ps1 without -Cpu)."
            )
        elif device_s == "auto" and dev.type == "cpu" and torch.version.cuda:
            print("GPU: CUDA build present but no device visible - check NVIDIA driver and GPU.")

        if not os.path.isfile(checkpoint):
            print(f"Missing checkpoint: {os.path.abspath(checkpoint)}")
            print("Place the .pth in codes/checkpoints/ (see POC_README.md).")
            return 1

        t_run0 = _now()

        patterns = ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG")
        paths: list[str] = []
        for p in patterns:
            paths.extend(glob.glob(os.path.join(input_dir, p)))
        paths = sorted(set(paths))
        if not paths:
            print(f"No images in: {os.path.abspath(input_dir)}")
            print("Add .jpg / .png to input_crops/ or set INPUT_DIR at the top of poc_inference.py.")
            return 1

        report_progress = os.environ.get("CRACKER_POC_PROGRESS") == "1"
        n_img = len(paths)
        if report_progress:
            print(f"[poc] Found {n_img} image(s) to process.", flush=True)

        os.makedirs(output_dir, exist_ok=True)

        t_m0 = _now()
        model = DeepCrack()
        if dev.type == "cuda":
            model = nn.DataParallel(model)
        model.to(dev)
        load_checkpoint_into_model(model, checkpoint, map_location=dev)
        model.eval()
        if DEBUG_TIMING:
            _log(f"model build + load weights: {_now() - t_m0:.3f}s", t_run0)

        ok = 0
        prog_step = max(1, n_img // 25) if report_progress and n_img else 1
        with torch.no_grad():
            for idx, img_path in enumerate(tqdm(paths, desc="DeepCrack POC")):
                t_img = _now()
                img_full = cv2.imread(img_path)
                if img_full is None:
                    print(f"Skip (unreadable): {img_path}")
                    continue
                if DEBUG_TIMING:
                    _log(f"imread {os.path.basename(img_path)}: {_now() - t_img:.3f}s", t_run0)

                h_im, w_im = img_full.shape[:2]
                inf_scale = _per_image_inference_scale(
                    target_edge if target_edge > 0 else None,
                    base_inf_scale,
                    h_im,
                    w_im,
                )
                if report_progress and target_edge > 0 and n_img:
                    cur = idx + 1
                    if cur == 1 or cur == n_img or cur % prog_step == 0 or n_img <= 10:
                        print(
                            f"[poc] {os.path.basename(img_path)}: inference_scale={inf_scale:.4f} "
                            f"(max side {max(h_im, w_im)} px -> target {target_edge} px)",
                            flush=True,
                        )

                t_proc = _now()
                label = os.path.basename(img_path)
                img_out, prob, mode = _process_one_image(
                    img_full,
                    model,
                    dev,
                    sq,
                    out_full_res,
                    use_tiling,
                    tovl,
                    tile_batch,
                    inf_scale,
                    t_run0=t_run0,
                    image_label=label,
                )
                if DEBUG_TIMING:
                    _log(f"inference total {label}: {_now() - t_proc:.3f}s ({mode})", t_run0)

                h0, w0 = img_full.shape[:2]
                if (h0 > sq or w0 > sq) and use_tiling:
                    tqdm.write(f"  {os.path.basename(img_path)}: {h0}x{w0} -> {mode}")

                t_io = _now()
                prob_u8 = (prob * 255).astype(np.uint8)
                base = os.path.splitext(os.path.basename(img_path))[0]
                cv2.imwrite(os.path.join(output_dir, f"{base}_crackprob.png"), prob_u8)

                preview = np.hstack([img_out, cv2.cvtColor(prob_u8, cv2.COLOR_GRAY2BGR)])
                cv2.imwrite(os.path.join(output_dir, f"{base}_preview.png"), preview)

                overlay_red = _red_crack_overlay(img_out, prob, OVERLAY_MAX_ALPHA)
                cv2.imwrite(os.path.join(output_dir, f"{base}_overlay_red.png"), overlay_red)
                if DEBUG_TIMING:
                    _log(f"imwrite x3 + numpy {label}: {_now() - t_io:.3f}s", t_run0)
                ok += 1
                if report_progress and n_img:
                    cur = idx + 1
                    if cur == 1 or cur == n_img or cur % prog_step == 0 or n_img <= 10:
                        pct = 100.0 * cur / n_img
                        print(
                            f"[poc] Progress {cur}/{n_img} ({pct:.1f}%) - {os.path.basename(img_path)}",
                            flush=True,
                        )

        if DEBUG_TIMING:
            _log(f"TOTAL run: {_now() - t_run0:.3f}s", t_run0)
        print(f"Done. Wrote {ok} result(s) to {os.path.abspath(output_dir)}")
        return 0
    finally:
        DEBUG_TIMING = _debug_prev


if __name__ == "__main__":
    raise SystemExit(run_poc())
