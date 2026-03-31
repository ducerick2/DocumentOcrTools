import os
import json
import shutil
import ast
from tqdm import tqdm
from pathlib import Path

def main():
    from sys import argv
    root = str(argv[1])
    # Undo restructuring
    # categories = ['straight', 'not_straight']
    categories = ['straight']
    sub_dirs = ['autopass', 'humanreview']
    
    # 1. Move files back to root autopass/humanreview
    print("Moving files back to original directories...")
    for cat in categories:
        cat_dir = os.path.join(root, cat)
        if not os.path.exists(cat_dir):
            continue
            
        for sub in sub_dirs:
            sub_src = os.path.join(cat_dir, sub)
            sub_dst = os.path.join(root, sub)
            
            if not os.path.exists(sub_src):
                continue
            
            # Create root autopass/humanreview if not exists
            os.makedirs(sub_dst, exist_ok=True)
            
            # Move all contents from straight/autopass to autopass/
            for item in os.listdir(sub_src):
                item_src = os.path.join(sub_src, item)
                item_dst = os.path.join(sub_dst, item)
                
                if os.path.exists(item_dst):
                    # If it's a directory (images, annotations, etc.), merge contents
                    if os.path.isdir(item_src):
                        for sub_item in os.listdir(item_src):
                            si_src = os.path.join(item_src, sub_item)
                            si_dst = os.path.join(item_dst, sub_item)
                            shutil.move(si_src, si_dst)
                        os.rmdir(item_src)
                    else:
                        os.remove(item_dst)
                        shutil.move(item_src, item_dst)
                else:
                    shutil.move(item_src, item_dst)
            
            if os.path.exists(sub_src) and not os.listdir(sub_src):
                os.rmdir(sub_src)
        
        if os.path.exists(cat_dir) and not os.listdir(cat_dir):
            os.rmdir(cat_dir)

    # 2. Revert annotations from model_outputs
    print("\nReverting annotations from model_outputs...")
    for sub in sub_dirs:
        sub_dir = os.path.join(root, sub)
        anno_dir = os.path.join(sub_dir, "annotations")
        mo_dir = os.path.join(sub_dir, "model_outputs")
        img_dir = os.path.join(sub_dir, "images")
        
        if not os.path.exists(mo_dir):
            continue
            
        mo_files = [f for f in os.listdir(mo_dir) if f.endswith("_mineru_2_5.json")]
        
        for mo_file in tqdm(mo_files, desc=f"Reverting {sub}"):
            image_id = mo_file.replace("_mineru_2_5.json", "")
            mo_path = os.path.join(mo_dir, mo_file)
            anno_path = os.path.join(anno_dir, f"{image_id}.json")
            
            # Find image path (for image_path field in annotation)
            image_path = os.path.join(img_dir, f"{image_id}.jpg")
            if not os.path.exists(image_path):
                image_path = os.path.join(img_dir, f"{image_id}.png")
            if not os.path.exists(image_path):
                image_path = os.path.join(img_dir, f"{image_id}.jpg")  # fallback
            
            with open(mo_path, 'r') as f:
                mo_data = json.load(f)
            
            raw_response = mo_data.get("raw_response", "")
            metadata = mo_data.get("metadata", {})
            
            try:
                # Parse the raw response which is a stringified list of dicts
                layouts_raw = ast.literal_eval(raw_response)
                
                final_layouts = []
                for idx, item in enumerate(layouts_raw):
                    # bboxes are normalized floats in [0.0, 1.0] — convert to [0, 999]
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
                
                # Construct annotation JSON
                annotation = {
                    "image_id": int(image_id) if image_id.isdigit() else image_id,
                    "image_path": str(image_path), # Use the path we found
                    "layouts": final_layouts,
                    "metadata": metadata
                }
                
                with open(anno_path, 'w', encoding='utf-8') as f:
                    json.dump(annotation, f, indent=2, ensure_ascii=False)
                    
            except Exception as e:
                # print(f"Error processing {mo_file}: {e}")
                continue

    print("\nRevert complete.")

if __name__ == "__main__":
    main()
