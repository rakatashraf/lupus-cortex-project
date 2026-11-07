(function () {
  'use strict';

  const state = { status: 'idle', analysis: null, request: null, error: null };
  const apiBase = String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, '');

  function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); }

  const REQUIRED_SCHEMA_VERSION = '1.0';

  function valid(report) {
    if (!report || typeof report !== 'object' || report.schema_version !== REQUIRED_SCHEMA_VERSION) return false;
    const location = report.location || {};
    const lat = Number(location.lat);
    const lon = Number(location.lon ?? location.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return false;
    if (!report.analysis_id || !report.model_version) return false;
    if (!report.time || typeof report.time !== 'object') return false;
    if (!report.data_quality || typeof report.data_quality !== 'object') return false;
    if (!report.components || typeof report.components !== 'object' || Array.isArray(report.components)) return false;
    if (!report.indices || typeof report.indices !== 'object' || Array.isArray(report.indices)) return false;
    if (!report.hwi || typeof report.hwi !== 'object') return false;
    if (!report.analysis || typeof report.analysis !== 'object') return false;
    return ['history', 'forecasts', 'warnings', 'recommendations', 'provenance'].every(key => Object.hasOwn(report, key));
  }

  async function request(location, options = {}) {
    const lat = Number(location?.lat);
    const lng = Number(location?.lng ?? location?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      state.status = 'error'; state.error = 'A valid latitude and longitude are required.';
      emit('cortex:analysis-error', { ...state });
      return null;
    }
    const scenario = options.scenario || null;
    if (state.status === 'awaiting_model' && state.request && state.request.lat === lat && state.request.lon === lng && Boolean(state.request.scenario) === Boolean(scenario)) return null;
    state.status = 'awaiting_model'; state.error = null;
    state.request = {
      lat, lon: lng, name: location?.name || 'Selected location',
      requested_at: new Date().toISOString(),
      scenario
    };
    emit('cortex:analysis-request', { ...state.request });
    emit('cortex:analysis-state', { ...state });
    if (!apiBase) {
      state.status = 'error'; state.error = 'Analysis unavailable: model backend is not configured.';
      emit('cortex:analysis-error', { ...state }); emit('cortex:analysis-state', { ...state });
      return null;
    }
    try {
      const endpoint = `${apiBase}${scenario ? '/api/scenario' : '/api/analyze'}`;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.request) });
      if (!response.ok) throw new Error(`Analysis request failed (${response.status}).`);
      return ingest(await response.json());
    } catch (error) {
      state.status = 'error'; state.error = error.message;
      emit('cortex:analysis-error', { ...state });
      return null;
    }
  }

  function ingest(report) {
    if (!valid(report)) throw new Error(`The model response must follow Lupus Cortex schema ${REQUIRED_SCHEMA_VERSION}.`);
    state.analysis = report; state.status = 'ready'; state.error = null;
    emit('cortex:analysis-ready', report);
    emit('cortex:analysis-state', { ...state });
    return report;
  }

  window.CortexAnalysis = { request, ingest, snapshot: () => ({ ...state }) };
  window.addEventListener('cortex:place-selected', event => request(event.detail));
}());
