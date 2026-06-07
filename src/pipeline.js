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

/**
 * GENERATE — text prompt → Gemini image → Hunyuan 3.1 GLB.
 * @param {{ prompt: string }} args
 * @returns {Promise<{ modelUrl: string, image: string, prompt: string }>}
 */
export async function generateObject({ prompt }) {
  return postJSON('/api/generate', { prompt });
}

/**
 * ITERATE — stored source image + new instruction → Gemini edit → Hunyuan 3.1 GLB.
 * The prior image is passed back as context so the new model is a variation,
 * not a brand-new object.
 * @param {{ sourceImage: string, prompt: string, instruction: string }} args
 * @returns {Promise<{ modelUrl: string, image: string, prompt: string }>}
 */
export async function iterateObject({ sourceImage, prompt, instruction }) {
  return postJSON('/api/iterate', { sourceImage, prompt, instruction });
}
