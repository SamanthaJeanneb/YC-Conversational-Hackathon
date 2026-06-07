# WorldVoice

> Speak a world into existence, then redesign it with your voice.

## What It Does

WorldVoice generates full 3D environments from a spoken description and lets you
iterate on them in real time through conversation. Describe a scene, walk through
it in your browser, then keep talking to reshape it: add objects, change the
lighting, restyle surfaces, swap materials. No 3D software, no modeling skills.
Just your voice and a world that listens.

## How It Works

### World Generation — generative world models + Gaussian splatting

A natural-language or image prompt is lifted into a fully navigable 3D world by
**Tencent HY-World 2.0**, a generative *world model* rather than a single-image
generator. The pipeline is a cascade of diffusion and neural-reconstruction
stages:

- **HY-Pano 2.0** — a panoramic latent-diffusion model synthesizes a seamless
  360° equirectangular environment from the prompt, fixing global scene
  structure, illumination, and style in one coherent shot.
- **WorldNav** — plans a camera trajectory through the panorama, sampling the
  viewpoints needed to recover parallax and occlusion cues.
- **WorldStereo 2.0** — multi-view stereo with monocular depth priors lifts the
  posed 2D views into metric 3D geometry.
- **WorldMirror 2.0** — a feed-forward neural reconstruction model fuses the
  posed views into a dense, geometrically consistent scene.
- **3DGS** — the scene is exported as a **3D Gaussian Splatting** radiance field
  for photoreal, real-time rendering, alongside a watertight **GLB** mesh for
  collision, physics, and AR.

Unlike video-diffusion "world simulators" that hallucinate frames, this produces
*persistent, explorable geometry* — real 3D assets you can walk through, not a
rendered fly-through. The pipeline runs on cloud **A100** GPUs.

### Voice Interaction — streaming STT → LLM intent parsing

**LiveKit** provides low-latency WebRTC audio transport. Streaming speech-to-text
feeds a **Claude** intent parser that maps free-form utterances onto a typed
command schema via structured tool-calling: generate a new world, drop an
object, change the lighting, restyle a surface, or teleport to a location. Each
command routes to either an asynchronous generation job or an instant
client-side scene operation, so conversational latency stays decoupled from heavy
GPU work.

### 3D Iteration — diffusion image editing + neural re-reconstruction

To iterate on a generated world we close a *perception → edit → reconstruction*
loop. The current viewport is captured; **Qwen-Image**, an instruction-guided
diffusion editor, applies the requested change (restyle, recolor, add detail,
shift atmosphere); and the edited view is re-projected through **WorldMirror
2.0** to reconstruct updated 3D geometry in place. This updates the scene from a
single voice command without regenerating the entire world.

### Rendering and AR — three.js + WebXR

The world loads in the browser via **three.js** (WebGL2). First-person
navigation lets you walk the environment on desktop; on WebXR-capable mobile, the
generated world is anchored into your physical space as **AR**. Objects generated
mid-session drop into the live scene as GLB meshes.

## Architecture

```
Voice Input → LiveKit (audio transport)
    → STT → Claude (intent parsing)
        → "rooftop garden"        → HY-World 2.0 (async, full worldgen → 3DGS + GLB)
        → "make the walls brick"  → Qwen (image edit) → WorldMirror 2.0 (reconstruct) → scene update
        → "add a bench here"      → image-to-3D diffusion (Hunyuan3D / Tripo3D) → drop GLB into scene
        → "make it sunset"        → client-side lighting change (instant)
    → three.js / WebXR (rendering)
    → Minimax TTS (spoken response)
```

## Tech Stack

- **World Generation:** HY-World 2.0 (HY-Pano 2.0, WorldNav, WorldStereo 2.0, WorldMirror 2.0) → 3D Gaussian Splatting + GLB
- **3D Iteration:** Qwen-Image (diffusion image editing) + WorldMirror 2.0 (neural 3D reconstruction from edited views)
- **Image Generation:** Minimax image-01
- **Object Generation:** image-to-3D diffusion (Hunyuan3D / Tripo3D)
- **Voice Transport:** LiveKit
- **Intent Parsing:** Claude (Anthropic)
- **Speech:** streaming STT + Minimax TTS
- **Rendering:** three.js, WebXR
- **Infrastructure:** RunPod (A100 GPUs), AWS

## Hackathon Tracks

- **Co-Pilot** — an ambient agent that takes voice input and displays live 3D context
- **Support** — voice-guided world building with real-time visual feedback

## Team

- Samantha Jeanneb
- Yehor Ivanenko

## Built At

Conversational AI Hackathon, hosted by Moss (F25) at Y Combinator — June 6–7, 2026
