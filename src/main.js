import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { installMeshyLighting } from './lighting.js';
import { generateImage, iterateImage, imageToModel, setLighting } from './pipeline.js';
import * as store from './store.js';
import { createVoice } from './voice.js';

// ─────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────
const EYE_HEIGHT = 1.6;        // human eye height (units = meters)
const MOVE_SPEED = 4.0;        // m/s
const ROOM = { size: 24, height: 4.2 };
const HALF = ROOM.size / 2;
const WALL_PAD = 0.7;          // keep the camera off the walls
const MODEL_TARGET_SIZE = 1.4; // longest-axis size for loaded GLBs (meters)
const REACH = 12;              // max crosshair interaction distance (meters)

// ─────────────────────────────────────────────────────────────────────────
//  Renderer / scene / camera  (renderer setup matches Suzanne's look)
// ─────────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1f);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, EYE_HEIGHT, 6);

const lights = installMeshyLighting(scene, renderer, { castShadows: true });

// ─────────────────────────────────────────────────────────────────────────
//  Room  (basic box: floor, ceiling, 4 walls)
// ─────────────────────────────────────────────────────────────────────────
const collidables = [];   // surfaces the crosshair can place objects on
const selectables = [];   // generated model roots the crosshair can select

function buildRoom() {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.92, metalness: 0.0 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x26282d, roughness: 0.85, metalness: 0.05 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x303338, roughness: 0.95, metalness: 0.0 });

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, ROOM.size), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.userData.surface = 'floor';
  scene.add(floor);
  collidables.push(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, ROOM.size), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = ROOM.height;
  ceil.receiveShadow = true;
  scene.add(ceil);

  // 4 walls (inward-facing planes)
  const wallDefs = [
    { pos: [0, ROOM.height / 2, -HALF], rot: [0, 0, 0] },              // north
    { pos: [0, ROOM.height / 2, HALF], rot: [0, Math.PI, 0] },         // south
    { pos: [-HALF, ROOM.height / 2, 0], rot: [0, Math.PI / 2, 0] },    // west
    { pos: [HALF, ROOM.height / 2, 0], rot: [0, -Math.PI / 2, 0] },    // east
  ];
  for (const def of wallDefs) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.size, ROOM.height), wallMat);
    wall.position.set(...def.pos);
    wall.rotation.set(...def.rot);
    wall.receiveShadow = true;
    wall.userData.surface = 'wall';
    scene.add(wall);
    collidables.push(wall);
  }

  // Faint floor grid for spatial reference
  const grid = new THREE.GridHelper(ROOM.size, ROOM.size, 0x4a4d55, 0x34363c);
  grid.position.y = 0.002;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);
}
buildRoom();

// ─────────────────────────────────────────────────────────────────────────
//  First-person controls
// ─────────────────────────────────────────────────────────────────────────
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject ? controls.getObject() : camera); // r181: controls.object === camera

const lockHint = document.getElementById('lock-hint');
const crosshair = document.getElementById('crosshair');

const keys = { forward: false, back: false, left: false, right: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// menuOpen suppresses re-locking while a panel is open so the user can type.
let menuOpen = false;

controls.addEventListener('lock', () => {
  lockHint.classList.add('hidden');
  crosshair.classList.add('active');
});
controls.addEventListener('unlock', () => {
  crosshair.classList.remove('active');
  // Esc / programmatic unlock: only show the click-to-enter hint if no panel
  // is driving the unlock (panels need the cursor free for typing).
  if (!menuOpen) lockHint.classList.remove('hidden');
  // Esc while carrying → cancel the move, snapping the object back.
  if (grabbedId && !menuOpen) cancelGrab();
  // Released → drop movement so we don't keep gliding.
  keys.forward = keys.back = keys.left = keys.right = false;
});

lockHint.addEventListener('click', () => {
  if (!menuOpen) controls.lock();
});

window.addEventListener('keydown', (e) => {
  if (menuOpen) return; // let the panel inputs handle typing
  if (e.code === 'KeyL') { openLightingPanel(); return; }
  if (e.code === 'KeyG') { toggleGrab(); return; }
  if (e.code === 'KeyV') { voiceEl.click(); return; }
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.forward = true; break;
    case 'KeyS': case 'ArrowDown': keys.back = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.forward = false; break;
    case 'KeyS': case 'ArrowDown': keys.back = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
  }
});

// ─────────────────────────────────────────────────────────────────────────
//  Crosshair raycasting (forward from screen center each frame)
// ─────────────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
let hoverObjectId = null;   // object under the crosshair, or null
let hoverPoint = null;      // world point under the crosshair (surface/object)
let groundHoverPoint = null;// world point on a room surface only (for placement)

function updateCrosshair() {
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = REACH;

  // While carrying, ignore object hover (don't pick up / re-target self).
  const objHits = grabbedId ? [] : raycaster.intersectObjects(selectables, true);
  const surfHits = raycaster.intersectObjects(collidables, true);

  const firstObj = objHits[0];
  const firstSurf = surfHits[0];

  hoverObjectId = null;
  hoverPoint = null;
  groundHoverPoint = firstSurf ? firstSurf.point.clone() : null;

  // Whichever is closer wins for the displayed crosshair state / hover point.
  if (firstObj && (!firstSurf || firstObj.distance <= firstSurf.distance)) {
    hoverObjectId = rootIdOf(firstObj.object);
    hoverPoint = firstObj.point.clone();
    crosshair.classList.add('on-object');
  } else {
    if (firstSurf) hoverPoint = firstSurf.point.clone();
    crosshair.classList.remove('on-object');
  }
}

// Walk up the parent chain to find the selectable root's stored id.
function rootIdOf(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData && cur.userData.objectId) return cur.userData.objectId;
    cur = cur.parent;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
//  Selection highlight
// ─────────────────────────────────────────────────────────────────────────
let selectedId = null;

function setSelected(id) {
  if (selectedId && store.get(selectedId)) applyHighlight(store.get(selectedId).root, false);
  selectedId = id;
  if (id && store.get(id)) applyHighlight(store.get(id).root, true);
}

function applyHighlight(root, on) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (on) {
        if (m.userData._emisStashed === undefined) {
          m.userData._emisStashed = m.emissive ? m.emissive.getHex() : 0x000000;
        }
        if (m.emissive) m.emissive.setHex(0x16407a);
      } else if (m.userData._emisStashed !== undefined) {
        if (m.emissive) m.emissive.setHex(m.userData._emisStashed);
        delete m.userData._emisStashed;
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Grab-to-move (carry the object on the crosshair, then click to place)
// ─────────────────────────────────────────────────────────────────────────
let grabbedId = null;
let grabOriginal = null; // original position, for Esc-cancel

function toggleGrab() {
  if (grabbedId) { dropGrab(true); return; }
  const id = hoverObjectId || selectedId;
  if (!id || !store.get(id)) return;
  grabbedId = id;
  setSelected(id);
  grabOriginal = store.get(id).root.position.clone();
  crosshair.classList.add('carrying');
  toast('Carrying — move with the mouse, click to place, Esc to cancel', false, 2800);
}

// Each frame while carrying: seat the object's base on the surface under the crosshair.
function grabUpdate() {
  const entry = store.get(grabbedId);
  if (!entry) { grabbedId = null; return; }
  const p = (groundHoverPoint ? groundHoverPoint.clone() : groundPointAhead());
  clampToRoom(p);
  const root = entry.root;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const c = new THREE.Vector3(); box.getCenter(c);
  root.position.x += p.x - c.x;
  root.position.z += p.z - c.z;
  root.position.y += p.y - box.min.y;
}

function dropGrab(commit) {
  const entry = store.get(grabbedId);
  if (entry) {
    if (commit) {
      entry.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(entry.root);
      const c = new THREE.Vector3(); box.getCenter(c);
      entry.placement.position.set(c.x, box.min.y, c.z); // so iterate swaps in place
      toast('Object placed', false, 1400);
    } else if (grabOriginal) {
      entry.root.position.copy(grabOriginal);
    }
  }
  grabbedId = null;
  grabOriginal = null;
  crosshair.classList.remove('carrying');
}

function cancelGrab() { if (grabbedId) dropGrab(false); }

// ─────────────────────────────────────────────────────────────────────────
//  Mouse: left = select+iterate (or place when carrying), right = generate menu
// ─────────────────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked || menuOpen) return;

  if (e.button === 0) {
    // Left-click: place the carried object, else select the one under the crosshair.
    if (grabbedId) { dropGrab(true); return; }
    if (hoverObjectId) {
      setSelected(hoverObjectId);
      openIteratePanel(hoverObjectId);
    }
  } else if (e.button === 2) {
    // Right-click: cancel a carry, else open Generate menu at the crosshair.
    if (grabbedId) { cancelGrab(); return; }
    const point = hoverPoint ? hoverPoint.clone() : groundPointAhead();
    openGeneratePanel(point);
  }
});
// Suppress the browser context menu so right-click is ours.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Fallback placement: a point on the floor ~3m ahead if nothing was hit.
function groundPointAhead() {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const p = camera.position.clone().add(fwd.multiplyScalar(3));
  p.y = 0;
  return clampToRoom(p);
}

function clampToRoom(p) {
  p.x = Math.max(-HALF + WALL_PAD, Math.min(HALF - WALL_PAD, p.x));
  p.z = Math.max(-HALF + WALL_PAD, Math.min(HALF - WALL_PAD, p.z));
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
//  Panels (release pointer lock while open so the user can type)
// ─────────────────────────────────────────────────────────────────────────
const genPanel = document.getElementById('generate-panel');
const genInput = document.getElementById('generate-input');
const genGo = document.getElementById('generate-go');
const genCancel = document.getElementById('generate-cancel');

const itPanel = document.getElementById('iterate-panel');
const itInput = document.getElementById('iterate-input');
const itThumb = document.getElementById('iterate-thumb');
const itCtx = document.getElementById('iterate-ctx');
const itGo = document.getElementById('iterate-go');
const itCancel = document.getElementById('iterate-cancel');

const lightPanel = document.getElementById('lighting-panel');
const lightInput = document.getElementById('lighting-input');
const lightGo = document.getElementById('lighting-go');
const lightCancel = document.getElementById('lighting-cancel');

let pendingPlacement = null; // world point captured at right-click time

function openPanel(panel, input) {
  menuOpen = true;
  if (controls.isLocked) controls.unlock();
  lockHint.classList.add('hidden');
  panel.classList.remove('hidden');
  setTimeout(() => input && input.focus(), 0);
}

function closePanels(relock = true) {
  genPanel.classList.add('hidden');
  itPanel.classList.add('hidden');
  lightPanel.classList.add('hidden');
  menuOpen = false;
  if (relock) controls.lock();
  else lockHint.classList.remove('hidden');
}

function openGeneratePanel(point) {
  pendingPlacement = point;
  genInput.value = '';
  openPanel(genPanel, genInput);
}

function openIteratePanel(id) {
  const entry = store.get(id);
  if (!entry) return;
  itInput.value = '';
  itThumb.src = entry.sourceImage || '';
  itThumb.style.display = entry.sourceImage ? 'block' : 'none';
  itCtx.textContent = entry.prompt ? `“${entry.prompt}”` : 'Generated object';
  openPanel(itPanel, itInput);
}

function openLightingPanel() {
  lightInput.value = '';
  openPanel(lightPanel, lightInput);
}

genCancel.addEventListener('click', () => closePanels(true));
itCancel.addEventListener('click', () => { setSelected(null); closePanels(true); });
lightCancel.addEventListener('click', () => closePanels(true));

genGo.addEventListener('click', runGenerate);
itGo.addEventListener('click', runIterate);
lightGo.addEventListener('click', runLighting);

// Submit on Enter (Shift+Enter = newline); Esc closes a panel.
for (const [input, run] of [[genInput, runGenerate], [itInput, runIterate], [lightInput, runLighting]]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
    else if (e.key === 'Escape') { e.preventDefault(); setSelected(null); closePanels(true); }
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Generate / iterate flows
// ─────────────────────────────────────────────────────────────────────────
function runGenerate() {
  const prompt = genInput.value.trim();
  if (!prompt) { genInput.focus(); return; }
  const placement = pendingPlacement ? pendingPlacement.clone() : groundPointAhead();
  closePanels(true);
  generateAt(prompt, placement);
}

// Core generate flow, callable from the UI or the voice layer.
async function generateAt(prompt, placement) {
  // Instant wireframe box, then swap to the image billboard once it arrives.
  let ph = addBoxPlaceholder(placement);
  toast(`Imagining “${prompt}”…`, true);
  try {
    const img = await generateImage({ prompt });
    removePlaceholder(ph);
    ph = addOutlineBillboard(placement, img.image); // fast shape preview (outline only)

    toast('Building 3D model…', true);
    const result = await imageToModel({ image: img.image, prompt: img.prompt || prompt });
    const id = store.nextId();
    const root = await loadModelAt(result.modelUrl, placement);
    removePlaceholder(ph); ph = null; // remove only after the mesh is in place
    root.userData.objectId = id;
    selectables.push(root);
    store.put(id, {
      root,
      sourceImage: result.image,
      prompt: result.prompt || prompt,
      placement: { position: placement.clone(), scale: root.userData._fitScale || 1 },
      history: [{ instruction: '(generate)', prompt: result.prompt || prompt, image: result.image }],
    });
    toast('Object created', false, 1800);
  } catch (err) {
    removePlaceholder(ph);
    console.error(err);
    toast(`Generate failed: ${err.message}`, false, 4500);
  }
}

function runIterate() {
  if (!selectedId) return;
  const entry = store.get(selectedId);
  const instruction = itInput.value.trim();
  if (!entry || !instruction) { itInput.focus(); return; }
  const id = selectedId;
  closePanels(true);
  iterateOn(id, instruction);
}

// Core iterate flow, callable from the UI or the voice layer.
async function iterateOn(id, instruction) {
  const entry = store.get(id);
  if (!entry || !instruction) return;
  const placement = entry.placement.position.clone();
  let ph = null;
  toast(`Re-imagining: “${instruction}”…`, true);
  try {
    const img = await iterateImage({
      sourceImage: entry.sourceImage,
      prompt: entry.prompt,
      instruction,
    });
    ph = addOutlineBillboard(placement, img.image); // fast shape preview of the change (outline only)

    toast('Building 3D model…', true);
    const result = await imageToModel({ image: img.image, prompt: img.prompt || instruction });
    // Swap the model in place — keep the same world position.
    const newRoot = await loadModelAt(result.modelUrl, placement);
    newRoot.userData.objectId = id;
    removePlaceholder(ph); ph = null;

    // Remove the old root from scene + selectables.
    scene.remove(entry.root);
    disposeObject(entry.root);
    const idx = selectables.indexOf(entry.root);
    if (idx >= 0) selectables.splice(idx, 1);
    selectables.push(newRoot);

    store.update(id, {
      root: newRoot,
      sourceImage: result.image,         // updated context
      prompt: result.prompt || instruction,
      history: [...entry.history, { instruction, prompt: result.prompt || instruction, image: result.image }],
    });
    if (selectedId === id) { selectedId = null; setSelected(id); } // re-apply highlight
    toast('Object updated', false, 1800);
  } catch (err) {
    removePlaceholder(ph);
    console.error(err);
    toast(`Iterate failed: ${err.message}`, false, 4500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Lighting layer (natural-language → live scene lighting)
// ─────────────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Snapshot the current rig so relative requests ("warmer", "a bit dimmer") work.
function currentLighting() {
  return {
    keyColor: '#' + lights.keyLight.color.getHexString(),
    keyIntensity: lights.keyLight.intensity,
    fillColor: '#' + lights.fillLight.color.getHexString(),
    fillIntensity: lights.fillLight.intensity,
    rimColor: '#' + lights.rimLight.color.getHexString(),
    rimIntensity: lights.rimLight.intensity,
    ambientIntensity: lights.ambientLight.intensity,
    hemiSky: '#' + lights.hemisphereLight.color.getHexString(),
    hemiGround: '#' + lights.hemisphereLight.groundColor.getHexString(),
    hemiIntensity: lights.hemisphereLight.intensity,
    environmentIntensity: scene.environmentIntensity,
    exposure: renderer.toneMappingExposure,
    background: '#' + scene.background.getHexString(),
  };
}

// Apply a full (or partial) rig config to the live scene, clamped to sane ranges.
function applyLighting(cfg) {
  const setColor = (target, hex) => { if (typeof hex === 'string') target.set(hex); };
  setColor(lights.keyLight.color, cfg.keyColor);
  setColor(lights.fillLight.color, cfg.fillColor);
  setColor(lights.rimLight.color, cfg.rimColor);
  setColor(lights.hemisphereLight.color, cfg.hemiSky);
  setColor(lights.hemisphereLight.groundColor, cfg.hemiGround);
  setColor(scene.background, cfg.background);
  if (Number.isFinite(cfg.keyIntensity)) lights.keyLight.intensity = clamp(cfg.keyIntensity, 0, 5);
  if (Number.isFinite(cfg.fillIntensity)) lights.fillLight.intensity = clamp(cfg.fillIntensity, 0, 5);
  if (Number.isFinite(cfg.rimIntensity)) lights.rimLight.intensity = clamp(cfg.rimIntensity, 0, 5);
  if (Number.isFinite(cfg.ambientIntensity)) lights.ambientLight.intensity = clamp(cfg.ambientIntensity, 0, 2);
  if (Number.isFinite(cfg.hemiIntensity)) lights.hemisphereLight.intensity = clamp(cfg.hemiIntensity, 0, 2);
  if (Number.isFinite(cfg.environmentIntensity)) scene.environmentIntensity = clamp(cfg.environmentIntensity, 0, 3);
  if (Number.isFinite(cfg.exposure)) renderer.toneMappingExposure = clamp(cfg.exposure, 0.1, 3);
}

function runLighting() {
  const prompt = lightInput.value.trim();
  if (!prompt) { lightInput.focus(); return; }
  closePanels(true);
  applyLightingPrompt(prompt);
}

// Core lighting flow, callable from the UI or the voice layer.
async function applyLightingPrompt(prompt) {
  toast(`Lighting: “${prompt}”…`, true);
  try {
    const cfg = await setLighting({ prompt, current: currentLighting() });
    applyLighting(cfg);
    toast(cfg.summary ? `Lighting: ${cfg.summary}` : 'Lighting updated', false, 2200);
  } catch (err) {
    console.error(err);
    toast(`Lighting failed: ${err.message}`, false, 4500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Model loading / placement
// ─────────────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();

function loadModelAt(url, point) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!root) return reject(new Error('GLB had no scene'));

        // Normalize to a sensible size and seat the base on the surface.
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const maxAxis = Math.max(size.x, size.y, size.z) || 1;
        const fit = MODEL_TARGET_SIZE / maxAxis;
        root.scale.setScalar(fit);
        root.userData._fitScale = fit;

        // After scaling, recompute so we can sit it on the hit point.
        root.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(root);
        const c2 = new THREE.Vector3(); box2.getCenter(c2);
        root.position.x += point.x - c2.x;
        root.position.z += point.z - c2.z;
        root.position.y += point.y - box2.min.y; // base on surface

        root.traverse((o) => {
          if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        });

        scene.add(root);
        resolve(root);
      },
      undefined,
      (err) => reject(new Error('Failed to load model')),
    );
  });
}

// Placeholders pulse while their object generates.
const loadingPlaceholders = new Set();

// Stage 1 (instant): a soft wireframe cube where the object will appear, shown
// for the few seconds before the preview image arrives.
function addBoxPlaceholder(point) {
  const g = new THREE.BoxGeometry(MODEL_TARGET_SIZE, MODEL_TARGET_SIZE, MODEL_TARGET_SIZE);
  const m = new THREE.MeshStandardMaterial({
    color: 0x6ea8ff, transparent: true, opacity: 0.18, roughness: 0.4,
    emissive: 0x16407a, emissiveIntensity: 0.6, wireframe: true,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(point.x, point.y + MODEL_TARGET_SIZE / 2, point.z);
  mesh.userData._placeholder = true;
  scene.add(mesh);
  return mesh;
}

// Trace the object's outline from the preview image: silhouette boundary
// (foreground-vs-background) + internal edges (Sobel), drawn in accent blue on
// a transparent canvas — a wireframe-style line sketch of the shape, not the
// full picture. Returns { canvas, aspect }.
const OUTLINE_RGB = [110, 168, 255]; // #6ea8ff, matches the box placeholder
function buildOutlineTexture(dataURI) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 320; // downscale for speed; lines stay crisp on a sprite
        const s = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));

        const src = document.createElement('canvas');
        src.width = w; src.height = h;
        const sctx = src.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(img, 0, 0, w, h);
        const d = sctx.getImageData(0, 0, w, h).data;

        // Background colour estimated from the four corners.
        const gray = new Float32Array(w * h);
        const fg = new Uint8Array(w * h);
        const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
        let br = 0, bg = 0, bb = 0;
        for (const [cx, cy] of corners) { const i = (cy * w + cx) * 4; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; }
        br /= 4; bg /= 4; bb /= 4;
        for (let p = 0; p < w * h; p++) {
          const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          gray[p] = 0.299 * r + 0.587 * g + 0.114 * b;
          fg[p] = (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb)) > 60 ? 1 : 0;
        }

        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const octx = out.getContext('2d');
        const o = octx.createImageData(w, h);
        const GX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const GY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
        const INTERNAL = 70; // Sobel threshold for interior detail lines
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            let sx = 0, sy = 0, k = 0;
            for (let j = -1; j <= 1; j++) for (let i2 = -1; i2 <= 1; i2++) {
              const v = gray[(y + j) * w + (x + i2)]; sx += v * GX[k]; sy += v * GY[k]; k++;
            }
            const mag = Math.hypot(sx, sy);
            // Silhouette: a foreground pixel touching the background.
            const sil = fg[p] && (!fg[p - 1] || !fg[p + 1] || !fg[p - w] || !fg[p + w]);
            let a = 0;
            if (sil) a = 255;
            else if (fg[p] && mag > INTERNAL) a = Math.min(255, (mag - INTERNAL) * 2.2);
            const oi = p * 4;
            o.data[oi] = OUTLINE_RGB[0]; o.data[oi + 1] = OUTLINE_RGB[1];
            o.data[oi + 2] = OUTLINE_RGB[2]; o.data[oi + 3] = a;
          }
        }
        octx.putImageData(o, 0, 0);
        resolve({ canvas: out, aspect: w / h });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('outline image load failed'));
    img.src = dataURI;
  });
}

// Stage 2 (fast, ~seconds): the traced outline as a camera-facing billboard —
// just the shape's lines, standing in until the GLB is ready.
function addOutlineBillboard(point, dataURI) {
  const mat = new THREE.SpriteMaterial({ transparent: true, opacity: 0.95, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const base = MODEL_TARGET_SIZE * 1.25;
  sprite.scale.set(base, base, 1);
  sprite.position.set(point.x, point.y + base / 2, point.z);
  sprite.userData._placeholder = true;
  scene.add(sprite);
  loadingPlaceholders.add(sprite);

  buildOutlineTexture(dataURI).then(({ canvas, aspect }) => {
    if (!loadingPlaceholders.has(sprite)) return; // already removed
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex;
    mat.needsUpdate = true;
    const wsc = base * aspect;
    sprite.scale.set(wsc, base, 1);
    sprite.position.y = point.y + base / 2;
  }).catch((err) => console.warn('[outline]', err.message));

  return sprite;
}

function removePlaceholder(obj) {
  if (!obj) return;
  scene.remove(obj);
  loadingPlaceholders.delete(obj);
  if (obj.isSprite) {
    obj.material.map?.dispose?.();
    obj.material.dispose();
  } else {
    disposeObject(obj);
  }
}

function disposeObject(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m?.dispose());
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Toast / status
// ─────────────────────────────────────────────────────────────────────────
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, spinning = false, autohide = 0) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = spinning ? `<span class="spinner"></span><span>${msg}</span>` : `<span>${msg}</span>`;
  toastEl.classList.add('show');
  if (autohide) toastTimer = setTimeout(() => toastEl.classList.remove('show'), autohide);
}

// ─────────────────────────────────────────────────────────────────────────
//  Animation loop  (grounded movement relative to facing direction)
// ─────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (controls.isLocked) {
    // Damp previous velocity, then accelerate along input direction.
    velocity.x -= velocity.x * 10 * dt;
    velocity.z -= velocity.z * 10 * dt;

    direction.z = Number(keys.forward) - Number(keys.back);
    direction.x = Number(keys.right) - Number(keys.left);
    direction.normalize();

    if (keys.forward || keys.back) velocity.z -= direction.z * MOVE_SPEED * 10 * dt;
    if (keys.left || keys.right) velocity.x -= direction.x * MOVE_SPEED * 10 * dt;

    controls.moveRight(-velocity.x * dt);
    controls.moveForward(-velocity.z * dt);

    // Stay grounded + inside the room.
    camera.position.y = EYE_HEIGHT;
    clampToRoom(camera.position);

    updateCrosshair();
    if (grabbedId) grabUpdate();
  }

  // Pulse loading billboards so they read as "generating," not placed.
  if (loadingPlaceholders.size) {
    const pulse = 0.78 + 0.18 * Math.sin(clock.elapsedTime * 4);
    loadingPlaceholders.forEach((s) => { if (s.material) s.material.opacity = pulse; });
  }

  renderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────────────────────────────────────────
//  Resize
// ─────────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────────────────────────────────────────
//  Voice layer (LiveKit) — the agent only triggers the functions above
// ─────────────────────────────────────────────────────────────────────────
const voiceEl = document.getElementById('voice');
const voiceOnOff = document.getElementById('voice-onoff');
const voiceState = document.getElementById('voice-state');

// Map an inbound agent command onto the existing scene functions.
function handleVoiceCommand(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'generate':
      generateAt(msg.prompt || 'an object', groundPointAhead()); // placed in front of the player
      break;
    case 'iterate': {
      const id = selectedId || hoverObjectId;
      if (!id) { toast('Look at or select an object first', false, 2600); break; }
      setSelected(id);
      iterateOn(id, msg.instruction || '');
      break;
    }
    case 'lighting':
      applyLightingPrompt(msg.description || '');
      break;
    case 'queue_world': // STUB — wire worldgen later
      toast(`(stub) queue world: “${msg.prompt || ''}”`, false, 2600);
      break;
    case 'retrieve':    // STUB — wire Moss retrieval later
      toast(`(stub) retrieve: “${msg.query || ''}”`, false, 2600);
      break;
    default:
      console.warn('[voice] unknown command', msg);
  }
}

const voice = createVoice({
  onCommand: handleVoiceCommand,
  onState: (s) => {
    if ('connected' in s) {
      voiceEl.classList.toggle('on', s.connected);
      voiceOnOff.textContent = s.connected ? 'on' : 'off';
    }
    if ('agentSpeaking' in s) voiceEl.classList.toggle('agent-speaking', !!s.agentSpeaking);
    if ('userSpeaking' in s) voiceEl.classList.toggle('user-speaking', !!s.userSpeaking);
    if (!voice || !voice.isConnected()) voiceState.textContent = '';
    else if (s.agentSpeaking) voiceState.textContent = 'speaking';
    else if (s.userSpeaking) voiceState.textContent = 'hearing you';
    else voiceState.textContent = 'listening';
  },
});

voiceEl.addEventListener('click', async () => {
  if (!voice.isConnected()) voiceState.textContent = 'connecting…';
  try {
    await voice.toggle();
  } catch (err) {
    console.error(err);
    toast(`Voice: ${err.message}`, false, 4500);
    voiceState.textContent = '';
  }
});
