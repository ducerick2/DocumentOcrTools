import os
import json
import glob
import shutil
from pathlib import Path

def normalize(val, max_val):
    if max_val == 0:
        return 0
    return min(999, max(0, int(round((val * 1000) / max_val))))

def main():
    src_dir = "/data/ducbm3/keypoints/data/SuperLayout/train_part6"
    dst_dir = "/data/ducbm3/DocumentOCR/dataset_public/train_part6_new"
    
    json_files = glob.glob(os.path.join(src_dir, "**", "*.json"), recursive=True)
    converted_count = 0
    
    print(f"Found {len(json_files)} JSON files in {src_dir}")
    
    for json_path in json_files:
        with open(json_path, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except Exception as e:
                print(f"Error parsing {json_path}: {e}")
                continue
                
        # Check if it's already MinerU or if it has shapes
        if 'shapes' not in data:
            print(f"Skipping {json_path} (no 'shapes' key found)")
            continue
            
        img_width = data.get('imageWidth', 1000)
        img_height = data.get('imageHeight', 1000)
        shapes = data.get('shapes', [])
        
        parts = Path(json_path).parts
        rel_path = Path(json_path).relative_to(src_dir)
        
        # Priority 1: Use the top-level directory name from source (new/preferred behavior)
        if len(rel_path.parts) > 1:
            subgroup = rel_path.parts[0]
        # Priority 2: Check for keywords (backward compatibility/fallback)
        elif "autopass" in parts:
            subgroup = "autopass"
        elif "humanreview" in parts:
            subgroup = "humanreview"
        else:
            subgroup = "default"
            
        dst_annotations_dir = os.path.join(dst_dir, subgroup, "annotations")
        dst_images_dir = os.path.join(dst_dir, subgroup, "images")
        
        os.makedirs(dst_annotations_dir, exist_ok=True)
        os.makedirs(dst_images_dir, exist_ok=True)
        os.makedirs(os.path.join(dst_dir, subgroup, "layout_detections"), exist_ok=True)
        os.makedirs(os.path.join(dst_dir, subgroup, "markdowns"), exist_ok=True)
        os.makedirs(os.path.join(dst_dir, subgroup, "texts"), exist_ok=True)
        
        image_id = Path(json_path).stem
        image_name = data.get('imagePath', f"{image_id}.jpg")
        
        # Try to locate the source image to copy
        src_img_path = os.path.join(os.path.dirname(json_path), image_name)
        if not os.path.exists(src_img_path):
            # Fallback to checking extension .jpg or .png
            fallback_jpg = str(Path(json_path).with_suffix('.jpg'))
            if os.path.exists(fallback_jpg):
                src_img_path = fallback_jpg
            else:
                fallback_png = str(Path(json_path).with_suffix('.png'))
                if os.path.exists(fallback_png):
                    src_img_path = fallback_png
                    
        abs_dest_img_path = ""
        if os.path.exists(src_img_path):
            dest_img_filename = os.path.basename(src_img_path)
            dest_img_path = os.path.join(dst_images_dir, dest_img_filename)
            if not os.path.exists(dest_img_path):
                 shutil.copy2(src_img_path, dest_img_path)
            abs_dest_img_path = dest_img_path
            
        layouts = []
        for index, shape in enumerate(shapes):
            label = shape.get('label', '')
            points = shape.get('points', [])
            
            if not points or len(points) < 1:
                continue
                
            # Normalize polygon points
            poly = [[normalize(p[0], img_width), normalize(p[1], img_height)] for p in points]
            
            layout = {
                "class": label,
                "content": None,
                "reading_order": index,
                "poly": poly
            }
            layouts.append(layout)
            
        result_data = {
            "image_id": image_id,
            "image_path": abs_dest_img_path,
            "layouts": layouts,
            "metadata": {
                "strategy": "converted_from_labelme_shapes",
                "original_path": json_path
            }
        }
        
        dest_json_path = os.path.join(dst_annotations_dir, f"{image_id}.json")
        with open(dest_json_path, 'w', encoding='utf-8') as f:
            json.dump(result_data, f, indent=2, ensure_ascii=False)
            
        layout_det_path = os.path.join(dst_dir, subgroup, "layout_detections", f"{image_id}.txt")
        with open(layout_det_path, "w", encoding="utf-8") as f:
            for layout in layouts:
                p = layout["poly"]
                poly_str = " ".join([f"{pt[0]} {pt[1]}" for pt in p])
                lbl = layout["class"]
                f.write(f"<|box_start|>{poly_str}<|box_end|><|ref_start|>{lbl}<|ref_end|>\n")
                
        md_path = os.path.join(dst_dir, subgroup, "markdowns", f"{image_id}.md")
        with open(md_path, "w", encoding="utf-8") as f:
            f.write("\n".join([""] * len(layouts)))
            
        txt_path = os.path.join(dst_dir, subgroup, "texts", f"{image_id}.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write("\n".join([""] * len(layouts)))
            
        converted_count += 1
        
    print(f"Successfully converted {converted_count} files and saved to {dst_dir}")

if __name__ == "__main__":
    main()
