"""
Regenerate annotations/*.json from layout_detections (for exact bbox) + model_outputs (for content).
This ensures annotations always match layout_detections perfectly.
"""
import os
import json
import ast
import re
from tqdm import tqdm


def parse_layout_detections(txt_path: str):
    """Parse layout detection file: <|box_start|>x1 y1 x2 y2<|box_end|><|ref_start|>class<|ref_end|>"""
    detections = []
    pattern = re.compile(
        r"<\|box_start\|>(\d+)\s+(\d+)\s+(\d+)\s+(\d+)<\|box_end\|><\|ref_start\|>(\S+?)<\|ref_end\|>"
    )
    try:
        with open(txt_path, 'r', encoding='utf-8') as f:
            for line in f:
                m = pattern.search(line.strip())
                if m:
                    x1, y1, x2, y2 = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
                    cls = m.group(5)
                    detections.append({"class": cls, "bbox": [x1, y1, x2, y2]})
    except FileNotFoundError:
        pass
    return detections


def parse_content_from_model_output(mo_path: str):
    """Extract content list (in order) from mineru model_output raw_response."""
    try:
        with open(mo_path, 'r', encoding='utf-8') as f:
            mo_data = json.load(f)
        raw_response = mo_data.get("raw_response", "")
        layouts_raw = ast.literal_eval(raw_response)
        return [item.get("content", "") for item in layouts_raw], mo_data.get("metadata", {})
    except Exception:
        return [], {}


def main():
    root = "/data/ducbm3/DocumentOCR/dataset_public/train_part2"
    sub_dirs = ['autopass', 'humanreview']
    
    stats = {"processed": 0, "skipped": 0}
    
    for sub in sub_dirs:
        sub_dir = os.path.join(root, sub)
        anno_dir = os.path.join(sub_dir, "annotations")
        ld_dir   = os.path.join(sub_dir, "layout_detections")
        mo_dir   = os.path.join(sub_dir, "model_outputs")
        img_dir  = os.path.join(sub_dir, "images")
        
        if not os.path.exists(ld_dir):
            continue
        
        ld_files = [f for f in os.listdir(ld_dir) if f.endswith(".txt")]
        
        for ld_file in tqdm(ld_files, desc=f"Fixing {sub}"):
            image_id = ld_file.replace(".txt", "")
            ld_path  = os.path.join(ld_dir, ld_file)
            mo_path  = os.path.join(mo_dir, f"{image_id}_mineru_2_5.json")
            anno_path = os.path.join(anno_dir, f"{image_id}.json")
            
            detections = parse_layout_detections(ld_path)
            if not detections:
                stats["skipped"] += 1
                continue
            
            contents, metadata = parse_content_from_model_output(mo_path)
            
            # Merge bbox from layout_detections with content from model_outputs (same order)
            final_layouts = []
            for idx, det in enumerate(detections):
                final_layouts.append({
                    "class": det["class"],
                    "bbox": det["bbox"],           # Exact values from layout_detections
                    "content": contents[idx] if idx < len(contents) else "",
                    "reading_order": idx
                })
            
            # Find image path
            image_path = os.path.join(img_dir, f"{image_id}.jpg")
            if not os.path.exists(image_path):
                image_path = os.path.join(img_dir, f"{image_id}.png")
            
            annotation = {
                "image_id": int(image_id) if image_id.isdigit() else image_id,
                "image_path": str(image_path),
                "layouts": final_layouts,
                "metadata": metadata
            }
            
            os.makedirs(anno_dir, exist_ok=True)
            with open(anno_path, 'w', encoding='utf-8') as f:
                json.dump(annotation, f, indent=2, ensure_ascii=False)
            
            stats["processed"] += 1
    
    print(f"\nDone. processed={stats['processed']}, skipped={stats['skipped']}")


if __name__ == "__main__":
    main()
