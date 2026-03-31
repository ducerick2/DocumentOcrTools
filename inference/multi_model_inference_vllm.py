import os
import sys
import json
import base64
import argparse
import asyncio
import io
import shutil
import re
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict
import numpy as np
from PIL import Image

# Async Imports
import httpx
import aiofiles
from dataclasses import dataclass, asdict

# Functions copied from multi_model_inference.py for standalone execution
@dataclass
class ModelOutput:
    model_name: str
    text: str
    layouts: List[Dict]
    raw_response: str
    success: bool
    error: str = ""

# ... (Previous code) ...

async def inference_http_async(model_key, model_config, image_path) -> ModelOutput:
    try:
        async with aiofiles.open(image_path, "rb") as f:
            image_data = await f.read()
        image_b64 = base64.b64encode(image_data).decode('utf-8')
        
        # Construct payload based on model type (copied from original)
        if model_config['api_type'] == 'gemini':
            payload = {
                "contents": [{"parts": [{"text": "Convert the document..."}, {"inline_data": {"mime_type": "image/png", "data": image_b64}}]}]
            }
        elif model_config['api_type'] == 'openai':
            payload = {
                "model": model_config['model_id'],
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Convert the image..."},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}}
                    ]
                }],
                "max_tokens": 4096
            }
        else:
            return ModelOutput(model_key, "", [], "", False, f"Unknown API type: {model_config.get('api_type')}")

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(model_config['url'], json=payload)
            if resp.status_code != 200:
                return ModelOutput(model_key, "", [], resp.text, False, f"HTTP {resp.status_code}")
            
            result = resp.json()
            # Parse content (simplified logic from original)
            content = ""
            if model_config['api_type'] == 'gemini':
                content = result['candidates'][0]['content']['parts'][0]['text']
            elif model_config['api_type'] == 'openai':
                content = result['choices'][0]['message']['content']
                
            layouts = [] # Need parsing logic here if we wanted to support consensus fully
            # For now, just return Text
            return ModelOutput(model_key, content, layouts, content, True)
            
    except Exception as e:
        return ModelOutput(model_key, "", [], "", False, str(e))

def calculate_text_similarity(text1: str, text2: str) -> float:
    """Calculate simple text similarity (Jaccard)"""
    if not text1 or not text2: return 0.0
    words1 = set(text1.lower().split())
    words2 = set(text2.lower().split())
    if not words1 or not words2: return 0.0
    intersection = len(words1 & words2)
    union = len(words1 | words2)
    return intersection / union if union > 0 else 0.0

def calculate_layout_quality(layouts: List[Dict]) -> float:
    """Calculate quality score for extracted layouts"""
    if not layouts: return 0.0
    quality_scores = []
    for layout in layouts:
        score = 0.0
        bbox = layout.get('bbox', [])
        if len(bbox) == 4 and all(isinstance(x, (int, float)) for x in bbox):
            if bbox[2] > bbox[0] and bbox[3] > bbox[1]: score += 0.3
        content = layout.get('content', '').strip()
        if content: score += 0.3
        class_name = layout.get('class', '')
        if class_name: score += 0.2
        if 'reading_order' in layout: score += 0.2
        quality_scores.append(score)
    return np.mean(quality_scores)

def calculate_consensus_score(outputs: List[ModelOutput]) -> Dict[str, float]:
    successful_outputs = [o for o in outputs if o.success]
    if len(successful_outputs) < 2: return {o.model_name: 0.5 for o in outputs}
    scores = {}
    all_layout_counts = [len(o.layouts) for o in successful_outputs]
    median_layouts = np.median(all_layout_counts) if all_layout_counts else 1
    max_layouts = max(all_layout_counts) if all_layout_counts else 1
    
    for output in successful_outputs:
        similarities = []
        for other in successful_outputs:
            if other.model_name != output.model_name:
                sim = calculate_text_similarity(output.text, other.text)
                similarities.append(sim)
        text_consensus = np.mean(similarities) if similarities else 0.0
        layout_count_score = max(0.0, min(1.0, 1.0 - abs(len(output.layouts) - median_layouts) / max(median_layouts, 1)))
        quality_score = calculate_layout_quality(output.layouts)
        completeness = min(len(output.layouts) / max(max_layouts, 1), 1.0)
        
        scores[output.model_name] = (0.40 * text_consensus + 0.20 * layout_count_score + 
                                   0.20 * quality_score + 0.20 * completeness)
    return scores

def select_best_output(outputs: List[ModelOutput]) -> Tuple[ModelOutput, Dict]:
    successful_outputs = [o for o in outputs if o.success]
    if not successful_outputs: return None, {"error": "All models failed"}
    
    if len(successful_outputs) == 1:
        output = successful_outputs[0]
        quality_score = float(calculate_layout_quality(output.layouts))
        if len(output.text.strip()) < 10 and len(output.layouts) > 0: quality_score *= 0.5
        return output, {
            "strategy": "single_quality_check", 
            "reason": "only_one_success",
            "qa_status": "autopass" if quality_score > 0.9 else "humanreview",
            "scores": {output.model_name: quality_score},
            "best_model": output.model_name,
            "best_score": quality_score,
            "all_scores_above_threshold": bool(quality_score > 0.9)
        }
    
    scores = calculate_consensus_score(successful_outputs)
    best_model = max(scores, key=scores.get)
    best_score = scores[best_model]
    best_output = next(o for o in successful_outputs if o.model_name == best_model)
    return best_output, {
        "strategy": "consensus",
        "scores": scores,
        "best_model": best_model,
        "best_score": best_score,
        "qa_status": "autopass" if all(s > 0.9 for s in scores.values()) else "humanreview"
    }

# Inference Functions
async def inference_mineru_async(client, image_path: str, content_model_config: Optional[Dict] = None) -> ModelOutput:
    try:
        async with aiofiles.open(image_path, "rb") as f:
            image_data = await f.read()
        image = Image.open(io.BytesIO(image_data))
        
        # Call MinerU 2-step extraction
        extracted = await client.aio_two_step_extract(image)
        
        # If content model is specified, re-infer content for each crop
        if content_model_config:
            print(f"  Re-infering content using {content_model_config.get('model_id', 'external model')}...")
            width, height = image.size
            crop_tasks = []
            sem = asyncio.Semaphore(5) # Limit concurrent crop requests
            
            async def process_crop(block):
                async with sem:
                    # Get bbox
                    bbox = block.get('bbox', [])
                    if not bbox: return
                    
                    # Denormalize if needed (MinerU sometimes returns normalized)
                    # But wait, we do denormalization later in the loop. 
                    # We need correct bbox here for cropping.
                    # Start with copy
                    c_bbox = list(bbox)
                    if c_bbox and all(isinstance(c, float) and c <= 1.0 for c in c_bbox):
                        c_bbox = [
                             int(c_bbox[0] * width),
                             int(c_bbox[1] * height),
                             int(c_bbox[2] * width),
                             int(c_bbox[3] * height)
                        ]
                    else:
                        c_bbox = [int(x) for x in c_bbox]
                        
                    # Validate bbox
                    c_bbox[0] = max(0, c_bbox[0])
                    c_bbox[1] = max(0, c_bbox[1])
                    c_bbox[2] = min(width, c_bbox[2])
                    c_bbox[3] = min(height, c_bbox[3])
                    
                    if c_bbox[2] <= c_bbox[0] or c_bbox[3] <= c_bbox[1]:
                        return # Invalid crop
                    
                    # Crop
                    crop_img = image.crop(c_bbox)
                    buf = io.BytesIO()
                    crop_img.save(buf, format='PNG')
                    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
                    
                    # Infer
                    try:
                        new_text = await call_model_api("content_model", content_model_config, b64, "Extract text from this image crop.")
                        if new_text:
                            block['content'] = new_text
                            block['text'] = new_text # Update both if exist
                    except Exception as e:
                        print(f"    Failed to extract crop: {e}")

            # Create tasks
            for block in extracted:
                if block.get('type') in ['image', 'logo', 'list', 'signature']: continue # Skip non-text? 
                # Actually, user wants "choose model for crop". Maybe only for text/tables?
                # Formula/equation might need specific prompting.
                # For now, process everything except images.
                crop_tasks.append(process_crop(block))
            
            if crop_tasks:
                await asyncio.gather(*crop_tasks)

        layouts = []
        full_text = []
        width, height = image.size
        
        # Assume extracted is list of dicts
        for idx, block in enumerate(extracted):
             # Try to normalize keys
             bbox = block.get('bbox', []) # [x1, y1, x2, y2]
             
             # Denormalize if floats <= 1.0
             if bbox and all(isinstance(c, float) and c <= 1.0 for c in bbox):
                 bbox = [
                     int(bbox[0] * width),
                     int(bbox[1] * height),
                     int(bbox[2] * width),
                     int(bbox[3] * height)
                 ]
             else:
                 # Ensure int
                 bbox = [int(x) for x in bbox]
             
             text = block.get('content', '') or block.get('text', '')
             cls = block.get('type', 'text')
             
             # Map MinerU classes to standard
             # User requested to keep equation/equation_block as is
             # if cls in ['equation', 'equation_block']:
             #    cls = 'formula'
             
             layouts.append({
                 "class": cls,
                 "bbox": bbox,
                 "content": text,
                 "reading_order": idx
             })
             full_text.append(text)
             
        return ModelOutput(
            model_name="mineru_2_5",
            text="\n".join(full_text),
            layouts=layouts,
            raw_response=str(extracted),
            success=True
        )
    except Exception as e:
        return ModelOutput("mineru_2_5", "", [], "", False, str(e))

async def inference_http_async(session, model_key, model_config, image_path) -> ModelOutput:
    # TODO: Implement HTTP call to Gemini/Qwen using aiohttp
    # This requires replicating the payload construction from multi_model_inference.py
    # For now, simplistic implementation
    return ModelOutput(model_key, "", [], "", False, "HTTP not fully ported yet")

# Models Configuration (copied)
MODELS = {
    "gemini_flash_lite": {
        "url": "http://localhost:9091/api/gemini-flash-lite/generate",
        "api_type": "gemini",
        "model_id": "gemini-2.0-flash-lite-preview-02-05"
    },
    "qwen3_vl_local": {
        # Using VLLM OpenAI API compatible endpoint
        "url": "http://localhost:9095/v1/chat/completions",
        "api_type": "openai",
        "model_id": "/data/llm-models/Qwen2.5-VL-3B-Instruct" 
    },
    "gemma_3_27b_it": {
        # Using VLLM OpenAI API compatible endpoint
        "url": "http://localhost:9093/v1/chat/completions",
        "api_type": "openai",
        "model_id": "google/gemma-3-27b-it" 
    },
    "mineru_2_5": {
        # In-process VLLM
        "type": "in_process_vllm",
        "model_id": "/data/llm-models/MinerU2.5-2509-1.2B"
    }
}

async def call_model_api(model_key, model_config, image_b64, prompt_text="Convert the document to markdown.") -> str:
    # Construct payload
    if model_config['api_type'] == 'gemini':
        payload = {
            "contents": [{"parts": [{"text": prompt_text}, {"inline_data": {"mime_type": "image/png", "data": image_b64}}]}]
        }
    elif model_config['api_type'] == 'openai':
        payload = {
            "model": model_config['model_id'],
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}}
                ]
            }],
            "max_tokens": 4096
        }
    else:
        raise ValueError(f"Unknown API type: {model_config.get('api_type')}")
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(model_config['url'], json=payload)
        if resp.status_code != 200:
            raise Exception(f"HTTP {resp.status_code}: {resp.text}")
        
        result = resp.json()
        content = ""
        if model_config['api_type'] == 'gemini':
            if 'candidates' in result:
                 content = result['candidates'][0]['content']['parts'][0]['text']
        elif model_config['api_type'] == 'openai':
            content = result['choices'][0]['message']['content']
        
        return content

async def inference_http_async(model_key, model_config, image_path) -> ModelOutput:
    try:
        async with aiofiles.open(image_path, "rb") as f:
            image_data = await f.read()
        image_b64 = base64.b64encode(image_data).decode('utf-8')
        
        content = await call_model_api(model_key, model_config, image_b64)
        
        # TODO: Implement proper parsing
        layouts = []
        return ModelOutput(model_key, content, layouts, content, True)
            
    except Exception as e:
        return ModelOutput(model_key, "", [], "", False, str(e))

def create_markdown(layouts: List[Dict]) -> str:
    """Create markdown from layouts"""
    lines = []
    for layout in sorted(layouts, key=lambda x: x.get('reading_order', 999)):
        class_name = layout.get('class', 'text')
        content = layout.get('content', '')
        if class_name == 'title': lines.append(f"# {content}\n")
        elif class_name == 'section-header': lines.append(f"## {content}\n")
        elif class_name == 'caption': lines.append(f"*{content}*\n")
        elif class_name == 'table': lines.append(f"{content}\n")
        elif class_name in ['formula', 'equation', 'equation_block']: lines.append(f"$$\n{content}\n$$\n")
        else: lines.append(f"{content}\n")
    return '\n'.join(lines)

def create_layout_detection(layouts: List[Dict], width: int, height: int) -> str:
    """Create layout detection format (normalized [0,999])"""
    lines = []
    for layout in sorted(layouts, key=lambda x: x.get('reading_order', 999)):
        bbox = layout.get('bbox', [0, 0, 0, 0])
        class_name = layout.get('class', 'text').lower().replace('-', '_')
        
        # Normalize to [0, 999]
        x1 = min(999, max(0, int(bbox[0] / width * 1000)))
        y1 = min(999, max(0, int(bbox[1] / height * 1000)))
        x2 = min(999, max(0, int(bbox[2] / width * 1000)))
        y2 = min(999, max(0, int(bbox[3] / height * 1000)))
        
        bbox_str = f"{x1:03d} {y1:03d} {x2:03d} {y2:03d}"
        line = f"<|box_start|>{bbox_str}<|box_end|><|ref_start|>{class_name}<|ref_end|>"
        lines.append(line)
    return '\n'.join(lines)

def save_outputs(output: ModelOutput, metadata: Dict, output_dir: Path, image_name: str, image_path: str, move_files: bool = False):
    qa_status = metadata.get('qa_status', 'humanreview')
    qa_dir = output_dir / qa_status
    
    dirs = {
        'annotations': qa_dir / "annotations",
        'markdowns': qa_dir / "markdowns",
        'layout_detections': qa_dir / "layout_detections",
        'texts': qa_dir / "texts",
        'model_outputs': qa_dir / "model_outputs",
        'images': qa_dir / "images"
    }
    for d in dirs.values(): d.mkdir(parents=True, exist_ok=True)
    
    # Copy/Move Image
    dest_path = dirs['images'] / f"{image_name}{Path(image_path).suffix}"
    if move_files:
        try: shutil.move(str(image_path), str(dest_path))
        except: shutil.copy2(str(image_path), str(dest_path)) 
    else:
        shutil.copy2(str(image_path), str(dest_path))
        
    # Get image size for normalization
    try:
        with Image.open(dest_path) as img:
            width, height = img.size
    except:
        width, height = 1000, 1000 # Fallback
        
    # Normalize layouts to [0, 999] for JSON and Layout Detection
    normalized_layouts = []
    for layout in output.layouts:
        bbox = layout.get('bbox', [0, 0, 0, 0])
        # Check if bbox is normalized 0-1 (from ModelOutput if we didn't denormalize)
        # But we DID denormalize in inference_mineru_async to pixels. 
        # So we assume bbox is in PIXELS now.
        
        # Normalize to [0, 999]
        norm_bbox = [
            min(999, max(0, int(bbox[0] / width * 1000))),
            min(999, max(0, int(bbox[1] / height * 1000))),
            min(999, max(0, int(bbox[2] / width * 1000))),
            min(999, max(0, int(bbox[3] / height * 1000)))
        ]
        
        new_layout = layout.copy()
        new_layout['bbox'] = norm_bbox
        normalized_layouts.append(new_layout)
        
    # Save outputs
    # 1. Annotation (Normalized)
    with open(dirs['annotations'] / f"{image_name}.json", 'w', encoding='utf-8') as f:
        json.dump({"image_name": image_name, "image_path": str(image_path), "layouts": normalized_layouts, "metadata": metadata}, f, indent=2, ensure_ascii=False)
    # 2. Markdown
    with open(dirs['markdowns'] / f"{image_name}.md", 'w', encoding='utf-8') as f:
        f.write(create_markdown(output.layouts))
    # 3. Layout Detection (Uses ALREADY NORMALIZED layouts? NO, create_layout_detection expects raw?)
    # Wait, create_layout_detection expects raw and normalizes itself.
    # But now I have normalized_layouts. 
    # I should update create_layout_detection to take normalized_layouts AND NOT normalize again?
    # OR just pass width=1000, height=1000 to it?
    with open(dirs['layout_detections'] / f"{image_name}.txt", 'w', encoding='utf-8') as f:
        # Pass normalized layouts, treating them as if image size is 1000x1000
        f.write(create_layout_detection(normalized_layouts, 1000, 1000))
    # 4. Text
    with open(dirs['texts'] / f"{image_name}.txt", 'w', encoding='utf-8') as f:
        f.write(output.text)
    # 5. Raw
    with open(dirs['model_outputs'] / f"{image_name}_{output.model_name}.json", 'w', encoding='utf-8') as f:
        json.dump({"model": output.model_name, "raw_response": output.raw_response, "metadata": metadata}, f, indent=2, ensure_ascii=False)

async def process_image_file(sem, image_path, output_dir, img_name, move_files, mineru_client, active_models, content_model_config=None):
    async with sem:
        print(f"Processing {image_path}...")
        outputs = []
        tasks = []
        
        # MinerU
        if mineru_client and "mineru_2_5" in active_models:
             tasks.append(inference_mineru_async(mineru_client, str(image_path), content_model_config))
        
        # HTTP Models
        async with httpx.AsyncClient() as session: # Session per image or global?
            # Creating session per image is safer for now
            # Actually we should use a shared session but passing it down is complex with current structure
             pass 
             
        # Execute MinerU
        if tasks:
            results = await asyncio.gather(*tasks)
            outputs.extend(results)
            
        # Select Best
        best_output, metadata = select_best_output(outputs)
        
        if best_output:
            save_outputs(best_output, metadata, output_dir, img_name, image_path, move_files)
            print(f"Finished {image_path}: {metadata['qa_status']}")
        else:
            print(f"Failed {image_path}")

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--content-model', help='Model to use for crop content extraction')
    parser.add_argument('--move-files', action='store_true', help='Move processed files instead of copying')
    parser.add_argument('--models', nargs='+', help='List of models to use (e.g. mineru_2_5 gemini_flash_lite)')
    args = parser.parse_args()
    
    # Filter models
    active_models = args.models if args.models else list(MODELS.keys())
    
    content_model_config = None
    if args.content_model:
        if args.content_model in MODELS:
            content_model_config = MODELS[args.content_model]
            print(f"Content Extraction Model: {args.content_model}")
        else:
            print(f"Warning: Content model {args.content_model} not found in configuration.")

    # Initialize MinerU
    client = None
    if "mineru_2_5" in active_models:
        try:
            from mineru_vl_utils import MinerUClient
            
            print("Initializing MinerU Client (Remote HTTP)...")
            # Using http-client backend to connect to port 9096
            client = MinerUClient(
                backend="http-client",
                server_url="http://localhost:9096/v1",
                model_name="/data/llm-models/MinerU2.5-2509-1.2B" # Model name serves as ID for OpenAI API
            )
            print("MinerU Client Initialized.")
        except ImportError as e:
            print(f"Failed to import MinerU dependencies: {e}")
            return
    
    # Process
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    image_files = sorted(list(input_dir.glob('*.png')) + list(input_dir.glob('*.jpg')))
    print(f"Found {len(image_files)} images.")
    
    sem = asyncio.Semaphore(2) # Limit concurrency
    tasks = [process_image_file(sem, img, output_dir, img.stem, args.move_files, client, active_models, content_model_config) for img in image_files]
    await asyncio.gather(*tasks)
    
if __name__ == "__main__":
    asyncio.run(main())
