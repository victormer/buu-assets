# buu-assets

Lazy asset loader for [buu.fun](https://buu.fun) 3D models and worlds. Load models by ID with automatic placeholder fallbacks — the game is always playable, even while assets are generating.

**Zero dependencies.** Detects THREE.js + GLTFLoader at runtime.

## Install

### CDN (recommended for Atomic Coding)

```html
<script src="https://cdn.jsdelivr.net/gh/victormer/buu-assets@v1.0.0/dist/buu-assets.min.js"></script>
```

This exposes `window.BUU` globally.

### GitHub Packages (npm)

```bash
npm install @victormer/buu-assets --registry=https://npm.pkg.github.com
```

```js
import BUU from '@victormer/buu-assets';
```

## Prerequisites

- **THREE.js** must be loaded (detected via `window.THREE`)
- **GLTFLoader** must be available — either via `window.THREE.GLTFLoader` (classic `<script>` setup) or registered manually with `BUU.setGLTFLoader()` (ES module setup)

Without GLTFLoader, models will remain as placeholder boxes. Without THREE.js, `loadModel` returns `null`.

### GLTFLoader setup (ES modules)

When using Three.js as ES modules, `GLTFLoader` is not on `window.THREE` — you must register it explicitly:

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

BUU.setGLTFLoader(GLTFLoader);
```

This only needs to be called once, before any `BUU.loadModel()` call.

### GLTFLoader setup (classic script tags)

No extra setup needed — the loader is auto-detected from `window.THREE.GLTFLoader`:

```html
<script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160/examples/js/loaders/GLTFLoader.js"></script>
<script src="https://cdn.jsdelivr.net/gh/victormer/buu-assets@1.0.0/dist/buu-assets.min.js"></script>
```

## Quick Start

```js
// Optional: change API endpoint (default: https://dev.api.buu.fun)
BUU.setApiUrl('https://dev.api.buu.fun');

// Required for ES module setups — register GLTFLoader once
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
BUU.setGLTFLoader(GLTFLoader);

// Load a model — returns immediately with a gray box placeholder
// Swaps to real GLB when the model finishes generating
var group = await BUU.loadModel('model-id-here', {
  width: 1, height: 2, depth: 1,  // placeholder dimensions
  onSwap: function(mesh, data) {
    console.log('Real model loaded!', data.prompt);
  }
});
scene.add(group);

// Load world data (splat URLs, panorama, etc.)
var world = await BUU.loadWorld('world-id-here');
console.log(world.splatUrl);      // Best splat file URL
console.log(world.panoramaUrl);   // Panorama image URL
```

## API

### Configuration

| Method | Returns | Description |
|--------|---------|-------------|
| `BUU.setApiUrl(url)` | `void` | Set API base URL (default: `https://dev.api.buu.fun`) |
| `BUU.getApiUrl()` | `string` | Get current API base URL |
| `BUU.setGLTFLoader(LoaderClass)` | `void` | Provide a GLTFLoader class (required for ES module setups) |

### 3D Models

#### `BUU.loadModel(modelId, options?)` → `Promise<THREE.Group>`

Load a 3D model by ID. Returns a `THREE.Group` immediately containing a gray box placeholder. In the background, fetches model data from the API and loads the real GLB mesh when available.

**Mesh resolution priority:** `texturedMesh.url` > `optimizedMesh.url` > `mesh.url`

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `width` | `number` | `1` | Placeholder box width |
| `height` | `number` | `1` | Placeholder box height |
| `depth` | `number` | `1` | Placeholder box depth |
| `color` | `string` | `'#888888'` | Placeholder box color |
| `poll` | `boolean` | `true` | Keep polling API if mesh not ready yet |
| `pollInterval` | `number` | `5000` | Milliseconds between polls |
| `maxPollTime` | `number` | `300000` | Max polling duration (5 min) |
| `onSwap` | `function` | — | Called with `(mesh, modelData)` when real mesh loads |
| `onError` | `function` | — | Called with `(error)` on failures |
| `onProgress` | `function` | — | Called with `(modelData)` on each poll |

```js
// Basic usage — gray box that becomes a real model
var tree = await BUU.loadModel('tree-model-id', {
  width: 0.5, height: 3, depth: 0.5,
  color: '#4a7c59',
  onSwap: function(mesh) { console.log('Tree loaded!'); }
});
scene.add(tree);

// No polling — just load what's available now
var prop = await BUU.loadModel('prop-id', { poll: false });
scene.add(prop);
```

#### `BUU.fetchModel(modelId)` → `Promise<object>`

Low-level fetch of model data from `/v1/models/public/:modelId`. Returns the raw API response.

```js
var data = await BUU.fetchModel('model-id');
console.log(data.prompt);           // Generation prompt
console.log(data.texturedMesh?.url); // GLB URL (if ready)
console.log(data.image?.url);       // Base image URL
```

### Worlds

#### `BUU.loadWorld(worldId, options?)` → `Promise<object>`

Fetch world data and resolve asset URLs. Returns structured data with the best available splat URL.

**Splat resolution priority:** `highRes` > `mediumRes` > `lowRes`

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poll` | `boolean` | `true` | Keep polling if assets not ready |
| `pollInterval` | `number` | `5000` | Milliseconds between polls |
| `maxPollTime` | `number` | `300000` | Max polling duration (5 min) |
| `onReady` | `function` | — | Called when splat/panorama URLs are available |
| `onError` | `function` | — | Called on failures |
| `onProgress` | `function` | — | Called with raw world data on each poll |

**Returns:**

```js
{
  worldId: 'abc123',
  splatUrl: 'https://...',           // Best splat file URL
  splats: {
    lowRes: 'https://...',           // 100k splat
    mediumRes: 'https://...',        // 500k splat
    highRes: 'https://...',          // Full resolution splat
  },
  panoramaUrl: 'https://...',       // Pano media URL
  thumbnailUrl: 'https://...',      // Thumbnail URL
  colliderMeshUrl: 'https://...',   // Collider mesh URL
  inputImages: [...],               // Input Media objects
  caption: 'AI-generated caption',
  displayName: 'My World',
  status: 'COMPLETED',
  raw: { ... }                      // Full API response
}
```

#### `BUU.fetchWorld(worldId)` → `Promise<object>`

Low-level fetch of world data from `/v1/worlds/public/:worldId`.

### Placeholders

#### `BUU.createPlaceholderBox(options?)` → `THREE.Mesh`

Create a solid-color box mesh. Used internally by `loadModel`, but available for manual use.

**Options:**
- `width` — box width (default: `1`)
- `height` — box height (default: `1`)
- `depth` — box depth (default: `1`)
- `color` — box color (default: `'#888888'`)

### URL Resolvers

| Method | Description |
|--------|-------------|
| `BUU.resolveMeshUrl(modelData)` | Get best mesh URL from model data |
| `BUU.resolveAllFormats(modelData)` | Get `{ glb, obj, fbx }` URLs |
| `BUU.resolveSplatUrl(worldData)` | Get best splat URL from world data |
| `BUU.resolveAllSplatUrls(worldData)` | Get `{ lowRes, mediumRes, highRes }` |

### Polling Control

| Method | Description |
|--------|-------------|
| `BUU.cancelPoll(modelId)` | Cancel polling for a specific model |
| `BUU.cancelAllPolls()` | Cancel all active polling operations |

### Utilities

| Method | Returns | Description |
|--------|---------|-------------|
| `BUU.isThreeAvailable()` | `boolean` | Check if THREE.js is loaded |
| `BUU.isGLTFLoaderAvailable()` | `boolean` | Check if GLTFLoader is available |
| `BUU.getCachedModel(id)` | `object\|null` | Get cached model `{ group, loaded }` |
| `BUU.getCachedWorld(id)` | `object\|null` | Get cached world data |
| `BUU.clearCache()` | `void` | Clear cache and cancel all polls |

## How It Works

```
Agent creates model → gets modelId
       ↓
BUU.loadModel(modelId, { width: 1, height: 2, depth: 1 })
       ↓
Returns THREE.Group with gray box → scene.add(group) → game is playable!
       ↓ (background)
Polls GET /v1/models/public/:modelId every 5s
       ↓
Model has texturedMesh.url? → Load GLB → Swap placeholder → onSwap() callback
```

## Fallback Behavior

| Scenario | Behavior |
|----------|----------|
| Model still generating | Gray box placeholder, polls until mesh URL appears |
| GLTFLoader not available | Gray box placeholder stays, warning in console |
| THREE.js not loaded | `loadModel` returns `null`, warning in console |
| Network error on fetch | Retries on next poll interval |
| GLB load fails | Retries on next poll interval |
| Max poll time reached | Stops polling, placeholder remains |

All placeholder meshes have `._isPlaceholder = true` for detection:

```js
var group = await BUU.loadModel('id');
var child = group.children[0];
if (child._isPlaceholder) {
  console.log('Still loading...');
}
```

## License

MIT
