import os
import json
import ast
import argparse
from tqdm import tqdm
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Revert annotations in target_folder from model_outputs in source_root_folder")
    parser.add_argument("target_folder", type=str, help="Folder containing annotations to revert (e.g., .../straight)")
    parser.add_argument("source_root", type=str, help="Root folder containing model_outputs (e.g., .../train_part4)")
    args = parser.parse_args()

    target_folder = Path(args.target_folder)
    source_root = Path(args.source_root)

    sub_dirs = ['autopass', 'humanreview']

    print(f"Reverting annotations in {target_folder}\nFrom source model_outputs in {source_root}...")

    total_reverted = 0
    total_missing = 0

    for sub in sub_dirs:
        target_anno_dir = target_folder / sub / "annotations"
        target_img_dir = target_folder / sub / "images"
        mo_dir = source_root / sub / "model_outputs"
        
        if not target_anno_dir.exists() or not mo_dir.exists():
            continue
            
        target_files = [f for f in os.listdir(target_anno_dir) if f.endswith(".json")]
        
        if not target_files:
            continue

        for anno_fname in tqdm(target_files, desc=f"Reverting {sub}"):
            image_id = anno_fname.replace(".json", "")
            mo_fname = f"{image_id}_mineru_2_5.json"
            mo_path = mo_dir / mo_fname
            anno_path = target_anno_dir / anno_fname
            
            if not mo_path.exists():
                total_missing += 1
                continue
            
            # Find image path for annotation
            image_path = target_img_dir / f"{image_id}.jpg"
            if not image_path.exists():
                image_path = target_img_dir / f"{image_id}.png"
            if not image_path.exists():
                image_path = target_img_dir / f"{image_id}.jpg" # default fallback
            
            try:
                with open(mo_path, 'r', encoding='utf-8') as f:
                    mo_data = json.load(f)
                
                raw_response = mo_data.get("raw_response", "")
                metadata = mo_data.get("metadata", {})
                
                layouts_raw = ast.literal_eval(raw_response)
                
                final_layouts = []
                for idx, item in enumerate(layouts_raw):
                    # Normalized bounding boxes [0..1] -> [0..999] pseudo-pixels
                    nb = item.get("bbox", [0, 0, 0, 0])
                    bbox = [
                        int(round(nb[0] * 999)),
                        int(round(nb[1] * 999)),
                        int(round(nb[2] * 999)),
                        int(round(nb[3] * 999))
                    ]
                    
                    final_layouts.append({
                        "class": item.get("type", "text"),
                        "bbox": bbox,
                        "content": item.get("content", ""),
                        "reading_order": idx
                    })
                
                annotation = {
                    "image_id": int(image_id) if image_id.isdigit() else image_id,
                    "image_path": str(image_path),
                    "layouts": final_layouts,
                    "metadata": metadata
                }
                
                with open(anno_path, 'w', encoding='utf-8') as f:
                    json.dump(annotation, f, indent=2, ensure_ascii=False)
                
                total_reverted += 1
            except Exception as e:
                # print(f"Error processing {mo_fname}: {e}")
                continue

    print(f"\nRevert complete. Successfully reverted {total_reverted} files.")
    if total_missing > 0:
        print(f"Warning: model_outputs not found for {total_missing} files.")

if __name__ == "__main__":
    main()
