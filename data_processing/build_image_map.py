"""
Build a mapping file: source image filename stem -> target annotation (sub, image_id)
Uses perceptual hash (thumbnail-based MD5) to match images across different resolutions.
Writes result to logs/src_to_tgt_map.json
"""
import os
import json
import hashlib
from pathlib import Path
from PIL import Image
from tqdm import tqdm


def thumb_hash(img_path, size=(32, 32)):
    """Compute hash of a small thumbnail for perceptual matching."""
    try:
        with Image.open(img_path) as img:
            thumb = img.convert('L').resize(size)
            return hashlib.md5(thumb.tobytes()).hexdigest()
    except Exception:
        return None


def main():
    src_img_dir = '/data/sonnh8/Layout/SuperTotalLayout/train_part2/images'
    target_root = '/data/ducbm3/DocumentOCR/dataset_public/train_part2'
    out_path = '/data/ducbm3/DocumentOCR/logs/src_to_tgt_map.json'

    # 1. Hash all target images
    print('Hashing target images...')
    tgt_hash_to_info = {}
    for sub in ['autopass', 'humanreview']:
        img_dir = os.path.join(target_root, sub, 'images')
        if not os.path.exists(img_dir):
            continue
        for fname in tqdm(os.listdir(img_dir), desc=f'  {sub}'):
            fpath = os.path.join(img_dir, fname)
            h = thumb_hash(fpath)
            if h:
                tgt_hash_to_info[h] = {'sub': sub, 'image_id': Path(fname).stem}
    print(f'  {len(tgt_hash_to_info)} target images hashed')

    # 2. Hash all source images and build mapping
    print('Hashing source images and matching...')
    src_files = [f for f in os.listdir(src_img_dir)
                 if f.lower().endswith(('.jpg', '.jpeg', '.png'))]

    mapping = {}  # src_stem -> {sub, image_id}
    unmatched = []
    for fname in tqdm(src_files, desc='  source'):
        src_stem = Path(fname).stem  # e.g. '(27)' or 'ket_qua...'
        fpath = os.path.join(src_img_dir, fname)
        h = thumb_hash(fpath)
        if h and h in tgt_hash_to_info:
            mapping[src_stem] = tgt_hash_to_info[h]
        else:
            unmatched.append(fname)

    print(f'  Matched: {len(mapping)}')
    print(f'  Unmatched: {len(unmatched)}')
    if unmatched[:5]:
        print(f'  Sample unmatched: {unmatched[:5]}')

    with open(out_path, 'w') as f:
        json.dump(mapping, f, indent=2)
    print(f'  Saved mapping to {out_path}')


if __name__ == '__main__':
    main()
