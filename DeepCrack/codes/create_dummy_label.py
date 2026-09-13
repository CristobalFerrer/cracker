"""Write a 512x512 black PNG for use as dummy GT in data/*.txt index files."""
import os

import cv2
import numpy as np

CODES_DIR = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(CODES_DIR, "data", "dummy_label_512.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
cv2.imwrite(out, np.zeros((512, 512), dtype=np.uint8))
print(f"Wrote {out}")
