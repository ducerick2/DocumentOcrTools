import json
import os
import argparse
from pathlib import Path
from glob import glob
from PIL import Image


def get_bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]

def compute_area(bbox):
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])

def compute_intersection(box1, box2):
    x_left = max(box1[0], box2[0])
    y_top = max(box1[1], box2[1])
    x_right = min(box1[2], box2[2])
    y_bottom = min(box1[3], box2[3])
    if x_right < x_left or y_bottom < y_top:
        return 0.0
    return (x_right - x_left) * (y_bottom - y_top)

def compute_iou(box1, box2):
    inter = compute_intersection(box1, box2)
    if inter == 0:
        return 0.0
    a1 = compute_area(box1)
    a2 = compute_area(box2)
    return inter / (a1 + a2 - inter)

def compute_containment(src_box, dst_box):
    # portion of dst_box contained within src_box
    inter = compute_intersection(src_box, dst_box)
    area_dst = compute_area(dst_box)
    if area_dst == 0: return 0.0
    return inter / area_dst

def compute_dist(b1, b2):
    dx = max(0, b1[0] - b2[2], b2[0] - b1[2])
    dy = max(0, b1[1] - b2[3], b2[1] - b1[3])
    return (dx**2 + dy**2)**0.5

def main(src_dir, dst_dir):
    src_files = glob(os.path.join(src_dir, "*.json"))
    
    for src_file in src_files:
        filename = os.path.basename(src_file)
        dst_file = os.path.join(dst_dir, filename)
        
        if not os.path.exists(dst_file):
            print(f"Skipping {filename}: not found in destination folder.")
            continue
            
        with open(src_file, 'r', encoding='utf-8') as f:
            src_data = json.load(f)
            
        with open(dst_file, 'r', encoding='utf-8') as f:
            dst_data = json.load(f)
            
        dst_dir_abs = os.path.abspath(dst_dir)
        if dst_dir_abs.endswith('annotations'):
            img_dir = os.path.join(os.path.dirname(dst_dir_abs), 'images')
        else:
            img_dir = os.path.join(dst_dir_abs, 'images')
            
        base_name = filename.rsplit('.', 1)[0]
        dst_img_path = os.path.join(img_dir, base_name + '.jpg')
        if not os.path.exists(dst_img_path):
            dst_img_path = os.path.join(img_dir, base_name + '.png')
            
        with Image.open(dst_img_path) as img:
            img_width, img_height = img.size
            
        if not img_width or not img_height:
            print(f"Skipping {filename}: missing image dimensions.")
            continue
            
        # Normalization functions
        def norm_bbox(bbox_orig):
            return [
                int(max(0, min(1000, bbox_orig[0] / img_width * 1000))),
                int(max(0, min(1000, bbox_orig[1] / img_height * 1000))),
                int(max(0, min(1000, bbox_orig[2] / img_width * 1000))),
                int(max(0, min(1000, bbox_orig[3] / img_height * 1000)))
            ]
            
        def de_norm_bbox(bbox_norm):
            return [
                bbox_norm[0] / 1000.0 * img_width,
                bbox_norm[1] / 1000.0 * img_height,
                bbox_norm[2] / 1000.0 * img_width,
                bbox_norm[3] / 1000.0 * img_height
            ]
            
        layouts = dst_data.get('layouts', [])
        
        # Pre-process: remove edge-aligned tall aside_text
        valid_layouts = []
        for l in layouts:
            if l.get('class') == 'aside_text':
                bbox_norm = l['bbox']
                near_edge = bbox_norm[0] < 50 or bbox_norm[2] > 950
                tall = (bbox_norm[3] - bbox_norm[1]) > 800
                if near_edge and tall:
                    continue
            valid_layouts.append(l)
        layouts = valid_layouts
        
        # We need a robust way to iterate and modify layouts safely
        shapes = src_data.get('shapes', [])
        
        # Sort shapes to ensure 'stamp_name' is processed before 'signature'
        def shape_priority(shape):
            lbl = shape.get('label', '')
            if lbl == 'stamp_name': return 0
            if lbl == 'stamp': return 1
            if lbl == 'signature': return 2
            return 3
            
        shapes.sort(key=shape_priority)
        
        # For title and page_number post-processing
        matched_title_bboxes = []  # save orig bboxes
        matched_page_number_bboxes = []
        deleted_image_bboxes = []  # save orig bboxes of deleted images
        
        for shape in shapes:
            label = shape.get('label')
            points = shape.get('points', [])
            if not points: continue
                
            src_bbox = get_bbox(points)
            
            # Helper: check match with a dst layout
            def is_match(layout):
                dst_b = de_norm_bbox(layout['bbox'])
                iou = compute_iou(src_bbox, dst_b)
                ioa_dst = compute_containment(src_bbox, dst_b)
                # User updated rule: IoU > 0.8
                return (iou > 0.8) or (ioa_dst > 0.9)
                
            overlapped_indices = [i for i, l in enumerate(layouts) if is_match(l)]
            
            # Helper to append shape
            def append_shape():
                norm_box = norm_bbox(src_bbox)
                norm_points = []
                for pt in points:
                    norm_points.append([
                         int(pt[0] / img_width * 1000), 
                         int(pt[1] / img_height * 1000)
                    ])
                new_layout = {
                    "class": label,
                    "bbox": norm_box,
                    "poly": norm_points,
                    "content": None,
                    "reading_order": len(layouts) # will be appended at end
                }
                layouts.append(new_layout)

            if label in ["checkbox", "checkedbox"]:
                image_matched = False
                for i in overlapped_indices:
                    if layouts[i]['class'] == 'image':
                        image_matched = True
                        
                if len(overlapped_indices) > 0 or image_matched:
                    layouts = [l for i, l in enumerate(layouts) if not (i in overlapped_indices and l['class'] == 'image')]
                    append_shape()
                else:
                    append_shape()
                    
            elif label == "title":
                if len(overlapped_indices) > 0:
                    for i in overlapped_indices:
                        layouts[i]['class'] = "title"
                    matched_title_bboxes.append(src_bbox)
                else:
                    append_shape()
                    
            elif label == "stamp":
                append_shape()
                
                to_remove_indices = set()
                # 1. Check for image/aside_text with overlap >= 0.5
                for i, l in enumerate(layouts):
                    if l['class'] in ["image", "aside_text"]:
                        db = de_norm_bbox(l['bbox'])
                        iou = compute_iou(src_bbox, db)
                        if iou >= 0.5:
                            to_remove_indices.add(i)
                            if l['class'] == 'image':
                                deleted_image_bboxes.append(db)
                                
                # 2. Check text boxes inside shape "stamp"
                text_indices_inside = []
                total_text_area_intersect = 0.0
                for i, l in enumerate(layouts):
                    if l['class'] in ['text', 'footer', 'header']:
                        db = de_norm_bbox(l['bbox'])
                        inter = compute_intersection(src_bbox, db)
                        if inter > 0:
                            if compute_containment(src_bbox, db) > 0.5: # Consider it 'inside'
                                text_indices_inside.append(i)
                            total_text_area_intersect += inter
                            
                src_area = compute_area(src_bbox)
                if src_area > 0 and (total_text_area_intersect / src_area > 0.5 or len(text_indices_inside) >= 3):
                    for idx in text_indices_inside:
                        to_remove_indices.add(idx)
                        
                layouts = [l for i, l in enumerate(layouts) if i not in to_remove_indices]
                    
            elif label == "page_number":
                found_intersect = False
                for i, l in enumerate(layouts):
                    if l['class'] in ["footer", "header", "page_number", "text"]:
                        db = de_norm_bbox(l['bbox'])
                        if compute_intersection(src_bbox, db) > 0:
                            layouts[i]['class'] = "page_number"
                            found_intersect = True
                            
                if found_intersect:
                    matched_page_number_bboxes.append(src_bbox)
                else:
                    append_shape()
            
            elif label == "stamp_name":
                append_shape()
                
                to_remove_indices = set()
                for i, l in enumerate(layouts):
                    db = de_norm_bbox(l['bbox'])
                    if l['class'] in ["image", "aside_text"]:
                        iou = compute_iou(src_bbox, db)
                        inter = compute_intersection(src_bbox, db)
                        # if IoU >= 0.5 or containment > 0.5, we remove it
                        if iou >= 0.5 or (inter > 0 and inter / compute_area(db) > 0.5):
                            to_remove_indices.add(i)
                            if l['class'] == 'image':
                                deleted_image_bboxes.append(db)
                                
                # For stamp_name + text: we delete if total text area > 0.5 stamp_name area
                # or if count >= 3
                text_indices_inside = []
                total_text_area_intersect = 0.0
                for i, l in enumerate(layouts):
                    if l['class'] in ['text', 'footer', 'header']:
                        db = de_norm_bbox(l['bbox'])
                        inter = compute_intersection(src_bbox, db)
                        if inter > 0:
                            text_indices_inside.append(i)
                            total_text_area_intersect += inter
                            
                src_area = compute_area(src_bbox)
                if src_area > 0 and (total_text_area_intersect / src_area > 0.5 or len(text_indices_inside) >= 3):
                    for i in text_indices_inside:
                        to_remove_indices.add(i)
                        
                layouts = [l for i, l in enumerate(layouts) if i not in to_remove_indices]
            
            elif label in ["logo", "barcode", "qrcode"]:
                if label == "logo":
                    header_to_remove = set()
                    for i, l in enumerate(layouts):
                        if l['class'] == 'header':
                            db = de_norm_bbox(l['bbox'])
                            if compute_containment(src_bbox, db) > 0.5:
                                header_to_remove.add(i)
                                
                    if header_to_remove:
                        layouts = [l for i, l in enumerate(layouts) if i not in header_to_remove]
                        overlapped_indices = [i for i, l in enumerate(layouts) if is_match(l)]
                        
                if len(overlapped_indices) > 0:
                    if label == "logo" and len(overlapped_indices) > 1:
                        # Merge them
                        min_x, min_y, max_x, max_y = 99999, 99999, -1, -1
                        for i in overlapped_indices:
                            db = layouts[i]['bbox']
                            min_x = min(min_x, db[0])
                            min_y = min(min_y, db[1])
                            max_x = max(max_x, db[2])
                            max_y = max(max_y, db[3])
                        
                        first_idx = overlapped_indices[0]
                        layouts[first_idx]['class'] = "logo"
                        layouts[first_idx]['bbox'] = [min_x, min_y, max_x, max_y]
                        
                        to_remove = set(overlapped_indices[1:])
                        layouts = [l for i, l in enumerate(layouts) if i not in to_remove]
                    else:
                        for i in overlapped_indices:
                            layouts[i]['class'] = label
                else:
                    append_shape()
                    
            elif label == "signature":
                append_shape()
                
                to_remove_indices = set()
                for i, l in enumerate(layouts):
                    db = de_norm_bbox(l['bbox'])
                    if l['class'] == "image":
                        # overlap with signature
                        if compute_intersection(src_bbox, db) > 0:
                            to_remove_indices.add(i)
                            deleted_image_bboxes.append(db)
                            
                    elif l['class'] in ["text", "footer", "header"]:
                        # inside signature and area > 80% shape signature
                        inter = compute_intersection(src_bbox, db)
                        src_area = compute_area(src_bbox)
                        if inter > 0 and src_area > 0:
                            if inter / src_area > 0.8:
                                to_remove_indices.add(i)
                                
                candidate_idx = -1
                min_dy = float('inf')
                sig_y_max = src_bbox[3]
                sig_x_center = (src_bbox[0] + src_bbox[2]) / 2.0
                
                for i, l in enumerate(layouts):
                    if i in to_remove_indices: continue
                    if l['class'] in ["text", "section", "footer", "stamp_name"]:
                        db = de_norm_bbox(l['bbox'])
                        db_y_center = (db[1] + db[3]) / 2.0
                        sig_y_center = (src_bbox[1] + src_bbox[3]) / 2.0
                        
                        if db_y_center > sig_y_center:
                            horiz_overlap = min(db[2], src_bbox[2]) - max(db[0], src_bbox[0])
                            if horiz_overlap > -50 or abs(sig_x_center - (db[0]+db[2])/2.0) < 200:
                                dy = max(0, db[1] - sig_y_max)
                                if dy < min_dy:
                                    min_dy = dy
                                    candidate_idx = i
                                    
                if candidate_idx != -1:
                    if layouts[candidate_idx]['class'] != "stamp_name":
                        layouts[candidate_idx]['class'] = "signature_name"
                                
                layouts = [l for i, l in enumerate(layouts) if i not in to_remove_indices]
            
            else:
                # User requested NOT to append other labels (like table, figure)
                pass
                    
        # Post-process titles
        has_title_in_src = any(s.get('label') == 'title' for s in shapes)
        
        if not has_title_in_src:
            for l in layouts:
                if l.get('class') == 'title':
                    l['class'] = 'section'
        elif matched_title_bboxes:
            y_centers = [(b[1] + b[3]) / 2.0 for b in matched_title_bboxes]
            avg_y = sum(y_centers) / len(y_centers)
            
            for i, l in enumerate(layouts):
                if l['class'] == 'title':
                    db_orig = de_norm_bbox(l['bbox'])
                    y_center_old = (db_orig[1] + db_orig[3]) / 2.0
                    
                    is_overlapped = False
                    for src_bbox in matched_title_bboxes:
                        iou = compute_iou(src_bbox, db_orig)
                        ioa_dst = compute_containment(src_bbox, db_orig)
                        if (iou > 0.8) or (ioa_dst > 0.9):
                            is_overlapped = True
                            break
                            
                    if not is_overlapped:
                        if y_center_old > avg_y:
                            layouts[i]['class'] = 'section'
                        else:
                            layouts[i]['class'] = 'header'
                            
        # Post-process page_number
        if matched_page_number_bboxes:
            y_centers = [(b[1] + b[3]) / 2.0 for b in matched_page_number_bboxes]
            avg_y = sum(y_centers) / len(y_centers)
            
            for i, l in enumerate(layouts):
                if l['class'] == 'page_number':
                    db_orig = de_norm_bbox(l['bbox'])
                    y_center_old = (db_orig[1] + db_orig[3]) / 2.0
                    
                    is_overlapped = False
                    for src_bbox in matched_page_number_bboxes:
                        if compute_intersection(src_bbox, db_orig) > 0:
                            is_overlapped = True
                            break
                            
                    if not is_overlapped:
                        if y_center_old > avg_y:
                            layouts[i]['class'] = 'footer'
                        else:
                            layouts[i]['class'] = 'header'

        # Post-process image_caption -> text if near deleted image
        if deleted_image_bboxes:
            dist_threshold = img_height * 0.05  # within 5% of document height
            for i, l in enumerate(layouts):
                if l.get('class') == 'image_caption':
                    db_orig = de_norm_bbox(l['bbox'])
                    is_near = False
                    for deleted_box in deleted_image_bboxes:
                        if compute_dist(db_orig, deleted_box) < dist_threshold:
                            is_near = True
                            break
                    if is_near:
                        layouts[i]['class'] = 'text'

        # Ensure reading order remains continuous or at least consistent
        for order, l in enumerate(layouts):
            l['reading_order'] = order
            
        dst_data['layouts'] = layouts
        
        # Save modifications back to dst file
        with open(dst_file, 'w', encoding='utf-8') as f:
            json.dump(dst_data, f, ensure_ascii=False, indent=2)

    print("Merge completed successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", type=str, default="/data/ducbm3/DocumentOCR/dataset_public/train_part4/jsons_others")
    parser.add_argument("--dst", type=str, default="/data/ducbm3/DocumentOCR/dataset_public/train_part4/samples/autopass/annotations")
    args = parser.parse_args()
    
    main(args.src, args.dst)
