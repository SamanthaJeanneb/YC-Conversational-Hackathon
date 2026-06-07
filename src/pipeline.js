// ─────────────────────────────────────────────────────────────────────────
//  PIPELINE WIRING  —  confirm these endpoints
// ─────────────────────────────────────────────────────────────────────────
//
// These are the ONLY two calls into the generation backend. They map onto the
// Suzanne3d pipeline (Gemini image generation → Replicate Hunyuan 3.1).
// The backend (server/index.js) reuses the exact model + params from
// suzanne3d-main: gemini-2.5-flash-image and tencent/hunyuan-3d-3.1 with
// face_count = 100000 and enable_pbr = true.
//
// If you'd rather point these at the full Flask backend
// (POST /api/generate-glb with workflow "hunyuan31-text" / "hunyuan31-1view",
// then poll /api/generation/job/:id), swap the fetch URLs below — the rest of
// the app only cares about the { modelUrl, image, prompt } shape returned.
//
// Response shape (both calls):
//   { modelUrl: string,   // GLB the GLTFLoader can fetch (proxied, same-origin)
//     image:    string,   // data-URI of the source image used (hidden context)
//     prompt:   string }  // effective prompt stored alongside the object

const API_BASE = ''; // same-origin; Vite proxies /api/* to the backend in dev

async function postJSON(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* noop */ }
    throw new Error(detail || `${path} failed (${res.status})`);
  }
  return res.json();
}

// The pipeline is split into two steps so the front end can show the Gemini
// image as a fast shape-preview placeholder (~seconds) while the much slower
// Hunyuan 3.1 mesh (~1-2 min) builds from that SAME image (no double work).

/**
 * STEP 1a — GENERATE IMAGE: text prompt → Gemini image (fast).
 * @param {{ prompt: string }} args
 * @returns {Promise<{ image: string, prompt: string }>}  image is a data-URI
 */
export async function generateImage({ prompt }) {
  return postJSON('/api/image', { prompt });
}

/**
 * SIZE — prompt → estimated real-world longest-axis size in meters (fast LLM).
 * Fired at the start of a generate so it overlaps the slow mesh build and costs
 * no extra wall-clock time. Resolves to null on failure (caller falls back).
 * @param {{ prompt: string }} args
 * @returns {Promise<{ sizeMeters: number|null }>}
 */
export async function estimateSize({ prompt }) {
  return postJSON('/api/size', { prompt });
}

/**
 * STEP 1b — ITERATE IMAGE: stored source image + instruction → Gemini edit (fast).
 * The prior image is passed as context so the result is a variation.
 * @param {{ sourceImage: string, prompt: string, instruction: string }} args
 * @returns {Promise<{ image: string, prompt: string }>}
 */
export async function iterateImage({ sourceImage, prompt, instruction }) {
  return postJSON('/api/image', { sourceImage, prompt, instruction });
}

/**
 * STEP 2 — IMAGE → MODEL: image → Hunyuan 3.1 GLB (slow; 100k faces, PBR).
 * @param {{ image: string, prompt: string }} args
 * @returns {Promise<{ modelUrl: string, image: string, prompt: string }>}
 */
export async function imageToModel({ image, prompt }) {
  return postJSON('/api/model', { image, prompt });
}

/**
 * LIGHTING — natural-language request + current rig state → full target rig.
 * A thin interpretation layer (Gemini) that maps intent onto the scene's
 * concrete lighting knobs. Returns the complete resulting state to apply.
 * @param {{ prompt: string, current: object }} args
 * @returns {Promise<object>} full lighting config (see server LIGHTING_SCHEMA)
 */
export async function setLighting({ prompt, current }) {
  return postJSON('/api/lighting', { prompt, current });
}
