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
 *    (key: lupus_cortex_api_keys). They are shown masked, never logged, and
 *    are sent only as a header to the provider that issued them. The CAMS
 *    ADS key and the Earthdata token are never sent from the browser at all:
 *    CAMS ADS and MERRA-2 GES DISC are not browser-callable, so those legs
 *    are queued for the backend.
 *  - The model backend is not built yet. When no backend base is
 *    configured, the extracted bundle is offered as a downloadable JSON and
 *    the UI says so honestly instead of pretending an analysis happened.
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
  var selectedArea = null; /* { mode:'point'|'bbox', lat, lng, name, bbox:[minLng,minLat,maxLng,maxLat] } */
  var cmrCache = {};

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
        openaq: typeof parsed.openaq === 'string' ? parsed.openaq : '',
        cams: typeof parsed.cams === 'string' ? parsed.cams : '',
        earthdata: typeof parsed.earthdata === 'string' ? parsed.earthdata : ''
      };
    } catch (_) { return { openaq: '', cams: '', earthdata: '' }; }
  }
  function saveKeys(keys) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch (_) { /* storage unavailable */ }
  }
  function masked(value) {
    if (!value) return 'Not set';
    if (value.length <= 4) return '••••';
    return '••••••••' + value.slice(-4);
  }
  function missingKeys() {
    var keys = loadKeys();
    var missing = [];
    if (!keys.openaq) missing.push('OpenAQ API key');
    if (!keys.cams) missing.push('CAMS ADS API key');
    if (!keys.earthdata) missing.push('Earthdata token');
    return missing;
  }
  function renderKeyStatus() {
    var keys = loadKeys();
    var map = { openaq: 'lxKeyStatusOpenaq', cams: 'lxKeyStatusCams', earthdata: 'lxKeyStatusEarthdata' };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el) el.textContent = masked(keys[k]);
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
  function saveKeysFromModal() {
    var keys = loadKeys();
    var io = $('lxKeyOpenaq'); var ic = $('lxKeyCams'); var ie = $('lxKeyEarthdata');
    /* Only overwrite a stored key when the user typed a new value. */
    if (io && io.value.trim()) keys.openaq = io.value.trim();
    if (ic && ic.value.trim()) keys.cams = ic.value.trim();
    if (ie && ie.value.trim()) keys.earthdata = ie.value.trim();
    saveKeys(keys);
    renderKeyStatus();
    closeKeyModal();
    var note = $('lxKeyNote');
    if (note) note.textContent = 'Keys saved in this browser only.';
    if (pendingExtractAfterKeys) { pendingExtractAfterKeys = false; runExtraction(); }
  }
  function forgetAllKeys() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
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
    if (!keys.openaq) {
      return Promise.resolve({ status: 'needs-key', evidence: 'OpenAQ API key required — add it in the API keys popup.' });
    }
    var headers = { 'X-API-Key': keys.openaq, 'Accept': 'application/json' };
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
        return { status: 'error', evidence: 'OpenAQ request failed (' + (err && err.message ? err.message : 'network error') + ').' };
      });
  }

  function cmrLeg(componentId, area, dates) {
    var spec = CMR_COLLECTIONS[componentId];
    if (!spec) return Promise.resolve({ status: 'queued', evidence: 'No browser CMR collection for this component; queued for backend.' });
    var cacheKey = componentId + '|' + area.bbox.join(',') + '|' + dates.start + '|' + dates.end;
    if (cmrCache[cacheKey]) return Promise.resolve(cmrCache[cacheKey]);
    var collUrl = CMR_BASE + '/collections.json?short_name=' + encodeURIComponent(spec.short_name) +
      '&version=' + encodeURIComponent(spec.version) + '&page_size=5';
    var result = fetchJson(collUrl, {}, 20000)
      .then(function (data) {
        var entries = (data.feed && data.feed.entry) || [];
        if (!entries.length) {
          return { status: 'not-found', evidence: 'Collection ' + spec.short_name + ' v' + spec.version + ' not found in NASA CMR.' };
        }
        var conceptId = entries[0].id;
        var granUrl = CMR_BASE + '/granules.json?concept_id=' + encodeURIComponent(conceptId) +
          '&bounding_box=' + area.bbox.join(',') +
          '&temporal=' + dates.start + 'T00:00:00Z,' + dates.end + 'T23:59:59Z&page_size=1';
        return fetchJson(granUrl, {}, 25000).then(function (gdata) {
          var hits = typeof gdata.hits === 'number' ? gdata.hits : ((gdata.feed && gdata.feed.entry) || []).length;
          if (!hits) return { status: 'not-found', evidence: '0 granules of ' + spec.short_name + ' v' + spec.version + ' in the area and date range.' };
          return { status: 'ok', evidence: hits + ' granules of ' + spec.short_name + ' v' + spec.version + ' in the area and date range.', raw: { collection: spec.short_name, version: spec.version, concept_id: conceptId, hits: hits } };
        });
      })
      .catch(function (err) {
        return { status: 'error', evidence: 'NASA CMR request failed (' + (err && err.message ? err.message : 'network error') + ').' };
      });
    cmrCache[cacheKey] = result;
    return result;
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
    var keys = loadKeys();
    if (what === 'earthdata' && !keys.earthdata) return Promise.resolve({ status: 'needs-key', evidence: reason + ' Earthdata token required.' });
    if (what === 'cams' && !keys.cams) return Promise.resolve({ status: 'needs-key', evidence: reason + ' CAMS ADS API key required.' });
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
  function runExtraction() {
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
    cmrCache = {};
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

    var jobs = LUPUS_COMPONENTS.map(function (c) {
      return extractComponent(c.id, area, dates, shared)
        .then(function (res) { results[c.id] = res; })
        .catch(function (err) { results[c.id] = { status: 'error', evidence: 'Extraction failed (' + (err && err.message ? err.message : 'unknown error') + ').' }; })
        .finally(function () { done += 1; renderChecklist(results); renderProgress(done, total); });
    });

    Promise.all(jobs).then(function () {
      extracting = false;
      var counts = { ok: 0, queued: 0, 'needs-key': 0, unavailable: 0, 'not-found': 0, error: 0 };
      Object.keys(results).forEach(function (id) { counts[results[id].status] = (counts[results[id].status] || 0) + 1; });
      lastBundle = buildBundle(area, dates, results);
      var summary = 'Extraction finished: ' + counts.ok + ' available, ' + counts.queued + ' queued for backend, ' +
        counts['needs-key'] + ' need an API key, ' + counts.unavailable + ' unavailable, ' + counts['not-found'] + ' not found in source, ' +
        counts.error + ' errors. Derived C14 and C16 are computed from C13 and C15, not extracted.';
      setSummary(summary, counts.error ? 'warn' : 'info');
      var dl = $('lxDownloadBundleBtn'); if (dl) dl.classList.remove('hidden');
      var send = $('lxSendBackendBtn'); if (send) send.classList.remove('hidden');
      window.dispatchEvent(new CustomEvent('cortex:extraction-ready', { detail: lastBundle }));
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
        note: 'Statuses are evidence only. No component value was invented; queued legs need the backend, needs-key legs need the matching API key.'
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

  function sendToBackend() {
    if (!lastBundle) return;
    var apiBase = String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, '');
    var point = currentPoint();
    if (!apiBase) {
      setSummary('Model backend not connected yet — the model will be added later. The extraction bundle is ready to download as JSON.', 'warn');
      return;
    }
    setSummary('Sending the extraction bundle to the backend…', 'info');
    /* The bundle travels on POST /api/extract; the analysis itself still
     * flows through the existing window.CortexAnalysis.request call, so
     * analysis-client.js is left untouched. */
    fetch(apiBase + '/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastBundle)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Backend returned HTTP ' + res.status);
        setSummary('Extraction bundle sent to the backend. Requesting analysis for the selected area…', 'info');
        if (point && window.CortexAnalysis && typeof window.CortexAnalysis.request === 'function') {
          window.CortexAnalysis.request(point);
        }
      })
      .catch(function (err) {
        setSummary('Could not reach the backend (' + (err && err.message ? err.message : 'network error') + '). The bundle is still available to download as JSON.', 'error');
      });
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
    if (missingKeys().length) openKeyModal();
  }
  function closeExtractor() { var p = $('lxExtractorPanel'); if (p) p.classList.add('hidden'); }

  function init() {
    if (bound) return;
    bound = true;
    renderKeyStatus();
    setAreaLabel();
    renderChecklist({});
    initDateInputs();

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
      if (missingKeys().length && !pendingExtractAfterKeys) {
        pendingExtractAfterKeys = true;
        openKeyModal();
        return;
      }
      runExtraction();
    });
    var dlBtn = $('lxDownloadBundleBtn');
    if (dlBtn) dlBtn.addEventListener('click', downloadBundle);
    var sendBtn = $('lxSendBackendBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendToBackend);

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
    missingKeys: missingKeys,
    forgetAllKeys: forgetAllKeys,
    getArea: getArea,
    getDates: getDates,
    run: runExtraction,
    getBundle: function () { return lastBundle; },
    downloadBundle: downloadBundle,
    sendToBackend: sendToBackend
  };
})();
