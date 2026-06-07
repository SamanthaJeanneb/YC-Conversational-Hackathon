#!/bin/bash
# Stage 8: download HY-World 2.0 model weights from Hugging Face
export PATH=/workspace/miniforge3/bin:$PATH
source activate hyworld2
export HF_HUB_ENABLE_HF_TRANSFER=0
export HF_HUB_DISABLE_XET=1
export HF_XET_HIGH_PERFORMANCE=0
# Container disk (/) is 200 GB; volume (/workspace) quota is too small for 174.7 GB.
# Download into the HF cache on / so from_pretrained('tencent/HY-World-2.0') finds it.
export HF_HOME=/hf_cache
mkdir -p /hf_cache
hf download tencent/HY-World-2.0
echo "DOWNLOAD_EXIT=$?"
