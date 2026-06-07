// ─────────────────────────────────────────────────────────────────────────
//  Lean generation proxy.
//
//  Reuses the Suzanne3d pipeline pieces WITHOUT the Flask/Supabase/Stripe
//  weight: Gemini image generation → Replicate Hunyuan 3.1 (100k faces, PBR).
//
//  Secrets are READ FROM the existing config (never hardcoded):
//    ~/Desktop/suzanne3d-main/.env   →  GEMINI_API_KEY,
//                                        REPLICATE_API_TOKEN (or _API_KEY)
//  A local ./.env (if present) overrides, so you can relocate keys later.
// ─────────────────────────────────────────────────────────────────────────
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import Replicate from 'replicate';

// Load the existing Suzanne config first, then any local .env on top.
dotenv.config({ path: path.join(os.homedir(), 'Desktop', 'suzanne3d-main', '.env') });
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// suzanne's replicate_service.py reads REPLICATE_API_KEY; .env.example documents
// REPLICATE_API_TOKEN. Accept either.
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
const PORT = process.env.PORT || 8787;

// Mirror suzanne3d-main/backend/view_generation.py image model preference order.
const IMAGE_GEN_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
];

// Mirror suzanne3d-main/backend/app.py hunyuan31 workflow:
//   replicate_predict("tencent/hunyuan-3d-3.1", { image, face_count, enable_pbr })
const HUNYUAN_MODEL = 'tencent/hunyuan-3d-3.1';
const HUNYUAN_OPTS = { face_count: 100000, enable_pbr: true, generate_type: 'Normal' };

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
// useFileOutput:false → run() resolves file outputs to plain URL strings.
const replicate = REPLICATE_TOKEN ? new Replicate({ auth: REPLICATE_TOKEN, useFileOutput: false }) : null;

// In-memory cache of downloaded GLBs so the browser fetches them same-origin
// (no Replicate CORS surprises). Keyed by a generated id.
const modelCache = new Map(); // id -> Buffer

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ── Gemini: prompt (+ optional source image) → image data-URI ──────────────
async function geminiImage({ prompt, sourceImage }) {
  if (!ai) throw new Error('GEMINI_API_KEY not configured');

  const parts = [];
  if (sourceImage) {
    const { mimeType, data } = parseDataUri(sourceImage);
    parts.push({ inlineData: { mimeType, data } });
  }
  // A compact single-hero instruction so Hunyuan gets a clean, depth-readable
  // subject (same intent as the Suzanne single-image reconstruction prompt).
  const guidance = sourceImage
    ? `Edit the attached object render: ${prompt}. Keep the same subject identity, ` +
      `centered on a neutral background, solid opaque 3D form with clear depth. ` +
      `Output ONLY the single edited image.`
    : `A single high-fidelity 3/4 hero render of: ${prompt}. One subject, centered, ` +
      `neutral background, directional studio lighting, solid opaque 3D form with ` +
      `clear depth cues. This will be fed into an image-to-3D reconstructor. ` +
      `Output ONLY one image, no labels or collage.`;
  parts.push({ text: guidance });

  const contents = [{ role: 'user', parts }];

  let lastErr = null;
  for (const model of IMAGE_GEN_MODELS) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents,
        config: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.28 },
      });
      const cand = resp?.candidates?.[0];
      const imgPart = cand?.content?.parts?.find((p) => p.inlineData?.data);
      if (imgPart) {
        const mime = imgPart.inlineData.mimeType || 'image/png';
        return `data:${mime};base64,${imgPart.inlineData.data}`;
      }
      lastErr = new Error(`No image returned by ${model} (finish: ${cand?.finishReason || 'unknown'})`);
    } catch (e) {
      lastErr = e;
      console.warn(`[gemini] ${model} failed:`, e.message);
    }
  }
  throw new Error(`Image generation failed. ${lastErr?.message || ''}`.trim());
}

// ── Replicate: image data-URI → Hunyuan 3.1 GLB url ────────────────────────
async function hunyuanFromImage(imageDataUri) {
  if (!replicate) throw new Error('REPLICATE_API_TOKEN not configured');
  const output = await replicate.run(HUNYUAN_MODEL, {
    input: { image: imageDataUri, ...HUNYUAN_OPTS },
  });
  return extractGlbUrl(output);
}

function extractGlbUrl(output) {
  if (!output) throw new Error('Hunyuan returned no output');
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return extractGlbUrl(output[0]);
  if (typeof output.url === 'function') return output.url();
  if (typeof output.url === 'string') return output.url;
  // object map: prefer a "mesh" key, else first value
  if (output.mesh) return extractGlbUrl(output.mesh);
  const vals = Object.values(output);
  if (vals.length) return extractGlbUrl(vals[0]);
  throw new Error('Could not find GLB url in Hunyuan output');
}

// Download the GLB once and stash it so the browser fetches it from us.
async function cacheGlb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download GLB (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const id = randomUUID();
  modelCache.set(id, buf);
  return `/api/model/${id}.glb`;
}

function parseDataUri(uri) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(uri || '');
  if (!m) throw new Error('Expected a base64 data URI for the source image');
  return { mimeType: m[1], data: m[2] };
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(ai),
    replicate: Boolean(replicate),
    model: HUNYUAN_MODEL,
    opts: HUNYUAN_OPTS,
  });
});

// GENERATE: text → image → Hunyuan 3.1 GLB
app.post('/api/generate', async (req, res) => {
  const prompt = (req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    console.log(`[generate] "${prompt}"`);
    const image = await geminiImage({ prompt });
    const glbUrl = await hunyuanFromImage(image);
    const modelUrl = await cacheGlb(glbUrl);
    res.json({ modelUrl, image, prompt });
  } catch (e) {
    console.error('[generate] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ITERATE: stored image + instruction → new image → Hunyuan 3.1 GLB
app.post('/api/iterate', async (req, res) => {
  const { sourceImage, prompt = '', instruction = '' } = req.body || {};
  if (!sourceImage) return res.status(400).json({ error: 'sourceImage required' });
  if (!instruction.trim()) return res.status(400).json({ error: 'instruction required' });
  try {
    console.log(`[iterate] "${instruction}" (base: "${prompt}")`);
    const effectivePrompt = prompt ? `${prompt}. ${instruction}` : instruction;
    const image = await geminiImage({ prompt: instruction, sourceImage });
    const glbUrl = await hunyuanFromImage(image);
    const modelUrl = await cacheGlb(glbUrl);
    res.json({ modelUrl, image, prompt: effectivePrompt });
  } catch (e) {
    console.error('[iterate] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Split pipeline (fast preview + slow mesh share one image) ──────────────
// STEP 1: text prompt OR (sourceImage + instruction) -> Gemini image.
app.post('/api/image', async (req, res) => {
  const { prompt = '', sourceImage = null, instruction = '' } = req.body || {};
  try {
    if (sourceImage) {
      if (!instruction.trim()) return res.status(400).json({ error: 'instruction required' });
      console.log(`[image:edit] "${instruction}"`);
      const image = await geminiImage({ prompt: instruction, sourceImage });
      const effectivePrompt = prompt ? `${prompt}. ${instruction}` : instruction;
      return res.json({ image, prompt: effectivePrompt });
    }
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt required' });
    console.log(`[image] "${prompt}"`);
    const image = await geminiImage({ prompt });
    res.json({ image, prompt });
  } catch (e) {
    console.error('[image] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// STEP 2: image (data-URI) -> Hunyuan 3.1 GLB.
app.post('/api/model', async (req, res) => {
  const { image, prompt = '' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    console.log('[model] building Hunyuan 3.1 mesh…');
    const glbUrl = await hunyuanFromImage(image);
    const modelUrl = await cacheGlb(glbUrl);
    res.json({ modelUrl, image, prompt });
  } catch (e) {
    console.error('[model] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// LIGHTING: natural-language request + current rig state -> full target rig.
// A thin interpretation layer — Gemini maps intent ("warm sunset", "dim and
// moody") onto the Meshy lighting rig's concrete knobs. Returns the COMPLETE
// resulting state so the client can apply it deterministically.
const LIGHTING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    keyColor: { type: Type.STRING },          // hex, e.g. "#fff4e0"
    keyIntensity: { type: Type.NUMBER },       // 0..5
    fillColor: { type: Type.STRING },
    fillIntensity: { type: Type.NUMBER },      // 0..5
    rimColor: { type: Type.STRING },
    rimIntensity: { type: Type.NUMBER },       // 0..5
    ambientIntensity: { type: Type.NUMBER },   // 0..2
    hemiSky: { type: Type.STRING },
    hemiGround: { type: Type.STRING },
    hemiIntensity: { type: Type.NUMBER },      // 0..2
    environmentIntensity: { type: Type.NUMBER },// 0..3
    exposure: { type: Type.NUMBER },           // 0.1..3
    background: { type: Type.STRING },         // room background hex
    summary: { type: Type.STRING },            // short human label
  },
  required: [
    'keyColor', 'keyIntensity', 'fillColor', 'fillIntensity', 'rimColor',
    'rimIntensity', 'ambientIntensity', 'hemiSky', 'hemiGround', 'hemiIntensity',
    'environmentIntensity', 'exposure', 'background', 'summary',
  ],
};

app.post('/api/lighting', async (req, res) => {
  const prompt = (req.body?.prompt || '').trim();
  const current = req.body?.current || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!ai) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  try {
    console.log(`[lighting] "${prompt}"`);
    const instruction =
      `You control a three.js studio lighting rig. Starting from the CURRENT ` +
      `state below, return the COMPLETE resulting state, changing ONLY what the ` +
      `request implies and leaving everything else equal to the current value.\n\n` +
      `Rig: key (main directional, warm by default), fill (soft secondary), rim ` +
      `(back/edge highlight — the silhouette "shine"), ambient (flat lift), ` +
      `hemisphere (sky/ground gradient fill), environmentIntensity (HDR ` +
      `reflection strength), exposure (overall brightness, tone mapping), ` +
      `background (room color behind everything).\n` +
      `Sane ranges: key/fill/rim 0..5, ambient/hemi 0..2, environmentIntensity ` +
      `0..3, exposure 0.1..3. Colors are hex strings. Warmer = toward orange; ` +
      `cooler = toward blue. "dim/moody" lowers intensities + exposure; ` +
      `"bright/studio" raises them.\n\n` +
      `CURRENT: ${JSON.stringify(current)}\n\nREQUEST: ${prompt}`;
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: instruction,
      config: { responseMimeType: 'application/json', responseSchema: LIGHTING_SCHEMA, temperature: 0.4 },
    });
    const cfg = JSON.parse(resp.text);
    res.json(cfg);
  } catch (e) {
    console.error('[lighting] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Serve cached GLBs same-origin.
app.get('/api/model/:id.glb', (req, res) => {
  const buf = modelCache.get(req.params.id);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`\n  Generation proxy on http://localhost:${PORT}`);
  console.log(`  Gemini:    ${ai ? 'configured' : 'MISSING GEMINI_API_KEY'}`);
  console.log(`  Replicate: ${replicate ? 'configured' : 'MISSING REPLICATE_API_TOKEN'}`);
  console.log(`  Model:     ${HUNYUAN_MODEL}  ${JSON.stringify(HUNYUAN_OPTS)}\n`);
});
