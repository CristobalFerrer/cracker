# DeepCrack POC (local inference)

This folder is a shallow clone of [qinnzou/DeepCrack](https://github.com/qinnzou/DeepCrack) with small patches for headless/CPU-friendly use and a **standalone inference script** that does not require Visdom.

## 1. Python environment

From `DeepCrack/codes`, run (PowerShell):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup_venv.ps1
```

That creates `.venv`, installs **CUDA 12.4 PyTorch** (GPU) by default, then `requirements-poc.txt`. If CUDA/DLL errors appear, use **`.\setup_venv.ps1 -Cpu`** for a CPU-only build.

If you already have a **CPU-only** venv (`2.x.x+cpu`), switch it to GPU without recreating the venv:

```powershell
.\use_cuda_torch.ps1
```

Activate:

```powershell
.\.venv\Scripts\Activate.ps1
```

Visdom is optional (see `requirements-poc-visdom.txt`); the patched code stubs it for `poc_inference.py` / basic `test.py` use.

## 2. Pretrained weights

Download the authors’ PyTorch checkpoint (same link as upstream README):

- [Google Drive – DeepCrack pretrained](https://drive.google.com/file/d/1OO3OAzR4yxYh_UBR9Nu7hV3XayfKVyO-/view?usp=sharing)

Place the `.pth` file as:

`codes/checkpoints/DeepCrack_CT260_FT1.pth`

(If the filename differs, pass `--checkpoint path\to\file.pth`.)

## 3. Run POC on your UAV crops

**Where to put images:** copy `.jpg` / `.png` files into `codes/input_crops/` (or set `INPUT_DIR` at the top of `poc_inference.py` to any folder).

**Large orthos (either side > 512 px):** with **`USE_TILING_FOR_LARGE_IMAGES = True`** (default), `poc_inference.py` runs **sliding 512×512 windows** with **`TILE_OVERLAP`** (default 128 px), **averages** crack probability in overlaps, and writes full-resolution `*_crackprob.png` / `*_overlay_red.png`. That keeps local ground sampling in each tile instead of shrinking the whole mosaic to 512². Tune **`TILE_BATCH_SIZE`** (e.g. 4–8 on GPU) for speed.

**Smaller images (both sides ≤ 512):** one forward pass; if **`OUTPUT_AT_INPUT_RESOLUTION = True`**, the prob map is resized to the input size when the image was upscaled to 512. Set **`USE_TILING_FOR_LARGE_IMAGES = False`** to force the old “whole image → resize to 512 → one inference” behavior on large files (not recommended for full mosaics).

**How to run:** open `codes/poc_inference.py`, edit the settings block at the top if needed, then **Run / Debug**.

**Cursor / VS Code:** the repo includes `.vscode/settings.json` (interpreter = `DeepCrack/codes/.venv`) and `.vscode/launch.json` — choose the debug configuration **“DeepCrack: poc_inference”** so `cwd` and `PYTHONPATH` point at `codes/` (fixes `model` / `weights_util` import errors).

Outputs go to `codes/poc_results/` by default (`OUTPUT_DIR` in the same file).

Outputs per image:

- `*_crackprob.png` — grayscale probability map (0–255)
- `*_preview.png` — input | heatmap side by side
- `*_overlay_red.png` — original with cracks tinted red (strength: `OVERLAY_MAX_ALPHA` in `poc_inference.py`)

## 4. Optional: upstream `test.py`

`trainer.py` is patched so `pos_weight` follows the model device (CPU/GPU). `tools/visdom.py` falls back to a stub if Visdom is missing or fails to connect.

To use the original index-file workflow, build a text file with one line per image:

`image_path label_path`

Generate a black 512×512 dummy label for visualization-only runs:

```powershell
python create_dummy_label.py
```

Then create e.g. `data/my_index.txt` with paths to your 512×512 images and `data/dummy_label_512.png`, and in `test.py` set `test_data_path='data/my_index.txt'` (or pass by editing the `test()` call). Run `python test.py`. Outputs are named `{stem}_deepcrack_stack.png` (prediction stacked above the label).

## 5. Scope

Road-trained weights; airport/runway imagery is **R&D only** until you validate or fine-tune on your data.
