#!/bin/bash
# Test single image with all 3 models

IMAGE_PATH="/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_extracted/validation/financial_reports/images/0.png"
OUTPUT_DIR="/data/ducbm3/DocumentOCR/test_multi_model_output"

echo "Testing multi-model inference on single image..."
echo "Image: $IMAGE_PATH"
echo "Output: $OUTPUT_DIR"
echo ""

python3 multi_model_inference.py \
    --input-dir "/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_extracted/validation/financial_reports/images" \
    --output-dir "$OUTPUT_DIR" \
    --max-images 1

echo ""
echo "Check output in: $OUTPUT_DIR"
