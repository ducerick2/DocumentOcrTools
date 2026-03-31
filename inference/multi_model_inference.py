import json
import base64
import requests
from pathlib import Path
from typing import Dict, List, Tuple
from dataclasses import dataclass
import numpy as np
from PIL import Image
from tqdm import tqdm
import re
import os

# API Configuration
GEMINI_API_KEY = "AIzaSyB6DI0vFHvFeGB7q36nGDMfqixnZbYM3ls"

# Model endpoints - Hybrid: 2 API + 1 Local vLLM
MODELS = {
    'gemini_flash_lite': {
        'url': f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={GEMINI_API_KEY}',
        'name': 'Gemini-2.5-Flash-Lite',
        'model_id': 'gemini-2.5-flash-lite',
        'api_type': 'gemini'
    },
    'qwen3_vl_local': {
        'url': 'http://localhost:9098/v1/chat/completions',
        'name': 'Qwen3-VL-30B-Local',
        'model_id': '/home/ducbm3/Qwen3-VL-30B-A3B-Instruct',
        'api_type': 'openai'
    },
    'gemma_3_27b_it': {
        'url': f'https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key={GEMINI_API_KEY}',
        'name': 'Gemma-3-27b-it',
        'model_id': 'gemma-3-27b-it',
        'api_type': 'gemini'
    },
    'mineru_2_5': {
        'url': 'http://localhost:9096/v1/chat/completions',
        'name': 'MinerU-2.5-1.2B',
        'model_id': '/data/llm-models/MinerU2.5-2509-1.2B', # Must match server serving name
        'api_type': 'mineru'
    }
}

@dataclass
class ModelOutput:
    """Output from a single model"""
    model_name: str
    text: str
    layouts: List[Dict]
    raw_response: str
    success: bool
    error: str = None

def encode_image_base64(image_path: str) -> str:
    """Encode image to base64"""
    with open(image_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def create_ocr_prompt() -> str:
    """Create prompt for document OCR"""
    return """Analyze this document image and extract:
1. All text content in reading order
2. Layout elements with their semantic types
3. Bounding boxes for each element in format [xmin, ymin, xmax, ymax]
4. For tables: extract as HTML with proper structure

**Element Classes** (choose the most specific):

**Textual Content**:
- text: Regular paragraph text
- title: Document or section title
- phonetic: Phonetic annotations or pronunciation guides
- image_caption: Caption for images/figures
- image_footnote: Footnote reference for images
- table_caption: Caption for tables
- table_footnote: Footnote reference for tables
- code: Code snippets or programming text
- code_caption: Caption for code blocks
- algorithm: Algorithm pseudocode
- reference: Bibliography or citation
- list: List items (bulleted or numbered)

**Visual Elements**:
- image: Photos, diagrams, illustrations
- table: Tabular data (extract as HTML)
- equation: Inline mathematical equations (within text flow, e.g., $E=mc^2$)
- equation_block: Display/block equations (centered, on separate lines, may be numbered)

**Page Margins**:
- header: Page header
- footer: Page footer
- aside_text: Sidebar or margin notes
- page_number: Page numbering
- page_footnote: Footnotes at page bottom

**Document Elements**:
- stamp: Official stamps or seals
- logo: Company/organization logos  
- signature: Handwritten signatures

Output as JSON with this exact structure:
{
  "layouts": [
    {
      "class": "title",
      "bbox": [x1, y1, x2, y2],
      "content": "extracted text",
      "reading_order": 0
    }
  ]
}

Important:
- Preserve exact reading order (top to bottom, left to right)
- Extract ALL visible text
- For tables, include full HTML in content
- Bounding boxes must be [xmin, ymin, xmax, ymax] format
- Use most specific class that applies
"""

def inference_model(model_key: str, image_path: str, timeout: int = 120) -> ModelOutput:
    """Run inference on a single model"""
    model_info = MODELS[model_key]
    
    try:
        # Encode image
        image_b64 = encode_image_base64(image_path)
        
        if model_info['api_type'] == 'openai':
            # OpenAI-compatible API (GPT-OSS, Qwen3)
            payload = {
                "model": model_info['model_id'],
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": create_ocr_prompt()},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{image_b64}"
                                }
                            }
                        ]
                    }
                ],
                "max_tokens": 4096,
                "temperature": 0.1
            }
            
            response = requests.post(
                model_info['url'],
                json=payload,
                timeout=timeout
            )
            
            if response.status_code != 200:
                return ModelOutput(
                    model_name=model_key,
                    text="",
                    layouts=[],
                    raw_response="",
                    success=False,
                    error=f"HTTP {response.status_code}: {response.text}"
                )
            
            result = response.json()
            content = result['choices'][0]['message']['content']
            
        elif model_info['api_type'] == 'gemini':
            # Gemini API
            payload = {
                "contents": [{
                    "parts": [
                        {"text": create_ocr_prompt()},
                        {
                            "inline_data": {
                                "mime_type": "image/png",
                                "data": image_b64
                            }
                        }
                    ]
                }],
                "generationConfig": {
                    "temperature": 0.1,
                    "maxOutputTokens": 4096
                }
            }
            
            response = requests.post(
                model_info['url'],
                json=payload,
                timeout=timeout
            )
            
            if response.status_code != 200:
                return ModelOutput(
                    model_name=model_key,
                    text="",
                    layouts=[],
                    raw_response="",
                    success=False,
                    error=f"HTTP {response.status_code}: {response.text}"
                )
            
            result = response.json()
            content = result['candidates'][0]['content']['parts'][0]['text']
        
        elif model_info['api_type'] == 'mineru':
            # MinerU 2.5 2-Phase Inference
            
            # Phase 1: Layout Detection
            payload_layout = {
                "model": model_info['model_id'],
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Layout Detection:"},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}}
                        ]
                    }
                ],
                "max_tokens": 4096,
                "temperature": 0.1
            }
            
            response = requests.post(model_info['url'], json=payload_layout, timeout=timeout)
            if response.status_code != 200:
                raise Exception(f"layout detection failed: {response.text}")
                
            layout_raw = response.json()['choices'][0]['message']['content']
            
            # Phase 2: Content Extraction
            # Parse layout lines: "x1 y1 x2 y2 type"
            import io
            from PIL import Image
            
            img_bytes = base64.b64decode(image_b64)
            img = Image.open(io.BytesIO(img_bytes))
            width_orig, height_orig = img.size
            
            layouts = []
            full_text_parts = []
            
            lines = layout_raw.strip().split('\n')
            for idx, line in enumerate(lines):
                # Expected format: "x1 y1 x2 y2 type" (normalized 0-1000)
                # Or "y1 x1 y2 x2 type"? My test showed "308 135 803 190text" matched x1=308...
                # So assume "x1 y1 x2 y2 type"
                
                parts = line.strip().split(' ')
                if len(parts) < 4:
                    continue
                
                # Check if starts with digit (coordinate)
                if not parts[0].isdigit():
                    continue
                    
                try:
                    p1, p2, p3 = parts[0], parts[1], parts[2]
                    
                     # Ensure first 3 are digits
                    if not (p1.isdigit() and p2.isdigit() and p3.isdigit()):
                        continue
                    
                    if len(parts) == 4:
                        # Case: "115 059 603 096title"
                        last_part = parts[3]
                        import re
                        m = re.match(r"(\d+)(.*)", last_part)
                        if m:
                            p4 = m.group(1)
                            class_name = m.group(2)
                        else:
                            continue
                    else:
                        # Case: "115 059 603 096 title"
                        p4 = parts[3]
                        if not p4.isdigit():
                            continue
                            
                        # Join remaining parts as class name (in case of spaces)
                        class_name = " ".join(parts[4:])
                    
                    if not class_name:
                         # Fallback if no class name found
                         class_name = "text"
                        
                    x1, y1, x2, y2 = int(p1), int(p2), int(p3), int(p4)
                    
                    # Denormalize
                    left = int(x1 * width_orig / 1000)
                    top = int(y1 * height_orig / 1000)
                    right = int(x2 * width_orig / 1000)
                    bottom = int(y2 * height_orig / 1000)
                    
                    # Crop
                    if right > left and bottom > top:
                        # Add margin?
                        crop = img.crop((left, top, right, bottom))
                        buffered = io.BytesIO()
                        crop.save(buffered, format="PNG")
                        crop_b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
                        
                        prompt_content = "Text Recognition"
                        if "table" in class_name: prompt_content = "Table Recognition"
                        elif "formula" in class_name: prompt_content = "Formula Recognition"
                        
                        # Phase 2 Request
                        payload_content = {
                            "model": model_info['model_id'],
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "text", "text": prompt_content},
                                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{crop_b64}"}}
                                    ]
                                }
                            ],
                            "max_tokens": 4096,
                            "temperature": 0.1
                        }
                        
                        resp_c = requests.post(model_info['url'], json=payload_content, timeout=timeout)
                        if resp_c.status_code == 200:
                            content_text = resp_c.json()['choices'][0]['message']['content']
                        else:
                            content_text = ""
                            
                        layouts.append({
                            "class": class_name,
                            "bbox": [left, top, right, bottom], # Use pixel coords for output
                            "content": content_text,
                            "reading_order": idx
                        })
                        full_text_parts.append(content_text)
                        
                except Exception as e:
                    # print(f"Error parsing line {line}: {e}")
                    continue
            
            # Fallback: If no layouts found but response has text, treat as full page text
            if not layouts and len(layout_raw.strip()) > 10:
                print("Warning: MinerU returned text instead of layout. Using full response as content.")
                layouts.append({
                    "class": "text",
                    "bbox": [0, 0, width_orig, height_orig],
                    "content": layout_raw,
                    "reading_order": 0
                })
                # Skip Phase 2 since we already have content?
                # But wait, is layout_raw standard text?
                # User example showed formatted text.
                content = layout_raw
                # We return immediately
                return ModelOutput(
                    model_name=model_key,
                    text=content,
                    layouts=layouts,
                    raw_response=layout_raw,
                    success=True
                )
            
            content = '\n'.join(full_text_parts)
            
            # Override parsing because we already built layouts
            return ModelOutput(
                model_name=model_key,
                text=content,
                layouts=layouts,
                raw_response=layout_raw, # Store layout raw response
                success=True
            )
            return ModelOutput(
                model_name=model_key,
                text="",
                layouts=[],
                raw_response="",
                success=False,
                error=f"Unknown API type: {model_info['api_type']}"
            )
        
        # Parse response
        layouts = parse_json_from_response(content)
        text = extract_text_from_layouts(layouts)
        
        return ModelOutput(
            model_name=model_key,
            text=text,
            layouts=layouts,
            raw_response=content,
            success=True
        )
        
    except Exception as e:
        return ModelOutput(
            model_name=model_key,
            text="",
            layouts=[],
            raw_response="",
            success=False,
            error=str(e)
        )

def parse_json_from_response(content: str) -> List[Dict]:
    """Extract JSON from model response"""
    try:
        # Try direct JSON parse
        data = json.loads(content)
        if 'layouts' in data:
            return data['layouts']
        return []
    except:
        pass
    
    # Try to find JSON block in markdown code fence
    json_match = re.search(r'```json\s*(\{.*?\})\s*```', content, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            if 'layouts' in data:
                return data['layouts']
        except:
            pass
    
    # Try to find JSON without code fence
    json_match = re.search(r'\{[^{]*"layouts"[^}]*\[.*?\]\s*\}', content, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            if 'layouts' in data:
                return data['layouts']
        except:
            pass
    
    # Last resort: try to extract just the layouts array
    layouts_match = re.search(r'"layouts"\s*:\s*(\[.*?\])', content, re.DOTALL)
    if layouts_match:
        try:
            layouts = json.loads(layouts_match.group(1))
            return layouts
        except:
            pass
    
    return []

def extract_text_from_layouts(layouts: List[Dict]) -> str:
    """Extract text from layouts in reading order"""
    if not layouts:
        return ""
    
    # Sort by reading order
    sorted_layouts = sorted(layouts, key=lambda x: x.get('reading_order', 999))
    
    # Extract text
    texts = [layout.get('content', '') for layout in sorted_layouts]
    return '\n'.join(texts)

def calculate_text_similarity(text1: str, text2: str) -> float:
    """Calculate simple text similarity (Jaccard)"""
    if not text1 or not text2:
        return 0.0
    
    words1 = set(text1.lower().split())
    words2 = set(text2.lower().split())
    
    if not words1 or not words2:
        return 0.0
    
    intersection = len(words1 & words2)
    union = len(words1 | words2)
    
    return intersection / union if union > 0 else 0.0

def calculate_consensus_score(outputs: List[ModelOutput]) -> Dict[str, float]:
    """Calculate consensus scores for each model"""
    successful_outputs = [o for o in outputs if o.success]
    
    if len(successful_outputs) < 2:
        # Not enough models to calculate consensus
        return {o.model_name: 0.5 for o in outputs}
    
    scores = {}
    
    # Calculate reference metrics from all outputs
    all_layout_counts = [len(o.layouts) for o in successful_outputs]
    median_layouts = np.median(all_layout_counts) if all_layout_counts else 1
    max_layouts = max(all_layout_counts) if all_layout_counts else 1
    
    for output in successful_outputs:
        # 1. Text Consensus (40% weight)
        similarities = []
        for other in successful_outputs:
            if other.model_name != output.model_name:
                sim = calculate_text_similarity(output.text, other.text)
                similarities.append(sim)
        text_consensus = np.mean(similarities) if similarities else 0.0
        
        # 2. Layout Count Consensus (20% weight)
        # How close is this model's count to the median?
        layout_count_score = 1.0 - abs(len(output.layouts) - median_layouts) / max(median_layouts, 1)
        layout_count_score = max(0.0, min(1.0, layout_count_score))
        
        # 3. Layout Quality (20% weight)
        quality_score = calculate_layout_quality(output.layouts)
        
        # 4. Completeness (20% weight)
        # Adaptive: compare to max across models, not fixed 10
        completeness = min(len(output.layouts) / max(max_layouts, 1), 1.0)
        
        # Combined score
        scores[output.model_name] = (
            0.40 * text_consensus +
            0.20 * layout_count_score +
            0.20 * quality_score +
            0.20 * completeness
        )
    
    return scores

def calculate_layout_quality(layouts: List[Dict]) -> float:
    """Calculate quality score for extracted layouts"""
    if not layouts:
        return 0.0
    
    quality_scores = []
    
    for layout in layouts:
        score = 0.0
        
        # 1. Has valid bbox (0.3 weight)
        bbox = layout.get('bbox', [])
        if len(bbox) == 4 and all(isinstance(x, (int, float)) for x in bbox):
            if bbox[2] > bbox[0] and bbox[3] > bbox[1]:  # Valid dimensions
                score += 0.3
        
        # 2. Has content (0.3 weight)
        content = layout.get('content', '').strip()
        if content:
            score += 0.3
        
        # 3. Has valid class (0.2 weight)
        class_name = layout.get('class', '')
        if class_name:
            score += 0.2
        
        # 4. Has reading order (0.2 weight)
        if 'reading_order' in layout:
            score += 0.2
        
        quality_scores.append(score)
    
    return np.mean(quality_scores)

def select_best_output(outputs: List[ModelOutput]) -> Tuple[ModelOutput, Dict]:
    """Select best model output using consensus"""
    successful_outputs = [o for o in outputs if o.success]
    
    if not successful_outputs:
        return None, {"error": "All models failed"}
    
    if len(successful_outputs) == 1:
        # Single model strategy: Calculate quality score directly
        output = successful_outputs[0]
        quality_score = float(calculate_layout_quality(output.layouts))
        
        # Additional sanity check: if mostly empty text, penalize
        if len(output.text.strip()) < 10 and len(output.layouts) > 0:
            quality_score *= 0.5
            
        return output, {
            "strategy": "single_quality_check", 
            "reason": "only_one_success",
            "qa_status": "autopass" if quality_score > 0.9 else "humanreview",
            "scores": {output.model_name: quality_score},
            "best_model": output.model_name,
            "best_score": quality_score,
            "all_scores_above_threshold": bool(quality_score > 0.9)
        }
    
    # Calculate consensus scores
    scores = calculate_consensus_score(successful_outputs)
    
    # Find best model
    best_model = max(scores, key=scores.get)
    best_score = scores[best_model]
    
    # Select strategy based on score
    if best_score > 0.8:
        strategy = "single_best"
        best_output = next(o for o in successful_outputs if o.model_name == best_model)
    elif best_score > 0.6:
        strategy = "weighted_ensemble"
        best_output = create_weighted_ensemble(successful_outputs, scores)
    else:
        strategy = "majority_vote"
        best_output = create_majority_vote(successful_outputs)
    
    # Determine QA status: autopass if ALL models score > 0.9
    all_scores_above_threshold = all(score > 0.9 for score in scores.values())
    qa_status = 'autopass' if all_scores_above_threshold else 'humanreview'
    
    metadata = {
        "strategy": strategy,
        "scores": scores,
        "best_model": best_model,
        "best_score": best_score,
        "qa_status": qa_status,
        "all_scores_above_threshold": all_scores_above_threshold
    }
    
    return best_output, metadata

def create_weighted_ensemble(outputs: List[ModelOutput], scores: Dict[str, float]) -> ModelOutput:
    """Create weighted ensemble of outputs"""
    # For now, just return best model
    # TODO: Implement proper weighted ensemble
    best_model = max(scores, key=scores.get)
    return next(o for o in outputs if o.model_name == best_model)

def create_majority_vote(outputs: List[ModelOutput]) -> ModelOutput:
    """Create majority vote ensemble"""
    # For now, just return first successful
    # TODO: Implement proper majority voting
    return outputs[0]

def process_image(image_path: str, output_dir: Path, image_name: str, move_files: bool = False, active_models: List[str] = None):
    """Process single image with selected models"""
    print(f"\nProcessing image {image_name}: {image_path}")
    
    if active_models is None:
        active_models = list(MODELS.keys())
    
    # Run inference on all models IN PARALLEL
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    outputs = []
    with ThreadPoolExecutor(max_workers=len(active_models)) as executor:
        # Submit all tasks concurrently
        future_to_model = {
            executor.submit(inference_model, model_key, image_path): model_key 
            for model_key in active_models
        }
        
        # Collect results as they complete
        for future in as_completed(future_to_model):
            model_key = future_to_model[future]
            try:
                output = future.result()
                outputs.append(output)
                
                if output.success:
                    print(f"  Running {model_key}... ✓ ({len(output.layouts)} layouts)")
                else:
                    print(f"  Running {model_key}... ✗ {output.error}")
            except Exception as e:
                print(f"  Running {model_key}... ✗ Exception: {str(e)}")
                outputs.append(ModelOutput(
                    model_name=model_key,
                    success=False,
                    error=str(e),
                    layouts=[],
                    text="",
                    raw_response=None
                ))
    
    # Select best output
    best_output, metadata = select_best_output(outputs)
    
    if best_output is None:
        print(f"  ✗ All models failed for image {image_name}")
        return False
    
    print(f"  Selected: {metadata['best_model']} (score: {metadata['best_score']:.2f}, strategy: {metadata['strategy']}, QA: {metadata['qa_status']})")
    
    # Save outputs
    save_outputs(best_output, metadata, output_dir, image_name, image_path, move_files)
    
    return True

def save_outputs(output: ModelOutput, metadata: Dict, output_dir: Path, image_name: str, image_path: str, move_files: bool = False):
    """Save final outputs in required format with QA routing"""
    # Determine QA status and route to appropriate folder
    qa_status = metadata.get('qa_status', 'humanreview')
    qa_dir = output_dir / qa_status
    
    # Create subdirectories under autopass or humanreview
    annotations_dir = qa_dir / "annotations"
    markdowns_dir = qa_dir / "markdowns"
    layout_detections_dir = qa_dir / "layout_detections"
    texts_dir = qa_dir / "texts"
    model_outputs_dir = qa_dir / "model_outputs"
    images_dir = qa_dir / "images"
    
    for d in [annotations_dir, markdowns_dir, layout_detections_dir, texts_dir, model_outputs_dir, images_dir]:
        d.mkdir(parents=True, exist_ok=True)
    
    # Copy or Move source image to output
    import shutil
    source_image = Path(image_path)
    if source_image.exists():
        dest_path = images_dir / f"{image_name}{source_image.suffix}"
        if move_files:
            try:
                shutil.move(str(source_image), str(dest_path))
            except Exception as e:
                print(f"Warning: Failed to move image {source_image}: {e}")
                # Fallback to copy if move fails (e.g. cross-device)
                shutil.copy2(source_image, dest_path)
                try:
                    os.remove(source_image)
                except:
                    pass
        else:
            shutil.copy2(source_image, dest_path)
    
    # 1. Save annotation JSON
    annotation = {
        "image_name": image_name,
        "image_path": str(image_path),
        "layouts": output.layouts,
        "metadata": metadata
    }
    
    with open(annotations_dir / f"{image_name}.json", 'w', encoding='utf-8') as f:
        json.dump(annotation, f, indent=2, ensure_ascii=False)
    
    # 2. Save markdown
    markdown = create_markdown(output.layouts)
    with open(markdowns_dir / f"{image_name}.md", 'w', encoding='utf-8') as f:
        f.write(markdown)
    
    # 3. Save layout detection
    layout_detection = create_layout_detection(output.layouts)
    with open(layout_detections_dir / f"{image_name}.txt", 'w', encoding='utf-8') as f:
        f.write(layout_detection)
    
    # 4. Save plain text
    with open(texts_dir / f"{image_name}.txt", 'w', encoding='utf-8') as f:
        f.write(output.text)
    
    # 5. Save raw model output
    with open(model_outputs_dir / f"{image_name}_{output.model_name}.json", 'w', encoding='utf-8') as f:
        json.dump({
            "model": output.model_name,
            "raw_response": output.raw_response,
            "metadata": metadata
        }, f, indent=2, ensure_ascii=False)

def create_markdown(layouts: List[Dict]) -> str:
    """Create markdown from layouts"""
    lines = []
    for layout in sorted(layouts, key=lambda x: x.get('reading_order', 999)):
        class_name = layout.get('class', 'text')
        content = layout.get('content', '')
        
        if class_name == 'title':
            lines.append(f"# {content}\n")
        elif class_name == 'section-header':
            lines.append(f"## {content}\n")
        elif class_name == 'caption':
            lines.append(f"*{content}*\n")
        elif class_name == 'table':
            lines.append(f"{content}\n")  # Already HTML
        elif class_name == 'formula':
            lines.append(f"$$\n{content}\n$$\n")
        else:
            lines.append(f"{content}\n")
    
    return '\n'.join(lines)

def create_layout_detection(layouts: List[Dict]) -> str:
    """Create layout detection format"""
    lines = []
    for layout in sorted(layouts, key=lambda x: x.get('reading_order', 999)):
        bbox = layout.get('bbox', [0, 0, 0, 0])
        class_name = layout.get('class', 'text').lower().replace('-', '_')
        
        bbox_str = f"{int(bbox[0]):03d} {int(bbox[1]):03d} {int(bbox[2]):03d} {int(bbox[3]):03d}"
        line = f"<|box_start|>{bbox_str}<|box_end|><|ref_start|>{class_name}<|ref_end|>"
        lines.append(line)
    
    return '\n'.join(lines)

    return '\n'.join(lines)
    
def main():
    import argparse
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    parser = argparse.ArgumentParser(description='Multi-model document OCR inference')
    parser.add_argument('--input-dir', type=str, required=True, help='Directory with images')
    parser.add_argument('--output-dir', type=str, required=True, help='Output directory')
    parser.add_argument('--max-images', type=int, default=None, help='Max images to process')
    parser.add_argument('--move-files', action='store_true', help='Move source images to output folder')
    parser.add_argument('--num-workers', type=int, default=4, help='Number of concurrent images to process')
    parser.add_argument('--models', type=str, nargs='+', help='List of models to run (space separated). Options: ' + ', '.join(MODELS.keys()))
    
    args = parser.parse_args()
    
    # Filter models if specified
    active_models = MODELS.keys()
    if args.models:
        # Validate models
        valid_models = []
        for m in args.models:
            if m in MODELS:
                valid_models.append(m)
            else:
                print(f"Warning: Model {m} not found. Available: {list(MODELS.keys())}")
        
        if not valid_models:
            print("Error: No valid models specified.")
            return
            
        active_models = valid_models
    
    print(f"Active Models: {list(active_models)}")
    
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Find all images
    image_files = sorted(list(input_dir.glob('*.png')) + list(input_dir.glob('*.jpg')))
    
    if args.max_images:
        image_files = image_files[:args.max_images]
    
    print(f"Found {len(image_files)} images")
    print(f"Output directory: {output_dir}")
    print(f"Moving files: {args.move_files}")
    print(f"Workers: {args.num_workers}")
    print("=" * 60)
    
    # Process images IN PARALLEL
    success_count = 0
    with ThreadPoolExecutor(max_workers=args.num_workers) as executor:
        futures = []
        for i, image_path in enumerate(image_files):
            # Try to use filename as ID to preserve extraction IDs
            image_name = image_path.stem
                
            futures.append(executor.submit(process_image, str(image_path), output_dir, image_name, args.move_files, active_models))
            
        for future in tqdm(as_completed(futures), total=len(futures), desc="Processing"):
            try:
                if future.result():
                    success_count += 1
            except Exception as e:
                print(f"Error processing image: {e}")
    
    print("=" * 60)
    print(f"✓ Processed {success_count}/{len(image_files)} images successfully")

if __name__ == "__main__":
    main()
