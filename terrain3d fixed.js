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
  const gibsDateCache = new Map();
  const GIBS_DATE_FALLBACK_DAYS = 10;

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
  const gisSourceData = { buildings: [], roads: [], railways: [], water: [], vegetation: [] };
  const gisRenderData = { buildings: [], roads: [], railways: [], water: [], vegetation: [] };

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

  function getGibsImageDate(daysAgo = 0) {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }

  // A tile that merely loads is not usable imagery: on hazy or cloudy days
  // the MODIS pass over the area is a flat grey/white wash, which is what
  // the twin preview showed as a grey box. Score the stitched crop by
  // luminance spread and reject flat/white frames, so the preview falls back
  // to the clearest recent day instead — or hides when nothing in the
  // 10-day window is usable. Thresholds calibrated on real GIBS tiles over
  // Rajshahi, 28 Oct-7 Nov 2026: haze sd 5-9, white cloud sd 15, clear
  // land sd 21-57 (luminance 0-255).
  const GIBS_MIN_LUMINANCE_SD = 20;
  const GIBS_MAX_MEAN_LUMINANCE = 240;
  function scoreImageryCanvas(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return null;
      const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 1024)));
      const data = ctx.getImageData(0, 0, w, h).data;
      let n = 0, sum = 0, sumSq = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += lum; sumSq += lum * lum; n++;
        }
      }
      if (!n) return null;
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      return { mean, sd, usable: sd >= GIBS_MIN_LUMINANCE_SD && mean <= GIBS_MAX_MEAN_LUMINANCE };
    } catch (err) {
      return null; // tainted canvas: cannot score; caller keeps the old accept behaviour
    }
  }

  function formatImageryDate(isoDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const parts = String(isoDate || '').split('-');
    if (parts.length !== 3) return isoDate || 'date unknown';
    const month = months[parseInt(parts[1], 10) - 1] || '';
    return `${parseInt(parts[2], 10)} ${month} ${parts[0]}`.trim();
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
    // GIBS is visual evidence only; numerical environmental features remain backend-owned.
    // Try newest first; a date counts only if its stitched crop actually
    // shows land (scoreImageryCanvas), not merely loads. The clearest date
    // found earlier today is retried first, then the rest of the window.
    const requestedDate = getGibsImageDate();
    const cached = gibsDateCache.get(requestedDate);
    const lagOrder = [];
    if (cached) lagOrder.push(cached.lagDays);
    for (let lagDays = 0; lagDays <= GIBS_DATE_FALLBACK_DAYS; lagDays++) {
      if (!lagOrder.includes(lagDays)) lagOrder.push(lagDays);
    }
    for (const lagDays of lagOrder) {
      const imageryDate = getGibsImageDate(lagDays);
      const imgs = await Promise.all(tiles.map((t) => loadTile(imageryDate, z, t.tx, t.ty)));
      if (imgs.every((img) => !img)) continue; // nothing published for this date
      fctx.clearRect(0, 0, full.width, full.height);
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

      const score = scoreImageryCanvas(out);
      if (score && !score.usable) {
        console.warn(`GIBS ${imageryDate} unusable for the preview (mean ${score.mean.toFixed(0)}, sd ${score.sd.toFixed(1)}) - trying an earlier day.`);
        continue;
      }

      const tex = new THREE.CanvasTexture(out);
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      const result = { requestedDate, imageryDate, lagDays, fallbackUsed: lagDays > 0, layer: NASA_GIBS_LAYER };
      gibsDateCache.set(requestedDate, result);
      return {
        texture: tex,
        source: 'NASA GIBS MODIS Terra True Color',
        layer: NASA_GIBS_LAYER,
        date: imageryDate,
        requestedDate,
        lagDays,
        fallbackUsed: lagDays > 0,
        zoom: z
      };
    }
    return null; // no usable imagery in the window: the preview hides instead of showing grey
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
    const meta = panel.querySelector('p');
    if (meta && satelliteImageryMeta?.date) {
      meta.textContent = `NASA imagery \u00b7 ${formatImageryDate(satelliteImageryMeta.date)} \u00b7 editable overlays`;
    }
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
      // A place picked from live suggestions carries its own
      // coordinates on the box: use them directly. Re-geocoding
      // the suggestion's display name fails in Open-Meteo (e.g.
      // "Rajshahi Division, Bangladesh" returns no results),
      // so a pick is never re-resolved.
      const pickedLat = parseFloat(input.dataset.pickedLat);
      const pickedLon = parseFloat(input.dataset.pickedLon);
      let loc;
      if (Number.isFinite(pickedLat) && Number.isFinite(pickedLon)) {
        loc = { lat: pickedLat, lng: pickedLon, name: input.value.trim() || `${pickedLat.toFixed(4)}, ${pickedLon.toFixed(4)}` };
      } else {
        setStatus('📍 Resolving location…', 'busy');
        loc = await resolveLocation(input.value.trim());
      }

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

  // Position user or observed-building meshes so their bases sit on terrain.
  function seatStructure(mesh, x, z) {
    const y = terrainSurfaceY(x, z);
    const rec = mesh.userData.record;
    // Observed GIS and dynamically materialized source buildings are extruded from y=0.
    const off = rec && rec.source === 'observed' ? 0 : mesh.userData.heightUnits / 2;
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
    if (record?.source === 'observed') {
      if (record.mesh) { record.mesh.visible = false; record.mesh.userData.removed = true; }
      if (record.type === 'building' && !digitalTwinState.scenario.removedBuildingIds.includes(record.id)) digitalTwinState.scenario.removedBuildingIds.push(record.id);
      if (record.type === 'vegetation') digitalTwinState.scenario.vegetationChanges.push({ id: record.id, action: 'remove' });
      if (record.type === 'water') digitalTwinState.scenario.waterChanges.push({ id: record.id, action: 'remove' });
      if (selectedStructure === record) { selectedStructure = null; updateSelectionInfo(); }
      updateStatsPanel(); scheduleTwinPreview();
      return;
    }
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
    if (!structureGroup || !gisGroup) return null;
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const candidates = [...structureGroup.children, ...gisGroup.children].filter(mesh => mesh.userData?.record && mesh.visible);
    const hits = raycaster.intersectObjects(candidates, true);
    for (const hit of hits) {
      let object = hit.object;
      while (object && !object.userData?.record) object = object.parent;
      if (object?.userData?.record) return object;
    }
    return null;
  }

  function selectStructureAtPointer(e) {
    const mesh = structureHitAtPointer(e) || materializeObservedBuildingAtPointer(e);
    selectStructure(mesh ? mesh.userData.record : null);
  }

  function deleteStructureAtPointer(e) {
    const mesh = structureHitAtPointer(e) || materializeObservedBuildingAtPointer(e);
    if (mesh && mesh.userData.record) removeStructure(mesh.userData.record);
  }

  // Buildings beyond the visual cap remain selectable from the full OSM source store.
  // A selected source feature is materialized on demand without changing the baseline.
  function materializeObservedBuildingAtPointer(e) {
    if (!terrainMesh) return null;
    pointerToNDC(e); raycaster.setFromCamera(pointerNDC, camera);
    const hit = raycaster.intersectObject(terrainMesh)[0];
    if (!hit) return null;
    const point = terrainMesh.worldToLocal(hit.point.clone());
    const feature = gisSourceData.buildings.find(item => {
      const polygon = (item.geometry || []).map(vertex => geoToLocal(vertex.lat, vertex.lon));
      return polygon.length >= 3 && pointInPolygonXZ(point.x, point.z, polygon);
    });
    if (!feature) return null;
    const existing = gisGroup.children.find(mesh => mesh.userData?.observedFeatureId === feature.id);
    if (existing) return existing;
    buildBuildingsMesh([feature]);
    return gisGroup.children.find(mesh => mesh.userData?.observedFeatureId === feature.id) || null;
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
    if (selectedStructure.type === 'building') {
      const change = selectedStructure.source === 'observed'
        ? { id: selectedStructure.id, nx: selectedStructure.nx, nz: selectedStructure.nz }
        : selectedStructure;
      if (!digitalTwinState.scenario.modifiedBuildings.some(item => item.id === change.id || item === change)) digitalTwinState.scenario.modifiedBuildings.push(change);
    }
    if (selectedStructure.type === 'vegetation') digitalTwinState.scenario.vegetationChanges.push({ id: selectedStructure.id, action: 'move', nx: selectedStructure.nx, nz: selectedStructure.nz });
    if (selectedStructure.type === 'water') digitalTwinState.scenario.waterChanges.push({ id: selectedStructure.id, action: 'move', nx: selectedStructure.nx, nz: selectedStructure.nz });
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
    if (rec.type !== 'building') { setStatus('Height editing is available for buildings only.', 'error'); return; }
    const newScale = Math.max(0.1, (rec.mesh.scale.y || 1) * factor);
    rec.mesh.scale.y = newScale;
    if (rec.heightMeters) rec.heightMeters = Math.max(1, rec.heightMeters * factor);
    if (rec.source !== 'observed') {
      // re-seat centred meshes so the base stays on the ground
      seatStructure(rec.mesh, rec.nx * PLANE_SIZE, rec.nz * PLANE_SIZE);
    }
    if (rec.source === 'observed' && !digitalTwinState.scenario.modifiedBuildings.some(item => item.id === rec.id)) {
      digitalTwinState.scenario.modifiedBuildings.push({ id: rec.id, height_scale: newScale });
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
  way["railway"~"rail|light_rail|tram|subway"](${bbox});
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
    const buildings = [], roadWays = [], railWays = [], areas = [];
    data.elements.forEach((el) => {
      if (el.type !== 'way' || !el.geometry) return;
      const t = el.tags || {};
      if (t.building) buildings.push(el);
      else if (t.highway) roadWays.push(el);
      else if (t.railway) railWays.push(el);
      else if (t.natural === 'water' || t.waterway) areas.push({ el, color: 0x2aa7e0 });
      else if (t.leisure === 'park' || t.landuse) areas.push({ el, color: 0x35c46a });
    });

    // Preserve every returned GIS feature for RF feature extraction before capping rendering.
    gisSourceData.buildings = buildings.map(buildObservedBuildingFeature).filter(Boolean);
    gisSourceData.roads = roadWays.slice();
    gisSourceData.railways = railWays.slice();
    gisSourceData.water = areas.filter(area => area.color === 0x2aa7e0).map(area => area.el);
    gisSourceData.vegetation = areas.filter(area => area.color === 0x35c46a).map(area => area.el);
    digitalTwinState.observed.buildings = gisSourceData.buildings;
    digitalTwinState.observed.roads = gisSourceData.roads;
    digitalTwinState.observed.railways = gisSourceData.railways;
    digitalTwinState.observed.water = gisSourceData.water;
    digitalTwinState.observed.vegetation = gisSourceData.vegetation;
    digitalTwinState.observed.landCover = areas.map(area => area.el);
    digitalTwinState.observed.metadata = { source: 'OpenStreetMap (Overpass)', sourceBuildingCount: gisSourceData.buildings.length };
    gisRenderData.buildings = gisSourceData.buildings.slice(0, BUILDING_EDIT_CAP);
    gisRenderData.roads = gisSourceData.roads;
    gisRenderData.railways = gisSourceData.railways;
    gisRenderData.water = gisSourceData.water;
    gisRenderData.vegetation = gisSourceData.vegetation;

    setStatus(`🏗️ Extruding ${gisRenderData.buildings.length} of ${gisSourceData.buildings.length} buildings & ${roadWays.length} roads…`, 'busy');
    await new Promise((r) => setTimeout(r, 30)); // let the UI paint

    const builtBuildings = buildBuildingsMesh(gisRenderData.buildings);
    const roadMeters = buildRoadsMesh(roadWays);
    const railMeters = buildRailwaysMesh(railWays);
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
    setStatus(`✅ GIS imported: ${gisStats.sourceBuildingCount} source buildings · ${builtBuildings} rendered · ${gisStats.roadsKm} km roads · ${(railMeters / 1000).toFixed(2)} km railways (OpenStreetMap).`, 'ok');
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

      const record = {
        id: feature.id, type: 'building', source: 'observed', mesh,
        nx: cx / PLANE_SIZE, nz: cz / PLANE_SIZE, heightUnits: hUnits,
        heightMeters: hMeters, height_source: feature.height_source, height_confidence: feature.height_confidence
      };
      mesh.userData = { heightUnits: hUnits, heightMeters: hMeters, height_source: feature.height_source, height_confidence: feature.height_confidence, observedFeatureId: feature.id, record };
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
      const record = { id: `osm-way-${a.el.id}`, type: isGreen ? 'vegetation' : 'water', source: 'observed', mesh };
      mesh.userData.record = record;
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

  // Restyle non-building GIS features for a clean massing view.
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
    txOnCityBuilt();
  }


  // ===========================================================================
  // 3D MODEL EXPORT — turn the textured terrain into printable / CAD-ready
  // models (STL, OBJ+MTL+texture, GLB), watertight solid.
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

  // Export-safe clone: THREE.Object3D.clone() deep-copies userData via
  // JSON.parse(JSON.stringify(...)), and our GIS meshes carry
  // userData.record.mesh — a back-reference to the mesh itself. Stringify
  // then recurses through Mesh.toJSON forever and throws
  // "RangeError: Maximum call stack size exceeded", which killed every
  // GLB/OBJ/STL export (2026-11-07). This clone copies geometry/material
  // (by reference) and transforms by hand and never touches userData.
  function cloneForExport(obj) {
    let out;
    if (obj.isMesh) {
      out = new THREE.Mesh(obj.geometry, obj.material);
    } else if (obj.isLineSegments || obj.isLine) {
      out = new THREE.LineSegments(obj.geometry, obj.material);
    } else {
      out = new THREE.Group();
    }
    out.name = obj.name;
    out.position.copy(obj.position);
    out.quaternion.copy(obj.quaternion);
    out.scale.copy(obj.scale);
    out.matrix.copy(obj.matrix);
    out.matrixWorld.copy(obj.matrixWorld);
    out.matrixAutoUpdate = obj.matrixAutoUpdate;
    out.matrixWorldNeedsUpdate = obj.matrixWorldNeedsUpdate;
    out.visible = obj.visible;
    if (obj.isMesh) {
      out.castShadow = obj.castShadow;
      out.receiveShadow = obj.receiveShadow;
    }
    obj.children.forEach((ch) => out.add(cloneForExport(ch)));
    return out;
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
      if (src && src.children.length) group.add(cloneForExport(src));
    });
    group.updateMatrixWorld(true);
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
    txOnExaggerationChanged();
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
    txOnReset();
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

    // Baseline vs scenario: the scenario record must reflect the user's edits,
    // not repeat the baseline (2026-11-05 finding, fixed 2026-11-07).
    // buildTwinFeatures() is computed ONCE; the scenario is derived from it.
    const baselineFeatures = buildTwinFeatures();
    const editedTerrainStats = {
      min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10,
      mean: Math.round((sum / n) * 10) / 10, relief: Math.round((max - min) * 10) / 10,
      mean_slope_pct: Math.round((slopeSum / slopeN) * 10) / 10,
      max_slope_pct: Math.round(maxSlopePct * 10) / 10,
    };
    const scenarioFeatures = buildScenarioFeatures(baselineFeatures, editedTerrainStats);

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
      baseline_features: baselineFeatures,
      scenario_features: scenarioFeatures,
      feature_deltas: buildTwinFeatureDelta(baselineFeatures, scenarioFeatures),
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
    bindTerrainSearch();

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
    bindLxExportControls();
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

  // ===========================================================================
  // EXPORT CONFIGURATOR (own implementation, 2026-11-07)
  // A layered export panel, bounding-box selection on a 2D preview drawn from
  // the planner's own DEM + OpenStreetMap data, contour lines computed from the
  // planner's own DEM, DXF / SVG / GeoJSON exports built from the planner's
  // own scene data, and a cross-section tool with a DEM elevation profile.
  // Data sources: OpenStreetMap via Overpass; elevation via Open-Meteo and the
  // Terrarium raster DEM. Exports are NOT survey-grade (stated in the panel).
  // ===========================================================================

  const TX_MAX_AREA_KM2 = 50; // selection limit, shown on the area pill
  // Every interval and DTM resolution is available — no tier, no paywall.
  const TX_CONTOUR_INTERVALS = [0.1, 0.5, 1, 2, 5, 10, 20];
  const TX_DTM_RESOLUTIONS = [0.5, 1, 2, 5, 10, 20, 30];
  const TX_DEFAULT_BUILDING_HEIGHT_M = DEFAULT_FLOOR_M * 3; // 9.6 m, documented in exports

  const TX = {
    bbox: { u0: 0, v0: 0, u1: 1, v1: 1 }, // normalized footprint fractions (u: west->east, v: south->north)
    contourIntervalM: 5,
    dtmResolutionM: 20,
    pendingShrinkBbox: false,
    section: { active: false, mode: 'select', a: null, b: null }, // endpoints in normalized u/v
    master: { satellite: true, d2: true, d3: true, raw: false },
    format: { satellite: 'JPEG', d2: 'DXF', d3: 'DXF', raw: 'GeoJSON' },
    layers2d: { buildings: true, roads: true, railways: true, waterways: true, shadows: true, trees: true, contours: true },
    layers3d: { buildings: true, roads: false, railways: false, waterways: false, trees: true, contours: false, terrainMesh: true },
    layersRaw: { buildings: true, roads: true, railways: true, waterways: true, trees: true, contours: true, terrain: false },
  };

  // Formats this browser build can actually write. Proprietary/binary
  // formats are not listed: they cannot be produced in a browser, so
  // they are not offered as buttons. Every format shown in the panel
  // exports a real file.
  const TX_PRODUCIBLE = { satellite: ['JPEG'], d2: ['DXF', 'SVG'], d3: ['DXF', 'OBJ', 'glTF', 'STL'], raw: ['GeoJSON', 'TXT'] };
  function txFormatProducible(section, format) {
    return (TX_PRODUCIBLE[section] || []).includes(format);
  }
  function txSelectFormat(section, format) {
    if (!txFormatProducible(section, format)) return { ok: false, gated: false, reason: `${format} export is not available in this browser build. Use ${TX_PRODUCIBLE[section].join(', ')}.` };
    TX.format[section] = format;
    return { ok: true };
  }

  // --- small DOM helper ------------------------------------------------------
  function txEl(id) { return document.getElementById(id); }

  // --- bounding box (normalized footprint fractions) -------------------------
  function txBboxKm() {
    if (!terrainData) return null;
    const wKm = (TX.bbox.u1 - TX.bbox.u0) * terrainData.areaKm;
    const hKm = (TX.bbox.v1 - TX.bbox.v0) * terrainData.areaKm;
    return { wKm, hKm, areaKm2: wKm * hKm };
  }
  function txBboxCorners() {
    if (!terrainData) return null;
    const b = gisBBox();
    const lon = (u) => b.w + u * (b.e - b.w);
    const lat = (v) => b.s + v * (b.n - b.s);
    return {
      sw: { lat: lat(TX.bbox.v0), lon: lon(TX.bbox.u0) },
      ne: { lat: lat(TX.bbox.v1), lon: lon(TX.bbox.u1) },
      nw: { lat: lat(TX.bbox.v1), lon: lon(TX.bbox.u0) },
      se: { lat: lat(TX.bbox.v0), lon: lon(TX.bbox.u1) },
    };
  }
  function txWorldToUV(x, z) {
    return { u: x / PLANE_SIZE + 0.5, v: 0.5 - z / PLANE_SIZE };
  }
  function txUVToWorld(u, v) {
    return { x: (u - 0.5) * PLANE_SIZE, z: (0.5 - v) * PLANE_SIZE };
  }
  // World units -> lon/lat (inverse of geoToLocal, equirectangular around centre)
  function txLocalToGeo(x, z) {
    const b = gisBBox();
    return {
      lon: b.w + (x / PLANE_SIZE + 0.5) * (b.e - b.w),
      lat: b.n - (z / PLANE_SIZE + 0.5) * (b.n - b.s),
    };
  }
  // World units -> local metres relative to the selection's SW corner
  function txWorldToLocalMeters(x, z) {
    const uv = txWorldToUV(x, z);
    const size = txBboxKm();
    if (!size) return { eastM: 0, northM: 0 };
    return { eastM: (uv.u - TX.bbox.u0) * size.wKm * 1000, northM: (uv.v - TX.bbox.v0) * size.hKm * 1000 };
  }
  function txClampBbox() {
    const b = TX.bbox;
    const MIN = 0.01; // minimum usable selection (~1% of the footprint side)
    b.u0 = Math.max(0, Math.min(1 - MIN, b.u0));
    b.v0 = Math.max(0, Math.min(1 - MIN, b.v0));
    b.u1 = Math.max(b.u0 + MIN, Math.min(1, b.u1));
    b.v1 = Math.max(b.v0 + MIN, Math.min(1, b.v1));
  }
  function txPointInBbox(lat, lon) {
    const uv = txWorldToUV(geoToLocal(lat, lon).x, geoToLocal(lat, lon).z);
    return uv.u >= TX.bbox.u0 && uv.u <= TX.bbox.u1 && uv.v >= TX.bbox.v0 && uv.v <= TX.bbox.v1;
  }
  // Liang-Barsky clip of a world-space segment to the selection rectangle.
  // Returns null when the segment lies fully outside, else the clipped endpoints.
  function txClipSegmentToBbox(x1, z1, x2, z2) {
    const a = txWorldToUV(x1, z1), b = txWorldToUV(x2, z2);
    const dx = b.u - a.u, dz = b.v - a.v;
    let t0 = 0, t1 = 1;
    const p = [-dx, dx, -dz, dz];
    const q = [a.u - TX.bbox.u0, TX.bbox.u1 - a.u, a.v - TX.bbox.v0, TX.bbox.v1 - a.v];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    const at = (t) => txUVToWorld(a.u + dx * t, a.v + dz * t);
    const p0 = at(t0), p1 = at(t1);
    return { x1: p0.x, z1: p0.z, x2: p1.x, z2: p1.z };
  }

  // --- elevation sampling (bilinear on the planner's own DEM grid) -----------
  function txElevationAtWorld(x, z) {
    if (!terrainData || !terrainData.grid) return null;
    const res = terrainData.resolution;
    const fx = Math.max(0, Math.min(res - 1, (x / PLANE_SIZE + 0.5) * (res - 1)));
    const fz = Math.max(0, Math.min(res - 1, (z / PLANE_SIZE + 0.5) * (res - 1)));
    const c0 = Math.floor(fx), r0 = Math.floor(fz);
    const c1 = Math.min(res - 1, c0 + 1), r1 = Math.min(res - 1, r0 + 1);
    const tc = fx - c0, tr = fz - r0;
    const g = terrainData.grid;
    const top = g[r0][c0] * (1 - tc) + g[r0][c1] * tc;
    const bottom = g[r1][c0] * (1 - tc) + g[r1][c1] * tc;
    return top * (1 - tr) + bottom * tr;
  }
  function txElevationAtLatLng(lat, lon) {
    const p = geoToLocal(lat, lon);
    return txElevationAtWorld(p.x, p.z);
  }

  // --- contour lines (marching squares, ported from the repo planner's
  // contour logic and adapted: this file's DEM grid is 2D rows, the interval
  // is user-chosen, segments are clipped to the selection box) ---------------
  let contourGroup = null;
  let contourSegments = []; // [{ level, x1, z1, x2, z2 }] in world units, bbox-clipped

  // Pure core: marching-squares segments in grid fractions (u: west->east,
  // v: south->north). No THREE / DOM dependency, so it is unit-testable.
  function computeContourSegments(grid, res, min, max, intervalM, bbox) {
    const segments = [];
    if (!grid || !res || res < 2 || !(intervalM > 0) || !(max > min)) return segments;
    const levels = [];
    for (let v = Math.ceil(min / intervalM) * intervalM; v < max; v += intervalM) levels.push(v);
    const H = (r, c) => {
      r = Math.max(0, Math.min(res - 1, r));
      c = Math.max(0, Math.min(res - 1, c));
      return grid[r][c];
    };
    // Grid row 0 is the north edge; v (south->north) = 1 - r/(res-1).
    const U = (c) => c / (res - 1);
    const V = (r) => 1 - r / (res - 1);
    for (const level of levels) {
      for (let r = 0; r < res - 1; r++) {
        for (let c = 0; c < res - 1; c++) {
          const h00 = H(r, c), h10 = H(r, c + 1), h01 = H(r + 1, c), h11 = H(r + 1, c + 1);
          const corners = [[h00, 0, 0], [h10, 1, 0], [h11, 1, 1], [h01, 0, 1]];
          const edges = [
            [corners[0], corners[1]], [corners[1], corners[2]],
            [corners[2], corners[3]], [corners[3], corners[0]],
          ];
          const cross = [];
          for (const [[ha, ca, ra], [hb, cb, rb]] of edges) {
            // Lower-inclusive crossing test: a contour that passes exactly
            // through a grid node (common with integer-metre DEMs) must still
            // produce a segment; the strict sign-change test drops it.
            const crossed = (ha <= level && hb > level) || (ha > level && hb <= level);
            if (crossed) {
              const t = (level - ha) / (hb - ha);
              cross.push([c + ca + (cb - ca) * t, r + ra + (rb - ra) * t]);
            }
          }
          if (cross.length === 2) {
            const [c1, r1] = cross[0], [c2, r2] = cross[1];
            const a = { u: U(c1), v: V(r1) }, b = { u: U(c2), v: V(r2) };
            if (!bbox) { segments.push({ level, u1: a.u, v1: a.v, u2: b.u, v2: b.v }); continue; }
            const clipped = clipSegmentUV(a.u, a.v, b.u, b.v, bbox);
            if (clipped) segments.push({ level, u1: clipped.u1, v1: clipped.v1, u2: clipped.u2, v2: clipped.v2 });
          }
        }
      }
    }
    return segments;
  }
  function clipSegmentUV(u1, v1, u2, v2, bbox) {
    const dx = u2 - u1, dv = v2 - v1;
    let t0 = 0, t1 = 1;
    const p = [-dx, dx, -dv, dv];
    const q = [u1 - bbox.u0, bbox.u1 - u1, v1 - bbox.v0, bbox.v1 - v1];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return { u1: u1 + dx * t0, v1: v1 + dv * t0, u2: u1 + dx * t1, v2: v1 + dv * t1 };
  }

  function clearContours() {
    if (contourGroup && scene) scene.remove(contourGroup);
    contourGroup = null;
    contourSegments = [];
  }
  function buildContours(intervalM) {
    clearContours();
    if (!terrainData || !terrainData.grid || !scene) return 0;
    const { grid, resolution, min, max } = terrainData;
    const uvSegs = computeContourSegments(grid, resolution, min, max, intervalM, TX.bbox);
    const heightScale = terrainMesh ? terrainMesh.userData.heightScale : 0;
    contourSegments = uvSegs.map((s) => {
      const a = txUVToWorld(s.u1, s.v1), b = txUVToWorld(s.u2, s.v2);
      return { level: s.level, x1: a.x, z1: a.z, x2: b.x, z2: b.z };
    });
    if (!contourSegments.length) return 0;
    const pts = [];
    for (const s of contourSegments) {
      const y = (s.level - min) * heightScale + 0.05;
      pts.push(new THREE.Vector3(s.x1, y, s.z1));
      pts.push(new THREE.Vector3(s.x2, y, s.z2));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    contourGroup = new THREE.Group();
    contourGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2e7d32 })));
    contourGroup.scale.y = verticalExaggeration;
    contourGroup.visible = !!TX.layers3d.contours;
    scene.add(contourGroup);
    const levels = new Set(contourSegments.map((s) => s.level)).size;
    return levels;
  }
  function rebuildContours() {
    if (!TX.layers3d.contours && !TX.layers2d.contours) { clearContours(); return 0; }
    return buildContours(TX.contourIntervalM);
  }

  // --- 2D preview map (drawn from the planner's own DEM + OSM data) ---------
  let txMapDrag = null; // { kind: 'move'|'nw'|'ne'|'sw'|'se'|'center'|'sec-a'|'sec-b'|'draw', startX, startY, bbox0, sec0 }
  function txMapCanvas() { return txEl('txMapCanvas'); }
  function txCanvasPoint(e) {
    const cv = txMapCanvas();
    const rect = cv.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (cv.width / rect.width), y: (e.clientY - rect.top) * (cv.height / rect.height) };
  }
  function txElevColor(t) {
    // hypsometric ramp: low green -> tan -> high white
    const stops = [[0.0, [46, 125, 50]], [0.45, [139, 150, 90]], [0.75, [185, 160, 106]], [1.0, [245, 245, 245]]];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const f = (t - t0) / Math.max(1e-9, t1 - t0);
        return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * f)},${Math.round(c0[1] + (c1[1] - c0[1]) * f)},${Math.round(c0[2] + (c1[2] - c0[2]) * f)})`;
      }
    }
    return 'rgb(245,245,245)';
  }
  function txDrawFeatureGeometry(ctx, geometry, close, W, H) {
    if (!geometry || geometry.length < 2) return;
    ctx.beginPath();
    geometry.forEach((p, i) => {
      const w = geoToLocal(p.lat, p.lon);
      const px = (w.x / PLANE_SIZE + 0.5) * W;
      const py = (w.z / PLANE_SIZE + 0.5) * H;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    if (close) ctx.closePath();
  }
  function renderTopoMap() {
    const cv = txMapCanvas();
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    if (!terrainData || !terrainData.grid) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Generate a location to see the 2D preview map.', W / 2, H / 2);
      return;
    }
    const res = terrainData.resolution;
    const { min, max } = terrainData;
    const range = Math.max(1e-9, max - min);
    // DEM heightmap
    const off = document.createElement('canvas');
    off.width = res; off.height = res;
    const octx = off.getContext('2d');
    const img = octx.createImageData(res, res);
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const t = (terrainData.grid[r][c] - min) / range;
        const col = txElevColor(t).match(/\d+/g).map(Number);
        const i = (r * res + c) * 4;
        img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W, H);
    const L = TX.layers2d;
    // Waterways + vegetation (fills)
    if (L.waterways) {
      ctx.fillStyle = 'rgba(42,167,224,0.75)';
      gisSourceData.water.forEach((el) => { txDrawFeatureGeometry(ctx, el.geometry, true, W, H); ctx.fill(); });
    }
    if (L.trees) {
      ctx.fillStyle = 'rgba(53,196,106,0.55)';
      gisSourceData.vegetation.forEach((el) => { txDrawFeatureGeometry(ctx, el.geometry, true, W, H); ctx.fill(); });
    }
    // Roads + railways
    if (L.roads) {
      ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1.4;
      gisSourceData.roads.forEach((way) => { txDrawFeatureGeometry(ctx, way.geometry, false, W, H); ctx.stroke(); });
    }
    if (L.railways) {
      ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
      gisSourceData.railways.forEach((way) => { txDrawFeatureGeometry(ctx, way.geometry, false, W, H); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    // Buildings (light outlines)
    if (L.buildings) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(245,245,245,0.55)';
      gisSourceData.buildings.forEach((f) => { txDrawFeatureGeometry(ctx, f.geometry, true, W, H); ctx.fill(); ctx.stroke(); });
    }
    // Contours
    if (L.contours && contourSegments.length) {
      ctx.strokeStyle = '#1d5c2e'; ctx.lineWidth = 0.8;
      contourSegments.forEach((s) => {
        ctx.beginPath();
        ctx.moveTo((s.x1 / PLANE_SIZE + 0.5) * W, (s.z1 / PLANE_SIZE + 0.5) * H);
        ctx.lineTo((s.x2 / PLANE_SIZE + 0.5) * W, (s.z2 / PLANE_SIZE + 0.5) * H);
        ctx.stroke();
      });
    }
    // Section line
    if (TX.section.active && TX.section.a && TX.section.b) {
      const ax = TX.section.a.u * W, ay = (1 - TX.section.a.v) * H;
      const bx = TX.section.b.u * W, by = (1 - TX.section.b.v) * H;
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      [[ax, ay], [bx, by]].forEach(([x, y]) => {
        ctx.fillStyle = '#2563eb';
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      });
    }
    // Selection rectangle + handles
    const rx = TX.bbox.u0 * W, ry = (1 - TX.bbox.v1) * H;
    const rw = (TX.bbox.u1 - TX.bbox.u0) * W, rh = (TX.bbox.v1 - TX.bbox.v0) * H;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
    const corners = [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]];
    ctx.fillStyle = '#000';
    corners.forEach(([x, y]) => ctx.fillRect(x - 5, y - 5, 10, 10));
    // centre "+" handle
    const cx = rx + rw / 2, cy = ry + rh / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - 5, cy - 5, 10, 10);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy); ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3); ctx.stroke();
    // Edge labels: width on top edge, height on right edge
    const size = txBboxKm();
    if (size) {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${size.wKm.toFixed(2)} km`, cx, Math.max(12, ry - 6));
      ctx.save();
      ctx.translate(Math.min(W - 8, rx + rw + 14), cy);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(`${size.hKm.toFixed(2)} km`, 0, 0);
      ctx.restore();
    }
  }
  function updateTopoReadouts() {
    const size = txBboxKm();
    const corners = txBboxCorners();
    const ro = txEl('txBboxReadout');
    const pill = txEl('txAreaPill');
    if (!size || !corners) {
      if (ro) ro.textContent = 'Generate a location first — the selection box appears on the 2D preview map.';
      if (pill) { pill.textContent = `Max. ${TX_MAX_AREA_KM2} km²`; pill.classList.remove('over'); }
      return;
    }
    if (ro) {
      ro.textContent =
        `${size.wKm.toFixed(2)} km × ${size.hKm.toFixed(2)} km · ${size.areaKm2.toFixed(2)} km² · ` +
        `SW ${corners.sw.lat.toFixed(4)}°, ${corners.sw.lon.toFixed(4)}° · NE ${corners.ne.lat.toFixed(4)}°, ${corners.ne.lon.toFixed(4)}°`;
    }
    if (pill) {
      pill.textContent = `Max. ${TX_MAX_AREA_KM2} km²`;
      const over = size.areaKm2 > TX_MAX_AREA_KM2;
      pill.classList.toggle('over', over);
      pill.title = over
        ? `Selection is ${size.areaKm2.toFixed(2)} km² — above the ${TX_MAX_AREA_KM2} km² limit for one export. Shrink the box to export.`
        : `Selection is within the ${TX_MAX_AREA_KM2} km² limit.`;
    }
  }
  function txMapHitTest(x, y) {
    const cv = txMapCanvas();
    const W = cv.width, H = cv.height;
    const rx = TX.bbox.u0 * W, ry = (1 - TX.bbox.v1) * H;
    const rw = (TX.bbox.u1 - TX.bbox.u0) * W, rh = (TX.bbox.v1 - TX.bbox.v0) * H;
    const near = (px, py) => Math.abs(x - px) <= 9 && Math.abs(y - py) <= 9;
    if (TX.section.active && TX.section.a && TX.section.b) {
      const ax = TX.section.a.u * W, ay = (1 - TX.section.a.v) * H;
      const bx = TX.section.b.u * W, by = (1 - TX.section.b.v) * H;
      if (near(ax, ay)) return 'sec-a';
      if (near(bx, by)) return 'sec-b';
    }
    if (near(rx, ry)) return 'nw';
    if (near(rx + rw, ry)) return 'ne';
    if (near(rx, ry + rh)) return 'sw';
    if (near(rx + rw, ry + rh)) return 'se';
    if (near(rx + rw / 2, ry + rh / 2)) return 'center';
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return 'move';
    return null;
  }
  function txMapPointerDown(e) {
    if (!terrainData) return;
    const p = txCanvasPoint(e);
    const cv = txMapCanvas();
    const hit = txMapHitTest(p.x, p.y);
    if (TX.section.active && TX.section.mode === 'draw' && !hit) {
      // Draw mode: each click sets an endpoint (first click A, second click B)
      const u = p.x / cv.width, v = 1 - p.y / cv.height;
      if (!TX.section.a || (TX.section.a && TX.section.b)) { TX.section.a = { u, v }; TX.section.b = null; }
      else { TX.section.b = { u, v }; }
      renderTopoMap();
      return;
    }
    if (!hit) return;
    e.preventDefault();
    txMapDrag = { kind: hit, startX: p.x, startY: p.y, bbox0: { ...TX.bbox }, sec0: TX.section.a && TX.section.b ? { a: { ...TX.section.a }, b: { ...TX.section.b } } : null };
    cv.setPointerCapture?.(e.pointerId);
  }
  function txMapPointerMove(e) {
    if (!txMapDrag || !terrainData) return;
    const cv = txMapCanvas();
    const p = txCanvasPoint(e);
    const du = (p.x - txMapDrag.startX) / cv.width;
    const dv = -(p.y - txMapDrag.startY) / cv.height; // canvas y grows down, v grows north
    const b = TX.bbox, b0 = txMapDrag.bbox0;
    const kind = txMapDrag.kind;
    if (kind === 'sec-a' || kind === 'sec-b') {
      const end = kind === 'sec-a' ? TX.section.a : TX.section.b;
      const orig = kind === 'sec-a' ? txMapDrag.sec0.a : txMapDrag.sec0.b;
      end.u = Math.max(0, Math.min(1, orig.u + du));
      end.v = Math.max(0, Math.min(1, orig.v + dv));
    } else if (kind === 'move' || kind === 'center') {
      const w = b0.u1 - b0.u0, h = b0.v1 - b0.v0;
      b.u0 = Math.max(0, Math.min(1 - w, b0.u0 + du));
      b.v0 = Math.max(0, Math.min(1 - h, b0.v0 + dv));
      b.u1 = b.u0 + w; b.v1 = b.v0 + h;
    } else {
      if (kind === 'nw' || kind === 'sw') b.u0 = Math.min(b0.u1 - 0.01, b0.u0 + du);
      if (kind === 'ne' || kind === 'se') b.u1 = Math.max(b0.u0 + 0.01, b0.u1 + du);
      if (kind === 'nw' || kind === 'ne') b.v1 = Math.max(b0.v0 + 0.01, b0.v1 + dv);
      if (kind === 'sw' || kind === 'se') b.v0 = Math.min(b0.v1 - 0.01, b0.v0 + dv);
      txClampBbox();
    }
    updateTopoReadouts();
    renderTopoMap();
  }
  function txMapPointerUp() {
    if (!txMapDrag) return;
    txMapDrag = null;
    rebuildContours();
    renderTopoMap();
  }

  // --- place search on the single location box (reuses the page's existing Nominatim forwardGeocode) ---
  let terrainSearchTimer = null;
  function searchResultIcon(result) {
    const t = `${result.class || ''}/${result.type || ''}`;
    if (/water|river|stream|lake/.test(t)) return '💧';
    if (/highway|road|street/.test(t)) return '🛣️';
    if (/building/.test(t)) return '🏢';
    if (/park|forest|meadow|leisure/.test(t)) return '🌳';
    if (/place|boundary|locality|city|town|village|suburb/.test(t)) return '📍';
    return '📍';
  }
  function bindTerrainSearch() {
    const input = txEl('terrainLocationInput');
    const box = txEl('terrainSearchSuggest');
    if (!input || !box || input.dataset.terrainSearchBound) return;
    input.dataset.terrainSearchBound = '1';
    input.addEventListener('input', () => {
      delete input.dataset.pickedLat;
      delete input.dataset.pickedLon;
      clearTimeout(terrainSearchTimer);
      const q = input.value.trim();
      if (q.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
      if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(q)) { box.classList.add('hidden'); box.innerHTML = ''; return; }
      terrainSearchTimer = setTimeout(async () => {
        if (typeof window.forwardGeocode !== 'function') {
          box.classList.remove('hidden');
          box.innerHTML = '<div class="tx-suggest-empty">Place search is unavailable (geocoder not loaded on this page).</div>';
          return;
        }
        try {
          const results = await window.forwardGeocode(q);
          if (!results || !results.length) {
            box.classList.remove('hidden');
            box.innerHTML = '<div class="tx-suggest-empty">No matching place found.</div>';
            return;
          }
          box.innerHTML = '';
          results.slice(0, 5).forEach((r) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'tx-suggest-item';
            item.innerHTML = `<span class="tx-suggest-icon">${searchResultIcon(r)}</span><span class="tx-suggest-name"></span>`;
            item.querySelector('.tx-suggest-name').textContent = r.display_name || r.name || `${r.lat}, ${r.lon}`;
            item.addEventListener('click', () => {
              box.classList.add('hidden');
              box.innerHTML = '';
              input.value = r.display_name || '';
              input.dataset.pickedLat = r.lat;
              input.dataset.pickedLon = r.lon;
              TX.pendingShrinkBbox = true;
              txEl('terrainGenerateBtn')?.click();
            });
            box.appendChild(item);
          });
          box.classList.remove('hidden');
        } catch (err) {
          box.classList.remove('hidden');
          box.innerHTML = `<div class="tx-suggest-empty">Search failed: ${String(err.message || err)}</div>`;
        }
      }, 250);
    });
    document.addEventListener('click', (e) => {
      if (!box.classList.contains('hidden') && !e.target.closest('#terrainSearchWrap')) {
        box.classList.add('hidden');
      }
    });
  }

  // --- cross-section tool ------------------------------------------------------
  function txDefaultSectionLine() {
    const mid = (TX.bbox.v0 + TX.bbox.v1) / 2;
    TX.section.a = { u: TX.bbox.u0 + 0.05, v: mid };
    TX.section.b = { u: TX.bbox.u1 - 0.05, v: mid };
  }
  function setSectionMode(on) {
    TX.section.active = !!on;
    const btn = txEl('txSectionToggle');
    if (btn) btn.classList.toggle('active', TX.section.active);
    const ctrls = txEl('txSectionControls');
    if (ctrls) ctrls.classList.toggle('hidden', !TX.section.active);
    if (TX.section.active && (!TX.section.a || !TX.section.b)) txDefaultSectionLine();
    renderTopoMap();
  }
  function generateSectionProfile() {
    if (!terrainData || !TX.section.a || !TX.section.b) {
      setStatus('Draw a section line on the 2D preview map first.', 'error');
      return null;
    }
    const N = 128;
    const a = txUVToWorld(TX.section.a.u, TX.section.a.v);
    const b = txUVToWorld(TX.section.b.u, TX.section.b.v);
    const samples = [];
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const e = txElevationAtWorld(x, z);
      const elev = Number.isFinite(e) ? e : 0;
      samples.push(elev);
      if (elev < min) min = elev;
      if (elev > max) max = elev;
      sum += elev;
    }
    const geoA = txLocalToGeo(a.x, a.z), geoB = txLocalToGeo(b.x, b.z);
    const midLat = (geoA.lat + geoB.lat) / 2 * Math.PI / 180;
    const lengthKm = Math.hypot((geoB.lat - geoA.lat) * 111.32, (geoB.lon - geoA.lon) * 111.32 * Math.cos(midLat));
    const profile = { lengthKm, min, max, mean: sum / N, relief: max - min, samples };
    const cv = txEl('txProfileCanvas');
    if (cv) {
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
      const padL = 44, padB = 22, padT = 12, padR = 10;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const span = Math.max(1e-9, max - min);
      const X = (i) => padL + (i / (N - 1)) * plotW;
      const Y = (e) => padT + (1 - (e - min) / span) * plotH;
      ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
      ctx.strokeRect(padL, padT, plotW, plotH);
      ctx.fillStyle = '#94a3b8'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(max)} m`, padL - 4, Y(max) + 4);
      ctx.fillText(`${Math.round(min)} m`, padL - 4, Y(min) + 4);
      ctx.textAlign = 'left';
      ctx.fillText('0 km', padL, H - 6);
      ctx.fillText(`${lengthKm.toFixed(2)} km`, W - padR - 52, H - 6);
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
      ctx.beginPath();
      samples.forEach((e, i) => { if (i === 0) ctx.moveTo(X(i), Y(e)); else ctx.lineTo(X(i), Y(e)); });
      ctx.stroke();
      ctx.lineTo(X(N - 1), padT + plotH); ctx.lineTo(X(0), padT + plotH); ctx.closePath();
      ctx.fillStyle = 'rgba(56,189,248,0.18)'; ctx.fill();
    }
    const stats = txEl('txProfileStats');
    if (stats) {
      stats.textContent =
        `Length ${lengthKm.toFixed(2)} km · Min ${min.toFixed(1)} m · Max ${max.toFixed(1)} m · ` +
        `Mean ${profile.mean.toFixed(1)} m · Relief ${profile.relief.toFixed(1)} m`;
    }
    return profile;
  }

  // --- layer visibility in the 3D scene (driven by the 3D section) -----------
  function applyTopoLayerVisibility() {
    if (!gisGroup) return;
    const L = TX.layers3d;
    gisGroup.children.forEach((m) => {
      const rec = m.userData?.record;
      const kind = m.userData?.kind;
      if (m.name === 'gisRoads') { m.visible = !!L.roads; return; }
      if (m.name === 'gisRailways') { m.visible = !!L.railways; return; }
      if (m.name === 'gisTree') { m.visible = !!L.trees; return; }
      if (kind === 'water') { m.visible = !!L.waterways; return; }
      if (kind === 'green') { m.visible = !!L.trees; return; }
      if (rec && rec.type === 'building') { m.visible = !!L.buildings; return; }
    });
    if (cityGroup) cityGroup.visible = !!L.buildings;
    if (terrainMesh) terrainMesh.visible = !!L.terrainMesh;
    if (contourGroup) contourGroup.visible = !!L.contours;
    setShadows(!!L.shadows);
  }

  // --- interval / DTM dropdown (one shared menu) ------------------------------
  let txIntervalTarget = null; // { kind: 'contour' | 'dtm' }
  function txIntervalOptions(kind) {
    if (kind === 'dtm') return { options: TX_DTM_RESOLUTIONS, current: TX.dtmResolutionM, label: 'DTM Resolution', min: 0.5 };
    return { options: TX_CONTOUR_INTERVALS, current: TX.contourIntervalM, label: 'Contour interval', min: 0.1 };
  }
  function txOpenIntervalMenu(kind, anchorBtn) {
    txIntervalTarget = { kind };
    const menu = txEl('txIntervalMenu');
    const input = txEl('txIntervalInput');
    const opts = txEl('txIntervalOptions');
    if (!menu || !input || !opts) return;
    const spec = txIntervalOptions(kind);
    input.value = `${spec.current.toFixed(2)} m`;
    opts.innerHTML = '';
    spec.options.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tx-interval-option' + (v === spec.current ? ' selected' : '');
      b.textContent = `${v} m`;
      b.addEventListener('click', () => {
        txApplyInterval(kind, v);
        txCloseIntervalMenu();
      });
      opts.appendChild(b);
    });
    menu.classList.remove('hidden');
    if (anchorBtn && anchorBtn.getBoundingClientRect) {
      // Menu is position:fixed, so viewport coordinates ONLY. Adding
      // window.scrollY/scrollX (document scroll) pushed it off-screen whenever
      // the page/modal was scrolled (found live on the Mac, 2026-11-07).
      const r = anchorBtn.getBoundingClientRect();
      const menuH = 260, menuW = 232; // approx. menu size; clamp inside viewport
      menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - menuH))}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left - 40, window.innerWidth - menuW))}px`;
    }
  }
  function txCloseIntervalMenu() {
    txEl('txIntervalMenu')?.classList.add('hidden');
    txIntervalTarget = null;
  }
  function txApplyInterval(kind, value) {
    if (kind === 'dtm') {
      TX.dtmResolutionM = value;
    } else {
      TX.contourIntervalM = value;
      rebuildContours();
    }
    txSyncIntervalButtons();
    renderTopoMap();
    return true;
  }
  function txSyncIntervalButtons() {
    document.querySelectorAll('[data-tx-interval="contour"]').forEach((b) => { b.textContent = `${TX.contourIntervalM} m`; });
    document.querySelectorAll('[data-tx-interval="dtm"]').forEach((b) => { b.textContent = `${TX.dtmResolutionM} m`; });
    // Interval buttons are disabled while their layer is off.
    const c2 = txEl('tx2dContourBtn'); if (c2) c2.disabled = !TX.layers2d.contours;
    const c3 = txEl('tx3dContourBtn'); if (c3) c3.disabled = !TX.layers3d.contours;
    const cr = txEl('txRawContourBtn'); if (cr) cr.disabled = !TX.layersRaw.contours;
    const d3 = txEl('txDtmBtn'); if (d3) d3.disabled = !TX.layers3d.terrainMesh;
    const dr = txEl('txRawDtmBtn'); if (dr) dr.disabled = !TX.layersRaw.terrain;
  }
  function txNote(msg) {
    const el = txEl('txNote');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    setStatus(msg, 'warn');
  }

  // --- configurator wiring ----------------------------------------------------
  function txSetMaster(section, on) {
    TX.master[section] = !!on;
    const body = txEl(`txSection-${section}`);
    if (body) body.classList.toggle('collapsed', !on);
    if (section === 'raw' && on) {
      // Ticking Raw Formats ticks all its layers except Terrain.
      Object.keys(TX.layersRaw).forEach((k) => { if (k !== 'terrain') TX.layersRaw[k] = true; });
      Object.keys(TX.layersRaw).forEach((k) => {
        const cb = txEl(`txRaw-${k}`);
        if (cb) cb.checked = TX.layersRaw[k];
      });
    }
    txSyncIntervalButtons();
  }
  function txLayerChanged(section, key, checked) {
    if (section === 'd2') TX.layers2d[key] = checked;
    else if (section === 'd3') TX.layers3d[key] = checked;
    else if (section === 'raw') TX.layersRaw[key] = checked;
    if (section === 'd3') applyTopoLayerVisibility();
    if (key === 'contours') {
      if (section === 'd3') rebuildContours();
      txSyncIntervalButtons();
    }
    if (key === 'terrain' || key === 'terrainMesh') txSyncIntervalButtons();
    renderTopoMap();
  }
  function txUpdateCoverageNote() {
    const el = txEl('txCoverageNote');
    if (!el) return;
    const notes = [];
    notes.push('Cadastral parcels: no cadastre data is available for this area, so parcel boundaries are not included in exports (never invented).');
    if (!gisSourceData.railways.length) notes.push('Railways: no railway features returned by OpenStreetMap for this area.');
    if (!gisSourceData.buildings.length) notes.push('Buildings: no building footprints returned by OpenStreetMap for this area.');
    notes.push('Detailed terrain / LoD2 rooftops: only available where the source data supports them; this build uses the planner DEM and flat-roof extrusions.');
    el.textContent = notes.join(' ');
  }
  function bindLxExportControls() {
    if (!txEl('lxExportPanel') || txEl('lxExportPanel').dataset.txBound) return;
    txEl('lxExportPanel').dataset.txBound = '1';
    // Section tool
    txEl('txSectionToggle')?.addEventListener('click', () => setSectionMode(!TX.section.active));
    txEl('txSectionModeSelect')?.addEventListener('change', (e) => { TX.section.mode = e.target.value; });
    txEl('txSectionGenerate')?.addEventListener('click', generateSectionProfile);
    // Mini-map pointer handling
    const cv = txMapCanvas();
    if (cv) {
      cv.addEventListener('pointerdown', txMapPointerDown);
      cv.addEventListener('pointermove', txMapPointerMove);
      cv.addEventListener('pointerup', txMapPointerUp);
      cv.addEventListener('pointercancel', txMapPointerUp);
    }
    // Section collapse (chevron) + master checkboxes
    document.querySelectorAll('.tx-section-head').forEach((head) => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('input[type="checkbox"], label')) return; // master checkbox/label toggles only the master, not the collapse
        const body = txEl(`txSection-${head.dataset.txSection}`);
        if (body) body.classList.toggle('collapsed');
        head.classList.toggle('collapsed');
      });
    });
    document.querySelectorAll('.tx-master').forEach((cb) => {
      cb.addEventListener('change', () => txSetMaster(cb.dataset.txSection, cb.checked));
    });
    // Layer checkboxes
    document.querySelectorAll('.tx-layer input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const section = cb.dataset.txSection, key = cb.dataset.txLayer;
        txLayerChanged(section, key, cb.checked);
      });
    });
    // Format buttons (single-select per section)
    document.querySelectorAll('.tx-fmt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.txSection, format = btn.dataset.txFormat;
        const res = txSelectFormat(section, format);
        if (!res.ok) { txNote(res.reason); return; }
        document.querySelectorAll(`.tx-fmt[data-tx-section="${section}"]`).forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    // Interval / DTM buttons open the shared menu
    document.querySelectorAll('[data-tx-interval]').forEach((btn) => {
      btn.addEventListener('click', () => txOpenIntervalMenu(btn.dataset.txInterval, btn));
    });
    txEl('txIntervalInput')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !txIntervalTarget) return;
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v <= 0) { txNote('Enter an interval in metres, for example "5 m".'); return; }
      const spec = txIntervalOptions(txIntervalTarget.kind);
      const clamped = Math.max(v, spec.min);
      if (clamped !== v) txNote(`${spec.label} below ${spec.min} m is not practical — using ${spec.min} m.`);
      txApplyInterval(txIntervalTarget.kind, clamped);
      txCloseIntervalMenu();
    });
    document.addEventListener('click', (e) => {
      const menu = txEl('txIntervalMenu');
      if (menu && !menu.classList.contains('hidden') && !e.target.closest('#txIntervalMenu') && !e.target.closest('[data-tx-interval]')) txCloseIntervalMenu();
    });
    // Export Now
    txEl('txExportNow')?.addEventListener('click', runLxExport);
    txSyncIntervalButtons();
  }
  function refreshLxExport() {
    if (!txEl('lxExportPanel')) return;
    if (TX.pendingShrinkBbox && terrainData) {
      TX.pendingShrinkBbox = false;
      const sideKm = Math.min(1, terrainData.areaKm);
      const f = sideKm / terrainData.areaKm / 2;
      TX.bbox = { u0: 0.5 - f, v0: 0.5 - f, u1: 0.5 + f, v1: 0.5 + f };
      txClampBbox();
    }
    rebuildContours();
    applyTopoLayerVisibility();
    updateTopoReadouts();
    txUpdateCoverageNote();
    renderTopoMap();
  }
  function resetLxExport() {
    TX.bbox = { u0: 0, v0: 0, u1: 1, v1: 1 };
    TX.section = { active: false, mode: 'select', a: null, b: null };
    TX.pendingShrinkBbox = false;
    clearContours();
    const my = txEl('txMyExport');
    if (my) my.classList.add('hidden');
    updateTopoReadouts();
    renderTopoMap();
  }

  // --- export content: gather the planner's own scene data in the box --------
  function txFeatureInBbox(geometry) {
    if (!geometry || !geometry.length) return false;
    return geometry.some((p) => txPointInBbox(p.lat, p.lon));
  }
  function collectExportFeatures() {
    const out = { buildings: [], roads: [], railways: [], water: [], vegetation: [], contours: contourSegments.slice(), shadows: false };
    if (!terrainData) return out;
    const inBox = (g) => txFeatureInBbox(g);
    out.buildings = gisSourceData.buildings.filter((f) => inBox(f.geometry));
    out.roads = gisSourceData.roads.filter((w) => inBox(w.geometry));
    out.railways = gisSourceData.railways.filter((w) => inBox(w.geometry));
    out.water = gisSourceData.water.filter((el) => inBox(el.geometry));
    out.vegetation = gisSourceData.vegetation.filter((el) => inBox(el.geometry));
    out.shadows = !!TX.layers2d.shadows;
    return out;
  }
  function txClipPolylineToBbox(worldPts) {
    // worldPts: [{x, z}] -> clipped sub-polylines in world units (or [] when outside)
    const parts = [];
    let current = [];
    for (let i = 0; i < worldPts.length - 1; i++) {
      const seg = txClipSegmentToBbox(worldPts[i].x, worldPts[i].z, worldPts[i + 1].x, worldPts[i + 1].z);
      if (!seg) {
        if (current.length > 1) parts.push(current);
        current = [];
        continue;
      }
      if (!current.length) current.push({ x: seg.x1, z: seg.z1 });
      current.push({ x: seg.x2, z: seg.z2 });
    }
    if (current.length > 1) parts.push(current);
    return parts;
  }
  function txGeoPolylineMeters(geometry) {
    // OSM lat/lon ring -> local-metre polylines clipped to the selection box
    if (!geometry || geometry.length < 2) return [];
    const world = geometry.map((p) => geoToLocal(p.lat, p.lon));
    return txClipPolylineToBbox(world).map((part) =>
      part.map((pt) => {
        const m = txWorldToLocalMeters(pt.x, pt.z);
        return { x: m.eastM, y: m.northM, z: txElevationAtWorld(pt.x, pt.z) || 0 };
      })
    );
  }
  function txExportMeta() {
    const corners = txBboxCorners();
    const size = txBboxKm();
    return {
      generator: 'Lupus Cortex 3D City Planner (own implementation)',
      location: terrainData?.center?.name || null,
      bbox_sw: corners ? [corners.sw.lon, corners.sw.lat] : null,
      bbox_ne: corners ? [corners.ne.lon, corners.ne.lat] : null,
      area_km2: size ? Math.round(size.areaKm2 * 100) / 100 : null,
      width_km: size ? Math.round(size.wKm * 100) / 100 : null,
      height_km: size ? Math.round(size.hKm * 100) / 100 : null,
      contour_interval_m: TX.contourIntervalM,
      dtm_resolution_m: TX.dtmResolutionM,
      sources: 'Buildings/roads/water/vegetation: OpenStreetMap (Overpass). Elevation: Open-Meteo Elevation API / Terrarium raster DEM.',
      coordinates: 'DXF/SVG: local metres east/north of the selection SW corner. GeoJSON: WGS84 lon/lat (equirectangular conversion around the area centre, approximate).',
      note: 'Exports are derived from open data and are NOT survey-grade. Do not use for legal boundaries or construction staking.',
      generated_at: new Date().toISOString(),
    };
  }

  // --- DXF (plain-text, AutoCAD-readable) ------------------------------------
  function dxfLayerTable(layers) {
    const colors = { BUILDINGS: 7, ROADS: 8, RAILWAYS: 8, WATER: 5, VEGETATION: 3, CONTOURS: 3, TERRAIN: 9, PARCELS: 7 };
    let s = '  0\nSECTION\n  2\nTABLES\n  0\nTABLE\n  2\nLAYER\n 70\n' + layers.length + '\n';
    layers.forEach((name) => {
      s += '  0\nLAYER\n  2\n' + name + '\n 70\n0\n 62\n' + (colors[name] || 7) + '\n  6\nContinuous\n';
    });
    return s + '  0\nENDTAB\n  0\nENDSEC\n';
  }
  function dxfPolyline(layer, pts, closed) {
    let s = '  0\nPOLYLINE\n  8\n' + layer + '\n 66\n1\n 70\n' + (closed ? 1 : 0) + '\n';
    pts.forEach((p) => {
      s += '  0\nVERTEX\n  8\n' + layer + '\n 10\n' + p.x.toFixed(3) + '\n 20\n' + p.y.toFixed(3) + '\n 30\n' + (p.z || 0).toFixed(3) + '\n';
    });
    return s + '  0\nSEQEND\n  8\n' + layer + '\n';
  }
  function dxfLine(layer, a, b) {
    return '  0\nLINE\n  8\n' + layer + '\n 10\n' + a.x.toFixed(3) + '\n 20\n' + a.y.toFixed(3) + '\n 30\n' + (a.z || 0).toFixed(3) +
      '\n 11\n' + b.x.toFixed(3) + '\n 21\n' + b.y.toFixed(3) + '\n 31\n' + (b.z || 0).toFixed(3) + '\n';
  }
  function dxf3DFace(layer, a, b, c) {
    const f = (p) => ' 10\n' + p.x.toFixed(3) + '\n 20\n' + p.y.toFixed(3) + '\n 30\n' + (p.z || 0).toFixed(3) + '\n';
    return '  0\n3DFACE\n  8\n' + layer + '\n' + f(a) + ' 11\n' + b.x.toFixed(3) + '\n 21\n' + b.y.toFixed(3) + '\n 31\n' + (b.z || 0).toFixed(3) +
      '\n 12\n' + c.x.toFixed(3) + '\n 22\n' + c.y.toFixed(3) + '\n 32\n' + (c.z || 0).toFixed(3) +
      '\n 13\n' + c.x.toFixed(3) + '\n 23\n' + c.y.toFixed(3) + '\n 33\n' + (c.z || 0).toFixed(3) + '\n';
  }
  function dxfHeader(meta) {
    const size = txBboxKm() || { wKm: 0, hKm: 0 };
    return '  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1009\n  9\n$INSBASE\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  9\n$EXTMIN\n 10\n0.0\n 20\n0.0\n  9\n$EXTMAX\n 10\n' + (size.wKm * 1000).toFixed(3) + '\n 20\n' + (size.hKm * 1000).toFixed(3) +
      '\n  0\nENDSEC\n  0\nSECTION\n  2\nCOMMENT\n  1\n' + meta.generator + ' | ' + meta.sources + ' | ' + meta.note + '\n  0\nENDSEC\n';
  }
  // Pure DXF builder: features are local-metre polylines, contours are
  // {level, x1,y1,z1,x2,y2,z2} segments. Testable without the scene.
  function buildDxfText(kind, features, meta) {
    const layers2d = ['BUILDINGS', 'ROADS', 'RAILWAYS', 'WATER', 'VEGETATION', 'CONTOURS'];
    const layers3d = ['TERRAIN', 'BUILDINGS', 'ROADS', 'RAILWAYS', 'WATER', 'VEGETATION', 'CONTOURS'];
    const layers = kind === '3d' ? layers3d : layers2d;
    let s = dxfHeader(meta) + dxfLayerTable(layers) + '  0\nSECTION\n  2\nENTITIES\n';
    const addRing = (layer, ring, closed) => { if (ring.length > 1) s += dxfPolyline(layer, ring, closed); };
    (features.buildings || []).forEach((ring) => addRing('BUILDINGS', ring, true));
    (features.roads || []).forEach((line) => addRing('ROADS', line, false));
    (features.railways || []).forEach((line) => addRing('RAILWAYS', line, false));
    (features.water || []).forEach((ring) => addRing('WATER', ring, true));
    (features.vegetation || []).forEach((ring) => addRing('VEGETATION', ring, true));
    (features.contours || []).forEach((c) => {
      s += dxfLine('CONTOURS', { x: c.x1, y: c.y1, z: c.z1 }, { x: c.x2, y: c.y2, z: c.z2 });
    });
    if (kind === '3d') {
      (features.terrainFaces || []).forEach((f) => { s += dxf3DFace('TERRAIN', f[0], f[1], f[2]); });
      (features.buildingTops || []).forEach((ring) => addRing('BUILDINGS', ring, true));
    }
    return s + '  0\nENDSEC\n  0\nEOF\n';
  }
  function txBuildDxf2D(features) {
    const meta = txExportMeta();
    const f = { buildings: [], roads: [], railways: [], water: [], vegetation: [], contours: [] };
    features.buildings.forEach((b) => txGeoPolylineMeters(b.geometry).forEach((ring) => f.buildings.push(ring.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.roads.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.roads.push(line.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.railways.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.railways.push(line.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.water.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.water.push(ring.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.vegetation.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.vegetation.push(ring.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.contours.forEach((c) => {
      const a = txWorldToLocalMeters(c.x1, c.z1), b = txWorldToLocalMeters(c.x2, c.z2);
      f.contours.push({ x1: a.eastM, y1: a.northM, z1: c.level, x2: b.eastM, y2: b.northM, z2: c.level });
    });
    return { text: buildDxfText('2d', f, meta), counts: txCountFeatures(f) };
  }
  function txBuildDxf3D(features) {
    const meta = txExportMeta();
    const f = { buildings: [], roads: [], railways: [], water: [], vegetation: [], contours: [], terrainFaces: [], buildingTops: [] };
    // Terrain mesh as 3DFACE, decimated to about the chosen DTM resolution.
    if (terrainData && terrainData.grid) {
      const res = terrainData.resolution;
      const cellM = (terrainData.areaKm * 1000) / Math.max(1, res - 1);
      const step = Math.max(1, Math.round(TX.dtmResolutionM / Math.max(1, cellM)));
      for (let r = 0; r < res - 1; r += step) {
        for (let c = 0; c < res - 1; c += step) {
          const r2 = Math.min(res - 1, r + step), c2 = Math.min(res - 1, c + step);
          const P = (rr, cc) => {
            const w = { x: (cc / (res - 1) - 0.5) * PLANE_SIZE, z: (rr / (res - 1) - 0.5) * PLANE_SIZE };
            const m = txWorldToLocalMeters(w.x, w.z);
            return { x: m.eastM, y: m.northM, z: terrainData.grid[rr][cc] };
          };
          const a = P(r, c), b = P(r, c2), d = P(r2, c), e = P(r2, c2);
          f.terrainFaces.push([a, d, b]);
          f.terrainFaces.push([b, d, e]);
        }
      }
    }
    features.buildings.forEach((b) => {
      txGeoPolylineMeters(b.geometry).forEach((ring) => {
        const base = ring.map((p) => ({ x: p.x, y: p.y, z: 0 }));
        const top = ring.map((p) => ({ x: p.x, y: p.y, z: b.height_m || TX_DEFAULT_BUILDING_HEIGHT_M }));
        f.buildings.push(base);
        f.buildingTops.push(top);
      });
    });
    features.roads.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.roads.push(line)));
    features.railways.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.railways.push(line)));
    features.water.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.water.push(ring.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.vegetation.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.vegetation.push(ring.map((p) => ({ x: p.x, y: p.y, z: 0 })))));
    features.contours.forEach((c) => {
      const a = txWorldToLocalMeters(c.x1, c.z1), b = txWorldToLocalMeters(c.x2, c.z2);
      f.contours.push({ x1: a.eastM, y1: a.northM, z1: c.level, x2: b.eastM, y2: b.northM, z2: c.level });
    });
    return { text: buildDxfText('3d', f, meta), counts: txCountFeatures(f) };
  }
  function txCountFeatures(f) {
    return {
      buildings: (f.buildings || []).length, roads: (f.roads || []).length, railways: (f.railways || []).length,
      water: (f.water || []).length, vegetation: (f.vegetation || []).length,
      contours: (f.contours || []).length, terrainFaces: (f.terrainFaces || []).length,
    };
  }

  // --- SVG (colour-coded 2D plan, like the 2D preview) ------------------------
  function buildSvgText(features, meta) {
    const size = txBboxKm() || { wKm: 0, hKm: 0 };
    const W = Math.max(1, Math.round(size.wKm * 1000)), H = Math.max(1, Math.round(size.hKm * 1000));
    const Y = (y) => H - y;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
      `<!-- ${meta.generator} | ${meta.sources} | ${meta.note} -->\n` +
      `<title>${meta.location ? meta.location.replace(/&/g, '&amp;') : 'Site plan'} — ${meta.area_km2} km²</title>\n` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="#eef2ee"/>\n`;
    const path = (ring, close) => 'M' + ring.map((p) => `${p.x.toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' L') + (close ? ' Z' : '');
    (features.vegetation || []).forEach((ring) => { s += `<path d="${path(ring, true)}" fill="#7ed491" stroke="#2e7d32" stroke-width="1"/>\n`; });
    (features.water || []).forEach((ring) => { s += `<path d="${path(ring, true)}" fill="#7cc4ea" stroke="#1d7fb8" stroke-width="1"/>\n`; });
    (features.roads || []).forEach((line) => { s += `<path d="${path(line, false)}" fill="none" stroke="#2b2f36" stroke-width="2"/>\n`; });
    (features.railways || []).forEach((line) => { s += `<path d="${path(line, false)}" fill="none" stroke="#4b5563" stroke-width="1.5" stroke-dasharray="6 4"/>\n`; });
    (features.buildings || []).forEach((ring) => { s += `<path d="${path(ring, true)}" fill="#f5f5f5" stroke="#333333" stroke-width="1.2"/>\n`; });
    (features.contours || []).forEach((c) => {
      s += `<line x1="${c.x1.toFixed(1)}" y1="${Y(c.y1).toFixed(1)}" x2="${c.x2.toFixed(1)}" y2="${Y(c.y2).toFixed(1)}" stroke="#2e7d32" stroke-width="0.7" data-elev="${c.z1}"/>\n`;
    });
    return s + '</svg>\n';
  }
  function txBuildSvg(features) {
    const meta = txExportMeta();
    const f = { buildings: [], roads: [], railways: [], water: [], vegetation: [], contours: [] };
    features.buildings.forEach((b) => txGeoPolylineMeters(b.geometry).forEach((ring) => f.buildings.push(ring)));
    features.roads.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.roads.push(line)));
    features.railways.forEach((w) => txGeoPolylineMeters(w.geometry).forEach((line) => f.railways.push(line)));
    features.water.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.water.push(ring)));
    features.vegetation.forEach((el) => txGeoPolylineMeters(el.geometry).forEach((ring) => f.vegetation.push(ring)));
    features.contours.forEach((c) => {
      const a = txWorldToLocalMeters(c.x1, c.z1), b = txWorldToLocalMeters(c.x2, c.z2);
      f.contours.push({ x1: a.eastM, y1: a.northM, z1: c.level, x2: b.eastM, y2: b.northM, z2: c.level });
    });
    return { text: buildSvgText(f, meta), counts: txCountFeatures(f) };
  }

  // --- GeoJSON (WGS84) --------------------------------------------------------
  function txLonLatRing(geometry) {
    if (!geometry || geometry.length < 2) return null;
    const ring = geometry.map((p) => { const g = txLocalToGeo(geoToLocal(p.lat, p.lon).x, geoToLocal(p.lat, p.lon).z); return [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]; });
    if (ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
    return ring;
  }
  function txBuildGeoJson(features) {
    const meta = txExportMeta();
    const out = { type: 'FeatureCollection', bbox: meta.bbox_sw && meta.bbox_ne ? [meta.bbox_sw[0], meta.bbox_sw[1], meta.bbox_ne[0], meta.bbox_ne[1]] : undefined, features: [], properties: meta };
    const add = (type, coords, props) => out.features.push({ type: 'Feature', geometry: { type, coordinates: coords }, properties: props });
    features.buildings.forEach((b) => {
      const ring = txLonLatRing(b.geometry);
      if (ring) add('Polygon', [ring], { layer: 'buildings', source: 'OpenStreetMap', id: b.id, height_m: b.height_m, height_source: b.height_source });
    });
    features.roads.forEach((w) => {
      const line = (w.geometry || []).map((p) => { const g = txLocalToGeo(geoToLocal(p.lat, p.lon).x, geoToLocal(p.lat, p.lon).z); return [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]; });
      if (line.length > 1) add('LineString', line, { layer: 'roads', source: 'OpenStreetMap', id: `osm-way-${w.id}`, highway: w.tags?.highway || null });
    });
    features.railways.forEach((w) => {
      const line = (w.geometry || []).map((p) => { const g = txLocalToGeo(geoToLocal(p.lat, p.lon).x, geoToLocal(p.lat, p.lon).z); return [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]; });
      if (line.length > 1) add('LineString', line, { layer: 'railways', source: 'OpenStreetMap', id: `osm-way-${w.id}`, railway: w.tags?.railway || null });
    });
    features.water.forEach((el) => {
      const ring = txLonLatRing(el.geometry);
      if (ring) add('Polygon', [ring], { layer: 'waterways', source: 'OpenStreetMap', id: `osm-way-${el.id}` });
    });
    features.vegetation.forEach((el) => {
      const ring = txLonLatRing(el.geometry);
      if (ring) add('Polygon', [ring], { layer: 'trees_and_green_spaces', source: 'OpenStreetMap', id: `osm-way-${el.id}` });
    });
    features.contours.forEach((c) => {
      const a = txLocalToGeo(c.x1, c.z1), b = txLocalToGeo(c.x2, c.z2);
      add('LineString', [[Math.round(a.lon * 1e6) / 1e6, Math.round(a.lat * 1e6) / 1e6], [Math.round(b.lon * 1e6) / 1e6, Math.round(b.lat * 1e6) / 1e6]], { layer: 'contour_lines', source: 'planner DEM', elevation_m: c.level, interval_m: TX.contourIntervalM });
    });
    return { text: JSON.stringify(out, null, 2), counts: { features: out.features.length } };
  }
  function txBuildTxtSummary(features, fileList) {
    const meta = txExportMeta();
    const lines = [
      'Lupus Cortex 3D City Planner — export summary',
      `Location: ${meta.location || 'unknown'}`,
      `Area: ${meta.area_km2} km² (${meta.width_km} km × ${meta.height_km} km)`,
      `Bounding box SW: ${meta.bbox_sw ? meta.bbox_sw[1].toFixed(5) + ', ' + meta.bbox_sw[0].toFixed(5) : 'n/a'} | NE: ${meta.bbox_ne ? meta.bbox_ne[1].toFixed(5) + ', ' + meta.bbox_ne[0].toFixed(5) : 'n/a'}`,
      `Contour interval: ${meta.contour_interval_m} m | DTM resolution: ${meta.dtm_resolution_m} m`,
      `Buildings: ${features.buildings.length} | Roads: ${features.roads.length} | Railways: ${features.railways.length} | Water: ${features.water.length} | Green: ${features.vegetation.length} | Contour segments: ${features.contours.length}`,
      `Files in this export: ${fileList.map((f) => f.name).join(', ')}`,
      `Sources: ${meta.sources}`,
      `Coordinates: ${meta.coordinates}`,
      meta.note,
      `Generated: ${meta.generated_at}`,
    ];
    return { text: lines.join('\n') + '\n', counts: {} };
  }

  // --- 3D model blobs (reuse the existing export group; collect, don't save) --
  function txBuildStlBlob() {
    if (!terrainMesh || !THREE.STLExporter) return null;
    const group = buildExportGroup(false);
    const result = new THREE.STLExporter().parse(group, { binary: true });
    return new Blob([result.buffer || result], { type: 'application/octet-stream' });
  }
  function txBuildObjBlobs() {
    if (!terrainMesh || !THREE.OBJExporter) return null;
    const group = buildExportGroup(true);
    const base = modelBaseName();
    let obj = new THREE.OBJExporter().parse(group);
    const out = [];
    const hasTex = surfaceMode === 'satellite' && satelliteTexture;
    if (hasTex) {
      obj = `mtllib ${base}.mtl\n` + obj;
      const mtl = `newmtl terrain_surface\nKa 1 1 1\nKd 1 1 1\nd 1\nillum 1\nmap_Kd ${base}.png\n`;
      out.push({ name: `${base}.mtl`, blob: new Blob([mtl], { type: 'text/plain' }) });
      const img = satelliteTexture.image;
      if (img && img.toBlob) {
        return new Promise((resolve) => {
          img.toBlob((b) => { if (b) out.push({ name: `${base}.png`, blob: b }); out.push({ name: `${base}.obj`, blob: new Blob([obj], { type: 'text/plain' }) }); resolve(out); }, 'image/png');
        });
      }
      if (img && img.toDataURL) out.push({ name: `${base}.png`, blob: dataURLToBlob(img.toDataURL('image/png')) });
    }
    out.push({ name: `${base}.obj`, blob: new Blob([obj], { type: 'text/plain' }) });
    return out;
  }
  function txBuildGlbBlob() {
    if (!terrainMesh || !THREE.GLTFExporter) return Promise.resolve(null);
    const group = buildExportGroup(true);
    return new Promise((resolve) => {
      new THREE.GLTFExporter().parse(group, (result) => {
        resolve(new Blob([result], { type: 'model/gltf-binary' }));
      }, { binary: true });
    });
  }
  function txBuildSatelliteJpeg() {
    if (!satelliteTexture || !satelliteTexture.image) return Promise.resolve(null);
    const img = satelliteTexture.image;
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth || img.width;
    cv.height = img.naturalHeight || img.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(img, 0, 0);
    return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/jpeg', 0.92));
  }

  // --- Export Now: async job with progress + "My export" file list -----------
  function txSetExportProgress(text) {
    const el = txEl('txExportProgress');
    if (el) el.textContent = text;
  }
  function txRenderMyExport(files, notes) {
    const view = txEl('txMyExport');
    const list = txEl('txExportFiles');
    const noteEl = txEl('txExportNotes');
    if (!view || !list) return;
    view.classList.remove('hidden');
    list.innerHTML = '';
    files.forEach((f) => {
      const url = URL.createObjectURL(f.blob);
      const row = document.createElement('div');
      row.className = 'tx-file-row';
      const kb = f.blob.size >= 1024 ? `${(f.blob.size / 1024).toFixed(1)} KB` : `${f.blob.size} B`;
      row.innerHTML = `<a class="tx-file-link" href="${url}" download="${f.name}"></a><span class="tx-file-size">${kb}</span>`;
      row.querySelector('.tx-file-link').textContent = f.name;
      list.appendChild(row);
    });
    if (noteEl) noteEl.textContent = notes.join(' ');
    txSetExportProgress(files.length ? `Export ready — ${files.length} file${files.length > 1 ? 's' : ''}.` : 'Export finished with no files.');
  }
  async function runLxExport() {
    if (!terrainData || !terrainMesh) { setStatus('Generate a terrain first.', 'error'); return; }
    const size = txBboxKm();
    if (size && size.areaKm2 > TX_MAX_AREA_KM2) {
      setStatus(`Selection is ${size.areaKm2.toFixed(2)} km² — above the ${TX_MAX_AREA_KM2} km² limit for one export. Shrink the box to export.`, 'error');
      txNote(`Selection is ${size.areaKm2.toFixed(2)} km² — above the ${TX_MAX_AREA_KM2} km² limit for one export. Shrink the box to export.`);
      return;
    }
    const view = txEl('txMyExport');
    if (view) view.classList.remove('hidden');
    txSetExportProgress('Preparing layers…');
    await new Promise((r) => setTimeout(r, 30));
    const features = collectExportFeatures();
    const files = [];
    const notes = [];
    const meta = txExportMeta();
    const base = modelBaseName();
    // Satellite Image
    if (TX.master.satellite) {
      txSetExportProgress('Building satellite image (JPEG)…');
      const jpg = await txBuildSatelliteJpeg();
      if (jpg) files.push({ name: 'lupus_satellite.jpg', blob: jpg });
      else notes.push('Satellite JPEG was skipped: no satellite imagery is loaded for this area.');
    }
    // 2D Vectorial Map
    if (TX.master.d2) {
      const fmt = TX.format.d2;
      if (!txFormatProducible('d2', fmt)) {
        notes.push(`2D ${fmt} is not available in this browser build — DXF and SVG are. Select DXF or SVG to include the 2D vectorial map.`);
      } else if (fmt === 'DXF') {
        txSetExportProgress('Building 2D vectorial map (DXF)…');
        const out = txBuildDxf2D(features);
        files.push({ name: 'lupus_vectorial.dxf', blob: new Blob([out.text], { type: 'text/plain' }) });
      } else if (fmt === 'SVG') {
        txSetExportProgress('Building 2D vectorial map (SVG)…');
        const out = txBuildSvg(features);
        files.push({ name: 'lupus_vectorial.svg', blob: new Blob([out.text], { type: 'image/svg+xml' }) });
      }
    }
    // 3D Modeling
    if (TX.master.d3) {
      const fmt = TX.format.d3;
      if (!txFormatProducible('d3', fmt)) {
        notes.push(`3D ${fmt} is not available in this browser build — DXF, OBJ, glTF and STL are. Select one of those to include the 3D model.`);
      } else if (fmt === 'DXF') {
        txSetExportProgress('Building 3D model (DXF)…');
        const out = txBuildDxf3D(features);
        files.push({ name: 'lupus_3d.dxf', blob: new Blob([out.text], { type: 'text/plain' }) });
      } else if (fmt === 'OBJ') {
        txSetExportProgress('Building 3D model (OBJ)…');
        const parts = await txBuildObjBlobs();
        (parts || []).forEach((p) => files.push({ name: p.name, blob: p.blob }));
      } else if (fmt === 'glTF') {
        txSetExportProgress('Building 3D model (glTF)…');
        const glb = await txBuildGlbBlob();
        if (glb) files.push({ name: `${base}.glb`, blob: glb });
      } else if (fmt === 'STL') {
        txSetExportProgress('Building 3D model (STL)…');
        const stl = txBuildStlBlob();
        if (stl) files.push({ name: `${base}.stl`, blob: stl });
      }
    }
    // Raw Formats
    if (TX.master.raw) {
      const fmt = TX.format.raw;
      if (!txFormatProducible('raw', fmt)) {
        notes.push(`Raw ${fmt} is not available in this browser build — GeoJSON and TXT are.`);
      } else if (fmt === 'GeoJSON') {
        txSetExportProgress('Building raw data (GeoJSON)…');
        const out = txBuildGeoJson(features);
        files.push({ name: 'lupus_raw.geojson', blob: new Blob([out.text], { type: 'application/geo+json' }) });
      } else if (fmt === 'TXT') {
        txSetExportProgress('Building raw data (TXT)…');
        const out = txBuildTxtSummary(features, files);
        files.push({ name: 'lupus_raw.txt', blob: new Blob([out.text], { type: 'text/plain' }) });
      }
    }
    notes.push(`Coordinates: ${meta.coordinates} ${meta.note}`);
    if (!gisSourceData.buildings.length && !gisSourceData.roads.length) {
      notes.push('Note: no OpenStreetMap features were returned for this area, so vector layers are empty.');
    }
    txRenderMyExport(files, notes);
    setStatus(files.length ? `✅ Export ready — ${files.length} file${files.length > 1 ? 's' : ''} listed under My export.` : 'Export finished with no files (see notes).', files.length ? 'ok' : 'warn');
  }

  // --- REAL scenario features: baseline vs scenario deltas -------------------
  // The old buildExportData() sent buildTwinFeatures() for BOTH baseline and
  // scenario (identical features, delta 0) — see the 2026-11-05 finding. The
  // scenario features are now computed from the same baseline record with the
  // recorded scenario edits applied; the delta is baseline -> scenario.
  //
  // buildTwinFeatures() returns AGGREGATES (not arrays):
  //   terrain {mean/min/max_elevation_m, elevation_range_m, mean/max_slope_pct, ...}
  //   buildings {source_count, rendered_count, building_density_per_km2,
  //     building_footprint_area_m2, builtup_pct, mean/max_height_m, *_coverage_pct}
  //   roads {road_length_km, road_density_km_per_km2}
  //   vegetation {green_space_area_m2, green_space_pct}
  //   water {surface_water_area_m2, surface_water_pct}
  //   surface {impervious_pct}
  // This function edits those aggregates from digitalTwinState.scenario, using
  // the same definitions as buildTwinFeatures() (mean/max height exclude
  // visualization_default heights; coverage is over the remaining buildings).
  function applyScenarioEditsToFeatures(feat, editedTerrain) {
    if (!feat) return null;
    const f = JSON.parse(JSON.stringify(feat));
    const sc = digitalTwinState.scenario;
    const areaKm2 = terrainData ? terrainData.areaKm * terrainData.areaKm : null;
    const areaM2 = areaKm2 ? areaKm2 * 1000000 : null;
    // --- buildings: removals / height modifications / additions ---
    const removedIds = new Set(sc.removedBuildingIds || []);
    const removed = gisSourceData.buildings.filter((b) => removedIds.has(b.id));
    const removedFootprint = removed.reduce((s, b) => s + (Number(b.footprint_area_m2) || 0), 0);
    const renderedIds = new Set((gisRenderData.buildings || []).map((b) => b.id));
    const removedRendered = removed.filter((b) => renderedIds.has(b.id)).length;
    // Heights of the buildings that remain, after height-scale modifications.
    // Keep the source tag so mean/max can exclude visualization_default, exactly
    // as buildTwinFeatures() does for the baseline.
    const heightEntries = [];
    gisSourceData.buildings.forEach((b) => {
      if (removedIds.has(b.id)) return;
      let h = b.height_m;
      const mod = (sc.modifiedBuildings || []).find((m) => m.id === b.id);
      if (mod && mod.height_scale) h = (h || TX_DEFAULT_BUILDING_HEIGHT_M) * mod.height_scale;
      heightEntries.push({ h, src: b.height_source });
    });
    let addedFootprint = 0;
    (sc.addedBuildings || []).forEach((ab) => {
      const h = ab.heightMeters || TX_DEFAULT_BUILDING_HEIGHT_M;
      heightEntries.push({ h, src: 'scenario' });
      if (ab.mesh) {
        const bbox = new THREE.Box3().setFromObject(ab.mesh);
        const mPerUnit = terrainData ? (terrainData.areaKm * 1000) / PLANE_SIZE : 1;
        addedFootprint += Math.max(0, (bbox.max.x - bbox.min.x) * (bbox.max.z - bbox.min.z)) * mPerUnit * mPerUnit;
      }
    });
    const heights = heightEntries.filter((e) => e.src !== 'visualization_default').map((e) => e.h);
    const B = f.buildings || {};
    B.source_count = Math.max(0, (B.source_count || 0) - removed.length + (sc.addedBuildings || []).length);
    B.rendered_count = Math.max(0, (B.rendered_count || 0) - removedRendered + (sc.addedBuildings || []).length);
    B.building_footprint_area_m2 = Math.max(0, (B.building_footprint_area_m2 || 0) - removedFootprint + addedFootprint);
    if (areaKm2) B.building_density_per_km2 = B.source_count / areaKm2;
    if (areaM2) B.builtup_pct = (B.building_footprint_area_m2 / areaM2) * 100;
    B.mean_height_m = heights.length ? heights.reduce((s, v) => s + v, 0) / heights.length : null;
    B.max_height_m = heights.length ? Math.max(...heights) : null;
    const remaining = gisSourceData.buildings.filter((b) => !removedIds.has(b.id));
    const cov = (src) => remaining.length ? (remaining.filter((b) => b.height_source === src).length / remaining.length) * 100 : null;
    B.observed_height_coverage_pct = cov('osm_height');
    B.derived_height_coverage_pct = cov('osm_levels_derived');
    B.default_height_coverage_pct = cov('visualization_default');
    // --- roads: added roads from their recorded points ---
    let addedRoadKm = 0;
    (sc.addedRoads || []).forEach((road) => {
      const pts = road.points || [];
      for (let i = 1; i < pts.length; i++) {
        addedRoadKm += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) / metersToUnits() / 1000;
      }
    });
    const R = f.roads || {};
    R.road_length_km = (R.road_length_km || 0) + addedRoadKm;
    if (areaKm2) R.road_density_km_per_km2 = R.road_length_km / areaKm2;
    // --- vegetation / water removals (by OSM way id) ---
    const removedVegArea = (sc.vegetationChanges || []).filter((c) => c.action === 'remove').reduce((s, c) => {
      const el = gisSourceData.vegetation.find((v) => `osm-way-${v.id}` === c.id || v.id === c.id);
      return s + (el ? polygonAreaM2(el.geometry) || 0 : 0);
    }, 0);
    const removedWaterArea = (sc.waterChanges || []).filter((c) => c.action === 'remove').reduce((s, c) => {
      const el = gisSourceData.water.find((v) => `osm-way-${v.id}` === c.id || v.id === c.id);
      return s + (el ? polygonAreaM2(el.geometry) || 0 : 0);
    }, 0);
    // --- zone-painted cells: zoneGrid is the authoritative record ---
    let parkCells = 0, waterCells = 0;
    if (zoneGrid && terrainData) {
      zoneGrid.forEach((z) => { if (z === 'park') parkCells++; if (z === 'water') waterCells++; });
    }
    const cellM = terrainData ? (terrainData.areaKm * 1000) / Math.max(1, terrainData.resolution - 1) : 0;
    const cellAreaM2 = cellM * cellM;
    const V = f.vegetation || {};
    V.green_space_area_m2 = Math.max(0, (V.green_space_area_m2 || 0) - removedVegArea + parkCells * cellAreaM2);
    if (areaM2) V.green_space_pct = (V.green_space_area_m2 / areaM2) * 100;
    const W = f.water || {};
    W.surface_water_area_m2 = Math.max(0, (W.surface_water_area_m2 || 0) - removedWaterArea + waterCells * cellAreaM2);
    if (areaM2) W.surface_water_pct = (W.surface_water_area_m2 / areaM2) * 100;
    // --- terrain: the edited-grid stats replace the observed DEM stats ---
    if (editedTerrain) {
      const T = f.terrain || {};
      T.mean_elevation_m = editedTerrain.mean;
      T.min_elevation_m = editedTerrain.min;
      T.max_elevation_m = editedTerrain.max;
      T.elevation_range_m = editedTerrain.relief;
      if (Number.isFinite(editedTerrain.mean_slope_pct)) T.mean_slope_pct = editedTerrain.mean_slope_pct;
      if (Number.isFinite(editedTerrain.max_slope_pct)) T.max_slope_pct = editedTerrain.max_slope_pct;
    }
    return f;
  }
  function buildScenarioFeatures(baseline, editedTerrain) {
    // Deep-copy the baseline and apply every recorded scenario edit, so the
    // scenario record reflects what the user actually changed in the planner.
    // editedTerrain is optional: {min, max, mean, relief, mean_slope_pct,
    // max_slope_pct} from the edited elevation grid (buildExportData passes it).
    const copy = JSON.parse(JSON.stringify(baseline));
    const edited = applyScenarioEditsToFeatures(copy, editedTerrain);
    return edited || copy;
  }

  // --- hooks: called from the existing buildCityFromSatellite / importGISData /
  // --- reset / setExaggeration / bindControls (the actual hook call sites are
  // --- patched into the base file; these functions are the handlers) ----------
  function txOnCityBuilt() {
    bindLxExportControls();
    refreshLxExport();
  }
  function txOnReset() {
    resetLxExport();
  }
  function txOnExaggerationChanged() {
    rebuildContours();
    renderTopoMap();
  }

  // --- test hook (used by the node smoke test via window.__lxExport) --------
  window.__lxExport = {
    state: TX,
    TX_MAX_AREA_KM2,
    TX_CONTOUR_INTERVALS,
    TX_DTM_RESOLUTIONS,
    txBboxKm,
    txBboxCorners,
    txClampBbox,
    txSelectFormat,
    txFormatProducible,
    txSetMaster,
    txLayerChanged,
    txApplyInterval,
    txSyncIntervalButtons,
    txElevColor,
    txElevationAtWorld,
    txWorldToLocalMeters,
    txLocalToGeo,
    txUVToWorld,
    txWorldToUV,
    txPointInBbox,
    txClipSegmentToBbox,
    computeContourSegments,
    buildContours,
    rebuildContours,
    clearContours,
    applyTopoLayerVisibility,
    setSectionMode,
    generateSectionProfile,
    collectExportFeatures,
    buildDxfText,
    buildSvgText,
    txBuildDxf2D,
    txBuildDxf3D,
    txBuildSvg,
    txBuildGeoJson,
    txBuildTxtSummary,
    txCountFeatures,
    buildScenarioFeatures,
    applyScenarioEditsToFeatures,
    bindLxExportControls,
    buildTwinFeatures,
    buildTwinFeatureDelta,
    buildExportData,
    updateTopoReadouts,
    renderTopoMap,
    refreshLxExport,
    resetLxExport,
    runLxExport,
  };
  // Make contourSegments readable from the test hook.
  Object.defineProperty(window.__lxExport, 'contourSegments', { get: () => contourSegments });
  // --- test seam (smoke test only): inject planner state the TX code reads ---
  // Production code never calls this; it exists so the node smoke test can set
  // terrainData / GIS data / scenario edits / scene groups without a browser.
  window.__lxExport._test = {
    setTerrain(td) { terrainData = td; },
    setTerrainMesh(tm) { terrainMesh = tm; },
    setScene(s) { scene = s; },
    setGis(g) { Object.assign(gisSourceData, g); },
    setRenderGis(g) { Object.assign(gisRenderData, g); },
    setGroups(g) {
      if ('gisGroup' in g) gisGroup = g.gisGroup;
      if ('cityGroup' in g) cityGroup = g.cityGroup;
      if ('contourGroup' in g) contourGroup = g.contourGroup;
    },
    setZoneGrid(zg) { zoneGrid = zg; },
    setScenario(s) { Object.assign(digitalTwinState.scenario, s); },
    clearScenario() { resetScenarioState(); },
    getScenario() { return digitalTwinState.scenario; },
    setContourSegments(segs) { contourSegments = segs; },
  };

  // --- railway rendering (mirrors buildRoadsMesh; grey dashed-look tube) -------
  function buildRailwaysMesh(ways) {
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
        if (l.x < -half || l.x > half || l.z < -half || l.z > half) continue;
        pts.push(new THREE.Vector3(l.x, terrainSurfaceY(l.x, l.z) + 0.35, l.z));
      }
      if (pts.length < 2) continue;
      for (let i = 1; i < pts.length; i++) totalMeters += pts[i].distanceTo(pts[i - 1]) / m2u;
      let geo;
      try {
        const curve = new THREE.CatmullRomCurve3(pts);
        geo = new THREE.TubeGeometry(curve, Math.max(4, pts.length * 3), 0.22, 5, false);
      } catch (e) { continue; }
      geos.push(geo);
    }
    if (!geos.length) return 0;
    const merged = mergeGeos(geos);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9, metalness: 0.0 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    mesh.name = 'gisRailways';
    gisGroup.add(mesh);
    return totalMeters;
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
