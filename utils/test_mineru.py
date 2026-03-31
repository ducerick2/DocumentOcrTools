
import base64
import requests
import json
import os

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

image_path = "/data/ducbm3/DocumentOCR/dataset_public/DocLayNet_extracted/train/financial_reports/autopass/images/10017.png"
base64_image = encode_image(image_path)

headers = {
    "Content-Type": "application/json",
    # "Authorization": f"Bearer {api_key}" # No auth needed for local vllm usually
}

# Payload for Layout Detection
payload_layout = {
    "model": "/data/llm-models/MinerU2.5-2509-1.2B", # Model name must match server arg
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Layout Detection:" 
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{base64_image}"
                    }
                }
            ]
        }
    ],
    "max_tokens": 4096,
    "temperature": 0.0 # Deterministic
}

print("Sending Layout Detection request...")
response = requests.post("http://localhost:9096/v1/chat/completions", headers=headers, json=payload_layout)

if response.status_code == 200:
    result = response.json()
    print("Response:")
    print(json.dumps(result, indent=2))
    
    content = result['choices'][0]['message']['content']
    print("\nLayout Content:")
    print(content)

    # Parse Layout
    lines = content.strip().split('\n')
    from PIL import Image
    import io

    # Load original image
    with open(image_path, "rb") as f:
        img = Image.open(f)
        img.load() # Force load
        width, height = img.size
        print(f"Image size: {width}x{height}")
        
    # Process first text block
    # ... parsing logic needs to be robust ...

    
    # Process first text block
    for line in lines:
        parts = line.strip().split(' ') # e.g. "308 135 803 190text" -> ["308", "135", "803", "190text"]
        # Wait, the output format in log was "115 059 603 096title" (no space before title?)
        # Actually in the log: "115 059 603 096title" looks like "096" then "title".
        # Let's inspect the log again carefully. "096title".
        # Ah, looking at the log: "115 059 603 096title". it seems concatenated?
        # Or maybe it's "115 059 603 096 title"?
        # "123 947 141 959page_number" -> "959" "page_number".
        # Standard MinerU output usually has a space or the type is strictly alpha.
        
        # Let's handle parsing carefully.
        # Last part is the type. First 4 are coords.
        # But if they are concatenated... 
        # I'll rely on the fact that coords are 3 digits? 
        # "096" -> 3 digits.
        # I'll just split by space and parse.
        
        # Let's assume the log output "115 059 603 096title" might be copy-paste artifact or real.
        # I will start by printing the raw line to debug.
        pass

    # For the test, I'll just hardcode one crop based on my reading of the log
    # "308 135 803 190text" -> x1=308, y1=135, x2=803, y2=190 (Normalized)
    
    x1, y1, x2, y2 = 308, 135, 803, 190
    
    # Denormalize
    left = int(x1 * width / 1000)
    top = int(y1 * height / 1000)
    right = int(x2 * width / 1000)
    bottom = int(y2 * height / 1000)
    
    print(f"\nCropping: {left}, {top}, {right}, {bottom}")
    cropped_img = img.crop((left, top, right, bottom))
    
    # Encode crop
    buffered = io.BytesIO()
    cropped_img.save(buffered, format="PNG")
    crop_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
    
    # Send Content Request
    payload_content = {
        "model": "/data/llm-models/MinerU2.5-2509-1.2B",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Text Recognition" 
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{crop_base64}"
                        }
                    }
                ]
            }
        ],
        "max_tokens": 4096,
        "temperature": 0.0
    }
    
    print("Sending Text Recognition request...")
    response_c = requests.post("http://localhost:9096/v1/chat/completions", headers=headers, json=payload_content)
    if response_c.status_code == 200:
        print("Content Response:")
        print(response_c.json()['choices'][0]['message']['content'])
    else:
        print("Error content:", response_c.text)

else:
    print(f"Error: {response.status_code}")
    print(response.text)
