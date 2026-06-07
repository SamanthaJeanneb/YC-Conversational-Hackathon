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
import { AccessToken } from 'livekit-server-sdk';

// Load the existing Suzanne config first, then any local .env on top.
dotenv.config({ path: path.join(os.homedir(), 'Desktop', 'suzanne3d-main', '.env') });
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// suzanne's replicate_service.py reads REPLICATE_API_KEY; .env.example documents
// REPLICATE_API_TOKEN. Accept either.
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
const PORT = process.env.PORT || 8787;

// LiveKit (for minting browser voice tokens). The agent uses the same creds.
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const VOICE_ROOM = process.env.VOICE_ROOM || 'studio';

// Mirror suzanne3d-main/backend/view_generation.py image model preference order.
const IMAGE_GEN_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
];

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// PRIMARY mesh provider: Hunyuan 3.1 on Replicate. Tripo3D (below) is the fallback.
const HUNYUAN_MODEL = 'tencent/hunyuan-3d-3.1';
const HUNYUAN_OPTS = { face_count: 100000, enable_pbr: true, generate_type: 'Normal' };
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

// ── Qwen-Image ─────────────────────────────────────────────────────────────
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

async function qwenImage({ prompt, sourceImage }) {
  if (!QWEN_API_KEY) throw new Error('QWEN_API_KEY not configured');
  throw new Error('Qwen image generation not implemented yet');
}

// MiniMax image edit — image-01 with the source as a subject reference. Returns
// a `data:<mime>;base64,...` string.
async function minimaxEdit({ instruction, sourceImage }) {
  if (!MINIMAX_API_KEY) throw new Error('MINIMAX_API_KEY not configured');
  const resp = await fetch('https://api.minimaxi.chat/v1/image_generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'image-01',
      prompt: instruction,
      subject_reference: [{ type: 'character', image_file: sourceImage }],
      response_format: 'base64',
      n: 1,
    }),
  });
  if (!resp.ok) throw new Error(`MiniMax edit failed (${resp.status})`);
  const j = await resp.json();
  const b64 = j?.data?.image_base64?.[0] || j?.data?.images?.[0];
  if (b64) return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
  const url = j?.data?.image_urls?.[0];
  if (url) {
    const img = await fetch(url);
    const buf = Buffer.from(await img.arrayBuffer());
    return `data:image/png;base64,${buf.toString('base64')}`;
  }
  throw new Error('MiniMax returned no image');
}

async function imageGen({ prompt, sourceImage }) {
  try {
    return await qwenImage({ prompt, sourceImage });
  } catch (qe) {
    try {
      return await geminiImage({ prompt, sourceImage });
    } catch (ge) {
      if (sourceImage && MINIMAX_API_KEY) {
        return await minimaxEdit({ instruction: prompt, sourceImage });
      }
      throw ge;
    }
  }
}

// ── Tripo3D: image data-URI → textured GLB url ─────────────────────────────
// Ported from suzanne3d-main/backend/tripo_client.py. Flow: upload the image →
// create an image_to_model task → poll until success → take the GLB url.
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
const TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi';
const TRIPO_MODEL_VERSION = process.env.TRIPO_MODEL_VERSION || 'v2.5-20250123';
const TRIPO_OPTS = {
  texture_quality: process.env.TRIPO_TEXTURE_QUALITY || 'standard', // standard | detailed
  pbr: true,
  face_limit: Number(process.env.TRIPO_FACE_LIMIT || 20000),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gate our own concurrency so several objects build in PARALLEL but we never
// fire an unbounded burst at Tripo. Extra requests queue and start as slots free.
const MESH_MAX_CONCURRENT = Number(process.env.MESH_MAX_CONCURRENT || process.env.HUNYUAN_MAX_CONCURRENT || 3);
let meshActive = 0;
const meshQueue = [];
function acquireMeshSlot() {
  if (meshActive < MESH_MAX_CONCURRENT) { meshActive++; return Promise.resolve(); }
  return new Promise((resolve) => meshQueue.push(resolve));
}
function releaseMeshSlot() {
  const next = meshQueue.shift();
  if (next) next();          // hand the slot straight to the next waiter
  else meshActive--;         // nobody waiting → free it
}

const tripoHeaders = (extra = {}) => ({ Authorization: `Bearer ${TRIPO_API_KEY}`, ...extra });

// Split a data:image/*;base64 URI into bytes + the file type Tripo expects.
function dataUriToImage(uri) {
  const m = /^data:(image\/(\w+));base64,(.*)$/s.exec(uri || '');
  if (!m) throw new Error('expected a data:image/*;base64 image');
  const sub = m[2].toLowerCase();
  const type = sub === 'jpg' ? 'jpeg' : sub;          // Tripo file.type: "png" | "jpeg"
  return { buffer: Buffer.from(m[3], 'base64'), mime: m[1], type, ext: type === 'jpeg' ? 'jpg' : 'png' };
}

async function tripoUpload(buffer, mime, ext) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `image.${ext}`);
  const resp = await fetch(`${TRIPO_BASE}/upload/sts`, { method: 'POST', headers: tripoHeaders(), body: form });
  if (!resp.ok) throw new Error(`Tripo upload failed (${resp.status})`);
  const token = (await resp.json())?.data?.image_token;
  if (!token) throw new Error('Tripo upload returned no image_token');
  return token;
}

async function tripoCreateTask(imageToken, fileType) {
  const resp = await fetch(`${TRIPO_BASE}/task`, {
    method: 'POST',
    headers: tripoHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type: 'image_to_model',
      file: { type: fileType, file_token: imageToken },
      model_version: TRIPO_MODEL_VERSION,
      ...TRIPO_OPTS,
    }),
  });
  if (!resp.ok) throw new Error(`Tripo task create failed (${resp.status})`);
  const taskId = (await resp.json())?.data?.task_id;
  if (!taskId) throw new Error('Tripo task create returned no task_id');
  return taskId;
}

async function tripoPoll(taskId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let transient = 0;
  while (Date.now() < deadline) {
    const resp = await fetch(`${TRIPO_BASE}/task/${taskId}`, { headers: tripoHeaders() });
    if (!resp.ok) {
      if ([500, 502, 503, 504].includes(resp.status) && transient++ < 8) { await sleep(Math.min(2000 * transient, 10000)); continue; }
      throw new Error(`Tripo poll failed (${resp.status})`);
    }
    transient = 0;
    const data = (await resp.json())?.data || {};
    if (data.status === 'success') return data.output || {};
    if (['failed', 'cancelled', 'banned', 'expired'].includes(data.status)) throw new Error(`Tripo generation ${data.status}`);
    await sleep(2000); // queued / running
  }
  throw new Error('Tripo generation timed out');
}

async function tripoFromImage(imageDataUri) {
  if (!TRIPO_API_KEY) throw new Error('TRIPO_API_KEY not configured');
  const { buffer, mime, type, ext } = dataUriToImage(imageDataUri);
  const token = await tripoUpload(buffer, mime, ext);
  const taskId = await tripoCreateTask(token, type);
  const output = await tripoPoll(taskId);
  const url = output.pbr_model || output.model || output.base_model;
  if (!url) throw new Error('Tripo returned no model URL');
  return url;
}

// ── Hunyuan 3.1 (Replicate) — primary mesh provider ────────────────────────
async function hunyuanFromImage(imageDataUri) {
  if (!replicate) throw new Error('REPLICATE_API_TOKEN not configured');
  const output = await replicate.run(HUNYUAN_MODEL, { input: { image: imageDataUri, ...HUNYUAN_OPTS } });
  return extractGlbUrl(output);
}

function extractGlbUrl(output) {
  if (!output) throw new Error('Hunyuan returned no output');
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return extractGlbUrl(output[0]);
  if (typeof output.url === 'function') return output.url();
  if (typeof output.url === 'string') return output.url;
  if (output.mesh) return extractGlbUrl(output.mesh);
  const vals = Object.values(output);
  if (vals.length) return extractGlbUrl(vals[0]);
  throw new Error('Could not find GLB url in Hunyuan output');
}

// ── Orchestrator: Hunyuan first, Tripo3D as fallback ───────────────────────
// Concurrency-gated so several objects build in parallel without bursting either
// provider. Try Hunyuan; if it fails for ANY reason (JobNumExceed,
// ResourceInsufficient, timeout, anything) and Tripo is configured, build with
// Tripo instead — so generation keeps working through Hunyuan's capacity blips.
async function meshFromImage(imageDataUri) {
  await acquireMeshSlot();
  try {
    if (!replicate) return await tripoFromImage(imageDataUri); // no Hunyuan → straight to Tripo
    try {
      return await hunyuanFromImage(imageDataUri);
    } catch (e) {
      if (!TRIPO_API_KEY) throw e;
      console.warn(`[mesh] Hunyuan failed (${e.message?.slice(0, 100)}) — falling back to Tripo3D`);
      return await tripoFromImage(imageDataUri);
    }
  } finally {
    releaseMeshSlot();
  }
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
    tripo: Boolean(TRIPO_API_KEY),
    livekit: Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    model: `${HUNYUAN_MODEL} (fallback: tripo3d ${TRIPO_MODEL_VERSION})`,
    opts: { hunyuan: HUNYUAN_OPTS, tripo: TRIPO_OPTS },
  });
});

// Mint a short-lived browser token to join the voice room. The agent worker
// auto-joins the same room (no agent_name => automatic dispatch).
app.get('/api/voice-token', async (req, res) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit not configured (LIVEKIT_URL/API_KEY/API_SECRET)' });
  }
  try {
    const room = (req.query.room || VOICE_ROOM).toString();
    const identity = (req.query.identity || `user-${Date.now().toString(36)}`).toString();
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '1h' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    res.json({ url: LIVEKIT_URL, token, room, identity });
  } catch (e) {
    console.error('[voice-token] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GENERATE: text → image → Hunyuan 3.1 GLB
app.post('/api/generate', async (req, res) => {
  const prompt = (req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    console.log(`[generate] "${prompt}"`);
    const image = await geminiImage({ prompt });
    const glbUrl = await meshFromImage(image);
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
    const glbUrl = await meshFromImage(image);
    const modelUrl = await cacheGlb(glbUrl);
    res.json({ modelUrl, image, prompt: effectivePrompt });
  } catch (e) {
    console.error('[iterate] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Split pipeline (fast preview + slow mesh share one image) ──────────────
// STEP 1: text prompt OR (sourceImage + instruction) -> Gemini image.
// Estimate an object's real-world size — the length of its LONGEST dimension in
// meters — so the scene can size each thing sensibly (a mug ~0.12m, a dining
// table ~1.6m) instead of forcing everything to one target. Clamped to a sane
// range; returns null on failure so the client falls back to its default.
const SIZE_SCHEMA = {
  type: Type.OBJECT,
  properties: { meters: { type: Type.NUMBER } },
  required: ['meters'],
};
async function estimateSizeMeters(prompt) {
  if (!ai) return null;
  try {
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents:
        `Estimate the typical real-world size of this object as the length of its ` +
        `LONGEST dimension, in meters. Reply as JSON {"meters": number}. Examples: ` +
        `coffee mug 0.12, wine bottle 0.3, book 0.25, potted plant 0.4, desk lamp ` +
        `0.5, dining chair 0.9, dining table 1.6, sofa 2.0, car 4.5.\n\nOBJECT: ${prompt}`,
      config: { responseMimeType: 'application/json', responseSchema: SIZE_SCHEMA, temperature: 0 },
    });
    const { meters } = JSON.parse(resp.text);
    if (!Number.isFinite(meters)) return null;
    return Math.min(20, Math.max(0.03, meters));
  } catch (e) {
    console.warn('[size] estimate failed:', e.message);
    return null;
  }
}

app.post('/api/image', async (req, res) => {
  const { prompt = '', sourceImage = null, instruction = '' } = req.body || {};
  try {
    if (sourceImage) {
      if (!instruction.trim()) return res.status(400).json({ error: 'instruction required' });
      console.log(`[image:edit] "${instruction}"`);
      const image = await imageGen({ prompt: instruction, sourceImage });
      const effectivePrompt = prompt ? `${prompt}. ${instruction}` : instruction;
      return res.json({ image, prompt: effectivePrompt });
    }
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt required' });
    console.log(`[image] "${prompt}"`);
    const image = await imageGen({ prompt });
    res.json({ image, prompt });
  } catch (e) {
    console.error('[image] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// SIZE: prompt -> estimated real-world longest-axis size (meters). Its own
// endpoint so the client can fire it at the start of a generate, in parallel
// with the slow image+mesh build — it resolves long before the mesh is ready.
app.post('/api/size', async (req, res) => {
  const prompt = (req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const sizeMeters = await estimateSizeMeters(prompt);
  res.json({ sizeMeters });
});

// STEP 2: image (data-URI) -> Hunyuan 3.1 GLB.
app.post('/api/model', async (req, res) => {
  const { image, prompt = '' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image required' });
  try {
    console.log('[model] building Hunyuan 3.1 mesh…');
    const glbUrl = await meshFromImage(image);
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
      `state below, return the COMPLETE resulting state. Keep values the request ` +
      `doesn't touch, but make whatever you DO change clearly visible.\n\n` +
      `Rig: key (main directional, warm by default), fill (soft secondary), rim ` +
      `(back/edge highlight — the silhouette "shine"), ambient (flat lift), ` +
      `hemisphere (sky/ground gradient fill), environmentIntensity (HDR ` +
      `reflection strength), exposure (overall brightness, tone mapping), ` +
      `background (room color behind everything).\n` +
      `Sane ranges: key/fill/rim 0..5, ambient/hemi 0..2, environmentIntensity ` +
      `0..3, exposure 0.1..3. Colors are hex strings. Warmer = toward orange; ` +
      `cooler = toward blue. "dim/moody" lowers intensities + exposure; ` +
      `"bright/studio" raises them.\n` +
      `IMPORTANT — the scene is dominated by a NEUTRAL HDR environment and a white ` +
      `rim light, so timid color changes get washed out and look like nothing ` +
      `happened. When the request names a COLOR or a strong mood, COMMIT to it: ` +
      `tint key, fill, ambient AND hemisphere-sky toward that color, set background ` +
      `to a deep shade of it, drop environmentIntensity to ~0.1-0.2 so the neutral ` +
      `HDR stops diluting the tint, and keep the tinted key in the upper range ` +
      `(~1.5-2.5) so it reads. Only make small adjustments for explicitly subtle ` +
      `requests ("a touch warmer", "slightly dimmer").\n\n` +
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
  console.log(`  Hunyuan:   ${replicate ? 'configured (primary)' : 'MISSING REPLICATE_API_TOKEN'}`);
  console.log(`  Tripo3D:   ${TRIPO_API_KEY ? 'configured (fallback)' : 'MISSING TRIPO_API_KEY (no fallback)'}`);
  const lkOk = LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET;
  console.log(`  LiveKit:   ${lkOk ? 'configured' : 'MISSING LIVEKIT_URL/API_KEY/API_SECRET (voice off)'}`);
  console.log(`  Model:     ${HUNYUAN_MODEL} → tripo3d ${TRIPO_MODEL_VERSION} fallback\n`);
});
