# FPS 3D Builder

A browser-based, first-person 3D scene (plain three.js) where you walk around a
room and **generate / iterate 3D objects with the crosshair** — no chat interface.

It reuses the Suzanne3d pipeline:

- **Lighting:** `src/lighting.js` is the `installMeshyLighting` recipe ported
  from `suzanne3d-main/.../sharedLighting.ts` (HDR studio IBL + warm key + hot
  rim), with the same renderer setup (ACES filmic, exposure 0.9). The HDR
  (`public/studio_small_03_1k.hdr`) is copied from Suzanne.
- **Generation:** Gemini `gemini-2.5-flash-image` → Replicate
  **`tencent/hunyuan-3d-3.1`** with `face_count: 100000`, `enable_pbr: true`
  — the same `hunyuan31` workflow used in `suzanne3d-main/backend/app.py`.
- **Secrets:** read from `~/Desktop/suzanne3d-main/.env`
  (`GEMINI_API_KEY`, `REPLICATE_API_TOKEN` / `REPLICATE_API_KEY`). Nothing is
  hardcoded. A local `./.env` overrides if present.

## Run

```bash
npm install
npm run dev:all      # vite (5173) + proxy (8787) together
# or, in two terminals:  npm run server   and   npm run dev
```

Open http://localhost:5173.

Check the backend is wired up: http://localhost:8787/api/health

## Controls

Generation, iteration, and lighting are **voice-controlled** (LiveKit) — there
is no text/chat interface. Clicks only *target*; you speak the rest.

| Action | |
|---|---|
| Enter | Click the scene to lock the pointer |
| Move | `W A S D` / arrow keys (grounded, eye height 1.6) |
| Look | Mouse |
| **Voice** | `V` or the **Voice** button → always-listening control (see `voice/`) |
| **Generate** | **Right-click** the ground to set a spawn marker, then say *"a red mug"* (no marker → spawns in front of you) |
| **Iterate** | **Left-click** an object to select it, then say *"make it bigger"* / *"add a handle"* |
| **Lighting** | say *"warm sunset"* / *"dim and moody"* |
| **Move** | `G` to grab the object under the crosshair; it follows you — **left-click** to place, **right-click**/`Esc` to cancel |
| Release | `Esc` |

While an object generates, a fast **outline placeholder** (silhouette + edges traced
from the Gemini preview image) appears at the spot, then is replaced by the GLB.

While a menu is open the pointer unlocks so you can type; it re-locks on close.

## Architecture

- `src/main.js` — the whole three.js app (room, first-person controls, crosshair
  raycast, click-targeting, generate/iterate/lighting flows, model loading).
- `src/pipeline.js` — the two clearly-marked async calls into the backend
  (`generateObject`, `iterateObject`). **Swap the endpoints here** if you want to
  point at the full Flask backend (`/api/generate-glb` + job polling) instead.
- `src/store.js` — in-memory object store keyed by id; holds mesh + the hidden
  source image / prompt history used for iteration.
- `server/index.js` — lean proxy: Gemini → Hunyuan 3.1, serves GLBs same-origin,
  and mints LiveKit voice tokens (`/api/voice-token`).
- `src/voice.js` + `voice/agent.py` — the optional real-time **voice layer**
  (LiveKit Agents). The Python worker routes speech to the scene functions over
  a data channel; it never touches three.js. See [`voice/README.md`](voice/README.md).

## Voice control (optional)

A LiveKit Agents worker turns speech into calls on the generate / iterate /
lighting functions. STT (Deepgram Nova-3), LLM (gpt-4.1-mini router) and TTS
(Cartesia Sonic-2) **all run through LiveKit Inference** — one bill, the only
creds needed are `LIVEKIT_*`. Quick start:

```bash
# add LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET to .env
cd voice && python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && python agent.py download-files
python agent.py dev          # worker auto-joins the room the browser opens
```
Then click **Voice** in the app. Full details in [`voice/README.md`](voice/README.md).
