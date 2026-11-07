// Scenario Lab: the browser collects intent; the backend owns every result.
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function renderWaiting(message) {
    const container = byId('recommendationsContainer');
    const list = byId('recommendationsList');
    if (!container || !list) return;
    container.classList.remove('hidden');
    list.innerHTML = `<div class="analysis-empty-state"><span>Scenario analysis</span><h3>${escapeHtml(message)}</h3><p>Only the model response can provide alternatives, wellbeing effects, measurements and trade-offs.</p></div>`;
  }

  function parseCoordinates(value) {
    const values = String(value || '').split(',').map(item => Number(item.trim()));
    if (values.length !== 2 || !Number.isFinite(values[0]) || !Number.isFinite(values[1])) return null;
    const [lat, lon] = values;
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : null;
  }

  function initUseCases() {
    const button = byId('analyzeScenarioBtn');
    if (button) button.onclick = analyzeScenario;
  }

  function analyzeScenario() {
    const coordinates = parseCoordinates(byId('usecaseLocation')?.value);
    const description = byId('usecaseDescription')?.value.trim();
    const name = byId('usecaseLocationName')?.value.trim() || 'Scenario location';
    if (!coordinates || !description) {
      renderWaiting('Enter valid coordinates and a scenario description.');
      return;
    }

    const baseline = window.CortexAnalysis?.snapshot?.().analysis;
    const scenario = {
      mode: 'scenario',
      baseline_analysis_id: baseline?.analysis_id || null,
      changes: {},
      description,
      requested_location_name: name
    };
    window.CortexAnalysis?.request?.({ ...coordinates, lng: coordinates.lon, name }, { scenario });
    renderWaiting('Scenario request sent. Awaiting model report.');
  }

  function renderScenarioReport(report) {
    const scenario = report?.scenario || report?.analysis?.scenario;
    if (!scenario) return;
    const container = byId('recommendationsContainer');
    const list = byId('recommendationsList');
    if (!container || !list) return;
    const alternatives = Array.isArray(scenario.alternatives) ? scenario.alternatives : [];
    const effects = scenario.human_wellbeing_effect ?? scenario.wellbeing_effect ?? 'Unavailable';
    const measurements = scenario.measurements ?? scenario.metrics ?? 'Unavailable';
    container.classList.remove('hidden');
    list.innerHTML = `<section class="scenario-report"><h3>Model scenario report</h3><p><b>Human wellbeing effect:</b> ${escapeHtml(effects)}</p><p><b>Measurements:</b> ${escapeHtml(typeof measurements === 'string' ? measurements : JSON.stringify(measurements))}</p><div class="scenario-alternatives">${alternatives.length ? alternatives.map(item => `<article><h4>${escapeHtml(item.name || item.location || 'Alternative location')}</h4><p>${escapeHtml(item.summary || item.rationale || 'No rationale returned.')}</p></article>`).join('') : '<p>Alternative locations were not returned by the model.</p>'}</div></section>`;
  }

  window.initUseCases = initUseCases;
  window.addEventListener('cortex:analysis-ready', event => renderScenarioReport(event.detail));
  window.addEventListener('cortex:analysis-error', () => renderWaiting('Analysis unavailable. Configure the model backend and try again.'));
}());
