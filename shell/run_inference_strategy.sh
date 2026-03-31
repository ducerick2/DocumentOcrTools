#!/bin/bash
# Interactive Inference Strategy Script
# Prompts user for input directory and model selection

SCRIPT="/data/ducbm3/DocumentOCR/inference/multi_model_inference.py"

echo "============================================================"
echo "Starting Interactive Inference Pipeline"
echo "============================================================"
echo "Script: $SCRIPT"
echo "============================================================"

# Prompt for Input Directory
read -e -p "Enter inference folder path (images directory): " INPUT_DIR
INPUT_DIR=$(realpath "$INPUT_DIR")

if [ ! -d "$INPUT_DIR" ]; then
    echo "Error: Directory '$INPUT_DIR' does not exist."
    exit 1
fi

# Prompt for Output Directory
read -e -p "Enter output folder path: " OUTPUT_DIR
echo "Output Directory: $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Available Models
MODELS=("gemini_flash_lite" "qwen3_vl_local" "gemma_3_27b_it" "mineru_2_5")
MODEL_NAMES=("Gemini-Flash-Lite" "Qwen3-VL-Local" "Gemma-3-27b-it" "MinerU-2.5-1.2B")

echo "------------------------------------------------------------"
echo "Available Models:"
for i in "${!MODELS[@]}"; do
    echo "$((i+1)). ${MODEL_NAMES[$i]}"
done
echo "------------------------------------------------------------"

read -p "Enter number of models to use: " NUM_MODELS

if ! [[ "$NUM_MODELS" =~ ^[0-9]+$ ]] || [ "$NUM_MODELS" -lt 1 ]; then
    echo "Error: Invalid number."
    exit 1
fi

SELECTED_MODELS=""
echo "Select $NUM_MODELS models:"

for (( i=1; i<=NUM_MODELS; i++ )); do
    while true; do
        read -p "  Model #$i (enter number): " CHOICE
        IDX=$((CHOICE-1))
        
        if [ "$IDX" -ge 0 ] && [ "$IDX" -lt "${#MODELS[@]}" ]; then
            MODEL_KEY="${MODELS[$IDX]}"
            # check if already selected
            if [[ "$SELECTED_MODELS" == *"$MODEL_KEY"* ]]; then
                 echo "    Warning: $MODEL_KEY already selected."
            else
                 SELECTED_MODELS="$SELECTED_MODELS $MODEL_KEY"
                 echo "    > Added: ${MODEL_NAMES[$IDX]}"
                 break
            fi
        else
            echo "    Invalid selection. Try again."
        fi
    done
done

echo "============================================================"
echo "Starting Inference..."
echo "Input: $INPUT_DIR"
echo "Models: $SELECTED_MODELS"
echo "============================================================"

# Determine Script and Python based on Model
PYTHON_CMD="python3"

if [[ "$SELECTED_MODELS" == *"mineru_2_5"* ]]; then
    echo "MinerU 2.5 selected. Switching to MinerU Client (Remote HTTP via port 9096)."
    SCRIPT="/data/ducbm3/DocumentOCR/inference/multi_model_inference_vllm.py"
    PYTHON_CMD="/data/ducbm3/VLM/deploy_vintern/bin/python3"
    
    # Prompt for Content Extraction Model
    echo "------------------------------------------------------------"
    read -p "Do you want to use a different model for CROP CONTENT extraction? (y/N): " USE_CONTENT_MODEL
    if [[ "$USE_CONTENT_MODEL" =~ ^[Yy]$ ]]; then
        echo "Select Content Extraction Model:"
        # List models again (excluding MinerU if desired, but user might want MinerU explicitly? No, that's default)
        # Just show all available models.
        for i in "${!MODELS[@]}"; do
             # Skip MinerU if you want, but maybe user wants running MinerU Layout + MinerU Content (Standard) vs MinerU Layout + Qwen Content
             # If they select MinerU here, it's same as default.
             echo "$((i+1)). ${MODEL_NAMES[$i]}"
        done
        
        while true; do
            read -p "Enter number for Content Model: " C_CHOICE
            C_IDX=$((C_CHOICE-1))
            if [ "$C_IDX" -ge 0 ] && [ "$C_IDX" -lt "${#MODELS[@]}" ]; then
                CONTENT_MODEL="${MODELS[$C_IDX]}"
                echo "    > Content Model: ${MODEL_NAMES[$C_IDX]}"
                break
            else
                echo "    Invalid selection."
            fi
        done
    fi
fi

# Run inference
CMD_ARGS=(
    "$SCRIPT"
    --input-dir "$INPUT_DIR"
    --output-dir "$OUTPUT_DIR"
    --move-files
    --models $SELECTED_MODELS
)

if [ -n "$CONTENT_MODEL" ]; then
    CMD_ARGS+=(--content-model "$CONTENT_MODEL")
fi

$PYTHON_CMD "${CMD_ARGS[@]}"

echo "Done! Results saved to $OUTPUT_DIR"
