"""
Unit tests for binary mask bit-packing serializer and base64 compression.
"""

import pytest
import numpy as np

from backend.app.services.serializer import (
    encode_mask_bitmask,
    decode_mask_bitmask,
    encode_masks_batch
)


def test_serializer_roundtrip_ones_and_zeros():
    shape = (100, 100)
    
    # All zeros
    mask_zeros = np.zeros(shape, dtype=np.uint8)
    encoded_zeros = encode_mask_bitmask(mask_zeros)
    decoded_zeros = decode_mask_bitmask(encoded_zeros, shape)
    assert np.array_equal(mask_zeros, decoded_zeros)

    # All ones
    mask_ones = np.ones(shape, dtype=np.uint8)
    encoded_ones = encode_mask_bitmask(mask_ones)
    decoded_ones = decode_mask_bitmask(encoded_ones, shape)
    assert np.array_equal(mask_ones, decoded_ones)


def test_serializer_roundtrip_pattern():
    shape = (316, 316) # ~100,000 cells
    
    # Checkerboard pattern
    r, c = np.indices(shape)
    pattern = ((r + c) % 2).astype(np.uint8)
    
    encoded = encode_mask_bitmask(pattern)
    assert isinstance(encoded, str)
    # 316x316 = 99,856 bits = 12,482 bytes => ~16.6 KB in base64
    assert len(encoded) < 20000
    
    decoded = decode_mask_bitmask(encoded, shape)
    assert np.array_equal(pattern, decoded)


def test_serializer_batch():
    shape = (50, 50)
    masks = [
        np.zeros(shape, dtype=np.uint8),
        np.ones(shape, dtype=np.uint8),
        np.random.randint(0, 2, size=shape, dtype=np.uint8)
    ]
    
    encoded_list = encode_masks_batch(masks)
    assert len(encoded_list) == 3
    
    for original, enc in zip(masks, encoded_list):
        decoded = decode_mask_bitmask(enc, shape)
        assert np.array_equal(original, decoded)
