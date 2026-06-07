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

| Action | |
|---|---|
| Enter | Click the scene to lock the pointer |
| Move | `W A S D` / arrow keys (grounded, eye height 1.6) |
| Look | Mouse |
| **Iterate** | **Left-click** an object → inline iterate control |
| **Generate** | **Right-click** the ground/surface → generate menu (placed at the crosshair) |
| Release | `Esc` |

While a menu is open the pointer unlocks so you can type; it re-locks on close.

## Architecture

- `src/main.js` — the whole three.js app (room, first-person controls, crosshair
  raycast, panels, generate/iterate flows, model loading).
- `src/pipeline.js` — the two clearly-marked async calls into the backend
  (`generateObject`, `iterateObject`). **Swap the endpoints here** if you want to
  point at the full Flask backend (`/api/generate-glb` + job polling) instead.
- `src/store.js` — in-memory object store keyed by id; holds mesh + the hidden
  source image / prompt history used for iteration.
- `server/index.js` — lean proxy: Gemini → Hunyuan 3.1, serves GLBs same-origin.
