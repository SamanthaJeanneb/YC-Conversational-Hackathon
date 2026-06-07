#!/usr/bin/env python3
# Two patches to make HY-Pano run on a single A100 80GB:
#  1) max_memory + offload_folder on from_pretrained -> leave GPU headroom (fixes diffusion OOM)
#  2) enable VAE spatial tiling after load -> tiled decode (fixes VAE-decode OOM at full res)
f = "/workspace/HY-World-2.0/hyworld2/panogen/pipeline.py"
s = open(f).read()
changed = []

# Patch 1: max_memory
needle1 = '            device_map="auto",\n'
add1 = (
    '            max_memory={0: "66GiB", "cpu": "105GiB"},\n'
    '            offload_folder="/offload",\n'
)
if "max_memory=" in s:
    changed.append("max_memory:ALREADY")
elif needle1 in s:
    s = s.replace(needle1, needle1 + add1, 1)
    changed.append("max_memory:OK")
else:
    changed.append("max_memory:NEEDLE_NOT_FOUND")

# Patch 2: enable VAE spatial tiling right after the model is loaded
needle2 = '        model.load_tokenizer(model_dir)\n'
add2 = (
    '        try:\n'
    '            model.vae.enable_spatial_tiling(True)\n'
    '            print("[Init] VAE spatial tiling enabled.")\n'
    '        except Exception as _e:\n'
    '            print(f"[Init] Could not enable VAE tiling: {_e}")\n'
)
if "enable_spatial_tiling(True)" in s:
    changed.append("vae_tiling:ALREADY")
elif needle2 in s:
    s = s.replace(needle2, needle2 + add2, 1)
    changed.append("vae_tiling:OK")
else:
    changed.append("vae_tiling:NEEDLE_NOT_FOUND")

open(f, "w").write(s)
print(" | ".join(changed))
