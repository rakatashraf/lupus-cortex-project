// ===== TERRAIN 3D STUDIO =====
// Convert any area into an editable 3D terrain model from real satellite/elevation
// data, sculpt/edit the design, then export the geometry as data for Gemini analysis.
// Inspired by topoexport.com (DTM terrain models + export workflow).

const TerrainStudio = (() => {
  // --- Elevation source: Open-Meteo Elevation API (free, no key, batched) ---
  const ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';
  const ELEVATION_FALLBACK_API = 'https://api.open-elevation.com/api/v1/lookup';
  const MAX_POINTS_PER_REQUEST = 100;
  const REQUEST_DELAY_MS = 350; // throttle between batches to avoid HTTP 429
  const TERRARIUM_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  const terrainGridCache = new Map();
  const demTileCache = new Map();
  let terrainAbortController = null;

  // --- NASA GIBS true-color imagery draped over the editable terrain twin. ---
  const NASA_GIBS_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor';
  const NASA_GIBS_TILE_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
  const NASA_GIBS_MATRIX_SET = 'GoogleMapsCompatible_Level9';
  const SATELLITE_TARGET_PX = 2048; // optional satellite overlay only; geometry drives model clarity
  const SATELLITE_MAX_TILES = 160; // safety cap on stitched tiles

  // --- Three.js scene state ---
  let scene = null;
  let camera = null;
  let renderer = null;
  let terrainMesh = null;
  let animationId = null;
  let baseGeometry = null; // holds original (unedited) z values
  let satelliteTexture = null; // draped NASA GIBS imagery
  let satelliteImageryMeta = null;
  let surfaceMode = 'elevation'; // elevation is the production default; satellite is an optional overlay

  // --- Terrain metadata ---
  let terrainData = null; // { center, areaKm, resolution, grid, min, max, mean }
  let structures = []; // user-placed markers/structures only
  let structureGroup = null;

  // --- City-planning state (InfraWorks / CityEngine inspired) ---
  let zoneOverlay = null; // translucent mesh visualising painted land-use zones
  let zoneTexture = null; // CanvasTexture backing the zone overlay
  let zoneCanvas = null; // res×res canvas of zone colours
  let zoneGrid = null; // Array(res*res) of zone names ('none' | zone id)
  let currentZone = 'residential'; // active zone for the paint brush
  let cityGroup = null; // procedurally generated buildings/trees
  let roads = []; // [{ points:[Vector3], mesh }]
  let roadDraft = []; // in-progress road waypoints (Vector3)
  let roadGroup = null;
  let measureGroup = null;
  let measurePts = []; // Vector3 clicks for the measure tool
  let sunLight = null; // shadow-casting sun for solar study
  let shadowsOn = false;

  // --- GIS import (OpenStreetMap via Overpass) ---
  const OVERPASS_ENDPOINTS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ];
  let gisGroup = null; // extruded OSM buildings/roads/land-use
  let gisStats = { buildings: 0, roadsKm: 0, source: null };
  const GIS_HEIGHT_SCALE = 1.3; // near-true-scale heights (clean, not spiky)
  const DEFAULT_FLOOR_M = 3.2; // metres per storey when only levels are tagged
  const BUILDING_EDIT_CAP = 2200; // max individually-editable GIS buildings
  let visualStyle = 'white'; // crisp architectural model is the production default

  // Analytical source state is deliberately separate from Three.js render objects.
  const digitalTwinState = {
    observed: { terrain: null, buildings: [], roads: [], vegetation: [], water: [], landCover: [], infrastructure: [], metadata: {} },
    scenario: { addedBuildings: [], removedBuildingIds: [], modifiedBuildings: [], addedRoads: [], removedRoadIds: [], terrainEdits: [], vegetationChanges: [], waterChanges: [], landUseChanges: [] }
  };
  const gisSourceData = { buildings: [], roads: [], water: [], vegetation: [] };
  const gisRenderData = { buildings: [], roads: [], water: [], vegetation: [] };

  function resetScenarioState() {
    Object.values(digitalTwinState.scenario).forEach(list => { list.length = 0; });
  }

  function scenarioChangeCounts() {
    const s = digitalTwinState.scenario;
    return { added_buildings: s.addedBuildings.length, removed_buildings: s.removedBuildingIds.length, modified_buildings: s.modifiedBuildings.length, added_roads: s.addedRoads.length, removed_roads: s.removedRoadIds.length, terrain_edits: s.terrainEdits.length, vegetation_changes: s.vegetationChanges.length, water_changes: s.waterChanges.length, land_use_changes: s.landUseChanges.length };
  }

  function isEdited() { return Object.values(scenarioChangeCounts()).some(count => count > 0); }

  // Land-use zoning rules — drive procedural building generation (CityEngine-style)
  const ZONES = {
    residential: { color: '#22c55e', hex: 0x16a34a, hMin: 4, hMax: 12, foot: 2.0, density: 0.55, popPerFloor: 6 },
    commercial: { color: '#3b82f6', hex: 0x2563eb, hMin: 10, hMax: 42, foot: 2.6, density: 0.6, popPerFloor: 12 },
    industrial: { color: '#f59e0b', hex: 0xd97706, hMin: 6, hMax: 16, foot: 3.4, density: 0.45, popPerFloor: 3 },
    park: { color: '#4ade80', hex: 0x15803d, trees: true, density: 0.35 },
    water: { color: '#0ea5e9', hex: 0x0284c7 },
    none: { color: 'rgba(0,0,0,0)', hex: 0x000000 },
  };
  const FLOOR_UNITS = 2.4; // world units per building floor (for stats)

  // --- Editing state ---
  let editMode = 'orbit'; // orbit | raise | lower | smooth | flatten | structure | select | move | delete | zone | road | measure
  let brushRadius = 2.5;
  let brushStrength = 0.6;
  let structureSize = 1; // multiplier for placed objects
  let verticalExaggeration = 1;
  let isPointerDown = false;
  let sculptCount = 0;
  let selectedStructure = null; // currently selected structure record
  let flattenTargetY = null; // reference height for the flatten brush
  const undoStack = []; // stack of revert callbacks (Blender-style undo)
  let strokeSnapshot = null; // terrain heights captured at stroke start

  // --- Camera orbit state ---
  const orbit = { theta: 0.9, phi: 1.0, radius: 90, target: new THREE.Vector3(0, 0, 0) };
  let lastPointer = { x: 0, y: 0 };

  const PLANE_SIZE = 80; // world units for the terrain plane footprint

  // ---------------------------------------------------------------------------
  // PUBLIC: open the studio
  // ---------------------------------------------------------------------------
  function open() {
    const modal = document.getElementById('terrainStudioModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    // Prefill from the NASA search input or current app location
    const seed = document.getElementById('locationSearch');
    const field = document.getElementById('terrainLocationInput');
    if (field && !field.value) {
      if (seed && seed.value.trim()) field.value = seed.value.trim();
      else if (window.appState && appState.currentLocation) {
        field.value = `${appState.currentLocation.lat}, ${appState.currentLocation.lng}`;
      }
    }
    bindControls();
  }

  function close() {
    const modal = document.getElementById('terrainStudioModal');
    if (modal) modal.classList.add('hidden');
    stopRenderLoop();
  }

  // ---------------------------------------------------------------------------
  // Resolve a query (place name or "lat, lng") into coordinates
  // ---------------------------------------------------------------------------
  async function resolveLocation(query) {
    const coordMatch = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng, name: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
      }
      throw new Error('Coordinates out of range.');
    }
    // Geocode place name via Open-Meteo geocoding (free, no key)
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1`;
    const res = await fetch(geoUrl);
    if (!res.ok) throw new Error('Geocoding request failed.');
    const data = await res.json();
    if (!data.results || !data.results.length) throw new Error('Location not found.');
    const r = data.results[0];
    return { lat: r.latitude, lng: r.longitude, name: `${r.name}${r.country ? ', ' + r.country : ''}` };
  }

  // ---------------------------------------------------------------------------
  // Small helpers: sleep + fetch JSON with exponential backoff on 429/5xx
  // ---------------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchJSONWithRetry(url, options = {}, maxRetries = 4) {
    let delay = 700;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, options);
      } catch (netErr) {
        if (attempt >= maxRetries) throw netErr;
        await sleep(delay);
        delay *= 2;
        continue;
      }
      if (res.ok) return res.json();
      // Retry on rate-limit or transient server errors
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : delay;
        await sleep(wait);
        delay *= 2;
        continue;
      }
      throw new Error(`status ${res.status}`);
    }
  }

  function reshapeGrid(elevations, resolution) {
    const grid = [];
    let min = Infinity, max = -Infinity, sum = 0;
    for (let r = 0; r < resolution; r++) {
      const row = [];
      for (let c = 0; c < resolution; c++) {
        const v = elevations[r * resolution + c];
        if (!Number.isFinite(v)) throw new Error('Elevation source returned an unavailable sample.');
        row.push(v);
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      grid.push(row);
    }
    return { grid, min, max, mean: sum / elevations.length };
  }

  // ---------------------------------------------------------------------------
  // Fetch a grid of elevations for a bounding box centred on lat/lng
  // ---------------------------------------------------------------------------
  function mercatorTile(lng, lat, zoom) {
    const scale = Math.pow(2, zoom);
    const x = (lng + 180) / 360 * scale;
    const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    const y = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * scale;
    return { x, y };
  }

  function decodeTerrarium(data, x, y) {
    const px = Math.max(0, Math.min(255, Math.floor(x)));
    const py = Math.max(0, Math.min(255, Math.floor(y)));
    const offset = (py * 256 + px) * 4;
    return data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
  }

  function loadTerrariumTile(zoom, x, y, signal) {
    const key = `${zoom}/${x}/${y}`;
    if (demTileCache.has(key)) return demTileCache.get(key);
    const task = new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const abort = () => reject(new DOMException('Terrain request cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      image.onload = () => {
        signal?.removeEventListener('abort', abort);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        resolve(context.getImageData(0, 0, 256, 256).data);
      };
      image.onerror = () => reject(new Error(`Terrarium DEM tile unavailable (${key}).`));
      image.src = `${TERRARIUM_TILE_URL}/${zoom}/${x}/${y}.png`;
    });
    demTileCache.set(key, task);
    return task;
  }

  async function fetchRasterElevationGrid(lat, lng, areaKm, resolution, signal) {
    const halfLat = (areaKm / 2) / 111;
    const halfLng = (areaKm / 2) / (111 * Math.cos(lat * Math.PI / 180) || 1);
    const zoom = areaKm <= 2 ? 14 : areaKm <= 6 ? 13 : 12;
    const nw = mercatorTile(lng - halfLng, lat + halfLat, zoom);
    const se = mercatorTile(lng + halfLng, lat - halfLat, zoom);
    const x0 = Math.floor(nw.x), x1 = Math.floor(se.x), y0 = Math.floor(nw.y), y1 = Math.floor(se.y);
    const tileKeys = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tileKeys.push({ x, y });
    if (!tileKeys.length || tileKeys.length > 64) throw new Error('Raster DEM coverage exceeds the supported tile request limit.');
    setStatus(`Fetching raster DEM (${tileKeys.length} tiles)…`, 'busy');
    const entries = await Promise.all(tileKeys.map(async tile => [`${tile.x}/${tile.y}`, await loadTerrariumTile(zoom, tile.x, tile.y, signal)]));
    const tiles = new Map(entries);
    const values = [];
    for (let r = 0; r < resolution; r++) {
      const sampleLat = lat + halfLat - (r / (resolution - 1)) * 2 * halfLat;
      for (let c = 0; c < resolution; c++) {
        const sampleLng = lng - halfLng + (c / (resolution - 1)) * 2 * halfLng;
        const point = mercatorTile(sampleLng, sampleLat, zoom);
        const tx = Math.floor(point.x), ty = Math.floor(point.y);
        const data = tiles.get(`${tx}/${ty}`);
        if (!data) throw new Error('Raster DEM tile coverage is incomplete.');
        values.push(decodeTerrarium(data, (point.x - tx) * 256, (point.y - ty) * 256));
      }
    }
    return { ...reshapeGrid(values, resolution), provenance: { terrain_source: 'Terrarium raster DEM', terrain_dataset: 'AWS elevation-tiles-prod Terrarium', terrain_resolution_m: null, terrain_requested_resolution: resolution, terrain_generated_resolution: resolution, terrain_is_fallback: false, terrain_quality: 'raster_resampled', terrain_retrieved_at: new Date().toISOString() } };
  }

  function bilinearResample(source, sourceResolution, targetResolution) {
    const output = [];
    for (let r = 0; r < targetResolution; r++) for (let c = 0; c < targetResolution; c++) {
      const y = r / (targetResolution - 1) * (sourceResolution - 1), x = c / (targetResolution - 1) * (sourceResolution - 1);
      const y0 = Math.floor(y), x0 = Math.floor(x), y1 = Math.min(sourceResolution - 1, y0 + 1), x1 = Math.min(sourceResolution - 1, x0 + 1);
      const dx = x - x0, dy = y - y0;
      const top = source[y0 * sourceResolution + x0] * (1 - dx) + source[y0 * sourceResolution + x1] * dx;
      const bottom = source[y1 * sourceResolution + x0] * (1 - dx) + source[y1 * sourceResolution + x1] * dx;
      output.push(top * (1 - dy) + bottom * dy);
    }
    return output;
  }

  async function fetchElevationGridPointFallback(lat, lng, areaKm, resolution) {
    const halfLat = (areaKm / 2) / 111;
    const halfLng = (areaKm / 2) / (111 * Math.cos(lat * Math.PI / 180) || 1);
    const lats = [], lngs = [];
    for (let r = 0; r < resolution; r++) for (let c = 0; c < resolution; c++) {
      lats.push(lat + halfLat - (r / (resolution - 1)) * 2 * halfLat);
      lngs.push(lng - halfLng + (c / (resolution - 1)) * 2 * halfLng);
    }
    const values = [];
    for (let i = 0; i < lats.length; i += MAX_POINTS_PER_REQUEST) {
      const url = `${ELEVATION_API}?latitude=${lats.slice(i, i + MAX_POINTS_PER_REQUEST).join(',')}&longitude=${lngs.slice(i, i + MAX_POINTS_PER_REQUEST).join(',')}`;
      const response = await fetchJSONWithRetry(url, {}, 2);
      if (!Array.isArray(response.elevation) || response.elevation.length !== Math.min(MAX_POINTS_PER_REQUEST, lats.length - i)) throw new Error('Fallback elevation source returned incomplete data.');
      values.push(...response.elevation);
    }
    return { values };
  }

  async function fetchElevationGrid(lat, lng, areaKm, resolution) {
    const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}:${areaKm}:${resolution}`;
    if (terrainGridCache.has(cacheKey)) return terrainGridCache.get(cacheKey);
    if (terrainAbortController) terrainAbortController.abort();
    terrainAbortController = new AbortController();
    try {
      const raster = await fetchRasterElevationGrid(lat, lng, areaKm, resolution, terrainAbortController.signal);
      terrainGridCache.set(cacheKey, raster);
      return raster;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.warn('Primary raster DEM unavailable; trying bounded point fallback.', error.message);
      setStatus('Primary terrain source unavailable. Trying fallback…', 'busy');
      const sourceResolution = Math.min(16, resolution);
      const fallback = await fetchElevationGridPointFallback(lat, lng, areaKm, sourceResolution);
      const grid = reshapeGrid(bilinearResample(fallback.values, sourceResolution, resolution), resolution);
      const result = { ...grid, provenance: { terrain_source: 'Open-Meteo Elevation API', terrain_dataset: 'Open-Meteo elevation fallback', terrain_resolution_m: null, terrain_requested_resolution: resolution, terrain_generated_resolution: sourceResolution, terrain_is_fallback: true, terrain_quality: 'point_api_resampled', terrain_retrieved_at: new Date().toISOString() } };
      terrainGridCache.set(cacheKey, result);
      return result;
    }
    const halfLat = (areaKm / 2) / 111; // deg latitude
    const halfLng = (areaKm / 2) / (111 * Math.cos(lat * Math.PI / 180) || 1);

    const lats = [];
    const lngs = [];
    for (let r = 0; r < resolution; r++) {
      const fy = r / (resolution - 1); // 0..1
      const rowLat = lat + halfLat - fy * (2 * halfLat); // north -> south
      for (let c = 0; c < resolution; c++) {
        const fx = c / (resolution - 1);
        const colLng = lng - halfLng + fx * (2 * halfLng);
        lats.push(rowLat);
        lngs.push(colLng);
      }
    }

    // Batch into <=100-point requests, throttled + retried to avoid HTTP 429
    const elevations = new Array(lats.length);
    const totalBatches = Math.ceil(lats.length / MAX_POINTS_PER_REQUEST);
    let batchNum = 0;
    for (let i = 0; i < lats.length; i += MAX_POINTS_PER_REQUEST) {
      batchNum++;
      const latSlice = lats.slice(i, i + MAX_POINTS_PER_REQUEST);
      const lngSlice = lngs.slice(i, i + MAX_POINTS_PER_REQUEST);
      setStatus(`⛰️ Fetching elevation data… batch ${batchNum}/${totalBatches}`, 'busy');
      const url = `${ELEVATION_API}?latitude=${latSlice.join(',')}&longitude=${lngSlice.join(',')}`;
      let json;
      try {
        json = await fetchJSONWithRetry(url);
      } catch (err) {
        console.warn('Open-Meteo elevation failed, switching to fallback:', err.message);
        setStatus('⛰️ Primary service busy — using backup elevation source…', 'busy');
        return fetchElevationGridFallback(lats, lngs, resolution);
      }
      if (!json.elevation) throw new Error('Elevation data missing in response.');
      for (let k = 0; k < json.elevation.length; k++) {
        elevations[i + k] = json.elevation[k];
      }
      if (i + MAX_POINTS_PER_REQUEST < lats.length) await sleep(REQUEST_DELAY_MS);
    }

    return reshapeGrid(elevations, resolution);
  }

  // Fallback elevation provider (Open-Elevation) — single POST for all points
  async function fetchElevationGridFallback(lats, lngs, resolution) {
    const locations = lats.map((la, i) => ({ latitude: la, longitude: lngs[i] }));
    let json;
    try {
      json = await fetchJSONWithRetry(ELEVATION_FALLBACK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations }),
      }, 2);
    } catch (err) {
      throw new Error('Elevation services are busy right now. Please wait a moment and try again, or reduce the "Detail" level.');
    }
    const elevations = (json.results || []).map((r) => r.elevation ?? 0);
    if (!elevations.length) throw new Error('No elevation data returned.');
    return reshapeGrid(elevations, resolution);
  }

  // ---------------------------------------------------------------------------
  // Satellite imagery: stitch NASA GIBS tiles for the selected bbox and drape
  // the result over the editable elevation mesh.
  // ---------------------------------------------------------------------------
  function lngToTileX(lng, z) {
    return ((lng + 180) / 360) * Math.pow(2, z);
  }
  function latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
  }

  function getGibsImageDate(daysAgo = 7) {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }

  function loadTile(date, z, x, y) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null); // tolerate missing tiles
      img.src = `${NASA_GIBS_TILE_URL}/${NASA_GIBS_LAYER}/default/${date}/${NASA_GIBS_MATRIX_SET}/${z}/${y}/${x}.jpg`;
    });
  }

  async function fetchSatelliteTexture(lat, lng, areaKm) {
    const halfLat = (areaKm / 2) / 111;
    const halfLng = (areaKm / 2) / (111 * Math.cos(lat * Math.PI / 180) || 1);
    const north = lat + halfLat, south = lat - halfLat;
    const west = lng - halfLng, east = lng + halfLng;

    // Choose a zoom so the area maps to roughly SATELLITE_TARGET_PX pixels
    const metersWide = areaKm * 1000;
    const metersPerPixel = metersWide / SATELLITE_TARGET_PX;
    let z = Math.round(
      Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel)
    );
    // The selected GIBS matrix set publishes imagery through Level 9.
    z = Math.max(2, Math.min(9, z));

    // Tile ranges covering the bbox
    const xF0 = lngToTileX(west, z), xF1 = lngToTileX(east, z);
    const yF0 = latToTileY(north, z), yF1 = latToTileY(south, z); // north has smaller y
    const x0 = Math.floor(xF0), x1 = Math.floor(xF1);
    const y0 = Math.floor(yF0), y1 = Math.floor(yF1);
    const cols = x1 - x0 + 1, rows = y1 - y0 + 1;

    // Guard against pathological tile counts
    if (cols * rows > SATELLITE_MAX_TILES) return null;

    const TILE = 256;
    const full = document.createElement('canvas');
    full.width = cols * TILE;
    full.height = rows * TILE;
    const fctx = full.getContext('2d');

    const tiles = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        tiles.push({ tx, ty });
      }
    }
    const imageDate = getGibsImageDate();
    const imgs = await Promise.all(tiles.map((t) => loadTile(imageDate, z, t.tx, t.ty)));
    imgs.forEach((img, i) => {
      if (!img) return;
      const { tx, ty } = tiles[i];
      fctx.drawImage(img, (tx - x0) * TILE, (ty - y0) * TILE, TILE, TILE);
    });

    // Crop the stitched canvas to the exact bbox
    const cropX = (xF0 - x0) * TILE;
    const cropY = (yF0 - y0) * TILE;
    const cropW = (xF1 - xF0) * TILE;
    const cropH = (yF1 - yF0) * TILE;

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cropW));
    out.height = Math.max(1, Math.round(cropH));
    out.getContext('2d').drawImage(full, cropX, cropY, cropW, cropH, 0, 0, out.width, out.height);

    const tex = new THREE.CanvasTexture(out);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return {
      texture: tex,
      source: 'NASA GIBS MODIS Terra True Color',
      layer: NASA_GIBS_LAYER,
      date: imageDate,
      zoom: z
    };
  }

  // Apply GPU-dependent quality (max anisotropy) once a renderer exists
  function applyTextureQuality(tex) {
    if (tex && renderer && renderer.capabilities) {
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
    }
  }

  let twinPreviewFrame = null;

  function scheduleTwinPreview() {
    if (twinPreviewFrame) return;
    twinPreviewFrame = requestAnimationFrame(() => {
      twinPreviewFrame = null;
      updateTwinPreview();
    });
  }

  // The preview preserves observed imagery and draws the user's edits as overlays.
  function updateTwinPreview() {
    const panel = document.getElementById('terrainTwinPreview');
    const canvas = document.getElementById('terrainTwinPreviewCanvas');
    const source = satelliteTexture?.image;
    if (!panel || !canvas || !source || !terrainMesh) {
      panel?.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);

    if (zoneCanvas) {
      ctx.save();
      ctx.globalAlpha = 0.58;
      ctx.drawImage(zoneCanvas, 0, 0, width, height);
      ctx.restore();
    }

    const toPreview = (point) => ({
      x: (point.x / PLANE_SIZE + 0.5) * width,
      y: (point.z / PLANE_SIZE + 0.5) * height
    });

    const positions = terrainMesh.geometry.attributes.position;
    if (baseGeometry) {
      ctx.fillStyle = 'rgba(251, 146, 60, 0.75)';
      for (let i = 0; i < positions.count; i += 2) {
        if (Math.abs(positions.getY(i) - baseGeometry[i]) < 0.08) continue;
        const p = toPreview({ x: positions.getX(i), z: positions.getZ(i) });
        ctx.fillRect(p.x - 1, p.y - 1, 3, 3);
      }
    }

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    roads.forEach(road => {
      ctx.beginPath();
      road.points.forEach((point, index) => {
        const p = toPreview(point);
        if (index) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
    });

    ctx.fillStyle = '#facc15';
    structures.forEach(structure => {
      const p = toPreview({ x: structure.nx * PLANE_SIZE, z: structure.nz * PLANE_SIZE });
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ---------------------------------------------------------------------------
  // Generate terrain from the current form inputs
  // ---------------------------------------------------------------------------
  async function generate() {
    const input = document.getElementById('terrainLocationInput');
    const areaKm = parseFloat(document.getElementById('terrainArea').value) || 5;
    const resolution = parseInt(document.getElementById('terrainResolution').value, 10) || 64;

    if (!input || !input.value.trim()) {
      setStatus('Enter a place name or coordinates first.', 'error');
      return;
    }

    try {
      setStatus('📍 Resolving location…', 'busy');
      const loc = await resolveLocation(input.value.trim());

      setStatus(`⛰️ Fetching elevation data for ${loc.name}…`, 'busy');
      const { grid, min, max, mean, provenance } = await fetchElevationGrid(loc.lat, loc.lng, areaKm, resolution);

      // Best-effort: fetch draped satellite imagery (non-fatal if it fails)
      setStatus('🛰️ Loading HD satellite imagery…', 'busy');
      satelliteTexture = null;
      satelliteImageryMeta = null;
      try {
        const imagery = await fetchSatelliteTexture(loc.lat, loc.lng, areaKm);
        satelliteTexture = imagery?.texture || null;
        satelliteImageryMeta = imagery || null;
      } catch (imgErr) {
        console.warn('Satellite imagery unavailable:', imgErr.message);
      }

      terrainData = { center: loc, areaKm, resolution, grid, min, max, mean, imagery: satelliteImageryMeta, provenance };
      digitalTwinState.observed.terrain = provenance;
      resetScenarioState();
      structures = [];
      selectedStructure = null;
      undoStack.length = 0;
      sculptCount = 0;

      buildScene(terrainData);
      setStatus(
        `✅ ${loc.name} · ${areaKm} km² · ${resolution}×${resolution} grid · ` +
        `elev ${Math.round(min)}–${Math.round(max)} m` +
        (satelliteTexture ? ` · 🛰️ NASA GIBS ${satelliteImageryMeta.date}` : ''),
        'ok'
      );
      updateStatsPanel();
      document.getElementById('terrainToolbar').classList.remove('hidden');
      updateSurfaceButton();
    } catch (err) {
      console.error('Terrain generation error:', err);
      setStatus(`❌ ${err.message || 'Failed to build terrain.'}`, 'error');
    }
  }

  function setStatus(msg, kind) {
    const status = document.getElementById('terrainStatus');
    if (!status) return;
    status.textContent = msg;
    status.className = 'terrain-status ' + (kind || '');
  }

  // ---------------------------------------------------------------------------
  // Build / rebuild the Three.js scene from terrain data
  // ---------------------------------------------------------------------------
  function buildScene(data) {
    const container = document.getElementById('terrainCanvasWrap');
    if (!container) return;

    stopRenderLoop();
    // Keep the observed-versus-planned preview mounted while rebuilding WebGL.
    const twinPreview = document.getElementById('terrainTwinPreview');
    container.innerHTML = '';
    if (twinPreview) container.appendChild(twinPreview);

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05081a);

    camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 2000); // architectural/isometric-like perspective
    updateCameraFromOrbit();

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping for a smooth, punchy, clean look
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    // Balanced lighting: soft sky fill + a strong key light so buildings get
    // clear light/shadow faces (depth) instead of a flat, washed-out look
    scene.add(new THREE.HemisphereLight(0xdff0ff, 0x53606e, 0.55));
    scene.add(new THREE.AmbientLight(0xffffff, 0.2));
    const dir2 = new THREE.DirectionalLight(0xbcd8ff, 0.35);
    dir2.position.set(-40, 30, -50);
    scene.add(dir2);

    // Sun — shadow-casting key light for InfraWorks-style solar study
    sunLight = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sunLight.position.set(40, 80, 30);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(4096, 4096);
    sunLight.shadow.radius = 4; // soft shadow edges
    sunLight.shadow.bias = -0.0005;
    const sc = sunLight.shadow.camera;
    sc.left = -PLANE_SIZE * 0.75; sc.right = PLANE_SIZE * 0.75;
    sc.top = PLANE_SIZE * 0.75; sc.bottom = -PLANE_SIZE * 0.75;
    sc.near = 1; sc.far = 400;
    sunLight.castShadow = shadowsOn;
    scene.add(sunLight);
    scene.add(sunLight.target);

    // Geometry — plane subdivided to (res-1) segments
    const res = data.resolution;
    const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2); // make it horizontal (XZ plane, Y up)

    const range = Math.max(1, data.max - data.min);
    // True-scale terrain: 1 metre → this many world units (keeps cities flat &
    // clean, while real mountains still rise). A gentle factor adds readability.
    const trueScale = (PLANE_SIZE / (data.areaKm * 1000)) * 1.1;
    // Blend toward true scale, but guarantee at least a little relief so flat
    // areas aren't perfectly featureless (cap the stretch for gentle terrain).
    const maxStretch = 4.5 / range; // never stretch relief beyond ~4.5 units (clean, flat cities)
    const heightScale = Math.min(trueScale, maxStretch);
    const maxHeightUnits = range * heightScale;

    const pos = geo.attributes.position;
    // PlaneGeometry vertices are row-major starting top-left after rotation
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const idx = r * res + c;
        const elev = data.grid[r][c];
        const y = (elev - data.min) * heightScale;
        pos.setY(idx, y);
      }
    }
    geo.computeVertexNormals();

    // Store base heights for reset
    baseGeometry = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) baseGeometry[i] = pos.getY(i);

    applyVertexColors(geo, data, maxHeightUnits);

    applyTextureQuality(satelliteTexture);
    const useSat = surfaceMode === 'satellite' && !!satelliteTexture;
    const mat = new THREE.MeshStandardMaterial({
      map: useSat ? satelliteTexture : null,
      vertexColors: !useSat,
      color: 0xffffff,
      flatShading: false,
      metalness: 0.0,
      roughness: 1.0,
      side: THREE.DoubleSide,
    });

    terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.scale.y = verticalExaggeration;
    terrainMesh.userData = { res, heightScale, min: data.min, maxHeightUnits };
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);

    // Land-use zone overlay — shares terrain geometry so it follows relief/sculpt
    initZoneLayer(res);
    zoneOverlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: zoneTexture, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    zoneOverlay.position.y = 0.35;
    zoneOverlay.scale.y = verticalExaggeration;
    zoneOverlay.renderOrder = 2;
    zoneOverlay.visible = false;
    scene.add(zoneOverlay);

    // Wireframe overlay (toggleable)
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.25 })
    );
    wire.name = 'wireframe';
    wire.scale.y = verticalExaggeration;
    wire.visible = false;
    scene.add(wire);

    // Base grid helper — subtle, so it reads clean
    const gridHelper = new THREE.GridHelper(PLANE_SIZE, 8, 0x3a4657, 0x243040);
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.3;
    gridHelper.position.y = -0.1;
    gridHelper.name = 'gridHelper';
    scene.add(gridHelper);

    // Solid base slab — gives the model a clean platform edge (architectural look)
    const slabThickness = 3;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(PLANE_SIZE, slabThickness, PLANE_SIZE),
      new THREE.MeshStandardMaterial({ color: 0xe9ecf2, roughness: 1, metalness: 0 })
    );
    slab.position.y = -slabThickness / 2;
    slab.receiveShadow = true;
    slab.name = 'baseSlab';
    scene.add(slab);

    // Soft drop shadow beneath the model (only the shadow shows, via ShadowMaterial)
    const shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(PLANE_SIZE * 3, PLANE_SIZE * 3),
      new THREE.ShadowMaterial({ opacity: 0.16 })
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = -slabThickness - 0.05;
    shadowGround.receiveShadow = true;
    shadowGround.name = 'shadowGround';
    scene.add(shadowGround);

    structureGroup = new THREE.Group();
    scene.add(structureGroup);
    cityGroup = new THREE.Group();
    scene.add(cityGroup);
    roadGroup = new THREE.Group();
    scene.add(roadGroup);
    measureGroup = new THREE.Group();
    scene.add(measureGroup);
    gisGroup = new THREE.Group();
    scene.add(gisGroup);
    gisStats = { buildings: 0, roadsKm: 0, source: null };
    roads = [];
    roadDraft = [];
    measurePts = [];

    orbit.target.set(0, 2, 0);
    orbit.theta = 0.88;
    orbit.phi = 0.68;
    orbit.radius = 78;
    updateCameraFromOrbit();
    updateSunFromTime(getSunTime());
    applyVisualStyle(visualStyle); // apply current style (background, fog, terrain look)
    bindCanvasInteraction();
    startRenderLoop();
    onResize();
    scheduleTwinPreview();
  }

  // Colour vertices by elevation (blue -> green -> brown -> white)
  function applyVertexColors(geo, data, maxYOverride) {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const maxY = maxYOverride
      || (terrainMesh && terrainMesh.userData && terrainMesh.userData.maxHeightUnits)
      || 12;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, pos.getY(i) / maxY));
      const col = elevationColor(t);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  function elevationColor(t) {
    // gradient stops
    const stops = [
      { t: 0.0, c: [0.12, 0.32, 0.55] }, // water/low blue
      { t: 0.25, c: [0.18, 0.55, 0.35] }, // green lowland
      { t: 0.5, c: [0.55, 0.6, 0.3] }, // yellow-green
      { t: 0.75, c: [0.5, 0.38, 0.25] }, // brown highland
      { t: 1.0, c: [0.95, 0.95, 0.98] }, // snow peaks
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t || 1);
        return {
          r: a.c[0] + (b.c[0] - a.c[0]) * f,
          g: a.c[1] + (b.c[1] - a.c[1]) * f,
          b: a.c[2] + (b.c[2] - a.c[2]) * f,
        };
      }
    }
    return { r: 1, g: 1, b: 1 };
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------
  function startRenderLoop() {
    const loop = () => {
      animationId = requestAnimationFrame(loop);
      if (renderer && scene && camera) renderer.render(scene, camera);
    };
    loop();
  }

  function stopRenderLoop() {
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    if (renderer) {
      renderer.dispose();
      const wrap = document.getElementById('terrainCanvasWrap');
      if (wrap && renderer.domElement && renderer.domElement.parentNode === wrap) {
        wrap.removeChild(renderer.domElement);
      }
    }
  }

  function updateCameraFromOrbit() {
    if (!camera) return;
    const { theta, phi, radius, target } = orbit;
    const x = target.x + radius * Math.sin(phi) * Math.cos(theta);
    const y = target.y + radius * Math.cos(phi);
    const z = target.z + radius * Math.sin(phi) * Math.sin(theta);
    camera.position.set(x, y, z);
    camera.lookAt(target);
  }

  // ---------------------------------------------------------------------------
  // Canvas interaction: orbit + sculpt + place structure
  // ---------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  function bindCanvasInteraction() {
    const canvas = renderer.domElement;

    canvas.addEventListener('pointerdown', (e) => {
      isPointerDown = true;
      lastPointer = { x: e.clientX, y: e.clientY };
      if (editMode === 'raise' || editMode === 'lower' || editMode === 'smooth' || editMode === 'flatten') {
        beginStroke();
        if (editMode === 'flatten') flattenTargetY = sampleTerrainY(e);
        sculptAtPointer(e);
      } else if (editMode === 'structure') {
        placeStructureAtPointer(e);
      } else if (editMode === 'select' || editMode === 'move') {
        selectStructureAtPointer(e);
      } else if (editMode === 'delete') {
        deleteStructureAtPointer(e);
      } else if (editMode === 'zone') {
        paintZoneAtPointer(e);
      } else if (editMode === 'road') {
        addRoadPointAtPointer(e);
      } else if (editMode === 'measure') {
        measureClickAtPointer(e);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isPointerDown) return;
      if (editMode === 'orbit') {
        const dx = e.clientX - lastPointer.x;
        const dy = e.clientY - lastPointer.y;
        orbit.theta -= dx * 0.005;
        orbit.phi = Math.max(0.15, Math.min(Math.PI / 2.05, orbit.phi - dy * 0.005));
        updateCameraFromOrbit();
      } else if (editMode === 'raise' || editMode === 'lower' || editMode === 'smooth' || editMode === 'flatten') {
        sculptAtPointer(e);
      } else if (editMode === 'move' && selectedStructure) {
        moveSelectedToPointer(e);
      } else if (editMode === 'zone') {
        paintZoneAtPointer(e);
      }
      lastPointer = { x: e.clientX, y: e.clientY };
    });

    const endPointer = () => {
      if (isPointerDown) finishStroke();
      isPointerDown = false;
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointerleave', endPointer);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbit.radius = Math.max(25, Math.min(400, orbit.radius + e.deltaY * 0.08));
      updateCameraFromOrbit();
    }, { passive: false });
  }

  // Capture terrain heights before a sculpt stroke so it can be undone
  function beginStroke() {
    if (!terrainMesh) return;
    const pos = terrainMesh.geometry.attributes.position;
    strokeSnapshot = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) strokeSnapshot[i] = pos.getY(i);
  }

  function finishStroke() {
    if (!strokeSnapshot || !terrainMesh) { strokeSnapshot = null; return; }
    const snap = strokeSnapshot;
    strokeSnapshot = null;
    pushUndo(() => {
      const pos = terrainMesh.geometry.attributes.position;
      for (let i = 0; i < pos.count && i < snap.length; i++) pos.setY(i, snap[i]);
      pos.needsUpdate = true;
      terrainMesh.geometry.computeVertexNormals();
      applyVertexColors(terrainMesh.geometry, terrainData);
      terrainMesh.geometry.attributes.color.needsUpdate = true;
      refreshWireframe();
    });
  }

  // Raycast the terrain and return the world-space Y at the pointer (or null)
  function sampleTerrainY(e) {
    if (!terrainMesh) return null;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return null;
    return terrainMesh.worldToLocal(hits[0].point.clone()).y;
  }

  function pointerToNDC(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function sculptAtPointer(e) {
    if (!terrainMesh) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;

    const localPoint = terrainMesh.worldToLocal(hits[0].point.clone());
    const pos = terrainMesh.geometry.attributes.position;
    const radiusSq = brushRadius * brushRadius;
    let changed = false;

    // Smooth needs neighbour average — precompute grid access
    const res = terrainMesh.userData.res;

    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - localPoint.x;
      const dz = pos.getZ(i) - localPoint.z;
      const dSq = dx * dx + dz * dz;
      if (dSq > radiusSq) continue;
      const falloff = 1 - Math.sqrt(dSq) / brushRadius; // 1 at centre -> 0 at edge

      if (editMode === 'raise') {
        pos.setY(i, pos.getY(i) + brushStrength * falloff);
        changed = true;
      } else if (editMode === 'lower') {
        pos.setY(i, Math.max(0, pos.getY(i) - brushStrength * falloff));
        changed = true;
      } else if (editMode === 'smooth') {
        const r = Math.floor(i / res);
        const c = i % res;
        let sum = 0, n = 0;
        for (let rr = r - 1; rr <= r + 1; rr++) {
          for (let cc = c - 1; cc <= c + 1; cc++) {
            if (rr < 0 || cc < 0 || rr >= res || cc >= res) continue;
            sum += pos.getY(rr * res + cc);
            n++;
          }
        }
        const avg = sum / n;
        pos.setY(i, pos.getY(i) + (avg - pos.getY(i)) * 0.5 * falloff);
        changed = true;
      } else if (editMode === 'flatten' && flattenTargetY !== null) {
        pos.setY(i, pos.getY(i) + (flattenTargetY - pos.getY(i)) * falloff);
        changed = true;
      }
    }

    if (changed) {
      sculptCount++;
      digitalTwinState.scenario.terrainEdits.push({ type: editMode });
      pos.needsUpdate = true;
      terrainMesh.geometry.computeVertexNormals();
      applyVertexColors(terrainMesh.geometry, terrainData);
      terrainMesh.geometry.attributes.color.needsUpdate = true;
      refreshWireframe();
      scheduleTwinPreview();
    }
  }

  // ---------------------------------------------------------------------------
  // Objects (structures) — build / place / select / move / delete, Blender-style
  // ---------------------------------------------------------------------------
  function buildStructureMesh(type, sizeScale) {
    const s = sizeScale || 1;
    let geo, color, h;
    switch (type) {
      case 'tower':
        h = 14 * s; geo = new THREE.CylinderGeometry(0.7, 1.1, h, 10); color = 0x94a3b8; break;
      case 'bridge':
        h = 1.4; geo = new THREE.BoxGeometry(14 * s, h, 3); color = 0xcbd5e1; break;
      case 'dam':
        h = 9 * s; geo = new THREE.BoxGeometry(16 * s, h, 2.4); color = 0x64748b; break;
      case 'tree':
        h = 6 * s; geo = new THREE.ConeGeometry(2 * s, h, 8); color = 0x22c55e; break;
      case 'marker':
        h = 3 * s; geo = new THREE.SphereGeometry(1.4 * s, 18, 14); color = 0xef4444; break;
      case 'road':
        h = 0.4; geo = new THREE.BoxGeometry(4 * s, h, 16 * s); color = 0x334155; break;
      default: // building
        h = 7 * s; geo = new THREE.BoxGeometry(3 * s, h, 3 * s); color = 0xf59e0b; break;
    }
    const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.baseColor = color;
    mesh.userData.heightUnits = h;
    return mesh;
  }

  // Position a structure mesh so its base sits on the terrain at (x,z)
  function seatStructure(mesh, x, z) {
    const y = terrainSurfaceY(x, z);
    const rec = mesh.userData.record;
    // GIS buildings are extruded from a y=0 base; boxes are centred
    const off = rec && rec.source === 'gis' ? 0 : mesh.userData.heightUnits / 2;
    mesh.position.set(x, y + off, z);
  }

  // Approximate terrain surface world-Y at local x,z by raycasting downward
  function terrainSurfaceY(x, z) {
    if (!terrainMesh) return 0;
    raycaster.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(terrainMesh);
    return hits.length ? hits[0].point.y : 0;
  }

  function addStructure(record, mesh) {
    record.mesh = mesh;
    mesh.userData.record = record;
    structureGroup.add(mesh);
    structures.push(record);
    if (record.type === 'building') digitalTwinState.scenario.addedBuildings.push(record);
    else if (record.type === 'tree') digitalTwinState.scenario.vegetationChanges.push(record);
    updateStatsPanel();
    scheduleTwinPreview();
    pushUndo(() => removeStructure(record, true));
  }

  function removeStructure(record, silent) {
    const idx = structures.indexOf(record);
    if (idx === -1) return;
    structures.splice(idx, 1);
    const scenarioIndex = digitalTwinState.scenario.addedBuildings.indexOf(record);
    if (scenarioIndex >= 0) digitalTwinState.scenario.addedBuildings.splice(scenarioIndex, 1);
    if (record.mesh) structureGroup.remove(record.mesh);
    if (record.source === 'gis' && gisStats.buildings > 0) gisStats.buildings--;
    if (selectedStructure === record) { selectedStructure = null; updateSelectionInfo(); }
    updateStatsPanel();
    scheduleTwinPreview();
    if (!silent) {
      pushUndo(() => {
        const mesh = buildStructureMesh(record.type, record.sizeScale);
        addStructure(record, mesh);
        seatStructure(mesh, record.nx * PLANE_SIZE, record.nz * PLANE_SIZE);
      });
    }
  }

  function placeStructureAtPointer(e) {
    if (!terrainMesh) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;

    const p = hits[0].point.clone();
    const type = document.getElementById('structureType')?.value || 'building';
    const mesh = buildStructureMesh(type, structureSize);
    const record = {
      type,
      nx: p.x / PLANE_SIZE,
      nz: p.z / PLANE_SIZE,
      sizeScale: structureSize,
      heightUnits: mesh.userData.heightUnits,
    };
    addStructure(record, mesh);
    seatStructure(mesh, p.x, p.z);
    selectStructure(record);
  }

  function structureHitAtPointer(e) {
    if (!structureGroup) return null;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(structureGroup.children, false);
    return hits.length ? hits[0].object : null;
  }

  function selectStructureAtPointer(e) {
    const mesh = structureHitAtPointer(e);
    selectStructure(mesh ? mesh.userData.record : null);
  }

  function deleteStructureAtPointer(e) {
    const mesh = structureHitAtPointer(e);
    if (mesh && mesh.userData.record) removeStructure(mesh.userData.record);
  }

  function selectStructure(record) {
    // clear previous highlight
    if (selectedStructure && selectedStructure.mesh) {
      selectedStructure.mesh.material.emissive?.setHex(0x000000);
    }
    selectedStructure = record || null;
    if (selectedStructure && selectedStructure.mesh) {
      selectedStructure.mesh.material.emissive?.setHex(0x2563eb);
    }
    updateSelectionInfo();
  }

  function deleteSelected() {
    if (selectedStructure) removeStructure(selectedStructure);
  }

  function moveSelectedToPointer(e) {
    if (!selectedStructure || !terrainMesh) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;
    const p = hits[0].point;
    selectedStructure.nx = p.x / PLANE_SIZE;
    selectedStructure.nz = p.z / PLANE_SIZE;
    seatStructure(selectedStructure.mesh, p.x, p.z);
    if (!digitalTwinState.scenario.modifiedBuildings.includes(selectedStructure) && selectedStructure.type === 'building') digitalTwinState.scenario.modifiedBuildings.push(selectedStructure);
    scheduleTwinPreview();
  }

  function updateSelectionInfo() {
    const el = document.getElementById('terrainSelection');
    if (!el) return;
    if (!selectedStructure) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const heightInfo = selectedStructure.heightMeters
      ? ` · ${Math.round(selectedStructure.heightMeters)} m`
      : '';
    el.innerHTML =
      `<span>Selected: <strong>${selectedStructure.type}</strong>${heightInfo}</span>` +
      `<span class="terrain-sel-actions">` +
      `<button class="btn secondary small" id="terrainHeightUpBtn" title="Taller">▲</button>` +
      `<button class="btn secondary small" id="terrainHeightDownBtn" title="Shorter">▼</button>` +
      `<button class="btn secondary small" id="terrainDeleteSelBtn">🗑️ Delete</button>` +
      `</span>`;
    document.getElementById('terrainDeleteSelBtn')?.addEventListener('click', deleteSelected);
    document.getElementById('terrainHeightUpBtn')?.addEventListener('click', () => adjustSelectedHeight(1.25));
    document.getElementById('terrainHeightDownBtn')?.addEventListener('click', () => adjustSelectedHeight(0.8));
  }

  // Adjust the height of the selected object (parametric edit of the primitive)
  function adjustSelectedHeight(factor) {
    const rec = selectedStructure;
    if (!rec || !rec.mesh) return;
    const newScale = Math.max(0.1, (rec.mesh.scale.y || 1) * factor);
    rec.mesh.scale.y = newScale;
    if (rec.heightMeters) rec.heightMeters = Math.max(1, rec.heightMeters * factor);
    if (rec.source !== 'gis') {
      // re-seat centred meshes so the base stays on the ground
      seatStructure(rec.mesh, rec.nx * PLANE_SIZE, rec.nz * PLANE_SIZE);
    }
    updateSelectionInfo();
    updateStatsPanel();
  }

  // ---------------------------------------------------------------------------
  // Undo (Blender-style Ctrl+Z) — stack of revert callbacks
  // ---------------------------------------------------------------------------
  function pushUndo(fn) {
    undoStack.push(fn);
    if (undoStack.length > 50) undoStack.shift();
  }

  function undo() {
    const fn = undoStack.pop();
    if (fn) fn();
  }

  // ===========================================================================
  // CITY PLANNING — zoning, procedural generation, roads, solar, measurement
  // (inspired by Autodesk InfraWorks & Esri CityEngine)
  // ===========================================================================

  // --- Land-use zoning ------------------------------------------------------
  function initZoneLayer(res) {
    zoneGrid = new Array(res * res).fill('none');
    zoneCanvas = document.createElement('canvas');
    zoneCanvas.width = res;
    zoneCanvas.height = res;
    const ctx = zoneCanvas.getContext('2d');
    ctx.clearRect(0, 0, res, res);
    zoneTexture = new THREE.CanvasTexture(zoneCanvas);
    zoneTexture.magFilter = THREE.NearestFilter;
    zoneTexture.minFilter = THREE.LinearFilter;
    zoneTexture.needsUpdate = true;
    digitalTwinState.scenario.landUseChanges.push({ zone: currentZone });
    scheduleTwinPreview();
  }

  // Map a terrain hit (local x,z) to a zone cell row/col
  function worldToCell(x, z, res) {
    const nx = x / PLANE_SIZE + 0.5; // 0..1 west->east
    const nz = z / PLANE_SIZE + 0.5; // 0..1
    const col = Math.max(0, Math.min(res - 1, Math.floor(nx * res)));
    const row = Math.max(0, Math.min(res - 1, Math.floor(nz * res)));
    return { row, col };
  }

  function setZone(zone) {
    currentZone = zone;
    if (zoneOverlay) zoneOverlay.visible = true;
  }

  function paintZoneAtPointer(e) {
    if (!terrainMesh || !zoneCanvas) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;
    const lp = terrainMesh.worldToLocal(hits[0].point.clone());
    const res = terrainMesh.userData.res;
    const { row, col } = worldToCell(lp.x, lp.z, res);
    const ctx = zoneCanvas.getContext('2d');
    const zcfg = ZONES[currentZone];
    const rad = Math.max(0, Math.round(brushRadius / 2));

    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const rr = row + dr, cc = col + dc;
        if (rr < 0 || cc < 0 || rr >= res || cc >= res) continue;
        if (dr * dr + dc * dc > rad * rad + 1) continue;
        zoneGrid[rr * res + cc] = currentZone;
        if (currentZone === 'none') ctx.clearRect(cc, rr, 1, 1);
        else { ctx.fillStyle = zcfg.color; ctx.fillRect(cc, rr, 1, 1); }
      }
    }
    zoneTexture.needsUpdate = true;
    scheduleTwinPreview();
    if (zoneOverlay && !zoneOverlay.visible) {
      zoneOverlay.visible = true;
      const btn = document.getElementById('terrainZoneViewBtn');
      if (btn) btn.textContent = '🗺️ Zones: on';
    }
  }

  function toggleZoneOverlay() {
    if (!zoneOverlay) return;
    zoneOverlay.visible = !zoneOverlay.visible;
    const btn = document.getElementById('terrainZoneViewBtn');
    if (btn) btn.textContent = zoneOverlay.visible ? '🗺️ Zones: on' : '🗺️ Zones: off';
  }

  function clearZones() {
    if (!terrainMesh) return;
    const res = terrainMesh.userData.res;
    zoneGrid.fill('none');
    zoneCanvas.getContext('2d').clearRect(0, 0, res, res);
    zoneTexture.needsUpdate = true;
  }

  // Deterministic helper for user-created scenario geometry. Same inputs always
  // produce the same layout. This is NOT used as an observed-data substitute.
  function stable01(a, b, salt = 0) {
    const v = Math.sin((a + 1) * 12.9898 + (b + 1) * 78.233 + salt * 37.719) * 43758.5453;
    return v - Math.floor(v);
  }

  // --- Procedural city generation (CityEngine-style) ------------------------
  function cellCenterWorld(row, col, res) {
    const x = ((col + 0.5) / res - 0.5) * PLANE_SIZE;
    const z = ((row + 0.5) / res - 0.5) * PLANE_SIZE;
    return { x, z };
  }

  function generateCity() {
    if (!terrainMesh) { setStatus('Generate a terrain first.', 'error'); return; }
    const painted = zoneGrid.some((z) => z !== 'none');
    if (!painted) {
      setStatus('Paint some zones first (use the 🎨 Zone tool), then Generate City.', 'error');
      return;
    }
    clearCity();
    const res = terrainMesh.userData.res;
    let built = 0;

    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const zone = zoneGrid[r * res + c];
        const cfg = ZONES[zone];
        if (!cfg || zone === 'none' || zone === 'water') continue;
        if (stable01(r, c, 1) > (cfg.density ?? 0.5)) continue;
        const { x, z } = cellCenterWorld(r, c, res);
        // jitter within the cell footprint
        const jx = x + (stable01(r, c, 2) - 0.5) * (PLANE_SIZE / res) * 0.35;
        const jz = z + (stable01(r, c, 3) - 0.5) * (PLANE_SIZE / res) * 0.35;
        const mesh = zone === 'park' ? makeTree(r, c) : makeZoneBuilding(zone, r, c);
        seatOnTerrain(mesh, jx, jz);
        cityGroup.add(mesh);
        built++;
      }
    }
    updateStatsPanel();
    setStatus(`🏙️ Generated ${built} structures from your zoning plan.`, 'ok');
  }

  function makeZoneBuilding(zone, row = 0, col = 0) {
    const cfg = ZONES[zone];
    const floors = Math.max(1, Math.round((cfg.hMin + stable01(row, col, 4) * (cfg.hMax - cfg.hMin)) / FLOOR_UNITS));
    const h = floors * FLOOR_UNITS;
    const w = cfg.foot * (0.82 + stable01(row, col, 5) * 0.30);
    const d = cfg.foot * (0.82 + stable01(row, col, 6) * 0.30);
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({ color: cfg.hex, metalness: 0.15, roughness: 0.7 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { heightUnits: h, floors, zone };
    return mesh;
  }

  function makeTree(row = 0, col = 0) {
    const h = 3.5 + stable01(row, col, 7) * 1.5;
    const geo = new THREE.ConeGeometry(1.15 + stable01(row, col, 8) * 0.45, h, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.userData = { heightUnits: h, zone: 'park' };
    return mesh;
  }

  function seatOnTerrain(mesh, x, z) {
    const y = terrainSurfaceY(x, z);
    mesh.position.set(x, y + mesh.userData.heightUnits / 2, z);
  }

  function clearCity() {
    if (cityGroup) while (cityGroup.children.length) cityGroup.remove(cityGroup.children[0]);
    updateStatsPanel();
  }

  // --- Roads (InfraWorks-style corridor) ------------------------------------
  function addRoadPointAtPointer(e) {
    if (!terrainMesh) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;
    const p = hits[0].point.clone();
    p.y += 0.4;
    roadDraft.push(p);
    rebuildRoadDraft();
  }

  function rebuildRoadDraft() {
    const existing = roadGroup.getObjectByName('roadDraft');
    if (existing) roadGroup.remove(existing);
    if (roadDraft.length < 2) return;
    const mesh = buildRoadMesh(roadDraft, 0x38bdf8);
    mesh.name = 'roadDraft';
    roadGroup.add(mesh);
  }

  function buildRoadMesh(points, color) {
    const curve = new THREE.CatmullRomCurve3(points);
    const seg = Math.max(8, points.length * 12);
    const geo = new THREE.TubeGeometry(curve, seg, 1.2, 6, false);
    const mat = new THREE.MeshStandardMaterial({ color: color || 0x334155, roughness: 0.8, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  function finishRoad() {
    if (roadDraft.length < 2) { setStatus('Click at least 2 points on the map to draw a road.', 'error'); return; }
    const draft = roadGroup.getObjectByName('roadDraft');
    if (draft) roadGroup.remove(draft);
    const mesh = buildRoadMesh(roadDraft, 0x1f2937);
    roadGroup.add(mesh);
    const record = { points: roadDraft.slice(), mesh };
    roads.push(record);
    digitalTwinState.scenario.addedRoads.push(record);
    const captured = roadDraft.slice();
    roadDraft = [];
    updateStatsPanel();
    scheduleTwinPreview();
    setStatus(`🛣️ Road added (${captured.length} waypoints). Total roads: ${roads.length}.`, 'ok');
    pushUndo(() => {
      roadGroup.remove(mesh);
      const i = roads.indexOf(record);
      if (i > -1) roads.splice(i, 1);
      updateStatsPanel();
      scheduleTwinPreview();
    });
  }

  // --- Measurement ----------------------------------------------------------
  function measureClickAtPointer(e) {
    if (!terrainMesh) return;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (!hits.length) return;
    const p = hits[0].point.clone();
    if (measurePts.length >= 2) clearMeasure();
    measurePts.push(p);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xf43f5e })
    );
    dot.position.copy(p);
    measureGroup.add(dot);

    if (measurePts.length === 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(measurePts),
        new THREE.LineBasicMaterial({ color: 0xf43f5e })
      );
      measureGroup.add(line);
      const worldDist = measurePts[0].distanceTo(measurePts[1]);
      const metersPerUnit = (terrainData.areaKm * 1000) / PLANE_SIZE;
      const meters = worldDist * metersPerUnit;
      const label = meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
      setStatus(`📏 Distance: ${label} (straight line)`, 'ok');
    }
  }

  function clearMeasure() {
    if (measureGroup) while (measureGroup.children.length) measureGroup.remove(measureGroup.children[0]);
    measurePts = [];
  }

  // --- Solar / shadow study -------------------------------------------------
  function getSunTime() {
    const el = document.getElementById('terrainSunTime');
    return el ? parseFloat(el.value) : 12;
  }

  function updateSunFromTime(hour) {
    if (!sunLight) return;
    // Map 6..18h to an east->west arc; elevation peaks at noon
    const t = Math.max(0, Math.min(1, (hour - 6) / 12));
    const azimuth = Math.PI * t; // 0=east .. PI=west
    const elevation = Math.sin(Math.PI * t) * (Math.PI / 2) * 0.9 + 0.05;
    const R = 120;
    sunLight.position.set(
      Math.cos(azimuth) * R * Math.cos(elevation),
      Math.max(4, Math.sin(elevation) * R),
      Math.sin(azimuth) * R * Math.cos(elevation) - 20
    );
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();
    // Warmer light near sunrise/sunset
    const warmth = 1 - Math.sin(Math.PI * t);
    sunLight.color.setRGB(1, 1 - warmth * 0.35, 1 - warmth * 0.55);
  }

  function toggleShadows() {
    setShadows(!shadowsOn);
  }

  // Enable/disable the shadow-casting sun (gives AO-like depth on clean models)
  function setShadows(on) {
    shadowsOn = on;
    if (sunLight) sunLight.castShadow = on;
    const sground = scene && scene.getObjectByName('shadowGround');
    if (sground) sground.visible = on;
    const btn = document.getElementById('terrainSunBtn');
    if (btn) btn.textContent = on ? '🌇 Sun study: on' : '🌞 Sun study: off';
  }

  // --- Planning statistics --------------------------------------------------
  function computePlanningStats() {
    const res = terrainMesh ? terrainMesh.userData.res : 0;
    const cellAreaM2 = terrainData ? Math.pow((terrainData.areaKm * 1000) / res, 2) : 0;
    const landUse = { residential: 0, commercial: 0, industrial: 0, park: 0, water: 0, none: 0 };
    if (zoneGrid) zoneGrid.forEach((z) => { landUse[z] = (landUse[z] || 0) + 1; });

    let buildings = 0, floors = 0, population = 0;
    if (cityGroup) {
      cityGroup.children.forEach((m) => {
        const u = m.userData || {};
        if (u.zone && u.zone !== 'park') {
          buildings++;
          floors += u.floors || 1;
          const pop = (ZONES[u.zone]?.popPerFloor || 0) * (u.floors || 1);
          population += pop;
        }
      });
    }
    const floorAreaM2 = Math.round(floors * 120); // ~120 m² average floor plate
    const roadLenM = roads.reduce((sum, rd) => {
      let d = 0;
      for (let i = 1; i < rd.points.length; i++) d += rd.points[i].distanceTo(rd.points[i - 1]);
      return sum + d;
    }, 0) * (terrainData ? (terrainData.areaKm * 1000) / PLANE_SIZE : 0);

    const zonedCells = res * res - (landUse.none || 0);
    const pct = (n) => (zonedCells ? Math.round((n / zonedCells) * 100) : 0);

    return {
      buildings,
      floors,
      population,
      floorAreaM2,
      roadLengthM: Math.round(roadLenM),
      gisBuildings: gisStats.buildings || 0,
      gisRoadsKm: gisStats.roadsKm || 0,
      gisSource: gisStats.source,
      landUseCells: landUse,
      landUseAreaM2: {
        residential: Math.round(landUse.residential * cellAreaM2),
        commercial: Math.round(landUse.commercial * cellAreaM2),
        industrial: Math.round(landUse.industrial * cellAreaM2),
        park: Math.round(landUse.park * cellAreaM2),
        water: Math.round(landUse.water * cellAreaM2),
      },
      landUsePct: {
        residential: pct(landUse.residential),
        commercial: pct(landUse.commercial),
        industrial: pct(landUse.industrial),
        park: pct(landUse.park),
        water: pct(landUse.water),
      },
    };
  }

  // ===========================================================================
  // GIS → 3D — pull real OpenStreetMap features (buildings, roads, land-use)
  // and parametrically extrude them into GPU-merged polygonal geometry that is
  // rendered through Three.js's standard WebGL rasterization pipeline.
  // ===========================================================================

  function gisBBox() {
    const c = terrainData.center;
    const areaKm = terrainData.areaKm;
    const halfLat = (areaKm / 2) / 111;
    const halfLng = (areaKm / 2) / (111 * Math.cos(c.lat * Math.PI / 180) || 1);
    return { s: c.lat - halfLat, w: c.lng - halfLng, n: c.lat + halfLat, e: c.lng + halfLng };
  }

  function geoToLocal(lat, lng) {
    const b = gisBBox();
    const fx = (lng - b.w) / (b.e - b.w);
    const fy = (b.n - lat) / (b.n - b.s); // north -> south
    return { x: (fx - 0.5) * PLANE_SIZE, z: (fy - 0.5) * PLANE_SIZE };
  }

  function metersToUnits() {
    return PLANE_SIZE / (terrainData.areaKm * 1000);
  }

  async function importGISData() {
    if (!terrainData) { setStatus('Generate a terrain first.', 'error'); return; }
    const b = gisBBox();
    const bbox = `${b.s},${b.w},${b.n},${b.e}`;
    const query =
`[out:json][timeout:30];
(
  way["building"](${bbox});
  way["highway"](${bbox});
  way["natural"="water"](${bbox});
  way["waterway"](${bbox});
  way["leisure"="park"](${bbox});
  way["landuse"~"grass|forest|meadow|recreation_ground"](${bbox});
);
out geom;`;

    setStatus('🏢 Downloading GIS features from OpenStreetMap…', 'busy');
    let data = null;
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        data = await res.json();
        if (data && data.elements) break;
      } catch (e) { /* try next mirror */ }
    }
    if (!data || !data.elements) {
      setStatus('❌ GIS service unavailable or too busy. Try again, or use a smaller area.', 'error');
      return;
    }

    clearGIS();
    const buildings = [], roadWays = [], areas = [];
    data.elements.forEach((el) => {
      if (el.type !== 'way' || !el.geometry) return;
      const t = el.tags || {};
      if (t.building) buildings.push(el);
      else if (t.highway) roadWays.push(el);
      else if (t.natural === 'water' || t.waterway) areas.push({ el, color: 0x2aa7e0 });
      else if (t.leisure === 'park' || t.landuse) areas.push({ el, color: 0x35c46a });
    });

    // Preserve every returned GIS feature for RF feature extraction before capping rendering.
    gisSourceData.buildings = buildings.map(buildObservedBuildingFeature).filter(Boolean);
    gisSourceData.roads = roadWays.slice();
    gisSourceData.water = areas.filter(area => area.color === 0x2aa7e0).map(area => area.el);
    gisSourceData.vegetation = areas.filter(area => area.color === 0x35c46a).map(area => area.el);
    digitalTwinState.observed.buildings = gisSourceData.buildings;
    digitalTwinState.observed.roads = gisSourceData.roads;
    digitalTwinState.observed.water = gisSourceData.water;
    digitalTwinState.observed.vegetation = gisSourceData.vegetation;
    digitalTwinState.observed.landCover = areas.map(area => area.el);
    digitalTwinState.observed.metadata = { source: 'OpenStreetMap (Overpass)', sourceBuildingCount: gisSourceData.buildings.length };
    gisRenderData.buildings = gisSourceData.buildings.slice(0, BUILDING_EDIT_CAP);
    gisRenderData.roads = gisSourceData.roads;
    gisRenderData.water = gisSourceData.water;
    gisRenderData.vegetation = gisSourceData.vegetation;

    setStatus(`🏗️ Extruding ${gisRenderData.buildings.length} of ${gisSourceData.buildings.length} buildings & ${roadWays.length} roads…`, 'busy');
    await new Promise((r) => setTimeout(r, 30)); // let the UI paint

    const builtBuildings = buildBuildingsMesh(gisRenderData.buildings);
    const roadMeters = buildRoadsMesh(roadWays);
    buildAreaMeshes(areas);
    restyleBuildings(visualStyle);
    restyleRoads(visualStyle);
    restyleGISSurfaceFeatures(visualStyle);

    gisStats = {
      buildings: builtBuildings,
      sourceBuildingCount: gisSourceData.buildings.length,
      renderedBuildingCount: builtBuildings,
      roadsKm: Math.round((roadMeters / 1000) * 100) / 100,
      source: 'OpenStreetMap (Overpass)',
    };
    updateStatsPanel();
    setStatus(`✅ GIS imported: ${gisStats.sourceBuildingCount} source buildings · ${builtBuildings} rendered · ${gisStats.roadsKm} km roads (OpenStreetMap).`, 'ok');
  }

  function buildingHeightMetadata(tags) {
    let height = null, source = 'visualization_default', confidence = 0.30;
    if (tags.height && Number.isFinite(parseFloat(tags.height))) { height = parseFloat(tags.height); source = 'osm_height'; confidence = 0.90; }
    else if (tags['building:levels'] && Number.isFinite(parseFloat(tags['building:levels']))) { height = parseFloat(tags['building:levels']) * DEFAULT_FLOOR_M; source = 'osm_levels_derived'; confidence = 0.75; }
    if (height === null) height = DEFAULT_FLOOR_M * 3;
    return { height_m: Math.max(3, Math.min(400, height)), height_source: source, height_confidence: confidence };
  }

  function polygonAreaM2(geometry) {
    if (!geometry || geometry.length < 3 || !terrainData) return null;
    const points = geometry.map(point => geoToLocal(point.lat, point.lon));
    let twiceArea = 0;
    points.forEach((point, index) => { const next = points[(index + 1) % points.length]; twiceArea += point.x * next.z - next.x * point.z; });
    const metresPerUnit = (terrainData.areaKm * 1000) / PLANE_SIZE;
    return Math.abs(twiceArea / 2) * metresPerUnit * metresPerUnit;
  }

  function buildObservedBuildingFeature(el) {
    if (!el?.geometry || el.geometry.length < 3) return null;
    const height = buildingHeightMetadata(el.tags || {});
    return { id: `osm-way-${el.id}`, footprint_area_m2: polygonAreaM2(el.geometry), geometry: el.geometry, ...height };
  }

  // Material for a building given the active visual style (Google-3D-Maps presets)
  function buildingMaterialForStyle(style) {
    if (style === 'white') {
      // uniform matte near-white (earth3dmap / architectural clean-model look)
      return new THREE.MeshStandardMaterial({ color: 0xf6f7fa, roughness: 1.0, metalness: 0.0, flatShading: true });
    }
    if (style === 'realistic') {
      return new THREE.MeshStandardMaterial({ color: 0xb9c1c9, roughness: 0.7, metalness: 0.12, flatShading: true });
    }
    return new THREE.MeshStandardMaterial({ color: 0xcbd2d9, roughness: 0.85, metalness: 0.05, flatShading: true });
  }

  // Parametric extrusion of building footprints as INDIVIDUALLY EDITABLE
  // primitives (feature-based modeling → clean, selectable/movable/deletable solids)
  function buildBuildingsMesh(features) {
    const m2u = metersToUnits();
    const half = PLANE_SIZE / 2;
    // Shared thin dark outline material (crisp architectural edges)
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x7b818a, transparent: true, opacity: 0.42 });
    let count = 0;
    for (const feature of features) {
      const g = feature.geometry;
      if (!g || g.length < 3) continue;
      const world = g.map((p) => geoToLocal(p.lat, p.lon));
      let cx = 0, cz = 0;
      world.forEach((p) => { cx += p.x; cz += p.z; });
      cx /= world.length; cz /= world.length;
      // Skip buildings whose footprint centre falls outside the model footprint
      if (cx < -half || cx > half || cz < -half || cz > half) continue;
      // Footprint shape centred on its centroid → mesh positioned at centroid
      const shape = new THREE.Shape();
      shape.moveTo(world[0].x - cx, -(world[0].z - cz));
      for (let i = 1; i < world.length; i++) shape.lineTo(world[i].x - cx, -(world[i].z - cz));
      const hMeters = feature.height_m;
      const hUnits = Math.max(0.6, Math.min(22, hMeters * m2u * GIS_HEIGHT_SCALE * verticalExaggeration));
      let geo;
      try {
        geo = new THREE.ExtrudeGeometry(shape, { depth: hUnits, bevelEnabled: false, steps: 1 });
      } catch (e) { continue; }
      geo.rotateX(-Math.PI / 2); // base at y=0, extruded upward

      const mat = buildingMaterialForStyle(visualStyle);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.position.set(cx, terrainSurfaceY(cx, cz), cz);

      // Crisp outline as a child (follows move/scale/delete → stays editable)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat);
      edges.name = 'edges';
      mesh.add(edges);

      mesh.userData = { heightUnits: hUnits, heightMeters: hMeters, height_source: feature.height_source, height_confidence: feature.height_confidence, observedFeatureId: feature.id };
      gisGroup.add(mesh);
      if (++count >= BUILDING_EDIT_CAP) break; // rendering cap only; source data remains complete
    }
    return count;
  }

  function roadWidthMeters(tags) {
    const map = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 6, residential: 5, service: 3.5, footway: 1.5, path: 1.2, cycleway: 2 };
    return map[tags.highway] || 4;
  }

  function buildRoadsMesh(ways) {
    const m2u = metersToUnits();
    const half = PLANE_SIZE / 2;
    const geos = [];
    let totalMeters = 0;
    for (const el of ways) {
      const g = el.geometry;
      if (!g || g.length < 2) continue;
      const pts = [];
      for (let i = 0; i < g.length; i++) {
        const l = geoToLocal(g[i].lat, g[i].lon);
        // Clip road nodes to the model footprint so highways don't spike past the edge
        if (l.x < -half || l.x > half || l.z < -half || l.z > half) continue;
        pts.push(new THREE.Vector3(l.x, terrainSurfaceY(l.x, l.z) + 0.3, l.z));
      }
      if (pts.length < 2) continue;
      for (let i = 1; i < pts.length; i++) totalMeters += pts[i].distanceTo(pts[i - 1]) / m2u;
      const radius = Math.max(0.12, (roadWidthMeters(el.tags || {}) / 2) * m2u); // true-ish width, not doubled
      let geo;
      try {
        const curve = new THREE.CatmullRomCurve3(pts);
        geo = new THREE.TubeGeometry(curve, Math.max(4, pts.length * 3), radius, 5, false);
      } catch (e) { continue; }
      geos.push(geo);
    }
    if (!geos.length) return 0;
    const merged = mergeGeos(geos);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9, metalness: 0.0 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    mesh.name = 'gisRoads';
    gisGroup.add(mesh);
    return totalMeters;
  }

  function buildAreaMeshes(areas) {
    for (const a of areas) {
      const g = a.el.geometry;
      if (!g || g.length < 3) continue;
      const pts = g.map((p) => geoToLocal(p.lat, p.lon));
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].z);
      let cx = 0, cz = 0;
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
      pts.forEach((p) => { cx += p.x; cz += p.z; });
      cx /= pts.length; cz /= pts.length;
      let geo;
      try { geo = new THREE.ShapeGeometry(shape); } catch (e) { continue; }
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, terrainSurfaceY(cx, cz) + 0.15, 0);
      const isGreen = a.color === 0x35c46a;
      const mat = new THREE.MeshStandardMaterial({ color: a.color, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.62, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'gisArea';
      mesh.userData.kind = isGreen ? 'green' : 'water';
      gisGroup.add(mesh);
      if (isGreen) scatterTrees(pts, cx, cz);
    }
  }

  // Deterministic tree proxies for the architectural view. These are derived only
  // from a real mapped green polygon, are never random, and are marked as visual-only
  // so they must NOT be sent to the environmental model as observed tree locations.
  function pointInPolygonXZ(x, z, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, zi = pts[i].z;
      const xj = pts[j].x, zj = pts[j].z;
      const hit = ((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  function scatterTrees(pts, cx, cz) {
    const half = PLANE_SIZE / 2;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
    const area = Math.max(0, (maxX - minX) * (maxZ - minZ));
    if (area <= 0) return;
    const target = Math.max(1, Math.min(24, Math.round(area / 18)));
    const cols = Math.max(1, Math.ceil(Math.sqrt(target * ((maxX - minX) / Math.max(0.001, maxZ - minZ)))));
    const rows = Math.max(1, Math.ceil(target / cols));
    const dx = (maxX - minX) / (cols + 1);
    const dz = (maxZ - minZ) / (rows + 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf4f5f3, roughness: 1.0, metalness: 0.0 });
    let made = 0;
    for (let r = 1; r <= rows && made < target; r++) {
      for (let c = 1; c <= cols && made < target; c++) {
        const x = minX + c * dx;
        const z = minZ + r * dz;
        if (x < -half || x > half || z < -half || z > half || !pointInPolygonXZ(x, z, pts)) continue;
        const radius = 0.48;
        const s = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), mat);
        s.position.set(x, terrainSurfaceY(x, z) + radius, z);
        s.castShadow = true;
        s.receiveShadow = true;
        s.name = 'gisTree';
        s.userData = { source: 'green-area-visualization', analytical: false };
        gisGroup.add(s);
        made++;
      }
    }
  }

  // GPU-friendly: merge many feature geometries into a single buffer (few draw calls)
  function mergeGeos(geos) {
    const util = THREE.BufferGeometryUtils;
    if (util && util.mergeBufferGeometries) {
      const cleaned = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = util.mergeBufferGeometries(cleaned, false);
      if (merged) { merged.computeVertexNormals(); return merged; }
    }
    return geos[0];
  }

  function clearGIS() {
    if (gisGroup) {
      while (gisGroup.children.length) {
        const c = gisGroup.children[0];
        gisGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
      }
    }
    // Remove previously imported editable GIS building primitives
    const remaining = [];
    structures.forEach((s) => {
      if (s.source === 'gis') {
        if (s.mesh && structureGroup) structureGroup.remove(s.mesh);
        if (s === selectedStructure) { selectedStructure = null; }
      } else {
        remaining.push(s);
      }
    });
    structures = remaining;
    updateSelectionInfo();
    gisStats = { buildings: 0, roadsKm: 0, source: null };
  }

  // ---------------------------------------------------------------------------
  // Visual style presets (Google-3D-Maps-inspired): Satellite / White / Realistic
  // ---------------------------------------------------------------------------
  function setStyle(style) {
    visualStyle = style;
    applyVisualStyle(style);
    const sel = document.getElementById('terrainStyleSelect');
    if (sel && sel.value !== style) sel.value = style;
  }

  function applyVisualStyle(style) {
    visualStyle = style;
    if (!scene || !terrainMesh) return;
    const mat = terrainMesh.material;
    // Reset any self-illumination applied by a previous style
    mat.emissiveMap = null;
    if (mat.emissive) mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
    if (style === 'white') {
      mat.map = null; mat.vertexColors = false; mat.color.setHex(0xf5f5f2);
      setSceneBackdrop(0xf4f5fa, 0); // no fog in architectural mode: distant geometry stays sharp
      surfaceMode = 'elevation';
    } else if (style === 'colorful') {
      mat.map = null; mat.vertexColors = true; mat.color.setHex(0xffffff);
      setSceneBackdrop(0xdbeeff, 0.75);
      surfaceMode = 'elevation';
    } else if (style === 'realistic') {
      mat.map = null; mat.vertexColors = true; mat.color.setHex(0xffffff);
      setSceneBackdrop(0x0b1220, 0);
      surfaceMode = 'elevation';
    } else { // satellite
      const useSat = !!satelliteTexture;
      // Show the imagery bright & crisp (self-illuminated) rather than dimmed by lighting
      mat.map = useSat ? satelliteTexture : null;
      mat.vertexColors = !useSat;
      mat.color.setHex(useSat ? 0x2a2f38 : 0xffffff);
      if (useSat) {
        mat.emissiveMap = satelliteTexture;
        if (mat.emissive) mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 1.0;
      }
      setSceneBackdrop(0x0a1020, 0);
      surfaceMode = 'satellite';
    }
    mat.needsUpdate = true;
    restyleBuildings(style);
    restyleRoads(style);
    restyleGISSurfaceFeatures(style);
    // Hide the helper grid on the clean model styles for an architectural look
    const grid = scene.getObjectByName('gridHelper');
    if (grid) grid.visible = (style === 'satellite' || style === 'realistic');
    // Style the base slab to suit the palette
    const slab = scene.getObjectByName('baseSlab');
    if (slab) slab.material.color.setHex(
      (style === 'satellite' || style === 'realistic') ? 0x2a3340 : 0xffffff
    );
    // Clean models read best with soft contact shadows (AO-like depth)
    setShadows(style === 'white' || style === 'colorful' || shadowsOn);
    const sground = scene.getObjectByName('shadowGround');
    if (sground) sground.visible = shadowsOn;
    updateSurfaceButton();
  }

  // Recolour GIS road linework to suit the active style (dark thin lines on white)
  function restyleRoads(style) {
    if (!gisGroup) return;
    const roadsMesh = gisGroup.getObjectByName('gisRoads');
    if (roadsMesh && roadsMesh.material) {
      const c = style === 'white' ? 0xa4a9b1 : (style === 'colorful' ? 0x3a4250 : 0x2b2f36);
      roadsMesh.material.color.setHex(c);
      roadsMesh.material.transparent = style === 'white';
      roadsMesh.material.opacity = style === 'white' ? 0.72 : 1;
      roadsMesh.material.needsUpdate = true;
    }
  }

  // Restyle non-building GIS features for a clean TopoExport-like massing view.
  function restyleGISSurfaceFeatures(style) {
    if (!gisGroup) return;
    gisGroup.children.forEach((obj) => {
      if (!obj.material) return;
      if (obj.name === 'gisTree') {
        obj.material.color.setHex(style === 'white' ? 0xf4f5f3 : 0x2e9e5b);
        obj.material.roughness = 1.0;
        obj.material.needsUpdate = true;
      } else if (obj.name === 'gisArea') {
        const kind = obj.userData?.kind;
        if (style === 'white') {
          obj.material.color.setHex(kind === 'water' ? 0xe7e9f7 : 0xeef1ed);
          obj.material.opacity = kind === 'water' ? 0.72 : 0.48;
        }
        obj.material.needsUpdate = true;
      }
    });
  }

  // Background + very distant haze (kept far beyond the model so it never
  // washes out the city — only softens the horizon when zoomed right out)
  function setSceneBackdrop(hex, fogStrength) {
    scene.background = new THREE.Color(hex);
    if (fogStrength > 0) {
      scene.fog = new THREE.Fog(hex, PLANE_SIZE * 2.6, PLANE_SIZE * 6);
    } else {
      scene.fog = null;
    }
  }

  // Vibrant height-based palette (low → high): teal → blue → indigo → magenta → red
  function heightColor(t) {
    const stops = [
      [0.00, [0.09, 0.70, 0.74]],
      [0.28, [0.10, 0.45, 0.96]],
      [0.52, [0.42, 0.28, 0.96]],
      [0.76, [0.80, 0.24, 0.86]],
      [1.00, [0.99, 0.33, 0.42]],
    ];
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      const [ta, ca] = stops[i], [tb, cb] = stops[i + 1];
      if (t >= ta && t <= tb) {
        const f = (t - ta) / (tb - ta || 1);
        return new THREE.Color(
          ca[0] + (cb[0] - ca[0]) * f,
          ca[1] + (cb[1] - ca[1]) * f,
          ca[2] + (cb[2] - ca[2]) * f
        );
      }
    }
    return new THREE.Color(0xffffff);
  }

  // Reassign building materials; tallest becomes a glass/metal "specialty" element
  function restyleBuildings(style) {
    let tallest = null, maxH = -Infinity;
    // reference height for the colourful gradient (relative to a pleasant max)
    const refMax = 11;
    const restyle = (mesh) => {
      const rec = mesh.userData && mesh.userData.record;
      if (rec && rec.type === 'tree') return; // trees keep green
      if (!mesh.geometry || mesh.name === 'wireframe') return;
      const h = (mesh.userData && mesh.userData.heightUnits) || 0;
      if (style === 'colorful') {
        // spread colours by height plus a stable per-building jitter for variety
        const seed = Math.sin(mesh.position.x * 12.9898 + mesh.position.z * 78.233) * 43758.5453;
        const rnd = seed - Math.floor(seed);
        const t = Math.min(1, 0.12 + (h / refMax) * 0.62 + rnd * 0.3);
        const col = heightColor(t);
        mesh.material = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.12, flatShading: true });
      } else {
        mesh.material = buildingMaterialForStyle(style);
      }
      if (h > maxH) { maxH = h; tallest = mesh; }
    };
    if (structureGroup) structureGroup.children.forEach(restyle);
    if (cityGroup) cityGroup.children.forEach((m) => { if (!(m.userData && m.userData.zone === 'park')) restyle(m); });
    if ((style === 'white' || style === 'colorful') && tallest) {
      // Specialty landmark element: light glass (low metalness so it doesn't go
      // black without an environment map), like the centre block in the reference
      tallest.material = new THREE.MeshStandardMaterial({
        color: 0x8ec5ff, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.6,
        emissive: 0x1b3a5c, emissiveIntensity: 0.35,
      });
    }
  }

  // One-click friendly flow: live satellite terrain → GIS footprints → extruded
  // editable primitives → clean white/glass model (the 4-step pipeline)
  async function buildCityFromSatellite() {
    setStyle('white');
    await generate();
    if (!terrainData) return;
    await importGISData();
    setStyle('white');
    resetCamera();
    setStatus(`✅ Crisp architectural digital twin ready · ${gisStats.buildings || 0} GIS buildings · ${(gisStats.roadsKm || 0).toFixed(2)} km roads.`, 'ok');
  }


  // ===========================================================================
  // 3D MODEL EXPORT — turn the textured terrain into printable / CAD-ready
  // models (STL, OBJ+MTL+texture, GLB), TopoExport-style watertight solid.
  // ===========================================================================

  // Build a watertight solid: top surface (edited heights) + side skirt + base.
  function buildSolidTerrainGeometry() {
    if (!terrainMesh) return null;
    const g = terrainMesh.geometry;
    const pos = g.attributes.position;
    const res = terrainMesh.userData.res;
    const yScale = verticalExaggeration;

    const topY = (r, c) => pos.getY(r * res + c) * yScale;
    const topX = (r, c) => pos.getX(r * res + c);
    const topZ = (r, c) => pos.getZ(r * res + c);

    // Base plane sits a bit below the lowest point → gives the model a solid block
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i) * yScale);
    const baseThickness = Math.max(6, PLANE_SIZE * 0.08);
    const baseY = minY - baseThickness;

    const positions = [];
    const uvs = [];
    const uvOf = (r, c) => [c / (res - 1), 1 - r / (res - 1)];

    const pushV = (x, y, z, u, v) => { positions.push(x, y, z); uvs.push(u, v); };
    const tri = (a, b, cc) => {
      pushV(a[0], a[1], a[2], a[3], a[4]);
      pushV(b[0], b[1], b[2], b[3], b[4]);
      pushV(cc[0], cc[1], cc[2], cc[3], cc[4]);
    };
    const vTop = (r, c) => {
      const uv = uvOf(r, c);
      return [topX(r, c), topY(r, c), topZ(r, c), uv[0], uv[1]];
    };

    // Top surface
    for (let r = 0; r < res - 1; r++) {
      for (let c = 0; c < res - 1; c++) {
        const a = vTop(r, c), b = vTop(r, c + 1), d = vTop(r + 1, c), e = vTop(r + 1, c + 1);
        tri(a, d, b);
        tri(b, d, e);
      }
    }

    // Side skirts (down to baseY) along the four edges
    const wall = (x1, z1, y1, x2, z2, y2) => {
      const bA = [x1, baseY, z1, 0, 0];
      const bB = [x2, baseY, z2, 0, 0];
      const tA = [x1, y1, z1, 0, 0];
      const tB = [x2, y2, z2, 0, 0];
      tri(tA, bA, tB);
      tri(tB, bA, bB);
    };
    for (let c = 0; c < res - 1; c++) { // north (r=0) & south (r=res-1)
      wall(topX(0, c), topZ(0, c), topY(0, c), topX(0, c + 1), topZ(0, c + 1), topY(0, c + 1));
      wall(topX(res - 1, c + 1), topZ(res - 1, c + 1), topY(res - 1, c + 1), topX(res - 1, c), topZ(res - 1, c), topY(res - 1, c));
    }
    for (let r = 0; r < res - 1; r++) { // west (c=0) & east (c=res-1)
      wall(topX(r + 1, 0), topZ(r + 1, 0), topY(r + 1, 0), topX(r, 0), topZ(r, 0), topY(r, 0));
      wall(topX(r, res - 1), topZ(r, res - 1), topY(r, res - 1), topX(r + 1, res - 1), topZ(r + 1, res - 1), topY(r + 1, res - 1));
    }

    // Flat bottom (two triangles across the footprint corners)
    const c00 = [topX(0, 0), baseY, topZ(0, 0), 0, 0];
    const c01 = [topX(0, res - 1), baseY, topZ(0, res - 1), 0, 0];
    const c10 = [topX(res - 1, 0), baseY, topZ(res - 1, 0), 0, 0];
    const c11 = [topX(res - 1, res - 1), baseY, topZ(res - 1, res - 1), 0, 0];
    tri(c00, c01, c10);
    tri(c10, c01, c11);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  }

  // Assemble an export group: solid terrain (textured) + buildings/roads clones
  function buildExportGroup(includeTexture) {
    const group = new THREE.Group();
    const solidGeo = buildSolidTerrainGeometry();
    if (!solidGeo) return null;

    const useTex = includeTexture && surfaceMode === 'satellite' && satelliteTexture;
    const mat = new THREE.MeshStandardMaterial({
      map: useTex ? satelliteTexture : null,
      color: useTex ? 0xffffff : 0x8d99ae,
      roughness: 1, metalness: 0,
    });
    mat.name = 'terrain_surface';
    const solid = new THREE.Mesh(solidGeo, mat);
    solid.name = 'terrain';
    group.add(solid);

    // Include placed structures, generated city and roads as part of the model
    [structureGroup, cityGroup, roadGroup, gisGroup].forEach((src) => {
      if (src && src.children.length) group.add(src.clone(true));
    });
    return group;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function modelBaseName() {
    const name = (terrainData?.center?.name || 'terrain').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `citymodel-${name}`;
  }

  function exportSTL() {
    if (!terrainMesh) { setStatus('Generate a terrain first.', 'error'); return; }
    if (!THREE.STLExporter) { setStatus('STL exporter not loaded.', 'error'); return; }
    const group = buildExportGroup(false);
    const result = new THREE.STLExporter().parse(group, { binary: true });
    const blob = new Blob([result.buffer || result], { type: 'application/octet-stream' });
    saveBlob(blob, `${modelBaseName()}.stl`);
    setStatus('🧊 Exported watertight STL (3D-print ready).', 'ok');
  }

  function exportOBJ() {
    if (!terrainMesh) { setStatus('Generate a terrain first.', 'error'); return; }
    if (!THREE.OBJExporter) { setStatus('OBJ exporter not loaded.', 'error'); return; }
    const group = buildExportGroup(true);
    const base = modelBaseName();
    let obj = new THREE.OBJExporter().parse(group);

    const hasTex = surfaceMode === 'satellite' && satelliteTexture;
    if (hasTex) {
      obj = `mtllib ${base}.mtl\n` + obj;
      const mtl =
        `newmtl terrain_surface\nKa 1 1 1\nKd 1 1 1\nd 1\nillum 1\nmap_Kd ${base}.png\n`;
      saveBlob(new Blob([mtl], { type: 'text/plain' }), `${base}.mtl`);
      // Satellite texture PNG
      const img = satelliteTexture.image;
      if (img && img.toBlob) img.toBlob((b) => b && saveBlob(b, `${base}.png`), 'image/png');
      else if (img && img.toDataURL) saveBlob(dataURLToBlob(img.toDataURL('image/png')), `${base}.png`);
    }
    saveBlob(new Blob([obj], { type: 'text/plain' }), `${base}.obj`);
    setStatus(hasTex
      ? '📦 Exported OBJ + MTL + satellite texture (open in Blender/CAD).'
      : '📦 Exported OBJ model.', 'ok');
  }

  function exportGLB() {
    if (!terrainMesh) { setStatus('Generate a terrain first.', 'error'); return; }
    if (!THREE.GLTFExporter) { setStatus('glTF exporter not loaded.', 'error'); return; }
    const group = buildExportGroup(true);
    setStatus('🧱 Building textured 3D model (GLB)…', 'busy');
    new THREE.GLTFExporter().parse(group, (result) => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      saveBlob(blob, `${modelBaseName()}.glb`);
      setStatus('🧱 Exported textured GLB 3D model (opens in Blender / 3D Viewer).', 'ok');
    }, { binary: true });
  }

  function dataURLToBlob(dataURL) {
    const parts = dataURL.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function refreshWireframe() {
    if (!scene) return;
    const old = scene.getObjectByName('wireframe');
    const visible = old ? old.visible : false;
    if (old) scene.remove(old);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(terrainMesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x1e293b, transparent: true, opacity: 0.25 })
    );
    wire.name = 'wireframe';
    wire.scale.y = verticalExaggeration;
    wire.visible = visible;
    scene.add(wire);
  }

  // ---------------------------------------------------------------------------
  // Toolbar actions
  // ---------------------------------------------------------------------------
  function setMode(mode) {
    editMode = mode;
    flattenTargetY = null;
    document.querySelectorAll('.terrain-tool').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const canvas = renderer && renderer.domElement;
    if (canvas) canvas.style.cursor = mode === 'orbit' ? 'grab' : 'crosshair';
  }

  function reseatStructures() {
    structures.forEach((s) => {
      if (s.mesh) seatStructure(s.mesh, s.nx * PLANE_SIZE, s.nz * PLANE_SIZE);
    });
  }

  function setExaggeration(v) {
    verticalExaggeration = v;
    if (terrainMesh) terrainMesh.scale.y = v;
    const wire = scene && scene.getObjectByName('wireframe');
    if (wire) wire.scale.y = v;
    reseatStructures();
  }

  function toggleWireframe() {
    const wire = scene && scene.getObjectByName('wireframe');
    if (wire) wire.visible = !wire.visible;
  }

  // Camera view helpers (user-friendly framing)
  function resetCamera() {
    orbit.target.set(0, 2, 0);
    orbit.theta = 0.88;
    orbit.phi = 0.68;
    orbit.radius = 78;
    updateCameraFromOrbit();
  }

  function topView() {
    orbit.target.set(0, 0, 0);
    orbit.phi = 0.12;
    orbit.radius = 115;
    updateCameraFromOrbit();
  }

  // Toggle between draped satellite imagery and elevation-colour shading
  function toggleSurface() {
    // Route through the style system so brightness/emissive stay consistent
    setStyle(visualStyle === 'satellite' ? 'colorful' : 'satellite');
  }

  function updateSurfaceButton() {
    const btn = document.getElementById('terrainSurfaceBtn');
    if (!btn) return;
    if (!satelliteTexture) {
      btn.textContent = '🛰️ Satellite (n/a)';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    btn.textContent = visualStyle === 'satellite' ? '🎨 Colorful' : '🛰️ Satellite';
  }

  function reset() {
    if (!terrainMesh || !baseGeometry) return;
    const pos = terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, baseGeometry[i]);
    pos.needsUpdate = true;
    terrainMesh.geometry.computeVertexNormals();
    applyVertexColors(terrainMesh.geometry, terrainData);
    terrainMesh.geometry.attributes.color.needsUpdate = true;
    sculptCount = 0;
    resetScenarioState();
    // clear structures
    if (structureGroup) {
      while (structureGroup.children.length) structureGroup.remove(structureGroup.children[0]);
    }
    structures = [];
    selectedStructure = null;
    undoStack.length = 0;
    clearCity();
    clearZones();
    clearMeasure();
    clearGIS();
    if (roadGroup) while (roadGroup.children.length) roadGroup.remove(roadGroup.children[0]);
    roads = [];
    roadDraft = [];
    updateSelectionInfo();
    refreshWireframe();
    updateStatsPanel();
  }

  // ---------------------------------------------------------------------------
  // Export design -> data
  // ---------------------------------------------------------------------------
  function buildTwinFeatures() {
    const areaM2 = terrainData ? terrainData.areaKm * terrainData.areaKm * 1000000 : null;
    const buildings = gisSourceData.buildings;
    const heights = buildings.filter(item => item.height_source !== 'visualization_default').map(item => item.height_m);
    const coverage = source => buildings.length ? buildings.filter(item => item.height_source === source).length / buildings.length * 100 : null;
    const footprintArea = buildings.reduce((sum, item) => sum + (Number(item.footprint_area_m2) || 0), 0);
    const roadLengthKm = gisSourceData.roads.reduce((sum, way) => {
      const geometry = way.geometry || [];
      for (let i = 1; i < geometry.length; i++) {
        const a = geometry[i - 1], b = geometry[i];
        const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
        sum += Math.hypot((b.lat - a.lat) * 111.32, (b.lon - a.lon) * 111.32 * Math.cos(lat));
      }
      return sum;
    }, 0);
    const polygonArea = list => list.reduce((sum, item) => sum + (polygonAreaM2(item.geometry) || 0), 0);
    return {
      terrain: { mean_elevation_m: terrainData?.mean ?? null, min_elevation_m: terrainData?.min ?? null, max_elevation_m: terrainData?.max ?? null, elevation_range_m: terrainData ? terrainData.max - terrainData.min : null, mean_slope_pct: null, max_slope_pct: null, source: terrainData ? 'Open-Meteo Elevation API' : null, resolution_m: terrainData ? (terrainData.areaKm * 1000) / Math.max(1, terrainData.resolution - 1) : null, terrain_is_fallback: true, terrain_quality: terrainData ? 'browser_elevation_fallback' : null },
      buildings: { source_count: buildings.length || null, rendered_count: gisRenderData.buildings.length || null, building_density_per_km2: terrainData ? buildings.length / (terrainData.areaKm * terrainData.areaKm) : null, building_footprint_area_m2: footprintArea || null, builtup_pct: areaM2 && footprintArea ? footprintArea / areaM2 * 100 : null, mean_height_m: heights.length ? heights.reduce((sum, value) => sum + value, 0) / heights.length : null, max_height_m: heights.length ? Math.max(...heights) : null, observed_height_coverage_pct: coverage('osm_height'), derived_height_coverage_pct: coverage('osm_levels_derived'), default_height_coverage_pct: coverage('visualization_default') },
      roads: { road_length_km: roadLengthKm || null, road_density_km_per_km2: terrainData ? roadLengthKm / (terrainData.areaKm * terrainData.areaKm) : null },
      vegetation: { green_space_area_m2: polygonArea(gisSourceData.vegetation) || null, green_space_pct: areaM2 ? polygonArea(gisSourceData.vegetation) / areaM2 * 100 : null },
      water: { surface_water_area_m2: polygonArea(gisSourceData.water) || null, surface_water_pct: areaM2 ? polygonArea(gisSourceData.water) / areaM2 * 100 : null },
      surface: { impervious_pct: null }
    };
  }

  function buildTwinFeatureDelta(baseline, scenario) {
    const delta = (path) => { const [group, key] = path; const a = baseline[group]?.[key], b = scenario[group]?.[key]; return Number.isFinite(a) && Number.isFinite(b) ? b - a : null; };
    return { green_space_pct: delta(['vegetation', 'green_space_pct']), impervious_pct: delta(['surface', 'impervious_pct']), building_density: delta(['buildings', 'building_density_per_km2']), road_density: delta(['roads', 'road_density_km_per_km2']), surface_water_pct: delta(['water', 'surface_water_pct']), mean_slope_pct: delta(['terrain', 'mean_slope_pct']) };
  }

  function buildExportData() {
    if (!terrainMesh || !terrainData) return null;
    const res = terrainMesh.userData.res;
    const heightScale = terrainMesh.userData.heightScale;
    const pos = terrainMesh.geometry.attributes.position;

    // Reconstruct edited elevation grid (metres) from current geometry
    const editedGrid = [];
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let r = 0; r < res; r++) {
      const row = [];
      for (let c = 0; c < res; c++) {
        const y = pos.getY(r * res + c) * verticalExaggeration;
        const elev = terrainData.min + y / heightScale; // back to metres
        const rounded = Math.round(elev * 10) / 10;
        row.push(rounded);
        if (rounded < min) min = rounded;
        if (rounded > max) max = rounded;
        sum += rounded; n++;
      }
      editedGrid.push(row);
    }

    // Approximate slope statistics (metres per cell)
    const cellMeters = (terrainData.areaKm * 1000) / (res - 1);
    let maxSlopePct = 0, slopeSum = 0, slopeN = 0;
    for (let r = 0; r < res - 1; r++) {
      for (let c = 0; c < res - 1; c++) {
        const dz = Math.abs(editedGrid[r][c] - editedGrid[r][c + 1]);
        const dz2 = Math.abs(editedGrid[r][c] - editedGrid[r + 1][c]);
        const grad = Math.max(dz, dz2) / cellMeters;
        const pct = grad * 100;
        if (pct > maxSlopePct) maxSlopePct = pct;
        slopeSum += pct; slopeN++;
      }
    }

    return {
      meta: {
        source: 'Lupus Cortex Terrain 3D Studio',
        elevationSource: 'Open-Meteo Elevation API',
        imagerySource: terrainData.imagery?.source || 'No satellite texture available',
        imageryLayer: terrainData.imagery?.layer || null,
        imageryDate: terrainData.imagery?.date || null,
        location: terrainData.center,
        areaKm: terrainData.areaKm,
        resolution: res,
        cellMeters: Math.round(cellMeters),
        verticalExaggeration,
        edited: isEdited(),
        sculptStrokes: sculptCount,
        generatedAt: new Date().toISOString(),
      },
      elevation: {
        unit: 'meters',
        min: Math.round(min * 10) / 10,
        max: Math.round(max * 10) / 10,
        mean: Math.round((sum / n) * 10) / 10,
        relief: Math.round((max - min) * 10) / 10,
        grid: editedGrid,
      },
      slope: {
        unit: 'percent',
        max: Math.round(maxSlopePct * 10) / 10,
        mean: Math.round((slopeSum / slopeN) * 10) / 10,
      },
      structures: structures.map((s) => ({
        type: s.type,
        // approximate real-world offset from centre in metres
        eastMeters: Math.round(s.nx * terrainData.areaKm * 1000),
        northMeters: Math.round(-s.nz * terrainData.areaKm * 1000),
        heightMeters: Math.round((s.heightUnits / terrainMesh.userData.heightScale) * 10) / 10,
      })),
      roads: roads.map((road) => road.points.map((point) => ({
        eastMeters: Math.round((point.x / PLANE_SIZE) * terrainData.areaKm * 1000),
        northMeters: Math.round((-point.z / PLANE_SIZE) * terrainData.areaKm * 1000),
      }))),
      baseline_features: buildTwinFeatures(),
      scenario_features: buildTwinFeatures(),
      feature_deltas: buildTwinFeatureDelta(buildTwinFeatures(), {}),
      scenario_changes: scenarioChangeCounts(),
      cityPlan: computePlanningStats(),
    };
  }

  function downloadJSON() {
    const data = buildExportData();
    if (!data) { setStatus('Generate a terrain first.', 'error'); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terrain-${(data.meta.location.name || 'model').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('💾 Terrain data exported as JSON.', 'ok');
  }

  // ---------------------------------------------------------------------------
  // Send structured observed/scenario features to the future hybrid model.
  // ---------------------------------------------------------------------------
  async function analyzeEnvironmentalImpact() {
    const data = buildExportData();
    if (!data) { setStatus('Generate a terrain first.', 'error'); return; }

    const panel = document.getElementById('terrainAnalysis');
    const body = document.getElementById('terrainAnalysisBody');
    if (panel) panel.classList.remove('hidden');
    if (body) body.textContent = 'Requesting environmental impact analysis…';

    const apiBase = String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, '');
    if (!apiBase) {
      if (body) body.textContent = 'Hybrid model backend is not configured. Environmental impact model unavailable.';
      return;
    }
    const baseline = window.CortexAnalysis?.snapshot?.().analysis;
    const request = {
      schema_version: '1.0', mode: 'digital_twin_change', baseline_analysis_id: baseline?.analysis_id || null,
      location: { lat: data.meta.location.lat, lon: data.meta.location.lng, name: data.meta.location.name },
      baseline_features: data.baseline_features, scenario_features: data.scenario_features,
      feature_deltas: data.feature_deltas, scenario_changes: data.scenario_changes
    };
    try {
      const response = await fetch(`${apiBase}/api/twin/change`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      if (!response.ok) throw new Error(`Environmental impact request failed (${response.status}).`);
      const report = await response.json();
      if (!report || report.schema_version !== '1.0') throw new Error('The hybrid model returned an invalid response.');
      if (body) body.textContent = 'Environmental impact analysis received. Connect the returned component, index and HWI changes to the report view.';
      window.dispatchEvent(new CustomEvent('cortex:twin-analysis-ready', { detail: report }));
    } catch (error) {
      if (body) body.textContent = `Environmental impact model unavailable: ${error.message}`;
    }
    return;

    // Compact the grid for the prompt (avoid oversized payloads)
    const compact = compactGrid(data.elevation.grid, 16);

    const prompt =
`You are a senior urban planner and civil-infrastructure analyst (think Autodesk InfraWorks + Esri CityEngine workflows). Review this 3D site & city-planning model built from real elevation data plus the planner's zoning, buildings and roads.

LOCATION: ${data.meta.location.name} (lat ${data.meta.location.lat}, lng ${data.meta.location.lng})
AREA: ${data.meta.areaKm} km across, grid ${data.meta.resolution}x${data.meta.resolution}, ~${data.meta.cellMeters} m per cell
OBSERVED IMAGERY BASELINE: ${data.meta.imagerySource}, layer ${data.meta.imageryLayer || 'n/a'}, image date ${data.meta.imageryDate || 'unavailable'}
PLANNED CHANGES: ${data.changes.sculptStrokes} terrain sculpt strokes, ${data.changes.structures} structures, ${data.changes.plannedRoads} planned roads, ${data.changes.zonedCells} zoned cells
ELEVATION (m): min ${data.elevation.min}, max ${data.elevation.max}, mean ${data.elevation.mean}, relief ${data.elevation.relief}
SLOPE: mean ${data.slope.mean}%, max ${data.slope.max}%
ZONING (% of zoned land): residential ${data.cityPlan.landUsePct.residential}%, commercial ${data.cityPlan.landUsePct.commercial}%, industrial ${data.cityPlan.landUsePct.industrial}%, parks ${data.cityPlan.landUsePct.park}%, water ${data.cityPlan.landUsePct.water}%
BUILT PROGRAM: ${data.cityPlan.buildings} buildings, ${data.cityPlan.floors} total floors, ~${data.cityPlan.floorAreaM2.toLocaleString()} m² floor area, est. population ${data.cityPlan.population.toLocaleString()}
INFRASTRUCTURE: ${(data.cityPlan.roadLengthM / 1000).toFixed(2)} km of roads
PLANNED ROAD GEOMETRY: ${JSON.stringify(data.roads)}
MANUAL STRUCTURES: ${JSON.stringify(data.structures)}
DOWNSAMPLED HEIGHTMAP (16x16, metres):
${compact.map((row) => row.map((v) => Math.round(v)).join(' ')).join('\n')}

Provide a concise professional planning review covering:
1. Site suitability — slope/buildability, which zones sit on flat vs steep ground
2. Land-use & zoning critique — balance, mixed-use, density vs terrain
3. Drainage, flood and water-pooling risk (low points) and stormwater guidance
4. Transport & road network adequacy and connectivity
5. Green space, walkability and livability
6. Environmental / geohazard considerations and mitigation
7. Top 3 prioritized recommendations
Keep it structured with short headers and bullet points.`;


    try {
      const url = `${apiBase}/api/twin/change`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) throw new Error(`Gemini API returned ${res.status}`);
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini.');
      if (body) body.innerHTML = formatAnalysis(text);
    } catch (err) {
      console.error('Gemini terrain analysis error:', err);
      if (body) {
        body.innerHTML =
          `<p style="color:#ef4444;">⚠️ ${err.message}</p>` +
          `<p style="color:var(--muted);font-size:13px;">The terrain data was still exported successfully. ` +
          `You can download the JSON and analyze it manually.</p>`;
      }
    }
  }

  function compactGrid(grid, target) {
    const res = grid.length;
    if (res <= target) return grid;
    const step = res / target;
    const out = [];
    for (let r = 0; r < target; r++) {
      const row = [];
      const sr = Math.min(res - 1, Math.floor(r * step));
      for (let c = 0; c < target; c++) {
        const sc = Math.min(res - 1, Math.floor(c * step));
        row.push(grid[sr][sc]);
      }
      out.push(row);
    }
    return out;
  }

  function formatAnalysis(text) {
    // Minimal markdown -> HTML
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h3>$1</h3>')
      .replace(/^# (.*)$/gm, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/^(?!<[hul])/gm, '')
      .replace(/^/, '<p>').concat('</p>');
  }

  // ---------------------------------------------------------------------------
  // Stats panel
  // ---------------------------------------------------------------------------
  function updateStatsPanel() {
    const el = document.getElementById('terrainStats');
    if (!el || !terrainData) return;
    const cityCount = cityGroup ? cityGroup.children.length : 0;
    const s = computePlanningStats();
    const gisRoadsKm = gisStats.roadsKm || 0;
    el.innerHTML = `
      <div><span>Relief</span><strong>${Math.round(terrainData.max - terrainData.min)} m</strong></div>
      <div><span>Mean elev.</span><strong>${Math.round(terrainData.mean)} m</strong></div>
      <div><span>Buildings</span><strong>${s.buildings + structures.length}</strong></div>
      <div><span>GIS buildings</span><strong>${gisStats.buildings || 0}</strong></div>
      <div><span>Est. population</span><strong>${s.population.toLocaleString()}</strong></div>
      <div><span>Roads</span><strong>${(s.roadLengthM / 1000 + gisRoadsKm).toFixed(2)} km</strong></div>
      <div><span>Generated</span><strong>${cityCount}</strong></div>
      <div><span>Edits</span><strong>${sculptCount}</strong></div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Bind static controls (called each open; guarded against double-binding)
  // ---------------------------------------------------------------------------
  let controlsBound = false;
  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('terrainGenerateBtn')?.addEventListener('click', buildCityFromSatellite);
    document.getElementById('terrainImportGisBtn')?.addEventListener('click', importGISData);
    document.getElementById('terrainBuildCityBtn')?.addEventListener('click', buildCityFromSatellite);
    document.getElementById('terrainStyleSelect')?.addEventListener('change', (e) => setStyle(e.target.value));
    document.getElementById('terrainCloseBtn')?.addEventListener('click', close);
    document.getElementById('terrainDownloadBtn')?.addEventListener('click', downloadJSON);
    document.getElementById('terrainAnalyzeBtn')?.addEventListener('click', analyzeEnvironmentalImpact);
    document.getElementById('terrainExportGlbBtn')?.addEventListener('click', exportGLB);
    document.getElementById('terrainExportObjBtn')?.addEventListener('click', exportOBJ);
    document.getElementById('terrainExportStlBtn')?.addEventListener('click', exportSTL);
    document.getElementById('terrainResetBtn')?.addEventListener('click', reset);
    document.getElementById('terrainWireBtn')?.addEventListener('click', toggleWireframe);
    document.getElementById('terrainSurfaceBtn')?.addEventListener('click', toggleSurface);
    document.getElementById('terrainResetViewBtn')?.addEventListener('click', resetCamera);
    document.getElementById('terrainTopViewBtn')?.addEventListener('click', topView);

    // City-planning controls
    document.getElementById('terrainGenerateCityBtn')?.addEventListener('click', generateCity);
    document.getElementById('terrainClearCityBtn')?.addEventListener('click', clearCity);
    document.getElementById('terrainRoadFinishBtn')?.addEventListener('click', finishRoad);
    document.getElementById('terrainMeasureClearBtn')?.addEventListener('click', clearMeasure);
    document.getElementById('terrainZoneViewBtn')?.addEventListener('click', toggleZoneOverlay);
    document.getElementById('terrainSunBtn')?.addEventListener('click', toggleShadows);
    document.getElementById('terrainZoneClearBtn')?.addEventListener('click', clearZones);
    document.getElementById('zonePaintType')?.addEventListener('change', (e) => setZone(e.target.value));
    const sunTime = document.getElementById('terrainSunTime');
    if (sunTime) {
      sunTime.addEventListener('input', () => {
        updateSunFromTime(parseFloat(sunTime.value));
        const lbl = document.getElementById('terrainSunTimeVal');
        if (lbl) {
          const h = Math.floor(parseFloat(sunTime.value));
          const m = Math.round((parseFloat(sunTime.value) - h) * 60);
          lbl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
      });
    }

    document.getElementById('terrainLocationInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') buildCityFromSatellite();
    });

    document.querySelectorAll('.terrain-tool').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    const exagg = document.getElementById('terrainExagg');
    if (exagg) {
      exagg.addEventListener('input', () => {
        setExaggeration(parseFloat(exagg.value));
        const lbl = document.getElementById('terrainExaggVal');
        if (lbl) lbl.textContent = `${parseFloat(exagg.value).toFixed(1)}×`;
      });
    }
    const rad = document.getElementById('terrainBrushRadius');
    if (rad) rad.addEventListener('input', () => { brushRadius = parseFloat(rad.value); });
    const str = document.getElementById('terrainBrushStrength');
    if (str) str.addEventListener('input', () => { brushStrength = parseFloat(str.value); });
    const size = document.getElementById('terrainStructureSize');
    if (size) {
      size.addEventListener('input', () => {
        structureSize = parseFloat(size.value);
        const lbl = document.getElementById('terrainStructureSizeVal');
        if (lbl) lbl.textContent = `${structureSize.toFixed(1)}×`;
      });
    }

    // Blender-style keyboard shortcuts (delete selection, undo)
    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('terrainStudioModal');
      if (!modal || modal.classList.contains('hidden')) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === 'x' || e.key === 'X') && selectedStructure) {
        e.preventDefault();
        deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
      }
    });

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!renderer || !camera) return;
    const container = document.getElementById('terrainCanvasWrap');
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  return { open, close };
})();

// Expose a global entry point used by the 3D view button
function openTerrainStudio() {
  TerrainStudio.open();
}

// Fill the terrain location input from an example chip and focus it
function terrainExample(query) {
  const input = document.getElementById('terrainLocationInput');
  if (input) {
    input.value = query;
    input.focus();
  }
}
