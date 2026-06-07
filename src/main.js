import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { installMeshyLighting } from './lighting.js';
import { generateImage, iterateImage, imageToModel, setLighting } from './pipeline.js';
import * as store from './store.js';

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
  // Released → drop movement so we don't keep gliding.
  keys.forward = keys.back = keys.left = keys.right = false;
});

lockHint.addEventListener('click', () => {
  if (!menuOpen) controls.lock();
});

window.addEventListener('keydown', (e) => {
  if (menuOpen) return; // let the panel inputs handle typing
  if (e.code === 'KeyL') { openLightingPanel(); return; }
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

function updateCrosshair() {
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = REACH;

  // Objects take priority for selection; collidables for placement point.
  const objHits = raycaster.intersectObjects(selectables, true);
  const surfHits = raycaster.intersectObjects(collidables, true);

  const firstObj = objHits[0];
  const firstSurf = surfHits[0];

  hoverObjectId = null;
  hoverPoint = null;

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
//  Mouse: left = select+iterate, right = generate menu
// ─────────────────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked || menuOpen) return;

  if (e.button === 0) {
    // Left-click: select object if the crosshair is on one; empty ground = noop.
    if (hoverObjectId) {
      setSelected(hoverObjectId);
      openIteratePanel(hoverObjectId);
    }
  } else if (e.button === 2) {
    // Right-click: open Generate menu, remembering where to place the object.
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
async function runGenerate() {
  const prompt = genInput.value.trim();
  if (!prompt) { genInput.focus(); return; }
  const placement = pendingPlacement ? pendingPlacement.clone() : groundPointAhead();
  closePanels(true);

  // Instant wireframe box, then swap to the image billboard once it arrives.
  let ph = addBoxPlaceholder(placement);
  toast(`Imagining “${prompt}”…`, true);
  try {
    const img = await generateImage({ prompt });
    removePlaceholder(ph);
    ph = addImageBillboard(placement, img.image); // fast shape preview

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

async function runIterate() {
  if (!selectedId) return;
  const entry = store.get(selectedId);
  const instruction = itInput.value.trim();
  if (!entry || !instruction) { itInput.focus(); return; }
  const id = selectedId;
  closePanels(true);

  const placement = entry.placement.position.clone();
  let ph = null;
  toast(`Re-imagining: “${instruction}”…`, true);
  try {
    const img = await iterateImage({
      sourceImage: entry.sourceImage,
      prompt: entry.prompt,
      instruction,
    });
    ph = addImageBillboard(placement, img.image); // fast shape preview of the change

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

async function runLighting() {
  const prompt = lightInput.value.trim();
  if (!prompt) { lightInput.focus(); return; }
  closePanels(true);

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

// Stage 2 (fast, ~seconds): the generated image as a camera-facing billboard —
// the actual shape of what's coming, standing in until the GLB is ready.
function addImageBillboard(point, dataURI) {
  const tex = new THREE.TextureLoader().load(dataURI);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.96, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const base = MODEL_TARGET_SIZE * 1.25;
  sprite.scale.set(base, base, 1);
  sprite.position.set(point.x, point.y + base / 2, point.z);
  sprite.userData._placeholder = true;

  // Correct aspect + height once the image dimensions are known.
  const img = new Image();
  img.onload = () => {
    const aspect = img.width / img.height || 1;
    const h = base;
    const w = base * aspect;
    sprite.scale.set(w, h, 1);
    sprite.position.y = point.y + h / 2;
  };
  img.src = dataURI;

  scene.add(sprite);
  loadingPlaceholders.add(sprite);
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
