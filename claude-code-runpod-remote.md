# Claude Code — Remote RunPod Control

## Goal

Use Claude Code on your local machine to SSH into your RunPod A100 and run all HY-World 2.0 setup + generation commands remotely.

---

## Step 1: Generate SSH Key (local)

```bash
ssh-keygen -t ed25519 -C "worldvoice-runpod" -f ~/.ssh/runpod
# Hit enter twice (no passphrase for speed)
```

## Step 2: Copy Public Key

```bash
cat ~/.ssh/runpod.pub
# Copy the output
```

Paste this into RunPod → Pod → Connect → SSH public key field → Save.

## Step 3: SSH Config (local)

Add to `~/.ssh/config`:

```
Host runpod
    HostName 213.173.105.4
    Port 30057
    User root
    IdentityFile ~/.ssh/runpod
    StrictHostKeyChecking no
```

**Update HostName and Port if the pod IP changes.** Find current values in RunPod → Pod → Connect → Direct TCP ports.

> ⚠️ **The direct-TCP port changes every time the pod is stopped/started.** Symptom: `ssh` returns `Connection refused` even though it worked before. Fix: re-read RunPod → Connect → Direct TCP ports and update `Port` above. (It changed 30183 → 30057 on a restart.)
>
> ⚠️ **Account SSH keys are only injected into the pod at startup.** Adding a key in RunPod → Settings → SSH Public Keys does NOT affect an already-running pod. Either restart the pod, or append the key to the pod's `~/.ssh/authorized_keys` directly. If the proxy login works but direct-TCP gives `Permission denied`, append the key via the proxy shell:
> ```bash
> echo "echo 'PASTE_YOUR_PUBLIC_KEY_LINE' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; exit" \
>   | ssh -tt <pod-id>@ssh.runpod.io -i ~/.ssh/runpod
> ```

## Step 4: Test Connection

```bash
ssh runpod "nvidia-smi"
```

Should print A100 80GB info. If this works, you're connected.

---

## Using Claude Code to Control RunPod

Claude Code can now run any command on the pod via `ssh runpod "command"`. Examples:

```bash
# Run a single command
ssh runpod "cd /workspace && ls"

# Run a multi-line script
ssh runpod 'bash -s' << 'EOF'
cd /workspace/HY-World-2.0
conda activate hyworld2
python -c "import torch; print(torch.cuda.get_device_name())"
EOF

# Start a long-running process in the background (won't die if SSH drops)
ssh runpod "cd /workspace/HY-World-2.0 
&& nohup python traj_generate.py > /workspace/logs/traj.log 2>&1 &"

# Check logs
ssh runpod "tail -f /workspace/logs/traj.log"
```

### Transfer Files

```bash
# Local → RunPod
scp -P 30057 -i ~/.ssh/runpod ./input.png root@213.173.105.4:/workspace/inputs/

# RunPod → Local (download generated world)
scp -P 30057 -i ~/.ssh/runpod root@213.173.105.4:/workspace/outputs/world/scene.glb ./downloads/

# Sync a whole folder
rsync -avz -e "ssh -p 30057 -i ~/.ssh/runpod" root@213.173.105.4:/workspace/outputs/ ./outputs/
```

Or using the SSH config alias:

```bash
scp runpod:/workspace/outputs/world/scene.glb ./downloads/
rsync -avz runpod:/workspace/outputs/ ./outputs/
```

---

## Full Setup Script (paste into Claude Code)

This runs the entire HY-World 2.0 install on RunPod in one shot. **This version reflects the actual working setup** — see the inline notes for what differs from the upstream README and why (each was a real failure we hit).

```bash
ssh runpod 'bash -s' << 'SETUP'
set -e

# --- prerequisites the base image lacks ---
# conda is NOT preinstalled -> install Miniforge to /workspace (persists across restarts)
if [ ! -x /workspace/miniforge3/bin/conda ]; then
  curl -fsSL -o /tmp/miniforge.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
  bash /tmp/miniforge.sh -b -p /workspace/miniforge3
fi
export PATH=/workspace/miniforge3/bin:$PATH

# GLM headers are required by the gsplat CUDA build (else: glm/gtc/type_ptr.hpp: No such file)
DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq libglm-dev

cd /workspace
git clone https://github.com/Tencent-Hunyuan/HY-World-2.0
cd HY-World-2.0

# conda env (python pinned per README)
conda create -n hyworld2 python=3.11.15 -y
source activate hyworld2

# CUDA build env: toolkit 12.8 is at /usr/local/cuda; pin to A100 (sm_80) to cut build time
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH
export TORCH_CUDA_ARCH_LIST=8.0

# base deps (installs torch 2.7.1+cu126)
pip install -r requirements.txt

# gsplat CUDA extension
cd hyworld2/worldgen/third_party/gsplat_maskgaussian
MAX_JOBS=16 pip install -e . --no-build-isolation
cd ../../../../

# FlashAttention-2
# NOTE: the container RAM is capped ~116 GiB (NOT the 1 TB `free` shows). High MAX_JOBS
# OOM-kills the compile ("Killed" -> "Error compiling objects"). Keep MAX_JOBS=4.
MAX_JOBS=4 pip install flash-attn --no-build-isolation

# worldgen extras (pytorch3d is a heavy CUDA build -> MAX_JOBS=4)
git submodule update --init --recursive   # needed BEFORE navmesh (recastnavigation)
MAX_JOBS=4 FORCE_CUDA=1 pip install --no-build-isolation -r requirements_git.txt
cd hyworld2/worldgen/third_party/navmesh
pip install . --no-build-isolation
cd ../../../../

# pre-download model weights
# NOTE: `huggingface-cli` is deprecated and no longer works -> use `hf download`
# NOTE: the hf_xet backend can crash ("Internal Writer Error: Background writer
# channel closed"); disable it to fall back to plain HTTP. Re-running resumes.
export HF_HUB_DISABLE_XET=1
hf download tencent/HY-World-2.0 --local-dir /workspace/models

echo "=== SETUP COMPLETE ==="
SETUP
```

---

## Generate a World (via Claude Code)

```bash
# Generate panorama
ssh runpod 'bash -s' << 'GEN'
cd /workspace/HY-World-2.0
source activate hyworld2

python -c "
from hyworld2.panogen.pipeline import HunyuanPanoPipeline
pipe = HunyuanPanoPipeline.from_pretrained('tencent/HY-World-2.0')
out = pipe('a futuristic city street at sunset')
out.save('/workspace/outputs/pano.png')
print('Panorama saved')
"
GEN

# Run worldgen stages (check README for exact CLI args)
ssh runpod "cd /workspace/HY-World-2.0 && source activate hyworld2 && python traj_generate.py"
ssh runpod "cd /workspace/HY-World-2.0 && source activate hyworld2 && python traj_render.py"
ssh runpod "cd /workspace/HY-World-2.0 && source activate hyworld2 && python video_gen.py"
ssh runpod "cd /workspace/HY-World-2.0 && source activate hyworld2 && python gen_gs_data.py"
ssh runpod "cd /workspace/HY-World-2.0 && source activate hyworld2 && python world_gs_trainer.py"

# Download the result
scp runpod:/workspace/outputs/world/scene.glb ./hackathon/public/worlds/
```

---

## Expose an API from RunPod (optional)

If you want the frontend to call RunPod directly instead of going through Claude Code:

```bash
# On RunPod, start a FastAPI server on port 8080
ssh runpod 'bash -s' << 'API'
cd /workspace
pip install fastapi uvicorn
cat > server.py << 'PYEOF'
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/outputs", StaticFiles(directory="/workspace/outputs"), name="outputs")

@app.get("/health")
def health():
    return {"status": "ok"}
PYEOF

nohup uvicorn server:app --host 0.0.0.0 --port 8080 > /workspace/logs/api.log 2>&1 &
echo "API running on port 8080"
API
```

Then expose port 8080 in RunPod pod settings (add an HTTP port). Your frontend can fetch worlds from `https://<pod-id>-8080.proxy.runpod.net/outputs/world/scene.glb`.

---

## Quick Reference

| Task | Command |
|------|---------|
| Check GPU | `ssh runpod "nvidia-smi"` |
| Check disk | `ssh runpod "df -h /workspace"` |
| Check running processes | `ssh runpod "ps aux \| grep python"` |
| Kill a stuck job | `ssh runpod "pkill -f traj_generate"` |
| Download output | `scp runpod:/workspace/outputs/world/scene.glb .` |
| Stream logs | `ssh runpod "tail -f /workspace/logs/traj.log"` |
| Pod still alive? | `ssh runpod "uptime"` |
