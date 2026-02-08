/* buu-assets v1.0.0 | MIT License */
var BUU = (function () {
  'use strict';

  /**
   * Buu Assets — Lazy asset loader for buu.fun 3D models and worlds.
   *
   * Global: window.BUU
   * Zero dependencies. Detects THREE.js + GLTFLoader at runtime.
   *
   * Usage:
   *   var group = await BUU.loadModel('model-id', { width: 1, height: 2, depth: 1 });
   *   scene.add(group);
   *   // group starts as a gray box, swaps to real GLB when ready
   */

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  var _apiUrl = 'https://dev.api.buu.fun';
  var _GLTFLoader = null;           // user-provided GLTFLoader class (for ES module setups)
  var _GaussianSplats3D = null;     // user-provided GaussianSplats3D module (for SPZ/splat loading)
  var _cache = {};                  // keyed by type:id  e.g. "model:abc123"
  var _activePolls = {};            // track active polling timers so they can be cancelled

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Check if THREE.js is available on window.
   */
  function threeAvailable() {
    return typeof window !== 'undefined' &&
      typeof window.THREE !== 'undefined' &&
      window.THREE !== null;
  }

  /**
   * Check if a GLTFLoader is available (user-provided or on window.THREE).
   */
  function gltfLoaderAvailable() {
    if (_GLTFLoader) return true;
    return threeAvailable() && typeof window.THREE.GLTFLoader !== 'undefined';
  }

  /**
   * Check if GaussianSplats3D is available (user-provided or on window).
   */
  function gaussianSplats3DAvailable() {
    if (_GaussianSplats3D) return true;
    return typeof window !== 'undefined' &&
      typeof window.GaussianSplats3D !== 'undefined' &&
      window.GaussianSplats3D !== null;
  }

  /**
   * Internal: get the GaussianSplats3D module from user-provided or window.
   */
  function _getGS3D() {
    if (_GaussianSplats3D) return _GaussianSplats3D;
    if (typeof window !== 'undefined' && window.GaussianSplats3D) return window.GaussianSplats3D;
    return null;
  }

  /**
   * Build the full API URL for a given path.
   * @param {string} path - e.g. '/v1/models/public/abc123'
   * @returns {string}
   */
  function apiUrl(path) {
    var base = _apiUrl;
    if (base[base.length - 1] === '/') base = base.slice(0, -1);
    return base + path;
  }

  // ---------------------------------------------------------------------------
  // API Fetchers
  // ---------------------------------------------------------------------------

  /**
   * Fetch model data from the buu.fun public API.
   *
   * @param {string} modelId
   * @returns {Promise<object>} - Raw model data from the API
   */
  function fetchModel(modelId) {
    var url = apiUrl('/v1/models/public/' + modelId);
    return fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching model ' + modelId);
        return response.json();
      });
  }

  /**
   * Fetch world data from the buu.fun public API.
   *
   * @param {string} worldId
   * @returns {Promise<object>} - Raw world data from the API
   */
  function fetchWorld(worldId) {
    var url = apiUrl('/v1/worlds/public/' + worldId);
    return fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching world ' + worldId);
        return response.json();
      });
  }

  // ---------------------------------------------------------------------------
  // Placeholder generators
  // ---------------------------------------------------------------------------

  /**
   * Create a placeholder THREE.Mesh (solid gray box).
   * Returns null if THREE.js is not loaded.
   *
   * @param {object} [options]
   * @param {number} [options.width=1]
   * @param {number} [options.height=1]
   * @param {number} [options.depth=1]
   * @param {string} [options.color='#888888']
   * @returns {THREE.Mesh|null}
   */
  function createPlaceholderBox(options) {
    if (!threeAvailable()) {
      console.warn('[BUU] createPlaceholderBox: THREE.js not loaded — returning null');
      return null;
    }
    var T = window.THREE;
    var opts = options || {};
    var w = opts.width || 1;
    var h = opts.height || 1;
    var d = opts.depth || 1;
    var color = opts.color || '#888888';

    var geometry = new T.BoxGeometry(w, h, d);
    var material = new T.MeshStandardMaterial
      ? new T.MeshStandardMaterial({ color: color, roughness: 0.8, metalness: 0.1 })
      : new T.MeshBasicMaterial({ color: color });
    var mesh = new T.Mesh(geometry, material);
    mesh.name = 'buu-placeholder';
    mesh._isPlaceholder = true;
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Mesh URL resolution
  // ---------------------------------------------------------------------------

  /**
   * Given model data from the API, find the best mesh URL to load.
   * Priority: texturedMesh > optimizedMesh > mesh
   *
   * @param {object} modelData - Model data from API
   * @returns {string|null} - URL of the best available mesh, or null
   */
  function resolveMeshUrl(modelData) {
    if (modelData.texturedMesh && modelData.texturedMesh.url) {
      return modelData.texturedMesh.url;
    }
    if (modelData.optimizedMesh && modelData.optimizedMesh.url) {
      return modelData.optimizedMesh.url;
    }
    if (modelData.mesh && modelData.mesh.url) {
      return modelData.mesh.url;
    }
    return null;
  }

  /**
   * Given model data, check what format variants are available (obj, fbx).
   *
   * @param {object} modelData
   * @returns {object} - { glb: string|null, obj: string|null, fbx: string|null }
   */
  function resolveAllFormats(modelData) {
    var glb = resolveMeshUrl(modelData);

    var obj = null;
    if (modelData.obj) {
      obj = resolveMeshUrl(modelData.obj);
    }

    var fbx = null;
    if (modelData.fbx) {
      fbx = resolveMeshUrl(modelData.fbx);
    }

    return { glb: glb, obj: obj, fbx: fbx };
  }

  // ---------------------------------------------------------------------------
  // GLB Loader
  // ---------------------------------------------------------------------------

  /**
   * Load a GLB file using THREE.GLTFLoader.
   *
   * @param {string} url - URL of the GLB file
   * @returns {Promise<THREE.Group>} - The loaded scene
   */
  function loadGLB(url) {
    var LoaderClass = _GLTFLoader || (threeAvailable() && window.THREE.GLTFLoader);
    if (!LoaderClass) {
      return Promise.reject(new Error('GLTFLoader not available — call BUU.setGLTFLoader(GLTFLoader) first'));
    }

    return new Promise(function (resolve, reject) {
      var loader = new LoaderClass();
      loader.load(
        url,
        // onLoad
        function (gltf) {
          resolve(gltf.scene);
        },
        // onProgress
        undefined,
        // onError
        function (error) {
          reject(error || new Error('Failed to load GLB: ' + url));
        }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Model Loader (main feature)
  // ---------------------------------------------------------------------------

  /**
   * Load a 3D model from buu.fun by ID.
   *
   * Returns a THREE.Group immediately with a gray box placeholder.
   * In the background, fetches model data from the API and loads the real GLB
   * mesh when available, swapping out the placeholder.
   *
   * If the model is still generating (no mesh URLs yet), polls the API
   * periodically until a mesh becomes available or maxPollTime is reached.
   *
   * @param {string} modelId - The model ID from buu.fun
   * @param {object} [options]
   * @param {number} [options.width=1]          - Placeholder box width
   * @param {number} [options.height=1]         - Placeholder box height
   * @param {number} [options.depth=1]          - Placeholder box depth
   * @param {string} [options.color='#888888']  - Placeholder box color
   * @param {boolean} [options.poll=true]       - Keep polling if no mesh yet
   * @param {number} [options.pollInterval=5000] - ms between polls
   * @param {number} [options.maxPollTime=300000] - Max polling duration (5 min)
   * @param {function} [options.onSwap]         - Callback when real mesh replaces placeholder
   * @param {function} [options.onError]        - Callback on errors
   * @param {function} [options.onProgress]     - Callback with model data on each poll
   * @returns {Promise<THREE.Group>}            - Group with placeholder (swaps to real mesh later)
   */
  function loadModel(modelId, options) {
    if (!threeAvailable()) {
      console.warn('[BUU] loadModel: THREE.js not loaded — returning null');
      return Promise.resolve(null);
    }

    var T = window.THREE;
    var opts = options || {};
    var poll = opts.poll !== undefined ? opts.poll : true;
    var pollInterval = opts.pollInterval || 5000;
    var maxPollTime = opts.maxPollTime || 300000;
    var onSwap = opts.onSwap || function () {};
    var onError = opts.onError || function () {};
    var onProgress = opts.onProgress || function () {};

    // Check cache — return cached group if the real mesh was already loaded
    var cacheKey = 'model:' + modelId;
    if (_cache[cacheKey] && _cache[cacheKey].loaded) {
      return Promise.resolve(_cache[cacheKey].group);
    }

    // Create container group
    var group = new T.Group();
    group.name = 'buu-model-' + modelId;
    group._buuModelId = modelId;
    group._buuLoaded = false;

    // Add placeholder
    var placeholder = createPlaceholderBox({
      width: opts.width,
      height: opts.height,
      depth: opts.depth,
      color: opts.color,
    });
    if (placeholder) {
      group.add(placeholder);
    }

    // Store in cache
    _cache[cacheKey] = { group: group, loaded: false };

    // Start the background loading process
    _startModelLoad(modelId, group, placeholder, poll, pollInterval, maxPollTime, onSwap, onError, onProgress);

    return Promise.resolve(group);
  }

  /**
   * Internal: Start the background fetch + load + poll cycle for a model.
   */
  function _startModelLoad(modelId, group, placeholder, poll, pollInterval, maxPollTime, onSwap, onError, onProgress) {
    var startTime = Date.now();
    var cacheKey = 'model:' + modelId;

    function attempt() {
      fetchModel(modelId)
        .then(function (modelData) {
          onProgress(modelData);

          var meshUrl = resolveMeshUrl(modelData);

          if (meshUrl) {
            // We have a mesh URL — try to load the GLB
            if (!gltfLoaderAvailable()) {
              console.warn('[BUU] GLTFLoader not available — model ' + modelId + ' will remain as placeholder');
              onError(new Error('GLTFLoader not available'));
              return;
            }

            loadGLB(meshUrl)
              .then(function (scene) {
                // Remove placeholder from group
                if (placeholder && placeholder.parent === group) {
                  group.remove(placeholder);
                  if (placeholder.geometry) placeholder.geometry.dispose();
                  if (placeholder.material) placeholder.material.dispose();
                }

                // Add real mesh
                scene.name = 'buu-mesh-' + modelId;
                group.add(scene);
                group._buuLoaded = true;
                group._buuModelData = modelData;

                // Update cache
                _cache[cacheKey].loaded = true;

                // Cancel any active polling
                if (_activePolls[modelId]) {
                  clearTimeout(_activePolls[modelId]);
                  delete _activePolls[modelId];
                }

                onSwap(scene, modelData);
              })
              .catch(function (err) {
                console.warn('[BUU] Failed to load GLB for model ' + modelId + ': ' + err.message);
                onError(err);
                // Continue polling if enabled — the GLB might not be ready yet
                if (poll && (Date.now() - startTime) < maxPollTime) {
                  _activePolls[modelId] = setTimeout(attempt, pollInterval);
                }
              });
          } else if (poll && (Date.now() - startTime) < maxPollTime) {
            // No mesh URL yet — poll again
            _activePolls[modelId] = setTimeout(attempt, pollInterval);
          } else if (!poll) {
            console.warn('[BUU] No mesh available for model ' + modelId + ' and polling is disabled');
          } else {
            console.warn('[BUU] Max poll time reached for model ' + modelId + ' — giving up');
            onError(new Error('Max poll time reached for model ' + modelId));
          }
        })
        .catch(function (err) {
          console.warn('[BUU] Error fetching model ' + modelId + ': ' + err.message);
          onError(err);
          // Retry on network errors if polling
          if (poll && (Date.now() - startTime) < maxPollTime) {
            _activePolls[modelId] = setTimeout(attempt, pollInterval);
          }
        });
    }

    attempt();
  }

  /**
   * Cancel polling for a specific model.
   *
   * @param {string} modelId
   */
  function cancelPoll(modelId) {
    if (_activePolls[modelId]) {
      clearTimeout(_activePolls[modelId]);
      delete _activePolls[modelId];
    }
  }

  /**
   * Cancel all active polling operations.
   */
  function cancelAllPolls() {
    for (var id in _activePolls) {
      if (_activePolls.hasOwnProperty(id)) {
        clearTimeout(_activePolls[id]);
      }
    }
    _activePolls = {};
  }

  // ---------------------------------------------------------------------------
  // World Loader
  // ---------------------------------------------------------------------------

  /**
   * Resolve the best splat URL from world data.
   * Priority: highRes > mediumRes > lowRes
   *
   * @param {object} worldData - World data from API
   * @returns {string|null}
   */
  function resolveSplatUrl(worldData) {
    if (worldData.splatFiles) {
      if (worldData.splatFiles.highRes && worldData.splatFiles.highRes.url) {
        return worldData.splatFiles.highRes.url;
      }
      if (worldData.splatFiles.mediumRes && worldData.splatFiles.mediumRes.url) {
        return worldData.splatFiles.mediumRes.url;
      }
      if (worldData.splatFiles.lowRes && worldData.splatFiles.lowRes.url) {
        return worldData.splatFiles.lowRes.url;
      }
    }
    return null;
  }

  /**
   * Resolve all splat URLs by resolution tier.
   *
   * @param {object} worldData
   * @returns {object} - { lowRes: string|null, mediumRes: string|null, highRes: string|null }
   */
  function resolveAllSplatUrls(worldData) {
    var files = worldData.splatFiles || {};
    return {
      lowRes: (files.lowRes && files.lowRes.url) || null,
      mediumRes: (files.mediumRes && files.mediumRes.url) || null,
      highRes: (files.highRes && files.highRes.url) || null,
    };
  }

  /**
   * Load world data from buu.fun by ID.
   *
   * Fetches the world data and returns a structured object with resolved URLs
   * for splat files, panorama, thumbnail, collider, etc.
   *
   * If the world is still generating, can poll until assets become available.
   *
   * @param {string} worldId
   * @param {object} [options]
   * @param {boolean} [options.poll=true]         - Keep polling if assets not ready
   * @param {number} [options.pollInterval=5000]  - ms between polls
   * @param {number} [options.maxPollTime=300000] - Max polling duration (5 min)
   * @param {function} [options.onReady]          - Callback when world data has splat URLs
   * @param {function} [options.onError]          - Callback on errors
   * @param {function} [options.onProgress]       - Callback with world data on each poll
   * @returns {Promise<object>} - Structured world data with resolved URLs
   */
  function loadWorld(worldId, options) {
    var opts = options || {};
    var poll = opts.poll !== undefined ? opts.poll : true;
    var pollInterval = opts.pollInterval || 5000;
    var maxPollTime = opts.maxPollTime || 300000;
    var onReady = opts.onReady || function () {};
    var onError = opts.onError || function () {};
    var onProgress = opts.onProgress || function () {};

    // Check cache
    var cacheKey = 'world:' + worldId;
    if (_cache[cacheKey] && _cache[cacheKey].ready) {
      return Promise.resolve(_cache[cacheKey].data);
    }

    return new Promise(function (resolve, reject) {
      var startTime = Date.now();
      var resolved = false;

      function attempt() {
        fetchWorld(worldId)
          .then(function (worldData) {
            onProgress(worldData);

            var splatUrl = resolveSplatUrl(worldData);
            var allSplats = resolveAllSplatUrls(worldData);

            var result = {
              worldId: worldId,
              splatUrl: splatUrl,
              splats: allSplats,
              panoramaUrl: (worldData.panoMedia && worldData.panoMedia.url) || null,
              thumbnailUrl: (worldData.thumbnailMedia && worldData.thumbnailMedia.url) || null,
              colliderMeshUrl: (worldData.colliderMesh && worldData.colliderMesh.url) || null,
              inputImages: worldData.inputImages || [],
              caption: worldData.caption || null,
              displayName: worldData.displayName || null,
              status: worldData.status || null,
              raw: worldData,
            };

            // Consider it "ready" when we have at least a splat URL or panorama
            var isReady = !!(splatUrl || result.panoramaUrl);

            if (isReady) {
              _cache[cacheKey] = { data: result, ready: true };

              if (_activePolls['world:' + worldId]) {
                clearTimeout(_activePolls['world:' + worldId]);
                delete _activePolls['world:' + worldId];
              }

              if (!resolved) {
                resolved = true;
                resolve(result);
              }
              onReady(result);
            } else if (poll && (Date.now() - startTime) < maxPollTime) {
              // Not ready yet — resolve immediately with partial data, keep polling
              if (!resolved) {
                resolved = true;
                resolve(result);
              }
              _activePolls['world:' + worldId] = setTimeout(attempt, pollInterval);
            } else {
              if (!resolved) {
                resolved = true;
                resolve(result);
              }
              if (!poll) {
                console.warn('[BUU] No assets available for world ' + worldId + ' and polling is disabled');
              } else {
                console.warn('[BUU] Max poll time reached for world ' + worldId);
                onError(new Error('Max poll time reached for world ' + worldId));
              }
            }
          })
          .catch(function (err) {
            console.warn('[BUU] Error fetching world ' + worldId + ': ' + err.message);
            onError(err);

            if (poll && (Date.now() - startTime) < maxPollTime) {
              _activePolls['world:' + worldId] = setTimeout(attempt, pollInterval);
            } else if (!resolved) {
              resolved = true;
              reject(err);
            }
          });
      }

      attempt();
    });
  }

  // ---------------------------------------------------------------------------
  // Splat Loader (Gaussian Splatting)
  // ---------------------------------------------------------------------------

  /**
   * Load a Gaussian Splat scene from a URL (.spz, .ply, .splat, .ksplat).
   *
   * Returns a GaussianSplats3D DropInViewer that can be added directly to a
   * Three.js scene with scene.add(viewer).
   *
   * Requires GaussianSplats3D — either via window.GaussianSplats3D (script tag)
   * or registered with BUU.setGaussianSplats3D() (ES modules).
   *
   * @param {string} url - URL to the splat file
   * @param {object} [options]
   * @param {number[]} [options.position]   - [x,y,z] scene offset
   * @param {number[]} [options.rotation]   - [x,y,z,w] quaternion
   * @param {number[]} [options.scale]      - [x,y,z] scale
   * @param {number}   [options.splatAlphaRemovalThreshold] - Alpha threshold (0-255), default 5
   * @param {boolean}  [options.showLoadingUI]    - Show loading indicator, default false
   * @param {boolean}  [options.progressiveLoad]  - Load progressively, default false
   * @param {string}   [options.format]     - Force format: 'ply','splat','ksplat','spz'
   * @param {object}   [options.viewer]     - DropInViewer constructor options override
   * @param {function} [options.onLoad]     - Called with (viewer) when splat scene is loaded
   * @param {function} [options.onError]    - Called with (error) on failure
   * @returns {Promise<object|null>}        - DropInViewer instance (scene.add-able), or null
   */
  function loadSplat(url, options) {
    var GS3D = _getGS3D();
    if (!GS3D) {
      console.warn('[BUU] loadSplat: GaussianSplats3D not available — call BUU.setGaussianSplats3D() or load via <script>');
      return Promise.resolve(null);
    }

    var opts = options || {};
    var onLoad = opts.onLoad || function () {};
    var onError = opts.onError || function () {};

    // DropInViewer config — sensible defaults for game/embed usage
    var viewerDefaults = {
      gpuAcceleratedSort: true,
      sharedMemoryForWorkers: true,
      sphericalHarmonicsDegree: 0,
    };
    // Apply LogLevel.None if enum exists
    if (GS3D.LogLevel) viewerDefaults.logLevel = GS3D.LogLevel.None;
    // Apply SceneRevealMode.Gradual if enum exists
    if (GS3D.SceneRevealMode) viewerDefaults.sceneRevealMode = GS3D.SceneRevealMode.Gradual;

    var viewerOpts = opts.viewer || {};
    var viewerConfig = {};
    var key;

    // Merge defaults (user overrides win)
    for (key in viewerDefaults) {
      if (viewerDefaults.hasOwnProperty(key)) {
        viewerConfig[key] = viewerOpts[key] !== undefined ? viewerOpts[key] : viewerDefaults[key];
      }
    }
    // Copy any extra user viewer options
    for (key in viewerOpts) {
      if (viewerOpts.hasOwnProperty(key) && viewerConfig[key] === undefined) {
        viewerConfig[key] = viewerOpts[key];
      }
    }

    var viewer;
    try {
      viewer = new GS3D.DropInViewer(viewerConfig);
    } catch (err) {
      console.warn('[BUU] Failed to create DropInViewer: ' + err.message);
      onError(err);
      return Promise.resolve(null);
    }

    // Scene-level options for addSplatScene
    var sceneConfig = {
      splatAlphaRemovalThreshold: opts.splatAlphaRemovalThreshold !== undefined ? opts.splatAlphaRemovalThreshold : 5,
      showLoadingUI: opts.showLoadingUI !== undefined ? opts.showLoadingUI : false,
      progressiveLoad: opts.progressiveLoad || false,
    };
    if (opts.position) sceneConfig.position = opts.position;
    if (opts.rotation) sceneConfig.rotation = opts.rotation;
    if (opts.scale) sceneConfig.scale = opts.scale;
    if (opts.format) sceneConfig.format = opts.format;

    // Tag the viewer for BUU tracking
    viewer._buuSplatUrl = url;

    return viewer.addSplatScene(url, sceneConfig)
      .then(function () {
        onLoad(viewer);
        return viewer;
      })
      .catch(function (err) {
        console.warn('[BUU] Failed to load splat from ' + url + ': ' + (err.message || err));
        onError(err);
        return null;
      });
  }

  /**
   * Load a world and its Gaussian Splat scene in one call.
   * Convenience wrapper: fetches world data, then loads the best splat URL.
   *
   * @param {string} worldId
   * @param {object} [options]
   * @param {string}   [options.splatResolution] - 'high','medium','low','auto' (default: 'auto')
   * @param {object}   [options.world]   - Options passed to loadWorld()
   * @param {object}   [options.splat]   - Options passed to loadSplat()
   * @param {function} [options.onLoad]  - Called with ({ world, viewer }) when both are ready
   * @param {function} [options.onError] - Called with (error)
   * @returns {Promise<object>}          - { world, viewer }
   */
  function loadWorldSplat(worldId, options) {
    var opts = options || {};
    var splatResolution = opts.splatResolution || 'auto';
    var worldOpts = opts.world || {};
    var splatOpts = opts.splat || {};
    var onLoad = opts.onLoad || function () {};
    var onError = opts.onError || function () {};

    return loadWorld(worldId, worldOpts)
      .then(function (worldData) {
        // Pick splat URL based on resolution preference
        var splatUrl;
        if (splatResolution === 'high' && worldData.splats.highRes) {
          splatUrl = worldData.splats.highRes;
        } else if (splatResolution === 'medium' && worldData.splats.mediumRes) {
          splatUrl = worldData.splats.mediumRes;
        } else if (splatResolution === 'low' && worldData.splats.lowRes) {
          splatUrl = worldData.splats.lowRes;
        } else {
          // 'auto': best available (highRes > mediumRes > lowRes)
          splatUrl = worldData.splatUrl;
        }

        if (!splatUrl) {
          console.warn('[BUU] No splat URL available for world ' + worldId);
          var result = { world: worldData, viewer: null };
          onLoad(result);
          return result;
        }

        return loadSplat(splatUrl, splatOpts)
          .then(function (viewer) {
            var result = { world: worldData, viewer: viewer };
            onLoad(result);
            return result;
          });
      })
      .catch(function (err) {
        console.warn('[BUU] Error loading world splat for ' + worldId + ': ' + (err.message || err));
        onError(err);
        return { world: null, viewer: null };
      });
  }

  /**
   * Dispose of a DropInViewer returned by loadSplat / loadWorldSplat.
   * Cleans up GPU resources, workers, and removes it from its parent scene.
   *
   * @param {object} viewer - The DropInViewer instance
   */
  function disposeSplat(viewer) {
    if (!viewer) return;
    // Remove from parent scene if attached
    if (viewer.parent) {
      viewer.parent.remove(viewer);
    }
    if (typeof viewer.dispose === 'function') {
      try { viewer.dispose(); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Cache utilities
  // ---------------------------------------------------------------------------

  /**
   * Clear the internal cache. Forces re-fetching on next load.
   * Also cancels all active polling.
   */
  function clearCache() {
    cancelAllPolls();
    _cache = {};
  }

  /**
   * Get cached model data if available.
   *
   * @param {string} modelId
   * @returns {object|null} - { group, loaded, modelData } or null
   */
  function getCachedModel(modelId) {
    var entry = _cache['model:' + modelId];
    if (!entry) return null;
    return {
      group: entry.group,
      loaded: entry.loaded,
    };
  }

  /**
   * Get cached world data if available.
   *
   * @param {string} worldId
   * @returns {object|null}
   */
  function getCachedWorld(worldId) {
    var entry = _cache['world:' + worldId];
    if (!entry) return null;
    return entry.data || null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var BUU = {
    // Configuration
    setApiUrl: function (url) { _apiUrl = url || 'https://dev.api.buu.fun'; },
    getApiUrl: function () { return _apiUrl; },
    setGLTFLoader: function (LoaderClass) { _GLTFLoader = LoaderClass; },
    setGaussianSplats3D: function (GS3DModule) { _GaussianSplats3D = GS3DModule; },

    // Model loading (main feature)
    loadModel: loadModel,

    // World loading
    loadWorld: loadWorld,

    // Splat loading (Gaussian Splatting — SPZ, PLY, SPLAT, KSPLAT)
    loadSplat: loadSplat,
    loadWorldSplat: loadWorldSplat,
    disposeSplat: disposeSplat,

    // Low-level fetchers
    fetchModel: fetchModel,
    fetchWorld: fetchWorld,

    // Placeholder
    createPlaceholderBox: createPlaceholderBox,

    // URL resolvers (utilities)
    resolveMeshUrl: resolveMeshUrl,
    resolveAllFormats: resolveAllFormats,
    resolveSplatUrl: resolveSplatUrl,
    resolveAllSplatUrls: resolveAllSplatUrls,

    // Polling control
    cancelPoll: cancelPoll,
    cancelAllPolls: cancelAllPolls,

    // Cache
    getCachedModel: getCachedModel,
    getCachedWorld: getCachedWorld,
    clearCache: clearCache,

    // Runtime detection
    isThreeAvailable: threeAvailable,
    isGLTFLoaderAvailable: gltfLoaderAvailable,
    isGaussianSplats3DAvailable: gaussianSplats3DAvailable,
  };

  return BUU;

})();
/* Loaded via: window.BUU */
