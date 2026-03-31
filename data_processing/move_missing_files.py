import os
import shutil
from tqdm import tqdm

def main():
    root = "/data/ducbm3/DocumentOCR/dataset_public/train_part2"
    categories = ['straight', 'not_straight']
    sub_dirs = ['autopass', 'humanreview']
    folders = ['annotations', 'layout_detections', 'markdowns', 'model_outputs', 'texts']
    
    print("Moving missing associated files...")
    
    for cat in categories:
        for sub in sub_dirs:
            img_dir = os.path.join(root, cat, sub, 'images')
            if not os.path.exists(img_dir):
                continue
            
            images = [f for f in os.listdir(img_dir) if f.lower().endswith(('.jpg', '.png', '.jpeg'))]
            print(f"Checking missing files for {len(images)} images in {cat}/{sub}...")
            
            for img_name in tqdm(images):
                base_name = os.path.splitext(img_name)[0]
                
                for folder in folders:
                    src_folder = os.path.join(root, sub, folder)
                    if not os.path.exists(src_folder):
                        continue
                    
                    dst_folder = os.path.join(root, cat, sub, folder)
                    os.makedirs(dst_folder, exist_ok=True)
                    
                    # Look for files starting with base_name + '.' or base_name + '_'
                    # This covers standard extensions and complex names like prefix_mineru_2_5.json
                    for f in os.listdir(src_folder):
                        if f.startswith(base_name + '.') or f.startswith(base_name + '_'):
                            shutil.move(os.path.join(src_folder, f), os.path.join(dst_folder, f))

    print("Missing files move complete.")

if __name__ == "__main__":
    main()
