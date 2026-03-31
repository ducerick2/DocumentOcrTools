#!/usr/bin/env python3
"""
Comprehensive DocLayNet v1.2 Dataset Extraction
Extracts images, annotations, markdowns, layout detections, and texts
Organized by split and document category
"""

from datasets import load_from_disk
from pathlib import Path
import json
from tqdm import tqdm
import argparse
from PIL import Image
import io
import multiprocessing
from functools import partial
from itertools import islice
import os

DATASET_PATH = "/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_v1.2"
OUTPUT_BASE = "/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_extracted"

# Category mapping
CATEGORY_NAMES = {
    1: "Caption", 2: "Footnote", 3: "Formula", 4: "List-item",
    5: "Page-footer", 6: "Page-header", 7: "Picture", 
    8: "Section-header", 9: "Table", 10: "Text", 11: "Title"
}

def calculate_reading_order(bboxes):
    """
    Calculate reading order based on spatial position (top-to-bottom, left-to-right)
    Returns indices sorted by reading order
    """
    # Convert bboxes to (x, y, w, h) and calculate center points
    positions = []
    for i, bbox in enumerate(bboxes):
        x, y, w, h = bbox
        center_x = x + w / 2
        center_y = y + h / 2
        positions.append((i, center_y, center_x))
    
    # Sort by y (top to bottom), then x (left to right)
    # Use bins for y-coordinate to handle elements on same line
    sorted_positions = sorted(positions, key=lambda p: (round(p[1] / 50), p[2]))
    
    return [p[0] for p in sorted_positions]

def convert_bbox_to_xyxy(bbox):
    """
    Convert bounding box from [x, y, w, h] to [xmin, ymin, xmax, ymax]
    """
    x, y, w, h = bbox
    return [x, y, x + w, y + h]

def extract_text_from_cells(pdf_cells):
    """Extract text content from PDF cells"""
    if not pdf_cells:
        return ""
    
    texts = []
    for cell in pdf_cells:
        if isinstance(cell, dict) and 'text' in cell:
            texts.append(cell['text'])
        elif isinstance(cell, str):
            texts.append(cell)
    
    return " ".join(texts).strip()

def table_to_html(content, bbox):
    """
    Keep table content in HTML format (not OTSL)
    """
    # If content already has HTML tags, keep it
    if '<table' in content.lower():
        return content
    
    # Otherwise wrap in basic HTML table
    return f"<table>\n{content}\n</table>"

def create_markdown(layouts_sorted):
    """Create markdown representation of document"""
    markdown_lines = []
    
    for layout in layouts_sorted:
        class_name = layout['class']
        content = layout['content']
        
        if not content:
            continue
        
        if class_name == "Title":
            markdown_lines.append(f"# {content}\n")
        elif class_name == "Section-header":
            markdown_lines.append(f"## {content}\n")
        elif class_name == "Caption":
            markdown_lines.append(f"*{content}*\n")
        elif class_name == "Table":
            # Keep HTML format (not OTSL)
            html_table = table_to_html(content, layout['bbox'])
            markdown_lines.append(f"{html_table}\n")
        elif class_name == "Formula":
            markdown_lines.append(f"$$\n{content}\n$$\n")
        elif class_name == "List-item":
            markdown_lines.append(f"- {content}\n")
        elif class_name == "Footnote":
            markdown_lines.append(f"[^note]: {content}\n")
        else:
            markdown_lines.append(f"{content}\n")
    
    return "\n".join(markdown_lines)

def create_layout_detection(layouts_sorted):
    """Create layout detection format with special tokens"""
    lines = []
    
    for layout in layouts_sorted:
        bbox = layout['bbox']  # Already in [xmin, ymin, xmax, ymax] format
        class_name = layout['class'].lower().replace('-', '_')
        
        # Format: <|box_start|>xmin ymin xmax ymax<|box_end|><|ref_start|>class<|ref_end|>
        bbox_str = f"{int(bbox[0]):03d} {int(bbox[1]):03d} {int(bbox[2]):03d} {int(bbox[3]):03d}"
        line = f"<|box_start|>{bbox_str}<|box_end|><|ref_start|>{class_name}<|ref_end|>"
        lines.append(line)
    
    return "\n".join(lines)

def create_plain_text(layouts_sorted):
    """Create plain text content sorted by reading order"""
    texts = []
    
    for layout in layouts_sorted:
        content = layout['content']
        if content:
            texts.append(content)
    
    return "\n\n".join(texts)

def process_sample(sample, output_dir):
    """Process a single sample and create all output files"""
    
    metadata = sample['metadata']
    image_id = metadata['image_id']
    doc_category = metadata.get('doc_category', 'unknown')
    
    # Create category directory structure
    category_dir = output_dir / doc_category
    images_dir = category_dir / "images"
    # Only create images directory
    for dir_path in [images_dir]:
        dir_path.mkdir(parents=True, exist_ok=True)
    
    # 1. Save image
    image = sample['image']
    image_path = images_dir / f"{image_id}.png"
    image.save(image_path)
    
    # Skip other extractions for now (reserved for later steps)
    # 2. Process layouts...
    # 3. Create annotation...
    # 4. Create markdown...
    # 5. Create layout detection...
    # 6. Create plain text...
    
    return doc_category

def extract_split(dataset, split_name, output_base, max_samples=None, workers=1):
    """Extract a complete split with all components"""
    
    print(f"\n{'='*80}")
    print(f"Extracting {split_name} split")
    print(f"{'='*80}")
    
    split_data = dataset[split_name]
    num_samples = min(len(split_data), max_samples) if max_samples else len(split_data)
    
    output_dir = Path(output_base) / split_name
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Processing {num_samples} / {len(split_data)} samples...")
    print(f"Output directory: {output_dir}")
    
    # Track statistics
    category_counts = {}
    
    # Prepare iterator
    if max_samples:
        samples_iter = islice(split_data, num_samples)
    else:
        samples_iter = split_data
        
    if workers > 1:
        # Use multiprocessing
        print(f"Using {workers} worker processes")
        process_func = partial(process_sample, output_dir=output_dir)
        with multiprocessing.Pool(processes=workers) as pool:
            # Chunksize increased to reduce overhead
            results = list(tqdm(pool.imap(process_func, samples_iter, chunksize=10), 
                              total=num_samples, desc=f"Extracting {split_name}"))
            
            for doc_category in results:
                category_counts[doc_category] = category_counts.get(doc_category, 0) + 1
    else:
        # Single process
        for sample in tqdm(samples_iter, total=num_samples, desc=f"Extracting {split_name}"):
            doc_category = process_sample(sample, output_dir)
            category_counts[doc_category] = category_counts.get(doc_category, 0) + 1
    
    # Print statistics
    print(f"\n✓ Extraction complete!")
    print(f"  Total samples: {num_samples}")
    print(f"\n  Samples per category:")
    for category, count in sorted(category_counts.items()):
        print(f"    {category}: {count}")
    
    return category_counts

def main():
    parser = argparse.ArgumentParser(
        description="Extract DocLayNet v1.2 with comprehensive structure"
    )
    parser.add_argument('--split', type=str, 
                       choices=['train', 'validation', 'test', 'all'], 
                       default='all', help='Which split to extract')
    parser.add_argument('--max-samples', type=int, default=None,
                       help='Maximum samples per split (for testing)')
    parser.add_argument('--output-dir', type=str, default=OUTPUT_BASE,
                       help='Output base directory')
    parser.add_argument('--workers', type=int, default=os.cpu_count(),
                       help='Number of worker processes')
    
    args = parser.parse_args()
    
    print("="*80)
    print("DocLayNet v1.2 Comprehensive Extraction")
    print("="*80)
    print(f"Dataset: {DATASET_PATH}")
    print(f"Output: {args.output_dir}")
    if args.max_samples:
        print(f"Max samples per split: {args.max_samples}")
    
    print("\nOutput structure per split:")
    print("  <category>/")
    print("    ├── images/            # Original PNG images")
    print("    ├── annotations/       # JSON with layouts + reading order")
    print("    ├── raw_annotations/   # Original structure from dataset")
    print("    ├── markdowns/         # Markdown with HTML tables")
    print("    ├── layout_detections/ # Special token format")
    print("    └── texts/             # Plain text content")
    
    # Load dataset
    print("\nLoading dataset...")
    dataset = load_from_disk(DATASET_PATH)
    print(f"✓ Loaded with splits: {list(dataset.keys())}")
    
    # Extract splits
    if args.split == 'all':
        splits = list(dataset.keys())
    else:
        splits = [args.split]
    
    total_stats = {}
    for split_name in splits:
        stats = extract_split(dataset, split_name, args.output_dir, args.max_samples, args.workers)
        total_stats[split_name] = stats
    
    print("\n" + "="*80)
    print("Extraction Complete!")
    print("="*80)
    print(f"\nOutput location: {args.output_dir}")
    print("\nDataset structure ready for Document OCR training!")

if __name__ == "__main__":
    main()
