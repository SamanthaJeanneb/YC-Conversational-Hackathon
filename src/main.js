import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { installMeshyLighting } from './lighting.js';
import { generateImage, iterateImage, imageToModel, setLighting, estimateSize } from './pipeline.js';
import * as store from './store.js';
import { createVoice } from './voice.js';

// ─────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────
const EYE_HEIGHT = 1.6;        // human eye height (units = meters)
const MOVE_SPEED = 4.0;        // m/s
const FLY_SPEED = 5.0;         // vertical m/s (Up/Down arrows)
const GRAVITY = 22.0;          // m/s² while walking (fall onto the surface below)
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
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, EYE_HEIGHT, 6);

const lights = installMeshyLighting(scene, renderer, { castShadows: true });

// ─────────────────────────────────────────────────────────────────────────
//  Room  (basic box: floor, ceiling, 4 walls)
// ─────────────────────────────────────────────────────────────────────────
const collidables = [];     // surfaces the crosshair can place objects on
const selectables = [];     // generated model roots the crosshair can select
const flatRoomMeshes = [];  // the basic box — kept invisible as collision/bounds + fallback
let flyCeiling = ROOM.height; // how high you can fly; raised to the loaded scene's height

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

  // The flat box is hidden by default — it stays only as invisible collision /
  // placement geometry and clamp bounds, and as a fallback if the environment
  // GLB fails to load. The loaded scene below is what you actually see.
  flatRoomMeshes.push(floor, ceil, grid, ...collidables.filter((c) => c.userData.surface === 'wall'));
  for (const m of flatRoomMeshes) m.visible = false;
}
buildRoom();

// The dungeon's materials are baked (originally KHR_materials_unlit, which we
// stripped so emissive survives). Render each one self-illuminated from its
// texture so it shows at full baked brightness with NO dependence on the studio
// rig: normal surfaces emit their baseColor; black-based additive effects
// (the water / glow props) emit their emissive map instead. baseColor stays as
// `map` so alpha-tested / blended materials keep their cutouts.
function bakedUnlit(m) {
  if (!m) return;
  m.toneMapped = false;      // baked colors at face value
  m.envMapIntensity = 0;     // ignore the studio HDR; the dungeon is self-lit
  // Render UNLIT base + ADD the emissive glow (torches, water, runes) with no
  // dependence on scene lights: push the sampled baseColor into the emissive
  // term (which already holds emissive*emissiveMap), then zero the diffuse the
  // lights would use so nothing gets double-lit. Alpha (diffuseColor.a) is kept.
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
\ttotalEmissiveRadiance += diffuseColor.rgb;
\tdiffuseColor.rgb = vec3( 0.0 );`,
    );
  };
  m.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────────
//  Environment scene — load a GLB world (the dungeon) in place of the flat
//  room. Fitted to the room footprint, floor seated on y=0, centered, and its
//  meshes registered as collidables so you can place objects on its surfaces.
// ─────────────────────────────────────────────────────────────────────────
function loadEnvironment(url) {
  // Local loader: the shared gltfLoader const is declared further down the file.
  new GLTFLoader().load(
    url,
    (gltf) => {
      const env = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (!env) return;
      // Fit the longest horizontal axis into the room footprint, seat on floor.
      env.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(env);
      const size = new THREE.Vector3(); box.getSize(size);
      const maxXZ = Math.max(size.x, size.z) || 1;
      env.scale.setScalar((ROOM.size * 0.92) / maxXZ);
      env.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(env);
      const c = new THREE.Vector3(); box.getCenter(c);
      env.position.x -= c.x;            // center horizontally on the origin
      env.position.z -= c.z;
      env.position.y -= box.min.y;      // seat the floor on y = 0
      flyCeiling = Math.max(ROOM.height, box.max.y - box.min.y); // let you fly up to its roof
      env.traverse((o) => {
        if (!o.isMesh) return;
        o.receiveShadow = true;
        o.castShadow = true;
        o.userData.surface = 'environment';
        collidables.push(o);            // let the crosshair place objects on it
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(bakedUnlit);
      });
      env.userData._environment = true;
      scene.add(env);
    },
    undefined,
    (err) => {
      console.error('[environment] load failed:', err);
      for (const m of flatRoomMeshes) m.visible = true; // fall back to the flat room
    },
  );
}
loadEnvironment('/dungeon_crossroads.glb');

// ─────────────────────────────────────────────────────────────────────────
//  First-person controls
// ─────────────────────────────────────────────────────────────────────────
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject ? controls.getObject() : camera); // r181: controls.object === camera

const lockHint = document.getElementById('lock-hint');
const crosshair = document.getElementById('crosshair');

const keys = { forward: false, back: false, left: false, right: false, up: false, down: false };
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Movement mode: fly freely (↑/↓ arrows) or walk grounded (snap to the surface
// beneath you). Double-tap Space toggles — so after flying inside the model you
// can drop onto the floor and walk it.
let walkMode = false;
let lastSpacePress = 0;
const groundRay = new THREE.Raycaster();
const DOWN_VEC = new THREE.Vector3(0, -1, 0);
function toggleWalkMode() {
  walkMode = !walkMode;
  velocity.y = 0; // start from rest
  if (walkMode) {
    // Drop to the LOWEST floor beneath you (the hallway ground), passing through
    // any roof/overhang above it — so you end up INSIDE the model, not on top.
    groundRay.set(camera.position.clone(), DOWN_VEC);
    groundRay.far = 4000;
    const hits = groundRay.intersectObjects(collidables, true);
    if (hits.length) camera.position.y = hits[hits.length - 1].point.y + EYE_HEIGHT;
  }
  toast(walkMode
    ? 'Walking the hallway — double-tap Space to fly'
    : 'Flying — ↑/↓ to rise & descend, double-tap Space to walk', false, 2600);
}

// Solid walls: block horizontal movement that would pass into the dungeon
// geometry. Resolved per-axis (X then Z) so you slide along walls instead of
// sticking. prevX/prevZ are the position before this frame's move.
const collideRay = new THREE.Raycaster();
const PLAYER_RADIUS = 0.45;
function resolveWallCollision(prevX, prevZ) {
  const y = camera.position.y;
  const dx = camera.position.x - prevX;
  if (Math.abs(dx) > 1e-4) {
    collideRay.set(new THREE.Vector3(prevX, y, prevZ), new THREE.Vector3(Math.sign(dx), 0, 0));
    collideRay.far = Math.abs(dx) + PLAYER_RADIUS;
    if (collideRay.intersectObjects(collidables, true).length) camera.position.x = prevX;
  }
  const dz = camera.position.z - prevZ;
  if (Math.abs(dz) > 1e-4) {
    collideRay.set(new THREE.Vector3(camera.position.x, y, prevZ), new THREE.Vector3(0, 0, Math.sign(dz)));
    collideRay.far = Math.abs(dz) + PLAYER_RADIUS;
    if (collideRay.intersectObjects(collidables, true).length) camera.position.z = prevZ;
  }
}

controls.addEventListener('lock', () => {
  lockHint.classList.add('hidden');
  crosshair.classList.add('active');
});
controls.addEventListener('unlock', () => {
  crosshair.classList.remove('active');
  lockHint.classList.remove('hidden');
  // Esc while carrying → cancel the move, snapping the object back.
  if (grabbedId) cancelGrab();
  // Released → drop movement so we don't keep gliding.
  keys.forward = keys.back = keys.left = keys.right = keys.up = keys.down = false;
});

lockHint.addEventListener('click', () => controls.lock());

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC') { e.preventDefault(); copySelected(); return; }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') { e.preventDefault(); pasteClipboard(); return; }
  if (e.code === 'BracketRight') { resizeSelected(1.1); return; }      // ] bigger
  if (e.code === 'BracketLeft') { resizeSelected(1 / 1.1); return; }   // [ smaller
  if (e.code === 'KeyG') { toggleGrab(); return; }
  if (e.code === 'KeyV') { voiceEl.click(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    const now = performance.now();
    if (now - lastSpacePress < 350) toggleWalkMode(); // double-tap
    lastSpacePress = now;
    return;
  }
  switch (e.code) {
    case 'KeyW': keys.forward = true; break;
    case 'KeyS': keys.back = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
    case 'ArrowUp': keys.up = true; break;     // fly up
    case 'ArrowDown': keys.down = true; break; // fly down
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': keys.forward = false; break;
    case 'KeyS': keys.back = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
    case 'ArrowUp': keys.up = false; break;
    case 'ArrowDown': keys.down = false; break;
  }
});

// Scroll wheel: while carrying, push/pull the held object nearer/farther (so you
// can move it through the whole depth of the room); otherwise resize the object
// you're aiming at (up = bigger). Only hijacks the wheel when relevant.
window.addEventListener('wheel', (e) => {
  if (grabbedId) {
    e.preventDefault();
    carryDistance = clampCarry(carryDistance * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); // up = farther
    return;
  }
  const id = selectedId || hoverObjectId;
  if (!id || !store.get(id)) return;
  e.preventDefault();
  resizeSelected(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

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
let grabOriginal = null;   // original position, for Esc-cancel
let carryDistance = 3;     // how far in front of the camera the held object floats (m)
const clampCarry = (d) => Math.max(0.8, Math.min(16, d));

function toggleGrab() {
  if (grabbedId) { dropGrab(true); return; }
  const id = hoverObjectId || selectedId;
  if (!id || !store.get(id)) return;
  grabbedId = id;
  setSelected(id);
  const root = store.get(id).root;
  grabOriginal = root.position.clone();
  // Pick up at the object's current distance so it doesn't jump toward you.
  root.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  carryDistance = clampCarry(c.distanceTo(camera.position));
  crosshair.classList.add('carrying');
  toast('Carrying — aim to move it anywhere, scroll to push/pull, click to place, Esc to cancel', false, 3200);
}

// Each frame while carrying: float the object in FREE SPACE in front of the
// camera along the look direction, so you can place it anywhere — high, low, or
// across the room — by aiming and pushing/pulling with the scroll wheel. Kept
// inside the walls (x/z) and between floor and ceiling (y).
function grabUpdate() {
  const entry = store.get(grabbedId);
  if (!entry) { grabbedId = null; return; }
  const root = entry.root;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const target = camera.position.clone().add(fwd.multiplyScalar(carryDistance));
  clampToRoom(target); // walls (x/z)
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3(); box.getSize(size);
  const halfH = size.y / 2;
  target.y = Math.max(halfH, Math.min(ROOM.height - halfH, target.y)); // floor↔ceiling
  const c = new THREE.Vector3(); box.getCenter(c);
  root.position.add(target.sub(c)); // shift the object's center onto the target point
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
//  Copy / paste — duplicate an object locally (no regeneration round-trip)
// ─────────────────────────────────────────────────────────────────────────
let clipboardId = null; // id of the object to duplicate on the next paste

function copySelected() {
  const id = selectedId || hoverObjectId;
  if (!id || !store.get(id)) { toast('Aim at or select an object to copy', false, 2200); return; }
  clipboardId = id;
  toast('Copied — Cmd/Ctrl+V to paste', false, 1800);
}

function pasteClipboard() {
  const src = clipboardId && store.get(clipboardId);
  if (!src) { toast('Nothing copied yet — aim at an object and press Cmd/Ctrl+C', false, 2600); return; }

  // Drop the copy at the placement marker if one is set, else on the surface
  // under the crosshair, else just ahead of the player.
  const at = pendingPlacement ? pendingPlacement.clone()
           : (groundHoverPoint ? groundHoverPoint.clone() : groundPointAhead());
  clampToRoom(at);
  clearPlacementMarker();

  // Deep-clone the in-scene mesh, then clone geometry + materials per mesh so the
  // copy is fully independent: highlighting, iterating, or disposing it never
  // touches the original (clone() shares geometry/materials by reference otherwise).
  const newRoot = src.root.clone(true);
  const id = store.nextId();
  newRoot.userData = { ...newRoot.userData, objectId: id };
  newRoot.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if (o.geometry) o.geometry = o.geometry.clone();
    if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
    else if (o.material) o.material = o.material.clone();
  });

  // Seat the copy's base on the paste point (same box-seating the loader uses).
  newRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(newRoot);
  const c = new THREE.Vector3(); box.getCenter(c);
  newRoot.position.x += at.x - c.x;
  newRoot.position.z += at.z - c.z;
  newRoot.position.y += at.y - box.min.y;

  scene.add(newRoot);
  selectables.push(newRoot);
  store.put(id, {
    root: newRoot,
    sourceImage: src.sourceImage, // carry context so the copy can be iterated on its own
    prompt: src.prompt,
    sizeMeters: src.sizeMeters,   // inherit the original's real-world size
    placement: { position: at.clone(), scale: newRoot.userData._fitScale || 1 },
    history: [...(src.history || [])],
  });
  setSelected(id);
  toast('Pasted', false, 1500);
}

// Resize the targeted object about its base footprint. Updates the stored
// real-world size so a later iterate keeps the new scale instead of resetting.
function resizeSelected(factor) {
  const id = grabbedId || selectedId || hoverObjectId;
  const entry = id && store.get(id);
  if (!entry) { toast('Aim at or select an object to resize', false, 1600); return; }
  const root = entry.root;
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const baseY = box.min.y;
  const cBefore = new THREE.Vector3(); box.getCenter(cBefore);
  root.scale.multiplyScalar(factor);
  root.userData._fitScale = (root.userData._fitScale || 1) * factor;
  // Reseat so it scales about its base/footprint, not the raw model origin.
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const cAfter = new THREE.Vector3(); box.getCenter(cAfter);
  root.position.x += cBefore.x - cAfter.x;
  root.position.z += cBefore.z - cAfter.z;
  root.position.y += baseY - box.min.y;
  entry.sizeMeters = (entry.sizeMeters || MODEL_TARGET_SIZE) * factor;
  entry.placement.scale = root.userData._fitScale;
}

// ─────────────────────────────────────────────────────────────────────────
//  Mouse: clicks only TARGET — generation/iteration happen by voice (LiveKit).
//    left-click  = select the object under the crosshair (iterate target)
//    right-click = drop a placement marker (where the next spoken object spawns)
//    (left/right also place/cancel a carried object when grabbing)
// ─────────────────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) return;

  if (e.button === 0) {
    if (grabbedId) { dropGrab(true); return; }
    if (hoverObjectId) {
      setSelected(hoverObjectId);
      toast('Selected — say the change (e.g. “make it bigger”)', false, 2400);
    } else {
      setSelected(null); // clicked empty space → deselect (clears the highlight)
    }
  } else if (e.button === 2) {
    if (grabbedId) { cancelGrab(); return; }
    const point = hoverPoint ? hoverPoint.clone() : groundPointAhead();
    setPlacementMarker(point);
    toast('Spawn point set — say what to create (e.g. “a red mug”)', false, 2600);
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
//  Placement marker — where the next voice-spawned object lands (right-click)
// ─────────────────────────────────────────────────────────────────────────
let pendingPlacement = null; // world point captured at right-click time
let placementMarker = null;  // floor ring showing it

function setPlacementMarker(point) {
  clearPlacementMarker();
  pendingPlacement = point.clone();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 40),
    new THREE.MeshBasicMaterial({ color: 0x6ea8ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(point.x, point.y + 0.02, point.z);
  ring.userData._marker = true;
  scene.add(ring);
  placementMarker = ring;
}

function clearPlacementMarker() {
  if (placementMarker) {
    scene.remove(placementMarker);
    placementMarker.geometry.dispose();
    placementMarker.material.dispose();
    placementMarker = null;
  }
  pendingPlacement = null;
}

// ─────────────────────────────────────────────────────────────────────────
//  Generate / iterate / lighting flows (triggered by the voice layer)
// ─────────────────────────────────────────────────────────────────────────
// Core generate flow, callable from the voice layer.
async function generateAt(prompt, placement) {
  // Animated wireframe box stands in for the whole generation.
  let ph = addBoxPlaceholder(placement);
  toast(`Imagining “${prompt}”…`, true);
  // Fire the size estimate immediately, in parallel with the whole image→mesh
  // pipeline. It's a fast call that resolves long before the slow mesh build
  // finishes, so the result is ready for free by the time we load the model.
  const sizePromise = estimateSize({ prompt }).then((r) => r && r.sizeMeters).catch(() => null);
  try {
    const img = await generateImage({ prompt });
    toast('Building 3D model…', true);
    const result = await imageToModel({ image: img.image, prompt: img.prompt || prompt });
    const id = store.nextId();
    const est = await sizePromise;
    const sizeMeters = Number.isFinite(est) ? est : MODEL_TARGET_SIZE;
    const root = await loadModelAt(result.modelUrl, placement, sizeMeters);
    removePlaceholder(ph); ph = null; // remove only after the mesh is in place
    root.userData.objectId = id;
    selectables.push(root);
    store.put(id, {
      root,
      sourceImage: result.image,
      prompt: result.prompt || prompt,
      sizeMeters, // real-world longest-axis target; preserved on iterate, changed on resize
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

// Core iterate flow, callable from the voice layer.
async function iterateOn(id, instruction) {
  const entry = store.get(id);
  if (!entry || !instruction) return;
  const placement = entry.placement.position.clone();
  const oldRoot = entry.root;
  // The previous loaded model itself becomes the loading state (ghosted in place).
  makeLoadingGhost(oldRoot);
  let ghosted = true;
  toast(`Re-imagining: “${instruction}”…`, true);
  try {
    const img = await iterateImage({
      sourceImage: entry.sourceImage,
      prompt: entry.prompt,
      instruction,
    });
    toast('Building 3D model…', true);
    const result = await imageToModel({ image: img.image, prompt: img.prompt || instruction });
    // Swap the model in place — keep the same world position AND the same
    // real-world size (don't snap back to the default target on every iterate).
    const newRoot = await loadModelAt(result.modelUrl, placement, entry.sizeMeters);
    newRoot.userData.objectId = id;

    // Remove the old (ghosted) root from scene + selectables.
    loadingPlaceholders.delete(oldRoot);
    ghosted = false;
    scene.remove(oldRoot);
    disposeObject(oldRoot);
    const idx = selectables.indexOf(oldRoot);
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
    if (ghosted) clearLoadingGhost(oldRoot); // restore the real model on failure
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

// The default rig, snapshotted once at startup so "reset the lighting" can
// restore it instantly (lights + scene.background are already set above).
const DEFAULT_LIGHTING = currentLighting();

// "reset / default / normal / back to how it was" → restore the startup rig.
function isResetRequest(p) {
  return /\b(reset|default|original|restore)\b/i.test(p)
    || /back to (normal|default|original)/i.test(p)
    || /\bnormal lighting\b/i.test(p);
}

function resetLighting() {
  applyLighting(DEFAULT_LIGHTING);
  toast('Lighting reset to default', false, 1800);
}

// Core lighting flow, callable from the voice layer. Handles ANY free-form
// description (colors, named scenes, moods, time of day) via the LLM, and
// short-circuits reset requests to the snapshotted default with no round-trip.
async function applyLightingPrompt(prompt) {
  if (isResetRequest(prompt)) { resetLighting(); return; }
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

function loadModelAt(url, point, targetSize = MODEL_TARGET_SIZE) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!root) return reject(new Error('GLB had no scene'));

        // Scale to the object's real-world longest-axis size (meters) so a mug
        // ends up small and a table normal — falling back to the default target.
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const maxAxis = Math.max(size.x, size.y, size.z) || 1;
        const fit = (Number.isFinite(targetSize) && targetSize > 0 ? targetSize : MODEL_TARGET_SIZE) / maxAxis;
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

// Objects currently rendered in a "loading" state. The render loop pulses
// every material's opacity (relative to a stashed base) so it's obvious
// something is generating; box placeholders also rotate + breathe.
const loadingPlaceholders = new Set();

// Register an object so the render loop animates it. Stashes each material's
// base opacity once so the pulse multiplies rather than overwrites.
function registerLoading(obj) {
  obj.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (!m) continue;
      m.transparent = true;
      if (m.userData._baseOp === undefined) m.userData._baseOp = m.opacity;
    }
  });
  loadingPlaceholders.add(obj);
}

// GENERATE placeholder: a glowing wireframe cube (the "square" you liked) with a
// breathing inner core, rotating + pulsing so it clearly reads as "loading."
function addBoxPlaceholder(point) {
  const size = MODEL_TARGET_SIZE;
  const group = new THREE.Group();

  const outer = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshBasicMaterial({ color: 0x6ea8ff, wireframe: true, transparent: true, opacity: 0.8, depthWrite: false }),
  );
  const inner = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.55, size * 0.55, size * 0.55),
    new THREE.MeshBasicMaterial({ color: 0x6ea8ff, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  group.add(outer, inner);
  group.position.set(point.x, point.y + size / 2, point.z);
  group.userData._loadingBox = true;
  group.userData._inner = inner;
  scene.add(group);
  registerLoading(group);
  return group;
}

// ITERATE placeholder: turn the ALREADY-LOADED model into a translucent accent
// "ghost" of itself, in place, so the loading shape is the real previous model
// (not an image). Original materials are stashed for restore-on-error.
function makeLoadingGhost(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.userData._ghostStash = o.material;
    o.material = new THREE.MeshBasicMaterial({
      color: 0x6ea8ff, transparent: true, opacity: 0.32, depthWrite: false,
    });
  });
  registerLoading(root);
}

// Restore a ghosted model to its real materials (used if iteration fails).
function clearLoadingGhost(root) {
  loadingPlaceholders.delete(root);
  root.traverse((o) => {
    if (o.isMesh && o.userData._ghostStash) {
      o.material.dispose?.();
      o.material = o.userData._ghostStash;
      delete o.userData._ghostStash;
    }
  });
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

    const prevX = camera.position.x, prevZ = camera.position.z;
    controls.moveRight(-velocity.x * dt);
    controls.moveForward(-velocity.z * dt);
    resolveWallCollision(prevX, prevZ); // walls are solid — no walking through them

    if (walkMode) {
      // Walk grounded: fall from where you are (gravity) and stop when your feet
      // meet the surface below — so you land INSIDE the model, never lifted onto
      // the top. The flat floor (y=0) is a collidable backstop.
      velocity.y -= GRAVITY * dt;
      camera.position.y += velocity.y * dt;
      groundRay.set(camera.position, DOWN_VEC);
      groundRay.far = 1000;
      const hit = groundRay.intersectObjects(collidables, true)[0];
      const floorY = hit ? hit.point.y + EYE_HEIGHT : 0.4;
      if (camera.position.y <= floorY) { camera.position.y = floorY; velocity.y = 0; }
    } else {
      // Fly with the Up/Down arrows; otherwise hold the current height.
      if (keys.up) camera.position.y += FLY_SPEED * dt;
      if (keys.down) camera.position.y -= FLY_SPEED * dt;
      velocity.y = 0;
    }
    camera.position.y = Math.max(0.4, Math.min(flyCeiling - 0.3, camera.position.y));
    clampToRoom(camera.position);

    updateCrosshair();
    if (grabbedId) grabUpdate();
  }

  // Animate loading placeholders so it's obvious something is generating:
  // strong opacity pulse on every material, plus rotate + breathe the box.
  if (loadingPlaceholders.size) {
    const t = clock.elapsedTime;
    const f = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 4.5)); // ~0.35 .. 1.0
    loadingPlaceholders.forEach((obj) => {
      obj.traverse((o) => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) if (m && m.userData._baseOp !== undefined) m.opacity = m.userData._baseOp * f;
      });
      if (obj.userData._loadingBox) {
        obj.rotation.y += dt * 0.9;
        const s = 1 + 0.16 * Math.sin(t * 5);
        obj.userData._inner.scale.setScalar(s);
      }
    });
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

// Dedupe guard: the voice agent can re-fire the same command (mic echo of its
// own TTS, turn splitting). Drop a command that's already running or that fired
// moments ago, so one spoken request generates exactly once.
const inFlightCmds = new Set();   // keys currently executing
const recentCmds = new Map();     // key -> last-fired timestamp (ms)
const DEDUPE_WINDOW_MS = 12000;
function isDuplicateCommand(key) {
  const now = performance.now();
  if (inFlightCmds.has(key)) return true;
  const last = recentCmds.get(key);
  recentCmds.set(key, now);
  return last !== undefined && now - last < DEDUPE_WINDOW_MS;
}
function runOnce(key, promise) {
  inFlightCmds.add(key);
  Promise.resolve(promise).finally(() => inFlightCmds.delete(key));
}

// Map an inbound agent command onto the existing scene functions.
function handleVoiceCommand(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'generate': {
      const prompt = msg.prompt || 'an object';
      const key = `generate:${prompt.toLowerCase().trim()}`;
      if (isDuplicateCommand(key)) { console.warn('[voice] ignored duplicate generate:', prompt); break; }
      // Spawn at the right-click placement marker if one is set, else in front of the player.
      const placement = pendingPlacement ? pendingPlacement.clone() : groundPointAhead();
      clearPlacementMarker();
      runOnce(key, generateAt(prompt, placement));
      break;
    }
    case 'iterate': {
      const id = selectedId || hoverObjectId;
      if (!id) { toast('Look at or select an object first', false, 2600); break; }
      const instruction = msg.instruction || '';
      const key = `iterate:${id}:${instruction.toLowerCase().trim()}`;
      if (isDuplicateCommand(key)) { console.warn('[voice] ignored duplicate iterate:', instruction); break; }
      setSelected(id);
      runOnce(key, iterateOn(id, instruction));
      break;
    }
    case 'lighting': {
      const description = msg.description || '';
      const key = `lighting:${description.toLowerCase().trim()}`;
      if (isDuplicateCommand(key)) { console.warn('[voice] ignored duplicate lighting:', description); break; }
      runOnce(key, applyLightingPrompt(description));
      break;
    }
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
