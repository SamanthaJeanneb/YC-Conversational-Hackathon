// "Meshy-style" studio lighting recipe: HDR studio IBL with a RoomEnvironment
// fallback, restrained ambient/hemi fill, soft warm key, cool low fill, and a
// hot white rim — the signature silhouette "shine."
//
// Renderer setup the caller must still do (renderer-global, not scene-attached):
//   renderer.outputColorSpace   = THREE.SRGBColorSpace;
//   renderer.toneMapping        = THREE.ACESFilmicToneMapping;
//   renderer.toneMappingExposure = 0.9;

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

export function installMeshyLighting(scene, renderer, opts = {}) {
  const scale = opts.directScale ?? 1;

  // ── IBL ────────────────────────────────────────────────────────────────
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // RoomEnvironment lights the scene synchronously so nothing appears unlit.
  let envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  // Scene-wide IBL dimmer: 0.35 = HDR reflects but doesn't blow out materials.
  scene.environmentIntensity = 0.35;

  let disposed = false;
  new HDRLoader().load(
    '/studio_small_03_1k.hdr',
    (hdrTex) => {
      if (disposed) { hdrTex.dispose(); return; }
      hdrTex.mapping = THREE.EquirectangularReflectionMapping;
      const hdrRT = pmrem.fromEquirectangular(hdrTex);
      scene.environment = hdrRT.texture;
      hdrTex.dispose();
      const prev = envRT;
      envRT = hdrRT;
      prev.dispose();
    },
    undefined,
    (err) => {
      console.warn('[meshyLighting] HDR failed, keeping RoomEnvironment fallback:', err);
    },
  );

  // ── Direct lights ──────────────────────────────────────────────────────
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.06 * scale);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xfff4e0, 0.7 * scale);
  keyLight.position.set(6, 9, 7);
  if (opts.castShadows) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 60;
    keyLight.shadow.camera.left = -12;
    keyLight.shadow.camera.right = 12;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -12;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    keyLight.shadow.radius = 4;
  }
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xc7d8ff, 0.15 * scale);
  fillLight.position.set(-6, 4, 4);
  scene.add(fillLight);

  // Rim is the standout — 1.1x intentionally higher than the key.
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.1 * scale);
  rimLight.position.set(-4, 6, -7);
  scene.add(rimLight);

  const hemi = opts.hemisphere ?? { sky: 0xdfefff, ground: 0x1a1a1f };
  const hemisphereLight = new THREE.HemisphereLight(hemi.sky, hemi.ground, 0.08 * scale);
  scene.add(hemisphereLight);

  return {
    pmrem, envRT, keyLight, fillLight, rimLight, ambientLight, hemisphereLight,
    dispose: () => {
      disposed = true;
      pmrem.dispose();
      envRT.dispose();
      scene.remove(ambientLight, keyLight, fillLight, rimLight, hemisphereLight);
    },
  };
}
