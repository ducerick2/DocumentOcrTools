#!/bin/bash
# Process full DocLayNet dataset with multi-model inference

DATASET_ROOT="/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_v1.2"
OUTPUT_ROOT="/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_MultiModel"

echo "=========================================="
echo "Multi-Model DocLayNet Processing"
echo "=========================================="
echo "Dataset: $DATASET_ROOT"
echo "Output: $OUTPUT_ROOT"
echo ""

# Process each split
for SPLIT in validation train test; do
    echo "Processing $SPLIT split..."
    
    # Get images from Arrow dataset
    python3 << EOF
from datasets import load_from_disk
from pathlib import Path
from PIL import Image
from tqdm import tqdm

dataset = load_from_disk('$DATASET_ROOT')
split_data = dataset['$SPLIT']

# Create temp images directory
temp_dir = Path('/tmp/doclaynet_${SPLIT}_images')
temp_dir.mkdir(parents=True, exist_ok=True)

print(f"Extracting {len(split_data)} images to {temp_dir}...")

for i, sample in enumerate(tqdm(split_data)):
    image = sample['image']
    image.save(temp_dir / f"{i}.png")

print(f"✓ Extracted {len(split_data)} images")
EOF

    # Run multi-model inference
    python3 multi_model_inference.py \
        --input-dir "/tmp/doclaynet_${SPLIT}_images" \
        --output-dir "$OUTPUT_ROOT/$SPLIT" \
        --max-images 100  # Start with 100 images per split for testing
    
    # Clean up temp images
    rm -rf "/tmp/doclaynet_${SPLIT}_images"
    
    echo "✓ Completed $SPLIT split"
    echo ""
done

echo "=========================================="
echo "Processing Complete!"
echo "=========================================="
echo "Output location: $OUTPUT_ROOT"
