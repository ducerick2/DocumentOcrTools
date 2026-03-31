import json
import glob
import os

base_dir = "/data/ducbm3/DocumentOCR/dataset_public/train_part3/humanreview"
outputs_dir = os.path.join(base_dir, "model_outputs")
ann_dir = os.path.join(base_dir, "annotations")
layout_dir = os.path.join(base_dir, "layout_detections")

print(f"Scanning {outputs_dir}...")
# Find MinerU output files
files = glob.glob(os.path.join(outputs_dir, "*_mineru_2_5.json"))
print(f"Found {len(files)} MinerU output files.")

count = 0
for fpath in files:
    fname = os.path.basename(fpath)
    image_id = fname.replace("_mineru_2_5.json", "")
    
    with open(fpath, 'r') as f:
        data = json.load(f)
        
    raw = data.get('raw_response', '[]')
    if isinstance(raw, str):
        try:
             # Replace single quotes if needed usually python repr
             raw_blocks = eval(raw) 
        except:
             try: raw_blocks = json.loads(raw)
             except: 
                 print(f"Failed to parse raw_response for {image_id}")
                 continue
    else:
        raw_blocks = raw
        
    if not isinstance(raw_blocks, list): 
        print(f"Raw blocks not list for {image_id}")
        continue
    
    # Load Annotation
    ann_path = os.path.join(ann_dir, f"{image_id}.json")
    if not os.path.exists(ann_path): 
        print(f"Annotation not found for {image_id}")
        continue
    
    with open(ann_path, 'r') as f:
        ann_data = json.load(f)
        
    layouts = ann_data.get('layouts', [])
    
    # Update layouts
    updated = False
    
    # Assumptions: 
    # 1. layouts list is in same order as raw_blocks? 
    # Usually yes if created by multi_model_inference_vllm.py
    # But layouts might have been sorted? No, default append.
    # Let's verify by length or reading_order if available.
    
    if len(layouts) != len(raw_blocks):
        print(f"Warning: Count mismatch for {image_id} (Ann: {len(layouts)}, Raw: {len(raw_blocks)})")
        # Continue best effort? matching indices?
        # Safe to assume index matching for now if no deletions happened
    
    for i, layout in enumerate(layouts):
        if i < len(raw_blocks):
            raw_block = raw_blocks[i]
            raw_type = raw_block.get('type')
            current_class = layout.get('class')
            
            # Check if mapped
            if current_class == 'formula' and raw_type in ['equation', 'equation_block']:
                layout['class'] = raw_type
                updated = True
                
    if updated:
        count += 1
        # Save Annotation
        with open(ann_path, 'w', encoding='utf-8') as f:
            json.dump(ann_data, f, indent=2, ensure_ascii=False)
            
        # Re-generate Layout Detection txt
        txt_path = os.path.join(layout_dir, f"{image_id}.txt")
        with open(txt_path, 'w', encoding='utf-8') as f:
            lines = []
            # Sort by reading order to be safe (though likely already sorted or sequential)
            # Annotator.js uses reading_order
            sorted_layouts = sorted(layouts, key=lambda x: x.get('reading_order', 999))
            
            for layout in sorted_layouts:
                bbox = layout.get('bbox', [0, 0, 0, 0])
                class_name = layout.get('class', 'text').lower().replace('-', '_') 
                
                # Ensure bbox format is int list
                if not isinstance(bbox, list) or len(bbox) != 4:
                     # Check if it was malformed
                     continue
                     
                x1, y1, x2, y2 = [int(c) for c in bbox]
                line = f"<|box_start|>{x1:03d} {y1:03d} {x2:03d} {y2:03d}<|box_end|><|ref_start|>{class_name}<|ref_end|>"
                lines.append(line)
            f.write('\n'.join(lines))
            
print(f"Updated {count} files.")
