/* ============================================================================
 * LUPUS CORTEX — Dashboard Data Extractor
 * ----------------------------------------------------------------------------
 * Collects the 30 listed registry components for a user-selected area and
 * date range, using only the real data sources the collection pipeline used.
 *
 * HARD RULES (do not weaken):
 *  - Only the 30 registry components (C01..C30b, no C14/C16 as collected
 *    components) plus the two derived indicators C14 and C16 may appear.
 *  - No measurement, value, score or count is ever invented. A component row
 *    shows only: source, status, evidence (a real record/granule count or
 *    the exact reason it is unavailable). Anything not returned by a live
 *    source is reported as queued / needs-key / unavailable — never faked.
 *  - API keys live ONLY in this browser's localStorage
 *    (key: lupus_cortex_api_keys) — saved in this browser only, until
 *    they expire. Each stored key carries its verification status and
 *    expiry: a key is verified BEFORE it is stored, checked again before
 *    every extraction, and never used once it is expired or rejected.
 *    An expired or rejected key raises a visible notice so the user can
 *    enter a new one. Keys are shown masked, never logged. The OpenAQ key
 *    is sent only to api.openaq.org and the Earthdata token only to
 *    cmr.earthdata.nasa.gov (for verification); the CAMS ADS key is never
 *    sent from the browser — CAMS ADS and MERRA-2 GES DISC are not
 *    browser-callable, so those legs are queued for the backend and the
 *    CAMS key is checked by the backend when it runs.
 *  - The model backend is not built yet. When no backend base is
 *    configured, the finished bundle is saved as the pending bundle in
 *    this browser's localStorage (key: lupus_cortex_pending_bundle —
 *    one bundle, the latest extraction wins) and offered as a
 *    downloadable JSON, and a watcher checks every 60 s whether the
 *    backend has come online; when it has, the bundle is sent
 *    automatically. When a backend IS configured, the bundle is sent
 *    automatically right after extraction finishes — no manual click —
 *    and analysis is requested through the existing
 *    window.CortexAnalysis.request flow. A failed send never drops the
 *    bundle: it stays pending and is retried on the next watcher tick.
 *  - Speed: component legs run with bounded concurrency (6 at a time),
 *    CMR collection lookups are cached once per page session, identical
 *    granule requests are deduplicated, and the checklist is rendered
 *    once at the end instead of once per component. The extraction
 *    duration is shown in the summary.
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. Component catalog — the 30 registry components, nothing else.    */
  /*    trained = true  -> the model was trained on this component.      */
  /*    trained = false -> static / annual / infrequent: used directly   */
  /*    for analysis, not model-trained.                                  */
  /* ------------------------------------------------------------------ */
  var TRAINED_IDS = [
    'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
    'C11', 'C15', 'C17', 'C18', 'C19', 'C20', 'C28', 'C30a'
  ];

  var LUPUS_COMPONENTS = [
    { id: 'C01',  name: 'PM2.5',                          unit: 'µg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'OpenAQ ground monitors + MERRA-2 + CAMS reanalysis' },
    { id: 'C02',  name: 'PM10',                           unit: 'µg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'OpenAQ ground monitors + MERRA-2 + CAMS reanalysis' },
    { id: 'C03',  name: 'NO2',                            unit: 'µg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'OpenAQ + OMI OMNO2d + CAMS' },
    { id: 'C04',  name: 'O3',                             unit: 'µg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'OpenAQ + MERRA-2 total-column O3 + CAMS' },
    { id: 'C05',  name: 'SO2',                            unit: 'µg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'OpenAQ + OMI OMSO2e + CAMS' },
    { id: 'C06',  name: 'CO',                             unit: 'mg/m³',      direction: 'lower_is_better',  cadence: 'hourly',  trained: true,  source: 'MERRA-2 + CAMS (OpenAQ where available)' },
    { id: 'C07',  name: 'Aerosol Optical Depth',          unit: 'unitless',   direction: 'lower_is_better',  cadence: 'daily',   trained: true,  source: 'MODIS MCD19A2.061 + CAMS AOD' },
    { id: 'C08',  name: 'Land Surface Temperature',       unit: '°C',         direction: 'context_dependent', cadence: '16-day', trained: true,  source: 'Landsat 8/9 Collection 2 + MODIS LST' },
    { id: 'C09',  name: 'Air Temperature (mean)',         unit: '°C',         direction: 'moderate_optimal', cadence: 'hourly',  trained: true,  source: 'MERRA-2' },
    { id: 'C10',  name: 'Relative Humidity (mean)',       unit: '%',          direction: 'moderate_optimal', cadence: 'hourly',  trained: true,  source: 'MERRA-2' },
    { id: 'C11',  name: 'NDVI',                           unit: 'index',      direction: 'higher_is_better', cadence: '5-day',  trained: true,  source: 'HLS HLSS30_VI / MODIS vegetation' },
    { id: 'C12',  name: 'Land Cover',                     unit: 'class_code', direction: 'context_dependent', cadence: 'annual', trained: false, source: 'MODIS MCD12Q1.061 (2015–2024; 2025 never released)' },
    { id: 'C13',  name: 'Built-up Percentage',            unit: '%',          direction: 'context_dependent', cadence: 'annual', trained: false, source: 'Derived from MCD12Q1 IGBP class 13' },
    { id: 'C15',  name: 'Precipitation',                  unit: 'mm',         direction: 'optimal_range',    cadence: 'hourly',  trained: true,  source: 'GPM IMERG Final V07' },
    { id: 'C17',  name: 'Soil Moisture',                  unit: 'm³/m³',      direction: 'moderate_optimal', cadence: 'hourly',  trained: true,  source: 'SMAP SPL3SMP / SPL2SMAP_S' },
    { id: 'C18',  name: 'Surface Water Index',            unit: 'index_0_1',  direction: 'context_dependent', cadence: 'daily',  trained: true,  source: 'Derived from MCD12Q1 IGBP class 17' },
    { id: 'C19',  name: 'Flood Risk',                     unit: 'binary',     direction: 'lower_is_better',  cadence: 'daily',   trained: true,  source: 'MODIS/VIIRS flood products (event-based)' },
    { id: 'C20',  name: 'Drought SPI',                    unit: 'std_dev',    direction: 'optimal_range',    cadence: 'daily',   trained: true,  source: 'Derived from IMERG precipitation (WMO SPI)' },
    { id: 'C21',  name: 'Population Density',             unit: 'persons/km²', direction: 'context_dependent', cadence: 'annual', trained: false, source: 'WorldPop' },
    { id: 'C22',  name: 'Vulnerable Population Density',  unit: 'persons/km²', direction: 'context_dependent', cadence: 'annual', trained: false, source: 'UN DESA World Population Prospects / WorldPop age structures' },
    { id: 'C23',  name: 'Road Density',                   unit: 'km/km²',     direction: 'higher_is_better', cadence: 'static',  trained: false, source: 'OpenStreetMap (no 2025 study-area data — unavailable)' },
    { id: 'C24',  name: 'Public Transport Accessibility', unit: 'index_0_100', direction: 'higher_is_better', cadence: 'static', trained: false, source: 'OpenStreetMap (no 2025 study-area data — unavailable)' },
    { id: 'C25',  name: 'Hospital Accessibility',         unit: 'index_0_100', direction: 'higher_is_better', cadence: 'static', trained: false, source: 'OpenStreetMap (no 2025 study-area data — unavailable)' },
    { id: 'C26',  name: 'Green Space Accessibility',      unit: 'index_0_100', direction: 'higher_is_better', cadence: 'source-specific', trained: false, source: 'Derived from MCD12Q1 IGBP classes 1–10, 12, 14' },
    { id: 'C27',  name: 'Critical Infrastructure Density', unit: 'index_0_100', direction: 'higher_is_better', cadence: 'static', trained: false, source: 'OpenStreetMap (no 2025 study-area data — unavailable)' },
    { id: 'C28',  name: 'Nighttime Lights',               unit: 'nW/cm²/sr',  direction: 'context_dependent', cadence: 'monthly', trained: true,  source: 'VIIRS Black Marble VNP46A2' },
    { id: 'C29a', name: 'Elevation',                      unit: 'm',          direction: 'context_dependent', cadence: 'static',  trained: false, source: 'SRTM / Copernicus DEM GLO-30 (static)' },
    { id: 'C29b', name: 'Slope',                          unit: 'degrees',    direction: 'context_dependent', cadence: 'static',  trained: false, source: 'Derived from DEM (static)' },
    { id: 'C30a', name: 'Disaster Exposure',              unit: 'index_0_1',  direction: 'lower_is_better',  cadence: 'daily',   trained: true,  source: 'UNDRR Sendai Framework composite' },
    { id: 'C30b', name: 'Disaster Readiness',             unit: 'index_0_100', direction: 'higher_is_better', cadence: 'static',  trained: false, source: 'UNDRR Sendai Monitor (no 2025 study-area data — unavailable)' }
  ];

  /* Derived indicators — computed from a collected component, never
   * collected or extracted as standalone components. */
  var DERIVED_COMPONENTS = [
    { id: 'C14', name: 'Impervious Surface Fraction', unit: 'fraction', derivedFrom: 'C13', source: 'Derived from C13 built-up % (not collected)' },
    { id: 'C16', name: 'Extreme Rainfall Indicator',  unit: 'index',    derivedFrom: 'C15', source: 'Derived from C15 precipitation (95th-percentile exceedance)' }
  ];

  /* ------------------------------------------------------------------ */
  /* 2. Source endpoints. CMR collection lookups use short_name +       */
  /*    version so no concept id is hard-coded.                           */
  /* ------------------------------------------------------------------ */
  var OPENAQ_BASE = 'https://api.openaq.org/v3';
  var CMR_BASE = 'https://cmr.earthdata.nasa.gov/search';
  var OVERPASS_BASE = 'https://overpass-api.de/api/interpreter';
  var WORLDPOP_BASE = 'https://www.worldpop.org/rest/data/pop/wpgp';
  var NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

  var CMR_COLLECTIONS = {
    C07:  { short_name: 'MCD19A2',    version: '061' },
    C08:  { short_name: 'MOD11A1',    version: '061' },
    C11:  { short_name: 'HLSS30',     version: '2.0' },
    C12:  { short_name: 'MCD12Q1',    version: '061' },
    C13:  { short_name: 'MCD12Q1',    version: '061' },
    C15:  { short_name: 'GPM_3IMERGDF', version: '07' },
    C17:  { short_name: 'SPL3SMP',    version: '009' },
    C18:  { short_name: 'MCD12Q1',    version: '061' },
    C26:  { short_name: 'MCD12Q1',    version: '061' },
    C28:  { short_name: 'VNP46A2',    version: '001' },
    C29a: { short_name: 'SRTMGL1',    version: '003' },
    C29b: { short_name: 'SRTMGL1',    version: '003' }
  };

  var OPENAQ_PARAMS = { C01: 'pm25', C02: 'pm10', C03: 'no2', C04: 'o3', C05: 'so2', C06: 'co' };

  /* Overpass fragments used ONLY to check what OSM holds in the area.
   * A live OSM count is reported as evidence of the check; it is never
   * treated as a validated component value, so C23–C27 stay unavailable. */
  var OVERPASS_QUERIES = {
    C23: 'way["highway"]',
    C24: 'nwr["public_transport"];nwr["highway"="bus_stop"]',
    C25: 'nwr["amenity"="hospital"]',
    C27: 'nwr["amenity"~"police|fire_station"]'
  };

  var STORAGE_KEY = 'lupus_cortex_api_keys';
  var TRAINING_WINDOW_END = '2025-12-31';
  var EARLIEST_DATE = '2015-01-01';

  /* ------------------------------------------------------------------ */
  /* 3. State                                                            */
  /* ------------------------------------------------------------------ */
  var bound = false;
  var extracting = false;
  var pendingExtractAfterKeys = false;
  var lastBundle = null;
  var lastExtractionMs = null;
  var lastCountsSummary = '';
  var selectedArea = null; /* { mode:'point'|'bbox', lat, lng, name, bbox:[minLng,minLat,maxLng,maxLat] } */
  var cmrCache = {}; /* granule results, keyed conceptId|bbox|start|end — kept for the whole page session: granule counts for a fixed area/dates are deterministic */
  var cmrCollectionCache = {}; /* collection concept ids, keyed short_name|version — looked up once per page session */
  var sessionVerified = {}; /* provider -> true once live-verified this page session */
  var expiryTickTimer = null;
  /* Auto-send state: one pending bundle (latest extraction wins). */
  var pendingBundleKey = 'lupus_cortex_pending_bundle';
  var backendHealthPath = '/api/health';
  var backendWatchMs = 60000;
  var backendHealthTimeoutMs = 5000;
  var extractionConcurrency = 6;
  var backendWatcherTimer = null;
  var backendKnownReachable = false;

  /* ------------------------------------------------------------------ */
  /* 4. Small helpers                                                     */
  /* ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch];
    });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function trained(id) { return TRAINED_IDS.indexOf(id) !== -1; }
  function componentById(id) {
    for (var i = 0; i < LUPUS_COMPONENTS.length; i++) {
      if (LUPUS_COMPONENTS[i].id === id) return LUPUS_COMPONENTS[i];
    }
    return null;
  }
  function fetchWithTimeout(url, options, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || 20000);
    var opts = options || {};
    opts.signal = controller.signal;
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }
  function fetchJson(url, options, ms) {
    return fetchWithTimeout(url, options, ms).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 5. API-key vault — localStorage only, masked display, never logged. */
  /* ------------------------------------------------------------------ */
  function loadKeys() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return {
        openaq: normalizeRecord(parsed.openaq),
        cams: normalizeRecord(parsed.cams),
        earthdata: normalizeRecord(parsed.earthdata)
      };
    } catch (_) { return { openaq: null, cams: null, earthdata: null }; }
  }
  function saveKeys(keys) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch (_) { /* storage unavailable */ }
  }
  function masked(value) {
    if (!value) return 'Not set';
    if (value.length <= 4) return '••••';
    return '••••••••' + value.slice(-4);
  }

  /* Key records: { value, savedAt, verifiedAt, expiresAt, status }.
   * status is 'verified' | 'pending' | 'expired' | 'invalid'. Old
   * plain-string records (pre-expiry builds) are migrated to 'pending'
   * and live-verified on the next refresh. */
  var PROVIDERS = ['openaq', 'cams', 'earthdata'];
  var PROVIDER_LABELS = { openaq: 'OpenAQ API key', cams: 'CAMS ADS API key', earthdata: 'Earthdata token' };
  var KEY_STATUS_IDS = { openaq: 'lxKeyStatusOpenaq', cams: 'lxKeyStatusCams', earthdata: 'lxKeyStatusEarthdata' };
  var PANEL_KEY_IDS = { openaq: 'lxPanelKeyOpenaq', cams: 'lxPanelKeyCams', earthdata: 'lxPanelKeyEarthdata' };
  var KEY_INPUT_IDS = { openaq: 'lxKeyOpenaq', cams: 'lxKeyCams', earthdata: 'lxKeyEarthdata' };

  function normalizeRecord(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      if (!raw) return null;
      return { value: raw, savedAt: null, verifiedAt: null, expiresAt: null, status: 'pending' };
    }
    if (typeof raw === 'object' && typeof raw.value === 'string' && raw.value) {
      return {
        value: raw.value,
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : null,
        verifiedAt: typeof raw.verifiedAt === 'number' ? raw.verifiedAt : null,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
        status: ['verified', 'pending', 'expired', 'invalid'].indexOf(raw.status) !== -1 ? raw.status : 'pending'
      };
    }
    return null;
  }
  /* Pure: true when the record carries an expiry that has passed. */
  function isKeyExpired(record, now) {
    if (!record || !record.value) return false;
    if (typeof record.expiresAt !== 'number') return false;
    return now >= record.expiresAt;
  }
  /* Pure: the effective status of a record at a given time. Returns
   * 'missing' for no record, otherwise one of the stored statuses. */
  function keyStatusFor(record, now) {
    if (!record || !record.value) return 'missing';
    if (isKeyExpired(record, now)) return 'expired';
    if (record.status === 'invalid') return 'invalid';
    if (record.status === 'verified') return 'verified';
    return 'pending';
  }
  function formatDate(ms) {
    try { return new Date(ms).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  function b64urlDecode(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof atob === 'function') return atob(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf8');
    return null;
  }
  /* Pure: expiry (epoch ms) from a JWT `exp` claim, or null when the
   * token is not a JWT or carries no exp claim. */
  function decodeJwtExp(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length !== 3) return null;
      var decoded = b64urlDecode(parts[1]);
      if (decoded == null) return null;
      var payload = JSON.parse(decoded);
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch (_) { return null; }
  }
  function camsFormatOk(value) {
    var i = String(value).indexOf(':');
    return i > 0 && i < String(value).length - 1;
  }
  /* Live verification. Returns { ok, status, expiresAt, error, transient }.
   * transient = true means the check itself failed (network / server
   * error), so the result says nothing about the key. Only 401/403 prove
   * a key is invalid. Nothing is stored here — callers decide. */
  function verifyProvider(provider, value) {
    if (provider === 'openaq') {
      return fetchWithTimeout(OPENAQ_BASE + '/locations?limit=1', { headers: { 'X-API-Key': value, 'Accept': 'application/json' } }, 15000)
        .then(function (res) {
          if (res.status === 200) return { ok: true, status: 'verified', expiresAt: null, error: '', transient: false };
          if (res.status === 401 || res.status === 403) return { ok: false, status: 'invalid', expiresAt: null, error: 'OpenAQ rejected the key (HTTP ' + res.status + '). Check the key and try again.', transient: false };
          return { ok: false, status: 'invalid', expiresAt: null, error: 'OpenAQ returned HTTP ' + res.status + ' — the key could not be verified. Try again.', transient: true };
        })
        .catch(function (err) {
          return { ok: false, status: 'invalid', expiresAt: null, error: 'Could not reach OpenAQ (' + (err && err.message ? err.message : 'network error') + '). Check your connection and try again.', transient: true };
        });
    }
    if (provider === 'earthdata') {
      return fetchWithTimeout(CMR_BASE + '/granules.json?page_size=0', { headers: { 'Authorization': 'Bearer ' + value } }, 15000)
        .then(function (res) {
          if (res.status === 200) {
            var exp = decodeJwtExp(value);
            if (exp != null && exp <= Date.now()) return { ok: false, status: 'expired', expiresAt: exp, error: 'This Earthdata token already expired on ' + formatDate(exp) + '. Paste a new token.', transient: false };
            return { ok: true, status: 'verified', expiresAt: exp, error: '', transient: false };
          }
          if (res.status === 401 || res.status === 403) return { ok: false, status: 'invalid', expiresAt: null, error: 'Earthdata rejected the token (HTTP ' + res.status + '). Check the token and try again.', transient: false };
          return { ok: false, status: 'invalid', expiresAt: null, error: 'Earthdata returned HTTP ' + res.status + ' — the token could not be verified. Try again.', transient: true };
        })
        .catch(function (err) {
          return { ok: false, status: 'invalid', expiresAt: null, error: 'Could not reach Earthdata (' + (err && err.message ? err.message : 'network error') + '). Check your connection and try again.', transient: true };
        });
    }
    if (provider === 'cams') {
      /* The browser cannot call CAMS ADS (no CORS; the API needs a POST
       * retrieve), so only the uid:key shape is checked here. The backend
       * verifies the key when it runs. */
      if (!camsFormatOk(value)) return Promise.resolve({ ok: false, status: 'invalid', expiresAt: null, error: 'CAMS ADS key must look like uid:key — two parts separated by a colon.', transient: false });
      return Promise.resolve({ ok: true, status: 'pending', expiresAt: null, error: '', transient: false });
    }
    return Promise.resolve({ ok: false, status: 'invalid', expiresAt: null, error: 'Unknown provider.', transient: false });
  }
  /* Verify first, store only on success. Returns the verify result. */
  function verifyAndStoreKey(provider, value) {
    return verifyProvider(provider, value).then(function (res) {
      if (!res.ok) return res;
      var now = Date.now();
      var keys = loadKeys();
      keys[provider] = { value: value, savedAt: now, verifiedAt: now, expiresAt: res.expiresAt || null, status: res.status };
      saveKeys(keys);
      sessionVerified[provider] = true;
      return res;
    });
  }
  function getKeyStatuses() {
    var keys = loadKeys();
    var now = Date.now();
    var out = {};
    PROVIDERS.forEach(function (p) { out[p] = keyStatusFor(keys[p], now); });
    return out;
  }
  function unusableKeys(statuses) {
    var st = statuses || getKeyStatuses();
    var out = [];
    PROVIDERS.forEach(function (p) {
      if (st[p] === 'missing' || st[p] === 'expired' || st[p] === 'invalid') out.push({ provider: p, reason: st[p] });
    });
    return out;
  }
  function keyIsUsable(provider) {
    var s = getKeyStatuses()[provider];
    return s === 'verified' || (provider === 'cams' && s === 'pending');
  }
  /* Re-evaluate every stored key: flip past-expiry records to 'expired'
   * and live re-verify OpenAQ / Earthdata keys that carry no fixed expiry
   * (once per page session — see sessionVerified). A failed live check
   * marks the key 'invalid' only on 401/403; network or server errors
   * leave the stored status untouched. */
  function refreshKeyStatuses() {
    var keys = loadKeys();
    var now = Date.now();
    var changed = false;
    var jobs = [];
    PROVIDERS.forEach(function (p) {
      var rec = keys[p];
      if (!rec) return;
      var status = keyStatusFor(rec, now);
      if (status !== rec.status) { rec.status = status; changed = true; }
      /* A 'pending' record has never passed verification, so it is always
       * checked on refresh; the per-session cache applies only to already
       * verified keys, so one verified key is not re-checked per component. */
      if ((p === 'openaq' || p === 'earthdata') && !rec.expiresAt && (rec.status === 'pending' || (rec.status === 'verified' && !sessionVerified[p]))) {
        jobs.push(verifyProvider(p, rec.value).then(function (res) {
          if (res.ok) {
            rec.status = 'verified';
            rec.verifiedAt = Date.now();
            if (res.expiresAt) rec.expiresAt = res.expiresAt;
            sessionVerified[p] = true;
            changed = true;
          } else if (!res.transient) {
            rec.status = 'invalid';
            changed = true;
          }
        }));
      }
    });
    return Promise.all(jobs).then(function () {
      if (changed) saveKeys(keys);
      renderKeyStatus();
      refreshKeyNotice();
      return getKeyStatuses();
    });
  }
  /* No-network expiry tick: catches keys whose expiry passes while the
   * page is open. Runs every 60 s from init. */
  function checkKeyExpiryTick() {
    var keys = loadKeys();
    var now = Date.now();
    var changed = false;
    PROVIDERS.forEach(function (p) {
      var rec = keys[p];
      if (rec && rec.status !== 'expired' && isKeyExpired(rec, now)) { rec.status = 'expired'; changed = true; }
    });
    if (changed) { saveKeys(keys); renderKeyStatus(); refreshKeyNotice(); }
  }
  function markKeyStatus(provider, status) {
    var keys = loadKeys();
    var rec = keys[provider];
    if (!rec) return false;
    var mapped = status === 'rejected' ? 'invalid' : status;
    if (['verified', 'pending', 'expired', 'invalid'].indexOf(mapped) === -1) return false;
    rec.status = mapped;
    saveKeys(keys);
    renderKeyStatus();
    refreshKeyNotice();
    return true;
  }
  function markKeyInvalid(provider) {
    var keys = loadKeys();
    var rec = keys[provider];
    if (!rec) return;
    rec.status = 'invalid';
    saveKeys(keys);
    renderKeyStatus();
    refreshKeyNotice();
  }
  function showKeyNotice(problems) {
    var banner = $('lxKeyNotice');
    var text = $('lxKeyNoticeText');
    if (!banner || !text) return;
    var parts = problems.map(function (pr) {
      if (pr.reason === 'expired') return PROVIDER_LABELS[pr.provider] + ' has expired';
      if (pr.reason === 'invalid') return PROVIDER_LABELS[pr.provider] + ' was rejected';
      return PROVIDER_LABELS[pr.provider] + ' needs attention';
    });
    text.textContent = 'Your ' + parts.join(' and your ') + '. Enter a new key to keep extracting data.';
    banner.classList.remove('hidden');
  }
  function hideKeyNotice() { var b = $('lxKeyNotice'); if (b) b.classList.add('hidden'); }
  function refreshKeyNotice() {
    var st = getKeyStatuses();
    var problems = PROVIDERS.filter(function (p) { return st[p] === 'expired' || st[p] === 'invalid'; })
      .map(function (p) { return { provider: p, reason: st[p] }; });
    if (problems.length) showKeyNotice(problems); else hideKeyNotice();
  }
  function keyStatusLabel(status) {
    return { verified: 'Verified', pending: 'Pending', expired: 'Expired', invalid: 'Invalid', missing: 'Not set' }[status] || status;
  }
  function keyStatusText(provider, record, now) {
    if (!record) return 'Not set';
    var status = keyStatusFor(record, now);
    var text = masked(record.value) + ' — ' + keyStatusLabel(status);
    if (status === 'verified' || status === 'pending') {
      text += record.expiresAt ? ' · expires ' + formatDate(record.expiresAt) : ' · no fixed expiry — checked each time';
    } else if (status === 'expired' && record.expiresAt) {
      text += ' · expired ' + formatDate(record.expiresAt);
    }
    return text;
  }
  function keyStatusClass(status) {
    return { verified: 'lx-key-status--verified', pending: 'lx-key-status--pending', expired: 'lx-key-status--expired', invalid: 'lx-key-status--invalid', missing: 'lx-key-status--missing' }[status] || '';
  }
  function missingKeys() {
    var keys = loadKeys();
    var missing = [];
    PROVIDERS.forEach(function (p) {
      if (!keys[p] || !keys[p].value) missing.push(PROVIDER_LABELS[p]);
    });
    return missing;
  }
  function renderKeyStatus() {
    var keys = loadKeys();
    var now = Date.now();
    PROVIDERS.forEach(function (p) {
      var text = keyStatusText(p, keys[p], now);
      var cls = 'lx-key-status ' + keyStatusClass(keyStatusFor(keys[p], now));
      [$(KEY_STATUS_IDS[p]), $(PANEL_KEY_IDS[p])].forEach(function (el) {
        if (!el) return;
        el.textContent = text;
        el.className = cls;
      });
    });
  }
  function openKeyModal() {
    var modal = $('lxKeyModal');
    if (!modal) return;
    var keys = loadKeys();
    var io = $('lxKeyOpenaq'); if (io) io.value = '';
    var ic = $('lxKeyCams'); if (ic) ic.value = '';
    var ie = $('lxKeyEarthdata'); if (ie) ie.value = '';
    renderKeyStatus();
    modal.classList.remove('hidden');
  }
  function closeKeyModal() { var m = $('lxKeyModal'); if (m) m.classList.add('hidden'); }
  /* Save = verify first, store only what passes. A failed key is never
   * stored and the modal stays open with the error on that provider's
   * status line. Blank fields keep the key already stored. */
  function saveKeysFromModal() {
    var entered = {};
    PROVIDERS.forEach(function (p) {
      var input = $(KEY_INPUT_IDS[p]);
      entered[p] = input && input.value.trim() ? input.value.trim() : '';
    });
    var toCheck = PROVIDERS.filter(function (p) { return entered[p]; });
    var note = $('lxKeyNote');
    if (!toCheck.length) {
      closeKeyModal();
      if (pendingExtractAfterKeys) { pendingExtractAfterKeys = false; runExtraction(); }
      return;
    }
    if (note) note.textContent = 'Verifying keys…';
    Promise.all(toCheck.map(function (p) {
      return verifyAndStoreKey(p, entered[p]).then(function (res) { return { provider: p, res: res }; });
    })).then(function (outcomes) {
      var failed = outcomes.filter(function (o) { return !o.res.ok; });
      renderKeyStatus();
      failed.forEach(function (o) {
        var el = $(KEY_STATUS_IDS[o.provider]);
        if (el) {
          el.textContent = o.res.error || 'Verification failed.';
          el.className = 'lx-key-status lx-key-status--invalid';
        }
      });
      if (failed.length) {
        if (note) note.textContent = 'Some keys could not be verified and were not stored — fix them and try again.';
        return;
      }
      PROVIDERS.forEach(function (p) { var input = $(KEY_INPUT_IDS[p]); if (input) input.value = ''; });
      closeKeyModal();
      if (note) note.textContent = 'Keys verified and saved in this browser only.';
      if (pendingExtractAfterKeys) { pendingExtractAfterKeys = false; runExtraction(); }
    });
  }
  /* "Verify now" for one provider: verifies the typed value if there is
   * one (stores it on success), otherwise re-checks the stored key. */
  function verifyKeyFromModal(provider) {
    var input = $(KEY_INPUT_IDS[provider]);
    var typed = input && input.value.trim() ? input.value.trim() : '';
    var stored = loadKeys()[provider];
    var note = $('lxKeyNote');
    var statusEl = $(KEY_STATUS_IDS[provider]);
    if (!typed && !stored) {
      if (statusEl) statusEl.textContent = 'Enter a key first.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Checking…';
    if (typed) {
      verifyAndStoreKey(provider, typed).then(function (res) {
        renderKeyStatus();
        if (res.ok) {
          if (input) input.value = '';
          if (note) note.textContent = PROVIDER_LABELS[provider] + ' verified and saved in this browser only.';
        } else {
          if (statusEl) { statusEl.textContent = res.error; statusEl.className = 'lx-key-status lx-key-status--invalid'; }
          if (note) note.textContent = PROVIDER_LABELS[provider] + ' was not stored.';
        }
      });
      return;
    }
    verifyProvider(provider, stored.value).then(function (res) {
      if (res.ok) {
        var keys = loadKeys();
        keys[provider] = { value: stored.value, savedAt: stored.savedAt || Date.now(), verifiedAt: Date.now(), expiresAt: res.expiresAt || stored.expiresAt || null, status: res.status };
        saveKeys(keys);
        sessionVerified[provider] = true;
        renderKeyStatus();
        if (note) note.textContent = PROVIDER_LABELS[provider] + ' verified.';
      } else if (!res.transient) {
        markKeyInvalid(provider);
        if (statusEl) { statusEl.textContent = res.error; statusEl.className = 'lx-key-status lx-key-status--invalid'; }
        if (note) note.textContent = PROVIDER_LABELS[provider] + ' was rejected.';
      } else {
        renderKeyStatus();
        if (statusEl) statusEl.textContent = res.error;
        if (note) note.textContent = 'Could not check ' + PROVIDER_LABELS[provider] + ' — try again.';
      }
    });
  }
  function forgetAllKeys() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    sessionVerified = {};
    hideKeyNotice();
    renderKeyStatus();
    var note = $('lxKeyNote');
    if (note) note.textContent = 'All stored keys were removed from this browser.';
  }

  /* ------------------------------------------------------------------ */
  /* 6. Area + date selection                                            */
  /* ------------------------------------------------------------------ */
  function currentPoint() {
    var loc = (typeof window.appState !== 'undefined' && window.appState.currentLocation) || null;
    if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
      return { lat: Number(loc.lat), lng: Number(loc.lng), name: loc.name || 'Selected location' };
    }
    return null;
  }
  function pointBbox(lat, lng, halfDeg) {
    var h = halfDeg || 0.05;
    return [lng - h, lat - h, lng + h, lat + h];
  }
  function getArea() {
    if (selectedArea) return selectedArea;
    var point = currentPoint();
    if (!point) return null;
    return { mode: 'point', lat: point.lat, lng: point.lng, name: point.name, bbox: pointBbox(point.lat, point.lng) };
  }
  function setAreaLabel() {
    var el = $('lxAreaLabel');
    var area = getArea();
    if (!el) return;
    if (!area) { el.textContent = 'No area selected yet.'; return; }
    if (area.mode === 'bbox') {
      el.textContent = 'Bounding box: lat ' + area.bbox[1].toFixed(4) + ' to ' + area.bbox[3].toFixed(4) +
        ', lng ' + area.bbox[0].toFixed(4) + ' to ' + area.bbox[2].toFixed(4) + '.';
    } else {
      el.textContent = 'Point: ' + area.name + ' (' + area.lat.toFixed(4) + ', ' + area.lng.toFixed(4) + ').';
    }
  }
  function getDates() {
    var today = todayISO();
    var rangeMode = $('lxDateRange') && $('lxDateRange').checked;
    if (!rangeMode) return { mode: 'today', start: today, end: today, beyondTraining: today > TRAINING_WINDOW_END };
    var start = ($('lxDateStart') && $('lxDateStart').value) || '';
    var end = ($('lxDateEnd') && $('lxDateEnd').value) || '';
    return { mode: 'range', start: start, end: end, beyondTraining: end > TRAINING_WINDOW_END };
  }
  function validateInputs(area, dates) {
    var errors = [];
    if (!area) errors.push('Choose an area first (place name, coordinates, or bounding box).');
    if (!dates.start || !dates.end) errors.push('Choose a date range (start and end date).');
    else if (dates.start < EARLIEST_DATE || dates.end > todayISO()) {
      errors.push('Dates must be between ' + EARLIEST_DATE + ' and today.');
    } else if (dates.start > dates.end) {
      errors.push('The start date must be before the end date.');
    }
    return errors;
  }

  /* ------------------------------------------------------------------ */
  /* 7. Live source legs — each returns { status, evidence, raw }       */
  /*    status: ok | queued | needs-key | unavailable | not-found | error */
  /* ------------------------------------------------------------------ */
  function openaqLeg(area) {
    var keys = loadKeys();
    var keyStatus = keyStatusFor(keys.openaq, Date.now());
    if (keyStatus === 'missing') {
      return Promise.resolve({ status: 'needs-key', evidence: 'OpenAQ API key missing — add it in the API keys popup.' });
    }
    if (keyStatus === 'expired') {
      return Promise.resolve({ status: 'needs-key', evidence: 'OpenAQ API key expired — enter a new key in the API keys popup.' });
    }
    if (keyStatus === 'invalid') {
      return Promise.resolve({ status: 'needs-key', evidence: 'OpenAQ API key invalid — OpenAQ rejected it; enter a new key in the API keys popup.' });
    }
    if (keyStatus === 'pending') {
      return Promise.resolve({ status: 'needs-key', evidence: 'OpenAQ API key not verified yet — verify it in the API keys popup.' });
    }
    var headers = { 'X-API-Key': keys.openaq.value, 'Accept': 'application/json' };
    var url = OPENAQ_BASE + '/locations?coordinates=' + area.lat + ',' + area.lng + '&radius=25000&limit=10';
    return fetchJson(url, { headers: headers }, 20000)
      .then(function (data) {
        var locations = Array.isArray(data.results) ? data.results : [];
        if (!locations.length) {
          return { status: 'not-found', evidence: '0 OpenAQ locations within 25 km of the selected point.' };
        }
        var nearest = locations.slice(0, 5);
        return Promise.all(nearest.map(function (loc) {
          return fetchJson(OPENAQ_BASE + '/locations/' + loc.id + '/latest?limit=100', { headers: headers }, 20000)
            .catch(function () { return { results: [] }; });
        })).then(function (latestSets) {
          var counts = {};
          var raw = [];
          latestSets.forEach(function (set) {
            (set.results || []).forEach(function (m) {
              var param = m.parameter && m.parameter.name;
              if (!param) return;
              counts[param] = (counts[param] || 0) + 1;
              raw.push({ parameter: param, value: m.value, unit: m.unit, datetime: m.datetime && m.datetime.utc, location_id: m.locationId });
            });
          });
          return { status: 'ok', evidence: locations.length + ' OpenAQ locations within 25 km; ' + Object.keys(counts).map(function (p) { return counts[p] + ' latest ' + p + ' measurements'; }).join(', ') + '.', counts: counts, raw: raw };
        });
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : 'network error';
        if (/HTTP 40[13]/.test(msg)) {
          markKeyInvalid('openaq');
          return { status: 'needs-key', evidence: 'OpenAQ API key invalid — OpenAQ rejected it (' + msg + '); enter a new key in the API keys popup.' };
        }
        return { status: 'error', evidence: 'OpenAQ request failed (' + msg + ').' };
      });
  }

  /* NASA CMR leg. Collection lookups are cached once per page session by
   * short_name+version (C12/C13/C18/C26 share MCD12Q1 061; C29a/C29b share
   * SRTMGL1 003, so one lookup serves all of them), and granule results
   * are cached by conceptId|bbox|dates. Only deterministic outcomes
   * ('ok', 'not-found') are kept — a failed request is retried next
   * time instead of caching the failure. */
  function cmrLeg(componentId, area, dates) {
    var spec = CMR_COLLECTIONS[componentId];
    if (!spec) return Promise.resolve({ status: 'queued', evidence: 'No browser CMR collection for this component; queued for backend.' });
    var collKey = spec.short_name + '|' + spec.version;
    var collPromise = cmrCollectionCache[collKey];
    if (!collPromise) {
      var collUrl = CMR_BASE + '/collections.json?short_name=' + encodeURIComponent(spec.short_name) +
        '&version=' + encodeURIComponent(spec.version) + '&page_size=5';
      collPromise = fetchJson(collUrl, {}, 20000)
        .then(function (data) {
          var entries = (data.feed && data.feed.entry) || [];
          return { id: entries.length ? entries[0].id : null };
        })
        .catch(function (err) {
          delete cmrCollectionCache[collKey];
          return { error: (err && err.message) || 'network error' };
        });
      cmrCollectionCache[collKey] = collPromise;
    }
    return collPromise.then(function (coll) {
      if (coll.error) return { status: 'error', evidence: 'NASA CMR request failed (' + coll.error + ').' };
      if (!coll.id) return { status: 'not-found', evidence: 'Collection ' + spec.short_name + ' v' + spec.version + ' not found in NASA CMR.' };
      var granKey = coll.id + '|' + area.bbox.join(',') + '|' + dates.start + '|' + dates.end;
      if (cmrCache[granKey]) return cmrCache[granKey];
      var granUrl = CMR_BASE + '/granules.json?concept_id=' + encodeURIComponent(coll.id) +
        '&bounding_box=' + area.bbox.join(',') +
        '&temporal=' + dates.start + 'T00:00:00Z,' + dates.end + 'T23:59:59Z&page_size=1';
      var result = fetchJson(granUrl, {}, 25000).then(function (gdata) {
        var hits = typeof gdata.hits === 'number' ? gdata.hits : ((gdata.feed && gdata.feed.entry) || []).length;
        if (!hits) return { status: 'not-found', evidence: '0 granules of ' + spec.short_name + ' v' + spec.version + ' in the area and date range.' };
        return { status: 'ok', evidence: hits + ' granules of ' + spec.short_name + ' v' + spec.version + ' in the area and date range.', raw: { collection: spec.short_name, version: spec.version, concept_id: coll.id, hits: hits } };
      }).catch(function (err) {
        delete cmrCache[granKey];
        return { status: 'error', evidence: 'NASA CMR request failed (' + (err && err.message ? err.message : 'network error') + ').' };
      });
      cmrCache[granKey] = result;
      return result;
    });
  }

  function worldpopLeg(area) {
    var point = currentPoint();
    var reverseUrl = NOMINATIM_BASE + '/reverse?format=json&addressdetails=1&lat=' + area.lat + '&lon=' + area.lng + '&zoom=10';
    return fetchJson(reverseUrl, { headers: { 'Accept': 'application/json' } }, 15000)
      .then(function (place) {
        var iso3 = place && place.address && place.address.country_code ? String(place.address.country_code).toUpperCase() : '';
        if (!iso3) return { status: 'error', evidence: 'Could not determine the country for the selected point, so the WorldPop catalogue could not be queried.' };
        return fetchJson(WORLDPOP_BASE + '?iso3=' + encodeURIComponent(iso3), {}, 20000).then(function (data) {
          var sets = Array.isArray(data.data) ? data.data : [];
          if (!sets.length) return { status: 'not-found', evidence: '0 WorldPop population datasets listed for ' + iso3 + '.' };
          return { status: 'ok', evidence: sets.length + ' WorldPop population datasets listed for ' + iso3 + '.', raw: { iso3: iso3, datasets: sets.length } };
        });
      })
      .catch(function (err) {
        return { status: 'error', evidence: 'WorldPop request failed (' + (err && err.message ? err.message : 'network error') + ').' };
      });
  }

  function overpassCount(fragment, bbox) {
    var query = '[out:json][timeout:25];(' + fragment + '(' + bbox[1] + ',' + bbox[0] + ',' + bbox[3] + ',' + bbox[2] + '););out count;';
    return fetchWithTimeout(OVERPASS_BASE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) }, 30000)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var el = (data.elements || [])[0];
        var total = el && el.tags && el.tags.total;
        return total == null ? null : Number(total);
      })
      .catch(function () { return null; });
  }

  function queuedLeg(reason) {
    return Promise.resolve({ status: 'queued', evidence: reason });
  }
  function needsKeyLeg(what, reason) {
    var status = keyStatusFor(loadKeys()[what], Date.now());
    if (status === 'missing') return Promise.resolve({ status: 'needs-key', evidence: reason + ' Key missing — add it in the API keys popup.' });
    if (status === 'expired') return Promise.resolve({ status: 'needs-key', evidence: reason + ' Key expired — enter a new key in the API keys popup.' });
    if (status === 'invalid') return Promise.resolve({ status: 'needs-key', evidence: reason + ' Key invalid — it was rejected; enter a new key in the API keys popup.' });
    if (status === 'pending' && what !== 'cams') return Promise.resolve({ status: 'needs-key', evidence: reason + ' Key not verified yet — verify it in the API keys popup.' });
    return Promise.resolve({ status: 'queued', evidence: reason + ' Key on file — queued for backend.' });
  }

  /* ------------------------------------------------------------------ */
  /* 8. Per-component extraction plan                                    */
  /* ------------------------------------------------------------------ */
  function extractComponent(id, area, dates, shared) {
    var keys = loadKeys();
    switch (id) {
      case 'C01': case 'C02': case 'C03': case 'C04': case 'C05': case 'C06': {
        /* OpenAQ leg is shared across C01–C06; per-component counts come
         * from the same fetch. MERRA-2 / CAMS legs are queued for backend. */
        return shared.openaq.then(function (res) {
          var param = OPENAQ_PARAMS[id];
          if (res.status !== 'ok') return { status: res.status, evidence: res.evidence };
          var n = (res.counts && res.counts[param]) || 0;
          if (!n) return { status: 'not-found', evidence: '0 latest ' + param + ' measurements at the OpenAQ locations near this point.' };
          return { status: 'ok', evidence: n + ' latest ' + param + ' measurements at OpenAQ locations near this point.', raw: (res.raw || []).filter(function (m) { return m.parameter === param; }) };
        });
      }
      case 'C07': case 'C08': case 'C11': case 'C12': case 'C13':
      case 'C17': case 'C18': case 'C26': case 'C28': case 'C29a': case 'C29b':
        return cmrLeg(id, area, dates);
      case 'C09': case 'C10':
        /* MERRA-2 only: GES DISC is not browser-callable. */
        return needsKeyLeg('earthdata', 'MERRA-2 GES DISC is not browser-callable; queued for backend. ');
      case 'C15':
        return cmrLeg('C15', area, dates);
      case 'C19':
        return queuedLeg('Event-based MODIS/VIIRS flood products — no browser CMR collection; queued for backend.');
      case 'C20':
        /* Derived from C15: reuse the IMERG granule result. */
        return shared.c15.then(function (res) {
          if (res.status !== 'ok') return { status: res.status, evidence: 'Derived from C15 — ' + res.evidence };
          return { status: 'ok', evidence: 'Derived from C15 — ' + res.evidence, raw: res.raw };
        });
      case 'C21': case 'C22':
        return shared.worldpop;
      case 'C23': case 'C24': case 'C25': case 'C27': {
        /* OSM is checked live, but the result is NOT a validated
         * component value: these components stay unavailable. */
        return overpassCount(OVERPASS_QUERIES[id], area.bbox).then(function (count) {
          if (count == null) return { status: 'unavailable', evidence: 'Overpass query failed; no 2025 study-area data.' };
          return { status: 'unavailable', evidence: 'OSM live count: ' + count + ' features in the area (not a validated component value); no 2025 study-area data.' };
        });
      }
      case 'C30a':
        return queuedLeg('UNDRR Sendai Framework composite — no browser API; queued for backend.');
      case 'C30b':
        return Promise.resolve({ status: 'unavailable', evidence: 'UNDRR Sendai Monitor — no 2025 study-area data.' });
      default:
        return Promise.resolve({ status: 'error', evidence: 'No extraction leg defined for this component.' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 9. Checklist UI                                                     */
  /* ------------------------------------------------------------------ */
  var STATUS_LABELS = {
    ok: 'Available', queued: 'Queued for backend', 'needs-key': 'Needs API key',
    unavailable: 'Unavailable', 'not-found': 'Not found in source', error: 'Error', pending: 'Pending…'
  };
  function statusClass(status) {
    return { ok: 'lx-ok', queued: 'lx-queued', 'needs-key': 'lx-needs-key', unavailable: 'lx-unavailable', 'not-found': 'lx-not-found', error: 'lx-error', pending: 'lx-pending' }[status] || 'lx-pending';
  }
  function renderChecklist(results) {
    var body = $('lxComponentRows');
    if (!body) return;
    body.innerHTML = LUPUS_COMPONENTS.map(function (c) {
      var r = results[c.id] || { status: 'pending', evidence: 'Waiting…' };
      return '<tr>' +
        '<td><strong>' + esc(c.id) + '</strong></td>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td>' + esc(c.source) + '</td>' +
        '<td>' + (c.trained ? 'Trained' : 'Analysis only') + '</td>' +
        '<td><span class="lx-status ' + statusClass(r.status) + '">' + esc(STATUS_LABELS[r.status] || r.status) + '</span></td>' +
        '<td>' + esc(r.evidence || '') + '</td>' +
        '</tr>';
    }).join('') + DERIVED_COMPONENTS.map(function (d) {
      return '<tr class="lx-derived-row">' +
        '<td><strong>' + esc(d.id) + '</strong></td>' +
        '<td>' + esc(d.name) + '</td>' +
        '<td>' + esc(d.source) + '</td>' +
        '<td>Derived</td>' +
        '<td><span class="lx-status lx-derived">Derived</span></td>' +
        '<td>Derived from ' + esc(d.derivedFrom) + ' — not collected.</td>' +
        '</tr>';
    }).join('');
  }
  function renderProgress(done, total) {
    var bar = $('lxExtractProgressBar');
    var label = $('lxExtractProgressLabel');
    if (bar) bar.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    if (label) label.textContent = done + ' of ' + total + ' components checked';
  }
  function setSummary(text, kind) {
    var el = $('lxExtractSummary');
    if (!el) return;
    el.textContent = text;
    el.className = 'lx-summary' + (kind ? ' lx-summary--' + kind : '');
  }

  /* ------------------------------------------------------------------ */
  /* 10. Extraction run + hand-off                                       */
  /* ------------------------------------------------------------------ */
  /* Extraction gate: keys are re-checked first; a key that is missing,
   * expired or invalid blocks its legs (the leg reports exactly why) and
   * raises the notice. Legs that do not depend on the key still run. */
  function runExtraction() {
    if (extracting) return;
    refreshKeyStatuses().then(function () {
      var bad = unusableKeys();
      if (bad.length) showKeyNotice(bad);
      proceedExtraction();
    });
  }
  function proceedExtraction() {
    if (extracting) return;
    var area = getArea();
    var dates = getDates();
    var errors = validateInputs(area, dates);
    var warnEl = $('lxDateWarning');
    if (warnEl) {
      warnEl.textContent = dates.beyondTraining
        ? 'Note: the selected range goes past 2025-12-31, the end of the model training window. Data beyond the training window is shown as extracted evidence only.'
        : '';
      warnEl.classList.toggle('hidden', !dates.beyondTraining);
    }
    if (errors.length) { setSummary(errors.join(' '), 'error'); return; }

    extracting = true;
    var extractionStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var results = {};
    var done = 0;
    var total = LUPUS_COMPONENTS.length;
    renderChecklist(results);
    renderProgress(0, total);
    setSummary('Extracting… checking each listed source for the selected area and dates.', 'info');

    var shared = {
      openaq: openaqLeg(area),
      c15: cmrLeg('C15', area, dates),
      worldpop: worldpopLeg(area)
    };

    /* Bounded concurrency (6 at a time): the 30 component legs run in
     * parallel but do not fire all at once. The checklist is rendered
     * once at the end — only the progress bar moves per component. */
    var tasks = LUPUS_COMPONENTS.map(function (c) {
      return function () {
        return extractComponent(c.id, area, dates, shared)
          .then(function (res) { results[c.id] = res; })
          .catch(function (err) { results[c.id] = { status: 'error', evidence: 'Extraction failed (' + (err && err.message ? err.message : 'unknown error') + ').' }; })
          .finally(function () { done += 1; renderProgress(done, total); });
      };
    });

    runWithConcurrency(tasks, extractionConcurrency).then(function () {
      extracting = false;
      var nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      lastExtractionMs = Math.round(nowMs - extractionStartedAt);
      var counts = { ok: 0, queued: 0, 'needs-key': 0, unavailable: 0, 'not-found': 0, error: 0 };
      Object.keys(results).forEach(function (id) { counts[results[id].status] = (counts[results[id].status] || 0) + 1; });
      lastBundle = buildBundle(area, dates, results);
      lastCountsSummary = 'Extraction finished in ' + (lastExtractionMs / 1000).toFixed(1) + ' s: ' + counts.ok + ' available, ' + counts.queued + ' queued for backend, ' +
        counts['needs-key'] + ' need an API key, ' + counts.unavailable + ' unavailable, ' + counts['not-found'] + ' not found in source, ' +
        counts.error + ' errors. Derived C14 and C16 are computed from C13 and C15, not extracted.';
      setSummary(lastCountsSummary, counts.error ? 'warn' : 'info');
      renderChecklist(results);
      renderProgress(done, total);
      var dl = $('lxDownloadBundleBtn'); if (dl) dl.classList.remove('hidden');
      var send = $('lxSendBackendBtn'); if (send) send.classList.remove('hidden');
      window.dispatchEvent(new CustomEvent('cortex:extraction-ready', { detail: lastBundle }));
      autoSendBundle(lastBundle);
    });
  }

  /* Run task functions (each returning a promise) with at most `limit`
   * in flight. Resolves when every task has settled. */
  function runWithConcurrency(tasks, limit) {
    var max = Math.max(1, limit || extractionConcurrency);
    var index = 0;
    var inFlight = 0;
    var done = 0;
    return new Promise(function (resolve) {
      if (!tasks.length) { resolve(); return; }
      function launch() {
        while (inFlight < max && index < tasks.length) {
          var task = tasks[index++];
          inFlight++;
          task().finally(function () {
            inFlight--;
            done++;
            if (done === tasks.length) { resolve(); return; }
            launch();
          });
        }
      }
      launch();
    });
  }

  function buildBundle(area, dates, results) {
    return {
      schema_version: '1.0',
      kind: 'lupus-cortex-extraction',
      extraction_id: 'lx-' + Date.now().toString(36),
      extracted_at: new Date().toISOString(),
      area: area,
      dates: dates,
      components: LUPUS_COMPONENTS.map(function (c) {
        var r = results[c.id] || { status: 'error', evidence: 'No result recorded.' };
        var entry = { id: c.id, name: c.name, unit: c.unit, direction: c.direction, source: c.source, cadence: c.cadence, trained: c.trained, status: r.status, evidence: r.evidence };
        if (r.raw !== undefined) entry.raw = r.raw;
        return entry;
      }),
      derived: DERIVED_COMPONENTS.map(function (d) {
        return { id: d.id, name: d.name, unit: d.unit, derived_from: d.derivedFrom, source: d.source, status: 'derived' };
      }),
      manifest: {
        components_listed: LUPUS_COMPONENTS.length,
        trained_count: TRAINED_IDS.length,
        backend_configured: Boolean(String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, '')),
        key_statuses: getKeyStatuses(),
        note: 'Statuses are evidence only. No component value was invented; queued legs need the backend, needs-key legs need the matching API key. Key statuses are included without key values.'
      }
    };
  }

  function downloadBundle() {
    if (!lastBundle) return;
    var blob = new Blob([JSON.stringify(lastBundle, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lupus-extraction-' + (lastBundle.dates.start || todayISO()) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* The backend may report per-provider key status in its /api/extract
   * response ({ key_status: { openaq: 'verified', cams: 'rejected', ... } }).
   * A rejection is surfaced through the same expiry/invalid notice path. */
  function applyBackendKeyStatus(data) {
    if (!data || typeof data !== 'object') return;
    var ks = data.key_status || data.keyStatus || data.keys;
    if (!ks || typeof ks !== 'object') return;
    PROVIDERS.forEach(function (p) {
      if (ks[p]) markKeyStatus(p, ks[p]);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 10b. Auto-send, pending bundle, backend watcher                     */
  /* ------------------------------------------------------------------ */
  function apiBaseNow() { return String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, ''); }

  function savePendingBundle(bundle) {
    try { localStorage.setItem(pendingBundleKey, JSON.stringify(bundle)); } catch (_) { /* storage unavailable: the download is still offered */ }
  }
  function loadPendingBundle() {
    try {
      var raw = localStorage.getItem(pendingBundleKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.kind === 'lupus-cortex-extraction' ? parsed : null;
    } catch (_) { return null; }
  }
  function clearPendingBundle() {
    try { localStorage.removeItem(pendingBundleKey); } catch (_) { /* ignore */ }
  }

  /* POST a bundle to /api/extract. Resolves true only when the backend
   * accepted it (any 2xx). Applies any key_status the backend returns. */
  function postBundleToBackend(bundle) {
    var base = apiBaseNow();
    if (!base) return Promise.resolve(false);
    return Promise.resolve().then(function () {
      return fetch(base + '/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle)
      });
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (_) { /* non-JSON body */ }
          return { res: res, data: data };
        });
      })
      .then(function (out) {
        if (!out.res.ok) throw new Error('Backend returned HTTP ' + out.res.status);
        applyBackendKeyStatus(out.data);
        return true;
      });
  }

  /* Auto-send: the default path after an extraction finishes. With a
   * backend configured the bundle goes out immediately and analysis is
   * requested through the existing window.CortexAnalysis.request flow —
   * no manual click. Without one, the bundle is saved as the pending
   * bundle and the watcher starts. A failed POST keeps the pending
   * bundle and retries on the next watcher tick — a bundle is never
   * silently dropped. */
  function autoSendBundle(bundle) {
    if (!bundle) return Promise.resolve(false);
    var base = apiBaseNow();
    if (!base) {
      savePendingBundle(bundle);
      startBackendWatcher();
      setSummary(lastCountsSummary + ' Model backend not connected yet — the model will be added later. The bundle is saved in this browser and will be sent automatically when the backend comes online. Download it as JSON in the meantime.', 'warn');
      return Promise.resolve(false);
    }
    setSummary(lastCountsSummary + ' Sending the extraction bundle to the backend automatically…', 'info');
    return postBundleToBackend(bundle).then(function () {
      clearPendingBundle();
      stopBackendWatcher();
      setSummary(lastCountsSummary + ' Extraction bundle sent to the backend automatically. Requesting analysis for the selected area…', 'info');
      showBackendNotice('Extraction bundle sent to the backend automatically.');
      requestAnalysisForCurrentPoint();
      return true;
    }).catch(function (err) {
      savePendingBundle(bundle);
      startBackendWatcher();
      setSummary(lastCountsSummary + ' Could not reach the backend (' + (err && err.message ? err.message : 'network error') + '). The bundle is saved in this browser and will be sent automatically when the backend is reachable.', 'error');
      return false;
    });
  }

  function requestAnalysisForCurrentPoint() {
    var point = currentPoint();
    if (point && window.CortexAnalysis && typeof window.CortexAnalysis.request === 'function') {
      window.CortexAnalysis.request(point);
    }
  }

  /* Manual "Send to backend" — same path as auto-send (retry/fallback). */
  function sendToBackend() {
    if (!lastBundle) return Promise.resolve(false);
    return autoSendBundle(lastBundle);
  }

  /* Backend watcher: while a bundle is pending, check every 60 s whether
   * the backend is reachable. Any HTTP response counts as reachable —
   * even a 404, which only proves the server is up (the /api/health
   * endpoint itself may not exist on the future backend); only a
   * network error or timeout counts as offline. On reachable + pending
   * bundle, the bundle is sent, cleared, and the user is told. */
  function checkBackendHealth() {
    var base = apiBaseNow();
    if (!base) return Promise.resolve(false);
    return Promise.resolve().then(function () {
      return fetchWithTimeout(base + backendHealthPath, { method: 'GET' }, backendHealthTimeoutMs);
    }).then(function () {
      backendKnownReachable = true;
      return true;
    }).catch(function () {
      backendKnownReachable = false;
      return false;
    });
  }
  function checkBackendAndFlush() {
    var pending = loadPendingBundle();
    if (!pending) { stopBackendWatcher(); return Promise.resolve(false); }
    return checkBackendHealth().then(function (reachable) {
      if (!reachable) return false;
      return postBundleToBackend(pending).then(function () {
        clearPendingBundle();
        stopBackendWatcher();
        showBackendNotice('Extraction bundle sent to the backend automatically.');
        setSummary((lastCountsSummary ? lastCountsSummary + ' ' : '') + 'Extraction bundle sent to the backend automatically.', 'info');
        requestAnalysisForCurrentPoint();
        return true;
      }).catch(function (err) {
        setSummary('Backend is reachable but the bundle could not be sent (' + (err && err.message ? err.message : 'network error') + '). It stays saved in this browser and will be retried.', 'error');
        return false;
      });
    });
  }
  function startBackendWatcher() {
    if (backendWatcherTimer) return;
    if (typeof setInterval !== 'function') return;
    backendWatcherTimer = setInterval(function () { checkBackendAndFlush(); }, backendWatchMs);
  }
  function stopBackendWatcher() {
    if (backendWatcherTimer) { clearInterval(backendWatcherTimer); backendWatcherTimer = null; }
  }
  function showBackendNotice(text) {
    var banner = $('lxBackendNotice');
    var el = $('lxBackendNoticeText');
    if (!banner || !el) return;
    el.textContent = text;
    banner.classList.remove('hidden');
  }
  function hideBackendNotice() {
    var banner = $('lxBackendNotice');
    if (banner) banner.classList.add('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* 11. Area tabs, place search, coords, bbox, dates                    */
  /* ------------------------------------------------------------------ */
  function switchAreaTab(tabName) {
    document.querySelectorAll('.lx-area-tab').forEach(function (t) {
      var active = t.dataset.lxAreaTab === tabName;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.lx-area-pane').forEach(function (p) {
      p.classList.toggle('active', p.dataset.lxAreaPane === tabName);
    });
  }
  function lxForwardGeocode(query) {
    if (typeof window.forwardGeocode === 'function') return window.forwardGeocode(query);
    var url = NOMINATIM_BASE + '/search?format=json&addressdetails=1&limit=5&q=' + encodeURIComponent(query);
    return fetchJson(url, { headers: { 'Accept': 'application/json' } }, 15000);
  }
  function lxReverseGeocode(lat, lng) {
    if (typeof window.reverseGeocode === 'function') return window.reverseGeocode(lat, lng);
    var url = NOMINATIM_BASE + '/reverse?format=json&addressdetails=1&lat=' + lat + '&lon=' + lng + '&zoom=12';
    return fetchJson(url, { headers: { 'Accept': 'application/json' } }, 15000);
  }
  function applyPoint(lat, lng, name) {
    selectedArea = { mode: 'point', lat: lat, lng: lng, name: name, bbox: pointBbox(lat, lng) };
    setAreaLabel();
    if (typeof window.setLocation === 'function') window.setLocation(lat, lng, name);
  }
  function handlePlaceSearch() {
    var input = $('lxPlaceInput');
    var q = input ? input.value.trim() : '';
    var status = $('lxPlaceStatus');
    if (q.length < 2) { if (status) status.textContent = 'Please enter at least 2 characters.'; return; }
    if (status) status.textContent = 'Searching…';
    lxForwardGeocode(q).then(function (results) {
      var box = $('lxPlaceSuggestions');
      if (!results.length) {
        if (status) status.textContent = 'No matching place found.';
        if (box) box.classList.add('hidden');
        return;
      }
      if (status) status.textContent = 'Found ' + results.length + ' matches — pick one:';
      if (!box) return;
      box.innerHTML = results.map(function (r, i) {
        var label = (r.address && (r.address.city || r.address.town || r.address.village || r.address.county || r.address.state)) || r.display_name;
        return '<button class="lx-suggestion" data-i="' + i + '"><span>' + esc(label) + '</span><span>' + esc(Number(r.lat).toFixed(3)) + '°, ' + esc(Number(r.lon).toFixed(3)) + '°</span></button>';
      }).join('');
      box.classList.remove('hidden');
      box.querySelectorAll('.lx-suggestion').forEach(function (btn, i) {
        btn.addEventListener('click', function () {
          var r = results[i];
          var name = (r.address && (r.address.city || r.address.town || r.address.village || r.address.county)) || r.display_name;
          applyPoint(Number(r.lat), Number(r.lon), name);
          box.classList.add('hidden');
          if (status) status.textContent = 'Area set to ' + name + '.';
        });
      });
    }).catch(function () {
      if (status) status.textContent = 'Search failed. Check your internet connection.';
    });
  }
  function handleCoordsApply() {
    var lat = Number($('lxCoordLat') && $('lxCoordLat').value);
    var lng = Number($('lxCoordLng') && $('lxCoordLng').value);
    var status = $('lxCoordsStatus');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      if (status) status.textContent = 'Latitude must be -90 to 90 and longitude -180 to 180.';
      return;
    }
    if (status) status.textContent = 'Resolving place name…';
    lxReverseGeocode(lat, lng).then(function (r) {
      var name = (r.address && (r.address.city || r.address.town || r.address.village || r.address.county)) || r.display_name || ('Location (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ')');
      applyPoint(lat, lng, name);
      if (status) status.textContent = 'Area set to ' + name + '.';
    }).catch(function () {
      applyPoint(lat, lng, 'Location (' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ')');
      if (status) status.textContent = 'Coordinates applied, but reverse geocoding failed.';
    });
  }
  function handleBboxApply() {
    var minLat = Number($('lxBboxMinLat') && $('lxBboxMinLat').value);
    var maxLat = Number($('lxBboxMaxLat') && $('lxBboxMaxLat').value);
    var minLng = Number($('lxBboxMinLng') && $('lxBboxMinLng').value);
    var maxLng = Number($('lxBboxMaxLng') && $('lxBboxMaxLng').value);
    var status = $('lxBboxStatus');
    var bad = [minLat, maxLat, minLng, maxLng].some(function (v) { return !Number.isFinite(v); }) ||
      minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 || minLat >= maxLat || minLng >= maxLng;
    if (bad) {
      if (status) status.textContent = 'Check the bounding box: latitudes -90 to 90, longitudes -180 to 180, and min must be less than max.';
      return;
    }
    var centerLat = (minLat + maxLat) / 2;
    var centerLng = (minLng + maxLng) / 2;
    selectedArea = { mode: 'bbox', lat: centerLat, lng: centerLng, name: 'Bounding box', bbox: [minLng, minLat, maxLng, maxLat] };
    setAreaLabel();
    if (typeof window.setLocation === 'function') window.setLocation(centerLat, centerLng, 'Bounding box centre');
    if (status) status.textContent = 'Bounding box applied.';
  }
  function toggleDateInputs() {
    var rangeMode = $('lxDateRange') && $('lxDateRange').checked;
    var wrap = $('lxDateRangeInputs');
    if (wrap) wrap.classList.toggle('hidden', !rangeMode);
  }
  function initDateInputs() {
    var today = todayISO();
    var start = $('lxDateStart'); var end = $('lxDateEnd');
    if (start) { start.min = EARLIEST_DATE; start.max = today; if (!start.value) start.value = '2025-01-01'; }
    if (end) { end.min = EARLIEST_DATE; end.max = today; if (!end.value) end.value = today; }
  }

  /* ------------------------------------------------------------------ */
  /* 12. Panel open/close + wiring                                      */
  /* ------------------------------------------------------------------ */
  function openExtractor() {
    var panel = $('lxExtractorPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    setAreaLabel();
    renderChecklist({});
    initDateInputs();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (unusableKeys().length) openKeyModal();
  }
  function closeExtractor() { var p = $('lxExtractorPanel'); if (p) p.classList.add('hidden'); }

  function init() {
    if (bound) return;
    bound = true;
    renderKeyStatus();
    refreshKeyStatuses();
    setAreaLabel();
    renderChecklist({});
    initDateInputs();
    if (typeof setInterval === 'function' && !expiryTickTimer) {
      expiryTickTimer = setInterval(checkKeyExpiryTick, 60000);
    }

    var openBtn = $('lxOpenExtractorBtn');
    if (openBtn) openBtn.addEventListener('click', openExtractor);
    var closeBtn = $('lxCloseExtractorBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeExtractor);
    var keysBtn = $('lxApiKeysBtn');
    if (keysBtn) keysBtn.addEventListener('click', openKeyModal);
    var keysBtn2 = $('lxApiKeysBtnPanel');
    if (keysBtn2) keysBtn2.addEventListener('click', openKeyModal);

    var saveBtn = $('lxKeySaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveKeysFromModal);
    var verifyBtns = { openaq: 'lxKeyVerifyOpenaq', cams: 'lxKeyVerifyCams', earthdata: 'lxKeyVerifyEarthdata' };
    Object.keys(verifyBtns).forEach(function (p) {
      var btn = $(verifyBtns[p]);
      if (btn) btn.addEventListener('click', function () { verifyKeyFromModal(p); });
    });
    var noticeBtn = $('lxKeyNoticeBtn');
    if (noticeBtn) noticeBtn.addEventListener('click', openKeyModal);
    var noticeDismissBtn = $('lxKeyNoticeDismissBtn');
    if (noticeDismissBtn) noticeDismissBtn.addEventListener('click', hideKeyNotice);
    var backendDismissBtn = $('lxBackendNoticeDismissBtn');
    if (backendDismissBtn) backendDismissBtn.addEventListener('click', hideBackendNotice);
    var forgetBtn = $('lxKeyForgetBtn');
    if (forgetBtn) forgetBtn.addEventListener('click', forgetAllKeys);
    var closeKeyBtn = $('lxKeyCloseBtn');
    if (closeKeyBtn) closeKeyBtn.addEventListener('click', function () { closeKeyModal(); });
    var continueBtn = $('lxKeyContinueBtn');
    if (continueBtn) continueBtn.addEventListener('click', function () {
      closeKeyModal();
      if (pendingExtractAfterKeys) { pendingExtractAfterKeys = false; runExtraction(); }
    });

    document.querySelectorAll('.lx-area-tab').forEach(function (t) {
      t.addEventListener('click', function () { switchAreaTab(t.dataset.lxAreaTab); });
    });
    var placeBtn = $('lxPlaceSearchBtn');
    if (placeBtn) placeBtn.addEventListener('click', handlePlaceSearch);
    var placeInput = $('lxPlaceInput');
    if (placeInput) placeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') handlePlaceSearch(); });
    var coordsBtn = $('lxCoordsApplyBtn');
    if (coordsBtn) coordsBtn.addEventListener('click', handleCoordsApply);
    var bboxBtn = $('lxBboxApplyBtn');
    if (bboxBtn) bboxBtn.addEventListener('click', handleBboxApply);

    var dateToday = $('lxDateToday');
    if (dateToday) dateToday.addEventListener('change', toggleDateInputs);
    var dateRange = $('lxDateRange');
    if (dateRange) dateRange.addEventListener('change', toggleDateInputs);

    var extractBtn = $('lxExtractBtn');
    if (extractBtn) extractBtn.addEventListener('click', function () {
      refreshKeyStatuses().then(function () {
        var bad = unusableKeys();
        if (bad.length && !pendingExtractAfterKeys) {
          pendingExtractAfterKeys = true;
          showKeyNotice(bad);
          openKeyModal();
          return;
        }
        runExtraction();
      });
    });
    var dlBtn = $('lxDownloadBundleBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadBundle);
    var sendBtn = $('lxSendBackendBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendToBackend);

    /* If a bundle is still pending from an earlier visit, check once now
     * whether the backend is up; otherwise the watcher starts on the
     * next extraction and checks every 60 s. */
    checkBackendAndFlush();

    window.addEventListener('cortex:key-status', function (event) {
      var detail = (event && event.detail) || {};
      if (detail.provider && detail.status) markKeyStatus(detail.provider, detail.status);
    });
    window.addEventListener('cortex:place-selected', function (event) {
      var detail = event.detail || {};
      if (Number.isFinite(Number(detail.lat)) && Number.isFinite(Number(detail.lng))) {
        selectedArea = { mode: 'point', lat: Number(detail.lat), lng: Number(detail.lng), name: detail.name || 'Selected location', bbox: pointBbox(Number(detail.lat), Number(detail.lng)) };
        setAreaLabel();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.LupusExtractor = {
    components: LUPUS_COMPONENTS,
    derived: DERIVED_COMPONENTS,
    trainedIds: TRAINED_IDS,
    init: init,
    open: openExtractor,
    close: closeExtractor,
    openKeyModal: openKeyModal,
    closeKeyModal: closeKeyModal,
    getKeys: loadKeys,
    getKeyStatuses: getKeyStatuses,
    missingKeys: missingKeys,
    unusableKeys: unusableKeys,
    isKeyExpired: isKeyExpired,
    keyStatusFor: keyStatusFor,
    decodeJwtExp: decodeJwtExp,
    verifyProvider: verifyProvider,
    verifyAndStoreKey: verifyAndStoreKey,
    refreshKeyStatuses: refreshKeyStatuses,
    checkKeyExpiryTick: checkKeyExpiryTick,
    showKeyNotice: showKeyNotice,
    markKeyStatus: markKeyStatus,
    openaqLeg: openaqLeg,
    needsKeyLeg: needsKeyLeg,
    extractComponent: extractComponent,
    forgetAllKeys: forgetAllKeys,
    getArea: getArea,
    getDates: getDates,
    run: runExtraction,
    getBundle: function () { return lastBundle; },
    downloadBundle: downloadBundle,
    sendToBackend: sendToBackend,
    autoSendBundle: autoSendBundle,
    getPendingBundle: loadPendingBundle,
    clearPendingBundle: clearPendingBundle,
    checkBackendHealth: checkBackendHealth,
    checkBackendAndFlush: checkBackendAndFlush,
    startBackendWatcher: startBackendWatcher,
    stopBackendWatcher: stopBackendWatcher,
    getLastExtractionMs: function () { return lastExtractionMs; },
    runWithConcurrency: runWithConcurrency,
    extractionConcurrency: extractionConcurrency
  };
})();
