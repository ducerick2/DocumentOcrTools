import os
import shutil
import random
import argparse
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Sample random files from the dataset")
    parser.add_argument('--num_samples', '-n', type=int, default=100, help='Number of random samples to pick')
    parser.add_argument('--src_dir', type=str, default='/data/ducbm3/DocumentOCR/dataset_public/val/straight/autopass', help='Source autopass directory')
    parser.add_argument('--dst_dir', type=str, default='/data/ducbm3/DocumentOCR/dataset_public/val/samples/autopass', help='Destination autopass directory')

    args = parser.parse_args()

    src_anno = Path(args.src_dir) / 'annotations'
    src_images = Path(args.src_dir) / 'images'
    src_layouts = Path(args.src_dir) / 'layout_detections'

    dst_anno = Path(args.dst_dir) / 'annotations'
    dst_images = Path(args.dst_dir) / 'images'
    dst_layouts = Path(args.dst_dir) / 'layout_detections'

    # Clear destination if exists
    if Path(args.dst_dir).exists():
        print(f"Clearing existing destination directory: {args.dst_dir}")
        shutil.rmtree(args.dst_dir)
    
    # Create directories
    dst_anno.mkdir(parents=True, exist_ok=True)
    dst_images.mkdir(parents=True, exist_ok=True)
    dst_layouts.mkdir(parents=True, exist_ok=True)

    # Get all json files
    all_jsons = list(src_anno.glob('*.json'))
    
    if not all_jsons:
        print(f"No json files found in {src_anno}")
        return

    # Sample N files
    num_to_sample = min(args.num_samples, len(all_jsons))
    print(f"Sampling {num_to_sample} files from {len(all_jsons)} available...")
    sampled_files = random.sample(all_jsons, num_to_sample)

    copied_count = 0
    for anno_path in sampled_files:
        stem = anno_path.stem
        # Copy annotation
        shutil.copy2(anno_path, dst_anno / anno_path.name)
        
        # Copy image (try jpg, png, jpeg)
        for ext in ['.jpg', '.png', '.jpeg']:
            img_path = src_images / f"{stem}{ext}"
            if img_path.exists():
                shutil.copy2(img_path, dst_images / img_path.name)
                break
        
        # Copy layout detection
        layout_path = src_layouts / f"{stem}.txt"
        if layout_path.exists():
            shutil.copy2(layout_path, dst_layouts / layout_path.name)
            
        copied_count += 1

    print(f"Successfully copied {copied_count} samples to {args.dst_dir}")

if __name__ == '__main__':
    main()
