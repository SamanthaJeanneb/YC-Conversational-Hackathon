#!/bin/bash
# Run HY-Pano-2.0 panorama expansion (HunyuanImage-3 backend)
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export HF_HOME=/hf_cache                 # weights live on the 200 GB container disk
export HF_HUB_OFFLINE=1                   # already downloaded; don't re-hit the hub
export TOKENIZERS_PARALLELISM=false
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
cd /workspace/HY-World-2.0/hyworld2/panogen
python pipeline.py \
    --image /workspace/inputs/city.jpg \
    --prompt "A futuristic city street at sunset, neon signs, flying vehicles, glowing skyscrapers, cinematic realistic style." \
    --bot-task image \
    --diff-infer-steps 30 \
    --seed 42 \
    --save /workspace/outputs/pano_city.png
echo "PANO_EXIT=$?"
