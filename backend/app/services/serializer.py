"""
Compact binary mask serializer for high-speed network transmission.
Bit-packs 2D uint8 binary masks (8 pixels per byte) and encodes to Base64.
"""

import base64
from typing import List, Tuple
import numpy as np


def encode_mask_bitmask(mask: np.ndarray) -> str:
    """
    Bit-packs a 2D uint8 binary mask (1 = unshaded, 0 = shaded) and returns a Base64 string.
    A 100,000-pixel patch compresses from 100 KB to ~12.5 KB.
    """
    # Ensure boolean/binary uint8
    binary_arr = (mask > 0).astype(np.uint8).ravel()
    packed = np.packbits(binary_arr)
    return base64.b64encode(packed.tobytes()).decode("ascii")


def decode_mask_bitmask(encoded: str, shape: Tuple[int, int]) -> np.ndarray:
    """
    Decodes a Base64 bit-packed string back into a 2D uint8 numpy array of shape (H, W).
    """
    raw_bytes = base64.b64decode(encoded)
    packed = np.frombuffer(raw_bytes, dtype=np.uint8)
    unpacked = np.unpackbits(packed)
    
    total_pixels = shape[0] * shape[1]
    # Trim any padding bits from the byte boundary
    trimmed = unpacked[:total_pixels]
    return trimmed.reshape(shape)


def encode_masks_batch(masks: List[np.ndarray]) -> List[str]:
    """
    Encodes a list of 2D binary masks into base64 bit-packed strings.
    """
    return [encode_mask_bitmask(m) for m in masks]
