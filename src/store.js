// In-memory object store, keyed by object id.
//
// Each entry holds everything we need to render and to iterate. The
// source image + prompt history are HIDDEN from the user — they exist only
// to feed back into the generation pipeline as iteration context.
//
//   id          string
//   root        THREE.Object3D   the loaded GLB root currently in the scene
//   sourceImage string           data-URI of the image last fed to Hunyuan
//   prompt      string           the most recent effective prompt
//   history     Array<{ instruction, prompt, image }>  iteration trail
//   placement   { position: THREE.Vector3, scale: number }  where it lives

const store = new Map();

let counter = 0;
export function nextId() {
  counter += 1;
  return `obj_${counter}`;
}

export function put(id, entry) {
  store.set(id, { id, history: [], ...entry });
  return store.get(id);
}

export function get(id) {
  return store.get(id);
}

export function update(id, patch) {
  const cur = store.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  store.set(id, next);
  return next;
}

export function remove(id) {
  store.delete(id);
}

export function all() {
  return [...store.values()];
}
