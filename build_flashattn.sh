#!/bin/bash
# Stage 6: build FlashAttention-2 (Ampere/A100 = sm_80)
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export TORCH_CUDA_ARCH_LIST=8.0
export FLASH_ATTENTION_FORCE_BUILD=TRUE
export MAX_JOBS=4
pip install flash-attn --no-build-isolation
echo "FLASH_EXIT=$?"
