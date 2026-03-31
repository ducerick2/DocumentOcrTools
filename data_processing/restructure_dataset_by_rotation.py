import os
import cv2
import numpy as np
import shutil
from tqdm import tqdm

def fast_rotate(arr, angle):
    """Rotates an image using cv2.getRotationMatrix2D + cv2.warpAffine."""
    h, w = arr.shape[:2]
    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(arr, M, (w, h), flags=cv2.INTER_NEAREST)
    return rotated

def determine_score(arr, angle):
    """Computes a horizontal histogram-based alignment score for a given rotation."""
    data = fast_rotate(arr, angle)
    histogram = np.sum(data, axis=1, dtype=float)
    score = np.sum((histogram[1:] - histogram[:-1]) ** 2, dtype=float)
    return score

def get_deskew_angle(image):
    """Estimates the optimal deskew angle."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    thresh = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )[1]
    
    scores = []
    angles = np.arange(-2, 2.5, 0.5)
    
    for angle in angles:
        score = determine_score(thresh, angle)
        scores.append(score)
    
    best_angle = angles[scores.index(max(scores))]
    return best_angle

def classify_image(image_path):
    """Calculates deskew angle and returns it."""
    image = cv2.imread(image_path)
    if image is None:
        return None
    h, w, _ = image.shape
    # Resize for faster angle estimation
    new_image = cv2.resize(image, (512, int(512 * h / w)))[:512, :512, :]
    return get_deskew_angle(new_image)

def move_group(img_name, src_root, source_sub_dir, category, folders):
    """Moves image and all related files to the target category folder."""
    base_name = os.path.splitext(img_name)[0]
    dst_root = os.path.join(src_root, category)
    
    # 1. Move the image first
    img_src = os.path.join(src_root, source_sub_dir, 'images', img_name)
    img_dst_dir = os.path.join(dst_root, source_sub_dir, 'images')
    os.makedirs(img_dst_dir, exist_ok=True)
    shutil.move(img_src, os.path.join(img_dst_dir, img_name))
    
    # 2. Move related files in other folders
    for folder in folders:
        if folder == 'images':
            continue
        
        src_folder_path = os.path.join(src_root, source_sub_dir, folder)
        if not os.path.isdir(src_folder_path):
            continue
            
        # Find any file starting with base_name
        for f in os.listdir(src_folder_path):
            if f.startswith(base_name + '.'):
                dst_folder_dir = os.path.join(dst_root, source_sub_dir, folder)
                os.makedirs(dst_folder_dir, exist_ok=True)
                shutil.move(os.path.join(src_folder_path, f), os.path.join(dst_folder_dir, f))

def main():
    from sys import argv
    dataset_root = argv[1]
    sub_dirs = ['autopass', 'humanreview']
    folders = ['images', 'annotations', 'layout_detections', 'markdowns', 'model_outputs', 'texts']
    
    print("Starting dataset restructuring by rotation...")
    
    for sub_dir in sub_dirs:
        img_dir = os.path.join(dataset_root, sub_dir, 'images')
        if not os.path.exists(img_dir):
            print(f"Skipping {sub_dir} (images directory not found)")
            continue
            
        images = [f for f in os.listdir(img_dir) if f.lower().endswith(('.jpg', '.png', '.jpeg'))]
        print(f"Processing {len(images)} files in {sub_dir}...")
        
        for img_name in tqdm(images):
            img_path = os.path.join(img_dir, img_name)
            angle = classify_image(img_path)
            
            if angle is None:
                print(f"Warning: Could not read {img_path}")
                continue
                
            category = "straight" if angle == 0 else "not_straight"
            move_group(img_name, dataset_root, sub_dir, category, folders)

    print("Restructuring complete.")

if __name__ == "__main__":
    main()
