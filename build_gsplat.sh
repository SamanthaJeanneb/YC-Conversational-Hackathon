#!/bin/bash
# Stage 5: build the gsplat_maskgaussian CUDA extension
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export TORCH_CUDA_ARCH_LIST=8.0
export MAX_JOBS=16
cd /workspace/HY-World-2.0/hyworld2/worldgen/third_party/gsplat_maskgaussian || exit 99
pip install -e . --no-build-isolation
echo "GSPLAT_EXIT=$?"
