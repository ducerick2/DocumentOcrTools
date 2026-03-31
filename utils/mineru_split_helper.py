#!/usr/bin/env python3
"""
mineru_split_helper.py
Called by server.js /api/extract-split endpoint.

Usage:
    echo '<base64_image>' | python3 mineru_split_helper.py [--mode layout|extract]

Modes:
    layout  (default) - Step 1 only: returns layout boxes without content (fast)
    extract           - Step 1 + 2: returns layout boxes WITH OCR content (slower)

Output (stdout): JSON object with layouts:
{
  "layouts": [
    { "class": "text", "bbox": [x1, y1, x2, y2], "content": "...", "reading_order": 0 },
    ...
  ]
}
bbox values are in absolute pixels relative to the input image.
"""

import sys
import json
import asyncio
import base64
import io
import argparse
from PIL import Image


async def run(image, mode="layout"):
    try:
        from mineru_vl_utils import MinerUClient

        client = MinerUClient(
            backend="http-client",
            server_url="http://localhost:9096/v1",
            model_name="/data/llm-models/MinerU2.5-2509-1.2B",
        )

        width, height = image.size
        layouts = []

        if mode == "extract":
            # 2-step: Layout Detection + Content Extraction
            extracted = await client.aio_two_step_extract(image)

            for idx, block in enumerate(extracted):
                bbox = block.bbox  # [x1, y1, x2, y2] normalized 0-1
                px_bbox = [
                    int(bbox[0] * width),
                    int(bbox[1] * height),
                    int(bbox[2] * width),
                    int(bbox[3] * height)
                ]
                layouts.append({
                    "class": block.type,
                    "bbox": px_bbox,
                    "content": block.content or "",
                    "reading_order": idx
                })
        else:
            # 1-step: Layout Detection only (no content extraction)
            blocks = await client.aio_layout_detect(image)

            for idx, block in enumerate(blocks):
                bbox = block.bbox  # [x1, y1, x2, y2] normalized 0-1
                px_bbox = [
                    int(bbox[0] * width),
                    int(bbox[1] * height),
                    int(bbox[2] * width),
                    int(bbox[3] * height)
                ]
                layouts.append({
                    "class": block.type,
                    "bbox": px_bbox,
                    "content": "",
                    "reading_order": idx
                })

        return {"layouts": layouts}
    except Exception as e:
        return {"error": str(e)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["layout", "extract"], default="layout",
                        help="layout = boxes only (1 step), extract = boxes + content (2 steps)")
    args = parser.parse_args()

    # Read base64 image data from stdin
    b64 = sys.stdin.read().strip()
    if not b64:
        print(json.dumps({"error": "No image data received"}), file=sys.stdout)
        sys.exit(1)

    # Strip data URI prefix if present
    if ',' in b64:
        b64 = b64.split(',', 1)[1]

    try:
        img_bytes = base64.b64decode(b64)
        image = Image.open(io.BytesIO(img_bytes)).convert('RGB')
    except Exception as e:
        print(json.dumps({"error": f"Failed to decode image: {e}"}), file=sys.stdout)
        sys.exit(1)

    try:
        result = asyncio.run(run(image, mode=args.mode))
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
