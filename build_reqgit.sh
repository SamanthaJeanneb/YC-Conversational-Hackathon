#!/bin/bash
# Stage 7b: install git-based deps (pytorch3d, fused-ssim, nerfview, spz, MoGe)
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export TORCH_CUDA_ARCH_LIST=8.0
export MAX_JOBS=4
export FORCE_CUDA=1
cd /workspace/HY-World-2.0 || exit 99
pip install --no-build-isolation -r requirements_git.txt
echo "REQGIT_EXIT=$?"
