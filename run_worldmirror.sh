#!/bin/bash
# WorldMirror 2.0 — images -> 3D environment (Gaussian splats + point cloud + depth)
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export HF_HOME=/hf_cache                 # weights on the 200 GB container disk
export HF_HUB_OFFLINE=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
cd /workspace/HY-World-2.0
SCENE="${1:-examples/worldrecon/realistic/Building}"
OUT="${2:-/workspace/outputs/worldmirror_out}"
python -m hyworld2.worldrecon.pipeline \
    --input_path "$SCENE" \
    --output_path "$OUT" \
    --enable_bf16
echo "WM_EXIT=$?"
