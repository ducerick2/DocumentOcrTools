import os
import json

base_directory = '/data/ducbm3/DocumentOCR/dataset_public/train_part4'

def has_null(obj):
    if obj is None:
        return True
    if isinstance(obj, list):
        return any(has_null(item) for item in obj)
    if isinstance(obj, dict):
        return any(has_null(item) for item in obj.values())
    return False

total_removed = 0
files_updated = 0
total_files_processed = 0

print(f"Starting recursive cleanup in {base_directory}...")

for root, dirs, files in os.walk(base_directory):
    for filename in files:
        if filename.endswith('.json'):
            total_files_processed += 1
            path = os.path.join(root, filename)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                if 'layouts' not in data:
                    continue
                    
                original_len = len(data['layouts'])
                new_layouts = []
                for layout in data['layouts']:
                    remove = False
                    if 'bbox' in layout:
                        if layout['bbox'] is None or has_null(layout['bbox']):
                            remove = True
                    
                    if not remove and 'poly' in layout:
                        if layout['poly'] is None or has_null(layout['poly']):
                            remove = True
                    
                    if not remove:
                        new_layouts.append(layout)
                        
                if len(new_layouts) != original_len:
                    data['layouts'] = new_layouts
                    with open(path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    
                    removed = original_len - len(new_layouts)
                    print(f"Updated {path}: removed {removed} layouts")
                    total_removed += removed
                    files_updated += 1
            except Exception as e:
                print(f"Error processing {path}: {e}")

print(f"\nCleanup complete.")
print(f"Total JSON files processed: {total_files_processed}")
print(f"Files updated: {files_updated}")
print(f"Total layouts removed: {total_removed}")
