// ===== URBAN HEALTH DASHBOARD =====

const urbanIndices = [
  {
    key: 'AQHI',
    name: 'Air Quality Health Index',
    category: 'Atmospheric Exposure',
    description: 'Tracks particulate, gaseous, and aerosol exposure affecting population health.',
    target: 78
  },
  {
    key: 'UHVI',
    name: 'Urban Heat Vulnerability Index',
    category: 'Heat & Climate',
    description: 'Combines thermal exposure, urban form, greenery, and population vulnerability.',
    target: 76
  },
  {
    key: 'GEA',
    name: 'Green Environment Accessibility Index',
    category: 'Ecological Condition',
    description: 'Measures vegetation condition, green-space coverage, and green-space access.',
    target: 78
  },
  {
    key: 'WSII',
    name: 'Water Security & Infrastructure Index',
    category: 'Water & Infrastructure',
    description: 'Assesses water availability, hydrological extremes, flood and drought exposure, and terrain.',
    target: 75
  },
  {
    key: 'TAI',
    name: 'Transport Accessibility Index',
    category: 'Access Systems',
    description: 'Measures road-network availability and public-transport access.',
    target: 78
  },
  {
    key: 'HAI',
    name: 'Healthcare Accessibility Index',
    category: 'Access Systems',
    description: 'Measures access to hospitals, critical infrastructure, and the population served.',
    target: 78
  },
  {
    key: 'CRI',
    name: 'Climate Resilience Index',
    category: 'Climate Resilience',
    description: 'Combines hydrological hazards, terrain, soil moisture, and disaster readiness.',
    target: 76
  },
  {
    key: 'SCI',
    name: 'Social / Urban Vulnerability Index',
    category: 'Social Vulnerability',
    description: 'Measures social exposure through population, urban form, access, services, and activity.',
    target: 74
  },
  {
    key: 'DRI',
    name: 'Disaster Readiness Index',
    category: 'Disaster Readiness',
    description: 'Measures preparedness alongside flood, heat, terrain, infrastructure, and population exposure.',
    target: 76
  }
];

let dashboardCharts = {
  radar: null,
  line: null
};

function clampScore(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function hwiLabelFromScore(score) {
  if (score >= 81) return 'Perfect';
  if (score >= 61) return 'Well managed';
  if (score >= 41) return 'Needs improvement';
  if (score >= 21) return 'Poor';
  return 'Harmful';
}

function initDashboard() {
  console.log('📊 Initializing dashboard...');
  fetchUrbanHealthData();
}

async function fetchUrbanHealthData() {
  const { lat, lng } = appState.currentLocation;
  
  try {
    appState.isLoading = true;
    updateLoadingState(true);
    
    const analysisState = window.CortexAnalysis?.snapshot?.();
    if (analysisState?.status === 'ready' && analysisState.analysis) {
      renderDashboardFromAnalysis(analysisState.analysis);
    } else {
      renderDashboardUnavailable(analysisState?.status === 'awaiting_model');
      window.CortexAnalysis?.request?.(appState.currentLocation);
    }
    appState.isLoading = false;
    updateLoadingState(false);
    
  } catch (error) {
    console.error('❌ Error fetching health data:', error);
    appState.isLoading = false;
    updateLoadingState(false);
  }
}

function renderDashboard(data) {
  // Update overall score
  const scoreEl = document.getElementById('overallScore');
  const statusEl = document.getElementById('scoreStatus');
  
  if (scoreEl) scoreEl.textContent = Number.isFinite(Number(data.overall_score)) ? data.overall_score : '—';
  const coverage = Number(data.data_quality?.coverage_pct ?? data.data_quality?.coverage);
  if (statusEl) statusEl.textContent = Number.isFinite(coverage) ? `Data coverage: ${coverage}%` : 'Data coverage unavailable';

  const hwi = data.hwi && Number.isFinite(Number(data.hwi.score)) ? data.hwi : null;
  const hwiScoreEl = document.getElementById('hwiScore');
  const hwiStatusEl = document.getElementById('hwiStatus');
  const hwiCard = document.getElementById('hwiScoreCard');
  if (hwiScoreEl) hwiScoreEl.textContent = hwi ? hwi.score : '—';
  if (hwiStatusEl) hwiStatusEl.textContent = hwi?.status || 'Data unavailable';
  if (hwiCard) hwiCard.onclick = hwi ? () => openIndexDetail('HWI', hwi) : null;
  
  // Render indices
  renderIndicesGrid(data.indices);
  
  // Render charts
  renderCharts(data.indices);
}

function renderIndicesGrid(indices) {
  const grid = document.getElementById('indicesGrid');
  if (!grid) return;
  
  grid.innerHTML = '';
  
  Object.values(indices).forEach(index => {
    const card = document.createElement('div');
    const scoreClass = statusToClass(index.status || statusFromScore(index.score));
    const gap = index.score - index.target;
    const progress = Math.min(100, Math.round((index.score / index.target) * 100));
    card.className = `index-card index-card--${scoreClass}`;
    
    card.innerHTML = `
      <div class="index-card-topline">
        <span class="index-status-badge ${scoreClass}">${statusIcon(index.score)} ${index.status}</span>
        <span class="index-key">${index.key}</span>
      </div>
      <h3>${index.name}</h3>
      <div class="index-score-row">
        <div class="index-score ${scoreClass}">${index.score}</div>
        <span class="index-score-denominator">/100</span>
      </div>
      <div class="index-category">${index.category}</div>
      <div class="index-progress-track ${scoreClass}" aria-label="${progress}% of target"><span style="width:${progress}%"></span></div>
      <div class="index-metrics">
        <span>Target <strong>${index.target}</strong></span>
        <span class="${gap >= 0 ? 'is-ahead' : 'is-behind'}">${gap >= 0 ? '+' : ''}${gap} vs target</span>
      </div>
      <div class="index-card-cta">View details →</div>
    `;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Open details for ${index.name}`);
    const open = () => openIndexDetail(index.key, index);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    grid.appendChild(card);
  });
}

// ============================================================
// INDEX DETAIL MODAL
// ============================================================
let currentIndexDetail = null;

function openIndexDetail(key, liveIndex) {
  const detail = (window.INDEX_DETAILS || {})[key];
  if (!detail) {
    console.warn('No detail entry for index', key);
    return;
  }
  const score  = liveIndex?.score ?? 0;
  const target = detail.target ?? liveIndex?.target ?? 75;
  const status = liveIndex?.status ?? statusFromScore(score);
  const progress = Math.min(100, Math.round((score / target) * 100));

  currentIndexDetail = { key, detail, score, target, status, progress, liveIndex };

  document.getElementById('indexModalTitle').textContent = detail.name;
  document.getElementById('indexModalCategory').textContent = liveIndex?.category || detail.category || 'Composite Index';

  document.getElementById('indexSummaryRow').innerHTML = renderSummaryRow(score, target, progress, status);

  // Default tab
  switchIndexTab('components');

  const modal = document.getElementById('indexDetailModal');
  const panel = modal.querySelector('.index-modal-panel');
  panel.classList.remove('glass-normal', 'glass-advisory', 'glass-warning', 'glass-high-alert', 'glass-critical-alert');
  panel.classList.add(`glass-${statusToClass(status)}`);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeIndexDetail() {
  const modal = document.getElementById('indexDetailModal');
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  currentIndexDetail = null;
}

function statusFromScore(s) {
  if (!Number.isFinite(Number(s))) return 'Data unavailable';
  if (s >= 81) return 'Perfect';
  if (s >= 61) return 'Well managed';
  if (s >= 41) return 'Needs improvement';
  if (s >= 21) return 'Poor';
  return 'Harmful';
}

function renderDashboardUnavailable(requested) {
  const grid = document.getElementById('indicesGrid');
  if (grid) grid.innerHTML = urbanIndices.map(index => {
    const detail = (window.INDEX_DETAILS || {})[index.key];
    const components = detail?.components?.map(component => component.name).join(', ') || 'Component definitions pending';
    return `<article class="index-card index-card--framework" tabindex="0" aria-label="${index.name} framework">
      <div class="index-card-topline"><span class="index-status-badge advisory">Framework</span><span class="index-key">${index.key}</span></div>
      <h3>${index.name}</h3><p class="index-framework-description">${index.description}</p>
      <div class="index-framework-meta"><span>Components</span><p>${components}</p></div>
      <div class="index-card-cta">Values, confidence and actions appear after analysis</div>
    </article>`;
  }).join('');
  ['overallScore', 'hwiScore'].forEach(id => { const element = document.getElementById(id); if (element) element.textContent = '—'; });
  ['scoreStatus', 'hwiStatus'].forEach(id => { const element = document.getElementById(id); if (element) element.textContent = requested ? 'Awaiting model report' : 'Data unavailable'; });
}

function renderDashboardFromAnalysis(report) {
  const indices = Object.entries(report.indices || {}).reduce((result, [key, value]) => {
    const definition = urbanIndices.find(index => index.key === key) || {};
    if (!Number.isFinite(Number(value?.score))) return result;
    result[key] = { ...definition, ...value, key, score: Number(value.score), status: value.status || statusFromScore(Number(value.score)) };
    return result;
  }, {});
  if (!Object.keys(indices).length) return renderDashboardUnavailable(false);
  const hwiScore = Number(report.hwi?.score);
  appState.healthData = { indices, overall_score: Number.isFinite(hwiScore) ? hwiScore : null, location: report.location, timestamp: report.time?.analyzed_at, data_quality: report.data_quality, hwi: Number.isFinite(hwiScore) ? report.hwi : null };
  setBackendHistory(report.history?.indices);
  selectedTrendKeys = null;
  renderDashboard(appState.healthData);
}

function statusIcon(s) {
  if (s >= 81) return '🟢';
  if (s >= 61) return '🟡';
  if (s >= 41) return '🟠';
  if (s >= 21) return '🔴';
  return '🛑';
}

function statusToClass(s) {
  return ({
    'Normal':         'normal',
    'Advisory':       'advisory',
    'Warning':        'warning',
    'High alert':     'high-alert',
    'Critical alert': 'critical-alert',
    'Perfect':        'normal',
    'Well managed':   'advisory',
    'Needs improvement': 'warning',
    'Poor':           'high-alert',
    'Harmful':        'critical-alert',
  })[s] || 'warning';
}

function renderSummaryRow(score, target, progress, status) {
  const sClass = statusToClass(status);
  return `
    <div class="summary-tile">
      <div class="summary-label">Current Score</div>
      <div class="summary-value ${sClass}">${score}</div>
      <div class="summary-foot">out of 100</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Target Score</div>
      <div class="summary-value">${target}</div>
      <div class="summary-foot">benchmark</div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Progress</div>
      <div class="summary-value">${progress}%</div>
      <div class="progress-bar"><span style="width:${Math.min(100, progress)}%"></span></div>
    </div>
    <div class="summary-tile">
      <div class="summary-label">Status</div>
      <div class="summary-pill ${sClass}">${status}</div>
      <div class="summary-foot">${score >= target ? 'On / above target' : 'Below target'}</div>
    </div>
  `;
}

function switchIndexTab(tabId) {
  document.querySelectorAll('.index-tab').forEach(btn => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const container = document.getElementById('indexTabContent');
  if (!currentIndexDetail) return;
  const d = currentIndexDetail.detail;

  if (tabId === 'components')      container.innerHTML = renderComponentsTab(d);
  else if (tabId === 'dataSources') container.innerHTML = renderDataSourcesTab(d);
  else if (tabId === 'technology')  container.innerHTML = renderTechnologyTab(d);
  else if (tabId === 'formula')     container.innerHTML = renderFormulaTab(d);
  else if (tabId === 'outlook')     container.innerHTML = renderBackendOutlook();
}

function componentCondition(score) {
  if (!Number.isFinite(Number(score))) return 'Data unavailable';
  if (score >= 81) return 'Perfect and standard for livelihood and biodiversity';
  if (score >= 61) return 'Good for daily life but can be better';
  if (score >= 41) return 'Needs improvement as soon as possible';
  if (score >= 21) return 'Very poor for human wellbeing';
  return 'Extremely hazardous and can cause loss for biodiversity';
}

function directionAwareComponentScore(component) {
  // Scores are model-owned; frontend only formats an already validated result.
  return Number.isFinite(Number(component.score)) ? Number(component.score) : null;
}

function renderComponentsTab(d) {
  const components = currentIndexDetail?.liveIndex?.components?.length ? currentIndexDetail.liveIndex.components : [];
  if (!components.length) return '<h3 class="tab-heading">Component Breakdown</h3><p class="tab-sub">Component data unavailable. Scores and values are shown only when returned by the model.</p>';
  const rows = components.map(c => {
    const score = directionAwareComponentScore(c);
    const condition = componentCondition(score);
    return `
    <tr>
      <td class="col-name">${c.name}</td>
      <td>${c.weight}%</td>
      <td>${c.direction || 'Mixed'}</td>
      <td><strong class="${statusToClass(statusFromScore(score))}">${score ?? 'Data unavailable'}</strong></td>
      <td><span class="component-condition ${statusToClass(statusFromScore(score))}">${condition}</span></td>
      <td>${c.unit}</td>
      <td>${c.calculation || 'Source-specific normalization'}</td>
      <td>
        <div class="mini-bar ${statusToClass(statusFromScore(score))}"><span style="width:${Number.isFinite(score) ? score : 0}%"></span></div>
      </td>
    </tr>`;
  }).join('');
  return `
    <h3 class="tab-heading">Component Breakdown</h3>
    <p class="tab-sub">Model-returned component scores use source-specific methodology. The frontend does not normalize environmental observations.</p>
    <div class="component-legend"><span class="normal">Perfect: 81-100</span><span class="advisory">Good for daily life but can be better: 61-80</span><span class="warning">Needs improvement as soon as possible: 41-60</span><span class="high-alert">Very poor for human wellbeing: 21-40</span><span class="critical-alert">Extremely hazardous and can cause loss for biodiversity: 0-20</span></div>
    <div class="detail-table-wrap">
      <table class="detail-table">
        <thead>
          <tr><th>Component</th><th>Weight</th><th>Direction</th><th>Score</th><th>Condition</th><th>Unit</th><th>Calculation</th><th>Contribution</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderBackendOutlook() {
  const report = window.CortexAnalysis?.snapshot?.().analysis;
  const forecasts = report?.forecasts;
  if (!forecasts || !Object.keys(forecasts).length) return '<h3 class="tab-heading">Forecast</h3><p class="tab-sub">Forecast unavailable. This frontend does not extrapolate environmental trends.</p>';
  return `<h3 class="tab-heading">Model Forecast</h3><pre class="model-forecast-data">${escapeDashboardText(JSON.stringify(forecasts, null, 2))}</pre>`;
}

function escapeDashboardText(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function outlookLocation() {
  const location = appState?.currentLocation || {};
  const name = location.name || 'the selected area';
  const lat = Number(location.lat), lng = Number(location.lng);
  const coordinates = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : 'selected coordinate';
  return { name, coordinates, lat };
}

function localTreeGuidance(lat) {
  if (Math.abs(lat) < 24) return 'a locally native shade tree such as Ficus racemosa, where it is approved by the local urban-forest authority';
  if (Math.abs(lat) < 38) return 'a locally native drought-tolerant canopy tree such as Azadirachta indica, where it is native and approved';
  return 'a locally native canopy tree from the municipality\'s approved planting list, such as Acer campestre in suitable temperate settings';
}

function componentImpact(component) {
  const name = component.name;
  if (/PM|NO2|O3|SO2|^CO$|AEROSOL/.test(name)) return { environment: 'air quality and urban vegetation', people: 'respiratory and cardiovascular health, especially for children, older people and outdoor workers', biodiversity: 'pollinator activity and plant growth near roads and emission sources', driver: 'traffic, generators, open burning and other combustion sources' };
  if (/LST|AIR_TEMP|REL_HUMIDITY|BUILTUP|IMPERVIOUS/.test(name)) return { environment: 'urban heat and surface-water balance', people: 'heat stress, dehydration and pressure on health services', biodiversity: 'tree health, urban habitat quality and water availability', driver: 'unshaded hard surfaces, limited cooling and heat exposure' };
  if (/NDVI|GREEN_SPACE|GREEN_ACCESS/.test(name)) return { environment: 'canopy cover, habitat connection and local cooling', people: 'access to shade, recreation and mental restoration', biodiversity: 'native plants, birds and pollinators', driver: 'fragmented green space and limited everyday access to nature' };
  if (/RAIN|FLOOD|DROUGHT|SOIL|WATER|PRECIPITATION/.test(name)) return { environment: 'water security and catchment health', people: 'safe water access, flooding and service disruption', biodiversity: 'wetland function, soil organisms and freshwater habitat', driver: 'runoff, extremes and weak water retention' };
  if (/TRANSPORT|ROAD/.test(name)) return { environment: 'transport emissions and land take', people: 'safe access to jobs, care and daily services', biodiversity: 'roadside habitat fragmentation and noise exposure', driver: 'gaps in safe, low-emission travel options' };
  if (/HOSPITAL|CRIT_INFRA|DISASTER/.test(name)) return { environment: 'service resilience during environmental stress', people: 'timely care and emergency protection', biodiversity: 'the ability to protect sensitive ecosystems during disruption', driver: 'coverage gaps and uneven preparedness' };
  return { environment: 'local environmental performance', people: 'daily wellbeing and access to essential services', biodiversity: 'the quality and resilience of local habitat', driver: 'uneven spatial conditions and service access' };
}

function componentSuggestion(component, location) {
  const impact = componentImpact(component);
  const tree = localTreeGuidance(location.lat || 0);
  const name = component.name;
  if (/PM|NO2|O3|SO2|^CO$|AEROSOL/.test(name)) return `At ${location.name} (${location.coordinates}), reduce ${impact.driver} first: enforce no-idling around schools and clinics, improve cleaner travel and stop open burning. Add a shaded buffer of ${tree} along suitable streets only after confirming utilities and local species suitability. Source control delivers the largest health gain; trees add lower-cost cooling, habitat and exposure-reduction co-benefits but do not replace emission controls.`;
  if (/LST|AIR_TEMP|REL_HUMIDITY|BUILTUP|IMPERVIOUS/.test(name)) return `At ${location.name} (${location.coordinates}), target the hottest paved routes with shade, permeable surfaces and ${tree}. Begin with public facilities, walking routes and areas used by heat-sensitive residents. Combining tree establishment with planned road or drainage maintenance reduces capital cost, while cooling people, supporting habitat and lowering heat-related service demand.`;
  if (/NDVI|GREEN_SPACE|GREEN_ACCESS/.test(name)) return `At ${location.name} (${location.coordinates}), protect existing canopy first, then connect small parks, school grounds and street verges with ${tree}. Prioritise native species and continuous habitat rather than isolated ornamental planting. Reusing public land and linking works to scheduled maintenance can reduce cost while improving shade, wellbeing, pollinator habitat and stormwater retention.`;
  if (/RAIN|FLOOD|DROUGHT|SOIL|WATER|PRECIPITATION/.test(name)) return `At ${location.name} (${location.coordinates}), inspect the local drainage and water path before building new assets. Use rain gardens, planted swales and maintained drainage at the highest-risk points, with native wetland planting where appropriate. These measures can defer expensive pipe expansion, reduce flood disruption for residents and create habitat while improving water retention.`;
  if (/TRANSPORT|ROAD/.test(name)) return `At ${location.name} (${location.coordinates}), audit the most-used walking and transit routes with residents, then fix crossings, shade and last-mile access before major road expansion. Pairing safer walking, cycling and public transport with roadside native planting reduces crash, health and fuel costs while limiting emissions and habitat fragmentation.`;
  return `At ${location.name} (${location.coordinates}), verify the weakest service gap with residents and providers, then target the existing asset that can close it fastest. Coordinating upgrades with routine maintenance reduces cost, protects human wellbeing during environmental stress and avoids avoidable pressure on nearby habitat.`;
}

function renderDataSourcesTab(d) {
  const cards = d.dataSources.map(s => `
    <article class="source-card">
      <header>
        <h4>Satellite / Dataset: ${s.satellite}</h4>
        <span class="source-agency">${s.agency}</span>
      </header>
      <div class="source-grid">
        <div><span class="k">Components</span><span class="v">${s.parameters.join(', ')}</span></div>
        <div><span class="k">Resolution</span><span class="v">${s.resolution}</span></div>
        <div><span class="k">Frequency</span><span class="v">${s.frequency}</span></div>
        <div><span class="k">Parameters</span><span class="v">${s.paramCount}</span></div>
        <div><span class="k">Status</span><span class="v">${s.status || 'Mixed'}</span></div>
      </div>
      <div class="source-params">
        ${s.parameters.map(p => `<span class="param-chip">${p}</span>`).join('')}
      </div>
    </article>`).join('');
  return `
    <h3 class="tab-heading">Data Sources</h3>
    <p class="tab-sub">Source missions and datasets aligned to the workbook, including whether each signal is direct, derived, modeled, or GIS-based.</p>
    <div class="source-grid-wrap">${cards}</div>`;
}

function renderTechnologyTab(d) {
  const t = d.technology;
  return `
    <h3 class="tab-heading">Technology Stack</h3>
    <p class="tab-sub">Algorithms, processing pipelines and AI models powering the computation.</p>
    <div class="tech-grid">
      <div class="tech-card">
        <div class="tech-icon">⚙️</div>
        <h4>Algorithm</h4>
        <p>${t.algorithm}</p>
      </div>
      <div class="tech-card">
        <div class="tech-icon">🔄</div>
        <h4>Processing Method</h4>
        <p>${t.processing}</p>
      </div>
      <div class="tech-card">
        <div class="tech-icon">🧬</div>
        <h4>Data Fusion</h4>
        <p>${t.fusion}</p>
      </div>
      <div class="tech-card">
        <div class="tech-icon">🤖</div>
        <h4>AI Models</h4>
        <ul class="tech-list">${t.aiModels.map(m => `<li>${m}</li>`).join('')}</ul>
      </div>
    </div>`;
}

function renderFormulaTab(d) {
  const f = d.formula;
  const vars = f.variables.map(v => `
    <li><code>${v.symbol}</code> <span>${v.meaning}</span></li>`).join('');
  const wRows = f.weights.map(w => `
    <tr><td>${w.name}</td><td>${(w.w * 100).toFixed(0)}%</td>
        <td><div class="mini-bar accent"><span style="width:${w.w * 100}%"></span></div></td></tr>`).join('');
  return `
    <h3 class="tab-heading">Mathematical Formula</h3>
    <p class="tab-sub">Exact computation, variables, weights and normalisation methodology.</p>

    <div class="formula-box">
      <div class="formula-label">Expression</div>
      <code class="formula-expr">${f.expression}</code>
    </div>

    <h4 class="sub-heading">Variable Definitions</h4>
    <ul class="variable-list">${vars}</ul>

    <h4 class="sub-heading">Component Weights</h4>
    <div class="detail-table-wrap">
      <table class="detail-table">
        <thead><tr><th>Component</th><th>Weight</th><th>Distribution</th></tr></thead>
        <tbody>${wRows}</tbody>
      </table>
    </div>

    <h4 class="sub-heading">Normalization Method</h4>
    <p class="normalization">${f.normalization}</p>`;
}

// Modal event wiring (runs once)
(function wireIndexModal() {
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-modal]')) closeIndexDetail();
    if (e.target.matches('.index-tab'))         switchIndexTab(e.target.dataset.tab);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeIndexDetail();
  });
})();

function renderCharts(indices) {
  renderRadarChart(indices);
  renderLineChart(indices);
}

// Cache the current radar mode across re-renders
let radarMode = 'both'; // 'both' | 'current' | 'gap'

function statusColor(score) {
  if (score >= 81) return '#22c55e';
  if (score >= 61) return '#eab308';
  if (score >= 41) return '#f97316';
  if (score >= 21) return '#ef4444';
  return '#991b1b';
}

function renderRadarChart(indices) {
  const ctx = document.getElementById('radarChart');
  if (!ctx) return;
  if (dashboardCharts.radar) dashboardCharts.radar.destroy();

  const arr = Object.values(indices);
  const labels = arr.map(i => i.key);
  const scores = arr.map(i => i.score);
  const targets = arr.map(i => i.target);
  const gaps = arr.map(i => Math.max(0, i.target - i.score));

  // Build a radial gradient inside the chart area
  const canvasCtx = ctx.getContext('2d');
  const grad = canvasCtx.createRadialGradient(
    ctx.width / 2, ctx.height / 2, 10,
    ctx.width / 2, ctx.height / 2, Math.min(ctx.width, ctx.height) / 2
  );
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.55)');
  grad.addColorStop(1, 'rgba(168, 85, 247, 0.05)');

  const targetGrad = canvasCtx.createRadialGradient(
    ctx.width / 2, ctx.height / 2, 10,
    ctx.width / 2, ctx.height / 2, Math.min(ctx.width, ctx.height) / 2
  );
  targetGrad.addColorStop(0, 'rgba(34, 197, 94, 0.35)');
  targetGrad.addColorStop(1, 'rgba(34, 197, 94, 0.02)');

  const datasets = [];
  if (radarMode === 'both' || radarMode === 'current') {
    datasets.push({
      label: 'Current Score',
      data: scores,
      backgroundColor: grad,
      borderColor: '#38bdf8',
      borderWidth: 2.5,
      pointBackgroundColor: scores.map(s => statusColor(s)),
      pointBorderColor: '#04060f',
      pointBorderWidth: 2,
      pointRadius: 5,
      pointHoverRadius: 8,
      pointHoverBorderWidth: 3,
    });
  }
  if (radarMode === 'both') {
    datasets.push({
      label: 'Target',
      data: targets,
      backgroundColor: targetGrad,
      borderColor: 'rgba(34, 197, 94, 0.9)',
      borderWidth: 2,
      borderDash: [6, 6],
      pointBackgroundColor: 'rgba(34, 197, 94, 1)',
      pointBorderColor: '#04060f',
      pointBorderWidth: 1,
      pointRadius: 3,
    });
  }
  if (radarMode === 'gap') {
    datasets.push({
      label: 'Gap to Target',
      data: gaps,
      backgroundColor: 'rgba(248, 113, 113, 0.25)',
      borderColor: '#f87171',
      borderWidth: 2.5,
      pointBackgroundColor: '#f87171',
      pointBorderColor: '#04060f',
      pointBorderWidth: 2,
      pointRadius: 5,
      pointHoverRadius: 8,
    });
  }

  dashboardCharts.radar = new Chart(ctx, {
    type: 'radar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'nearest', intersect: true },
      onClick: (evt, items) => {
        if (items.length) {
          const i = items[0].index;
          openIndexDetail(arr[i].key, arr[i]);
        }
      },
      onHover: (evt, items) => {
        if (evt?.native?.target) {
          evt.native.target.style.cursor = items.length ? 'pointer' : 'default';
        }
      },
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          ticks: {
            color: '#9ca3af',
            backdropColor: 'transparent',
            stepSize: 20,
            font: { size: 10 },
          },
          grid: { color: 'rgba(148, 163, 184, 0.15)', lineWidth: 1 },
          angleLines: { color: 'rgba(148, 163, 184, 0.18)' },
          pointLabels: {
            color: '#e5e7eb',
            font: { size: 12, weight: '600', family: 'Inter, system-ui' },
          },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#e5e7eb',
            usePointStyle: true,
            padding: 16,
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(5,8,22,0.95)',
          borderColor: 'rgba(56,189,248,0.4)',
          borderWidth: 1,
          padding: 12,
          titleFont: { size: 13, weight: '700' },
          callbacks: {
            title: (ctxs) => {
              const i = ctxs[0].dataIndex;
              return `${arr[i].key} — ${arr[i].name}`;
            },
            label: (c) => {
              const i = c.dataIndex;
              if (radarMode === 'gap') {
                return `Gap: ${gaps[i]} pts (current ${scores[i]} → target ${targets[i]})`;
              }
              return `${c.dataset.label}: ${c.parsed.r}`;
            },
            afterBody: () => '\nClick to open index details',
          },
        },
      },
    },
  });

  renderRadarKpis(arr);
  wireRadarModeButtons(indices);
}

function renderRadarKpis(arr) {
  const wrap = document.getElementById('radarKpis');
  if (!wrap) return;
  const avg = Math.round(arr.reduce((a, b) => a + b.score, 0) / arr.length);
  const top = arr.reduce((a, b) => (b.score > a.score ? b : a));
  const weak = arr.reduce((a, b) => (b.score < a.score ? b : a));
  const onTarget = arr.filter(i => i.score >= i.target).length;
  wrap.innerHTML = `
    <div class="kpi"><span class="kpi-k">Avg Score</span><span class="kpi-v" style="color:${statusColor(avg)}">${avg}</span></div>
    <div class="kpi"><span class="kpi-k">Top</span><span class="kpi-v" style="color:#4ade80">${top.key} · ${top.score}</span></div>
    <div class="kpi"><span class="kpi-k">Weakest</span><span class="kpi-v" style="color:#f87171">${weak.key} · ${weak.score}</span></div>
    <div class="kpi"><span class="kpi-k">On Target</span><span class="kpi-v">${onTarget}/${arr.length}</span></div>
  `;
}

function wireRadarModeButtons(indices) {
  document.querySelectorAll('[data-radar-mode]').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('[data-radar-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      radarMode = btn.dataset.radarMode;
      renderRadarChart(indices);
    };
  });
}

// ============================================================
// HISTORICAL TRENDS — selectable indices + clickable insights
// ============================================================
const TREND_COLORS = [
  '#38bdf8', '#22c55e', '#fbbf24', '#a78bfa', '#f87171',
  '#34d399', '#f472b6', '#60a5fa', '#facc15',
];

// Persist generated historical series across rerenders / toggles
let historicalSeries = null;       // { [key]: number[] }, returned by the backend
let historicalTimestamps = {};     // { [key]: ISO timestamp[] }
let selectedTrendKeys = null;      // Set<string>
let selectedTrendDays = 15;

function setBackendHistory(history) {
  historicalSeries = {};
  historicalTimestamps = {};
  Object.entries(history || {}).forEach(([key, series]) => {
    const values = Array.isArray(series) ? series : series?.values;
    const timestamps = Array.isArray(series?.timestamps) ? series.timestamps : [];
    if (!Array.isArray(values) || !values.length || (timestamps.length && timestamps.length !== values.length)) return;
    const numeric = values.map(Number);
    if (!numeric.every(Number.isFinite)) return;
    historicalSeries[key] = numeric;
    historicalTimestamps[key] = timestamps.length ? timestamps : numeric.map((_, index) => String(index));
  });
}

function filteredTrendSeries(key) {
  const values = historicalSeries?.[key] || [];
  const timestamps = historicalTimestamps?.[key] || [];
  if (!timestamps.length || !timestamps.every(item => Number.isFinite(Date.parse(item)))) return { values, timestamps };
  const latest = Math.max(...timestamps.map(item => Date.parse(item)));
  const cutoff = latest - selectedTrendDays * 86400000;
  const selected = values.map((value, index) => ({ value, timestamp: timestamps[index] })).filter(item => Date.parse(item.timestamp) >= cutoff);
  return { values: selected.map(item => item.value), timestamps: selected.map(item => item.timestamp) };
}

function ensureHistoricalSeries(indices) {
  // Historical series must arrive in the canonical model response. The frontend
  // deliberately does not synthesize a history when evidence is unavailable.
  if (!historicalSeries) historicalSeries = {};
}

function renderLineChart(indices) {
  const ctx = document.getElementById('lineChart');
  if (!ctx) return;

  ensureHistoricalSeries(indices);
  if (!Object.values(indices).some(index => Array.isArray(historicalSeries[index.key]) && historicalSeries[index.key].length)) {
    const wrap = document.getElementById('trendKpis');
    if (wrap) wrap.innerHTML = '<div class="analysis-empty-state"><span>Historical evidence</span><h3>Data unavailable</h3><p>The model has not returned validated historical series for this analysis.</p></div>';
    return;
  }

  // Default selection on first render: first 3
  if (!selectedTrendKeys) {
    selectedTrendKeys = new Set(Object.keys(indices).slice(0, 3));
  }
  document.querySelectorAll('[data-trend-days]').forEach(button => {
    button.onclick = () => { selectedTrendDays = Number(button.dataset.trendDays); document.querySelectorAll('[data-trend-days]').forEach(item => item.classList.toggle('active', item === button)); drawTrendChart(ctx, indices); };
  });

  renderTrendSelector(indices);
  drawTrendChart(ctx, indices);
}

function renderTrendSelector(indices) {
  const wrap = document.getElementById('trendIndexSelector');
  if (!wrap) return;
  wrap.innerHTML = Object.values(indices).map((idx, i) => {
    const color = TREND_COLORS[i % TREND_COLORS.length];
    const active = selectedTrendKeys.has(idx.key);
    return `
      <button class="trend-chip ${active ? 'active' : ''}"
              data-trend-key="${idx.key}"
              style="--chip:${color}"
              title="${idx.name}">
        <span class="chip-dot" style="background:${color}"></span>
        ${idx.key}
      </button>`;
  }).join('');

  wrap.querySelectorAll('.trend-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.trendKey;
      if (selectedTrendKeys.has(key)) {
        if (selectedTrendKeys.size <= 1) return; // keep at least one
        selectedTrendKeys.delete(key);
      } else {
        selectedTrendKeys.add(key);
      }
      btn.classList.toggle('active');
      drawTrendChart(document.getElementById('lineChart'), indices);
    });
  });
}

function drawTrendChart(ctx, indices) {
  if (dashboardCharts.line) dashboardCharts.line.destroy();

  const canvasCtx = ctx.getContext('2d');
  const keys = Array.from(selectedTrendKeys);
  const single = keys.length === 1;

  const datasets = keys.map((key) => {
    const color = TREND_COLORS[Object.keys(indices).indexOf(key) % TREND_COLORS.length];
    // Vertical gradient fill (stronger when only one line is selected)
    const grad = canvasCtx.createLinearGradient(0, 0, 0, ctx.height || 320);
    grad.addColorStop(0, color + (single ? 'aa' : '55'));
    grad.addColorStop(1, color + '00');
    return {
      label: key,
      data: filteredTrendSeries(key).values,
      borderColor: color,
      backgroundColor: grad,
      borderWidth: single ? 3 : 2.5,
      tension: 0.4,
      pointRadius: single ? 4 : 3,
      pointHoverRadius: 8,
      pointBackgroundColor: color,
      pointBorderColor: '#04060f',
      pointBorderWidth: 2,
      fill: single, // area fill only when one line, otherwise too noisy
    };
  });

  // Reference line at the average of last 12 months of selected indices
  const allVals = keys.flatMap(k => filteredTrendSeries(k).values);
  const refAvg = Math.round(allVals.reduce((a, b) => a + b, 0) / allVals.length);

  dashboardCharts.line = new Chart(ctx, {
    type: 'line',
    data: { labels: filteredTrendSeries(keys[0]).timestamps.map(timestamp => Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : timestamp), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'nearest', intersect: false },
      onClick: (evt, items) => {
        if (items.length) {
          const ds = datasets[items[0].datasetIndex];
          openTrendInsights(indices, ds.label);
        } else {
          openTrendInsights(indices, null);
        }
      },
      onHover: (evt, items) => {
        if (evt?.native?.target) {
          evt.native.target.style.cursor = items.length ? 'pointer' : 'default';
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          suggestedMin: 40,
          suggestedMax: 100,
          ticks: { color: '#9ca3af', stepSize: 10 },
          grid: { color: 'rgba(148, 163, 184, 0.10)' },
          border: { color: 'rgba(148, 163, 184, 0.2)' },
        },
        x: {
          ticks: { color: '#9ca3af', font: { size: 11, weight: '600' } },
          grid: { display: false },
          border: { color: 'rgba(148, 163, 184, 0.2)' },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#e5e7eb',
            usePointStyle: true,
            padding: 14,
            font: { size: 12 },
          },
          onClick: (e, item, legend) => {
            const ds = legend.chart.data.datasets[item.datasetIndex];
            openTrendInsights(indices, ds.label);
          },
        },
        tooltip: {
          backgroundColor: 'rgba(5,8,22,0.95)',
          borderColor: 'rgba(56,189,248,0.4)',
          borderWidth: 1,
          padding: 12,
          titleFont: { size: 13, weight: '700' },
          titleColor: '#7dd3fc',
          callbacks: {
            label: (c) => {
              const name = indices[c.dataset.label]?.name || c.dataset.label;
              return `  ${c.dataset.label} (${name}): ${c.parsed.y}`;
            },
            afterBody: () => '\nClick to open detailed insights',
          },
        },
      },
    },
    plugins: [{
      id: 'avgReferenceLine',
      afterDraw(chart) {
        const { ctx: c, chartArea: ca, scales: { y } } = chart;
        if (!ca) return;
        const yPos = y.getPixelForValue(refAvg);
        c.save();
        c.strokeStyle = 'rgba(168, 85, 247, 0.5)';
        c.setLineDash([4, 4]);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(ca.left, yPos);
        c.lineTo(ca.right, yPos);
        c.stroke();
        c.fillStyle = 'rgba(168, 85, 247, 0.85)';
        c.font = '600 10px Inter, system-ui';
        c.fillText(`avg ${refAvg}`, ca.right - 50, yPos - 4);
        c.restore();
      },
    }],
  });

  renderTrendKpis(indices, keys);
}

function renderTrendKpis(indices, keys) {
  const wrap = document.getElementById('trendKpis');
  if (!wrap) return;
  // Compute best/worst trend over last 6 months
  const stats = keys.map((k) => {
    const s = historicalSeries[k];
    const first = s[s.length - 6];
    const last = s[s.length - 1];
    return { key: k, delta: last - first, current: last };
  });
  const rising = stats.reduce((a, b) => (b.delta > a.delta ? b : a));
  const falling = stats.reduce((a, b) => (b.delta < a.delta ? b : a));
  const allAvg = Math.round(
    keys.reduce((acc, k) => acc + historicalSeries[k].reduce((a, b) => a + b, 0), 0)
    / (keys.length * 12)
  );
  wrap.innerHTML = `
    <div class="kpi"><span class="kpi-k">Tracking</span><span class="kpi-v">${keys.length} ${keys.length === 1 ? 'index' : 'indices'}</span></div>
    <div class="kpi"><span class="kpi-k">12-mo Avg</span><span class="kpi-v" style="color:${statusColor(allAvg)}">${allAvg}</span></div>
    <div class="kpi"><span class="kpi-k">Best Trend</span><span class="kpi-v" style="color:#4ade80">${rising.key} ${rising.delta >= 0 ? '↗ +' : '↘ '}${rising.delta}</span></div>
    <div class="kpi"><span class="kpi-k">Weakest Trend</span><span class="kpi-v" style="color:#f87171">${falling.key} ${falling.delta >= 0 ? '↗ +' : '↘ '}${falling.delta}</span></div>
  `;
}

// ---- Trend Insights Modal ----
function openTrendInsights(indices, focusKey) {
  const keys = focusKey ? [focusKey] : Array.from(selectedTrendKeys);
  const title = focusKey
    ? `${focusKey} — ${indices[focusKey]?.name || ''}`
    : `Comparing ${keys.length} indices`;

  document.getElementById('trendInsightsTitle').textContent = title;
  document.getElementById('trendInsightsBody').innerHTML = renderTrendInsightsBody(indices, keys);

  const modal = document.getElementById('trendInsightsModal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeTrendInsights() {
  document.getElementById('trendInsightsModal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderTrendInsightsBody(indices, keys) {
  // ----- summary tiles per index
  const summaryCards = keys.map((key) => {
    const series = historicalSeries[key] || [];
    const idx = indices[key];
    const stats = computeSeriesStats(series);
    const sClass = statusToClass(statusFromScore(idx.score));
    const trendArrow = stats.deltaPct > 1 ? '↗' : stats.deltaPct < -1 ? '↘' : '→';
    const trendClass = stats.deltaPct > 1 ? 'normal' : stats.deltaPct < -1 ? 'high-alert' : 'advisory';
    return `
      <article class="trend-card">
        <header>
          <h4>${idx.name} <span class="trend-key">${key}</span></h4>
          <span class="summary-pill ${sClass}">${statusFromScore(idx.score)}</span>
        </header>
        <div class="trend-stats">
          <div><span class="k">Current</span><span class="v ${sClass}">${idx.score}</span></div>
          <div><span class="k">Average</span><span class="v">${stats.avg}</span></div>
          <div><span class="k">Min / Max</span><span class="v">${stats.min} / ${stats.max}</span></div>
          <div><span class="k">Volatility (σ)</span><span class="v">${stats.std}</span></div>
          <div><span class="k">6-mo Δ</span><span class="v ${trendClass}">${trendArrow} ${stats.deltaPct >= 0 ? '+' : ''}${stats.deltaPct}%</span></div>
          <div><span class="k">Trend Slope</span><span class="v ${trendClass}">${stats.slope >= 0 ? '+' : ''}${stats.slope}/mo</span></div>
        </div>

        <h5 class="sub-heading">AI Insights</h5>
        <ul class="insight-list">
          ${buildInsightBullets(idx, stats).map(b => `<li>${b}</li>`).join('')}
        </ul>

        <h5 class="sub-heading">Monthly Breakdown</h5>
        <div class="detail-table-wrap">
          <table class="detail-table compact">
            <thead><tr><th>Month</th>${TREND_MONTHS.map(m => `<th>${m}</th>`).join('')}</tr></thead>
            <tbody>
              <tr>
                <td>Score</td>
                ${series.map(v => `<td class="${statusToClass(statusFromScore(v))}"><strong>${v}</strong></td>`).join('')}
              </tr>
            </tbody>
          </table>
        </div>
      </article>`;
  }).join('');

  // ----- comparison block (only when multiple)
  let comparison = '';
  if (keys.length > 1) {
    const ranked = keys
      .map(k => ({ key: k, score: indices[k].score, delta: computeSeriesStats(historicalSeries[k]).deltaPct }))
      .sort((a, b) => b.score - a.score);
    comparison = `
      <h3 class="tab-heading" style="margin-top:24px">Comparison</h3>
      <div class="detail-table-wrap">
        <table class="detail-table">
          <thead><tr><th>Rank</th><th>Index</th><th>Current</th><th>6-mo Δ</th></tr></thead>
          <tbody>
            ${ranked.map((r, i) => `
              <tr>
                <td>#${i + 1}</td>
                <td><strong>${r.key}</strong> — ${indices[r.key].name}</td>
                <td class="${statusToClass(statusFromScore(r.score))}"><strong>${r.score}</strong></td>
                <td class="${r.delta >= 0 ? 'normal' : 'high-alert'}">${r.delta >= 0 ? '+' : ''}${r.delta}%</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  return `${summaryCards}${comparison}`;
}

function computeSeriesStats(series) {
  const n = series.length;
  const avg = series.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const variance = series.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  // linear regression slope (least squares)
  const xs = series.map((_, i) => i);
  const xMean = (n - 1) / 2;
  const yMean = avg;
  const num = xs.reduce((a, x, i) => a + (x - xMean) * (series[i] - yMean), 0);
  const den = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);
  const slope = den ? num / den : 0;
  const first = series[0], last = series[n - 1];
  const deltaPct = first ? ((last - first) / first) * 100 : 0;
  return {
    avg: avg.toFixed(1),
    min, max,
    std: std.toFixed(1),
    slope: slope.toFixed(2),
    deltaPct: deltaPct.toFixed(1),
  };
}

function buildInsightBullets(idx, stats) {
  const bullets = [];
  const slopeNum = parseFloat(stats.slope);
  const dPct = parseFloat(stats.deltaPct);
  const stdNum = parseFloat(stats.std);

  bullets.push(slopeNum > 0.5
    ? `Steady improvement detected — trend slope of <strong>+${stats.slope}/month</strong> over the period.`
    : slopeNum < -0.5
      ? `Declining trajectory — losing about <strong>${Math.abs(slopeNum).toFixed(2)} points/month</strong>; attention recommended.`
      : `Performance is broadly stable (slope ≈ 0); minor fluctuations only.`);

  bullets.push(stdNum < 3
    ? `Low volatility (σ = ${stats.std}) suggests reliable, well-managed conditions.`
    : stdNum < 6
      ? `Moderate volatility (σ = ${stats.std}); some external drivers are influencing the index.`
      : `High volatility (σ = ${stats.std}); investigate seasonal or event-driven anomalies.`);

  bullets.push(idx.score >= 81
    ? `Currently in the <strong>Normal</strong> band — sustain through ongoing investment in ${idx.category.toLowerCase()}.`
    : idx.score >= 61
      ? `In the <strong>Advisory</strong> band — targeted interventions can restore a Normal score.`
      : idx.score >= 41
        ? `<strong>Warning</strong> — prioritize the lowest-weight components for quickest gains.`
        : idx.score >= 21
          ? `<strong>High alert</strong> — recommend escalation to policy review and a dedicated task force.`
          : `<strong>Critical alert</strong> — initiate immediate response and executive oversight.`);

  bullets.push(dPct >= 3
    ? `Net 6-month change of <strong>+${stats.deltaPct}%</strong> indicates current strategies are working.`
    : dPct <= -3
      ? `Net 6-month change of <strong>${stats.deltaPct}%</strong> — recent corrective actions have not yet reversed the trend.`
      : `Net 6-month change of <strong>${stats.deltaPct}%</strong> — broadly flat; consider revisiting targets.`);

  return bullets;
}

// Wire trend insights modal events + opener button
(function wireTrendInsights() {
  document.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-trends]')) closeTrendInsights();
    if (e.target.matches('#trendInsightsBtn')) {
      const data = appState.healthData;
      if (data) openTrendInsights(data.indices, null);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTrendInsights();
  });
})();

function updateLoadingState(isLoading) {
  const scoreEl = document.getElementById('overallScore');
  const statusEl = document.getElementById('scoreStatus');
  
  if (isLoading) {
    if (scoreEl) scoreEl.innerHTML = '<div class="loading"></div>';
    if (statusEl) statusEl.textContent = 'Loading data...';
  }
}

// ============================================================
// LOCATION CHANGE — inline panel with geocoding
// ============================================================
// Uses OpenStreetMap Nominatim (free, no API key, same place data
// as Google Maps geocoding). To switch to Google Maps Geocoding,
// replace forwardGeocode() / reverseGeocode() with the Google calls
// using your API key.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

async function forwardGeocode(query) {
  const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  return res.json(); // array of { lat, lon, display_name, address, ... }
}

async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_BASE}/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}&zoom=12`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
  return res.json(); // { display_name, address, ... }
}

function formatPlaceName(addressObj, fallbackDisplay) {
  if (!addressObj) return fallbackDisplay || 'Unknown location';
  const a = addressObj;
  const city    = a.city || a.town || a.village || a.municipality || a.suburb || a.county;
  const region  = a.state || a.region;
  const country = a.country;
  return [city, region, country].filter(Boolean).join(', ') || fallbackDisplay || 'Unknown location';
}

function setLocation(lat, lng, displayName) {
  appState.currentLocation.lat = parseFloat(lat);
  appState.currentLocation.lng = parseFloat(lng);
  appState.currentLocation.name = displayName;

  // Clear any previous model history before requesting the canonical location.
  historicalSeries = null;

  const label = document.getElementById('currentLocation');
  if (label) {
    label.textContent = `${displayName} (${appState.currentLocation.lat.toFixed(4)}°, ${appState.currentLocation.lng.toFixed(4)}°)`;
  }
  window.dispatchEvent(new CustomEvent('cortex:place-selected', {
    detail: { ...appState.currentLocation }
  }));
}

function setLocStatus(msg, type = 'info') {
  const el = document.getElementById('locStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `loc-status ${type}` + (msg ? '' : ' empty');
}

function toggleLocationPanel(forceOpen) {
  const panel = document.getElementById('locationPanel');
  const btn = document.getElementById('changeLocationBtn');
  if (!panel || !btn) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.textContent = open ? 'Close' : 'Change Location';
  if (open) {
    setLocStatus('');
    const inp = document.getElementById('placeSearchInput');
    if (inp) setTimeout(() => inp.focus(), 60);
  }
}

function switchLocTab(tabName) {
  document.querySelectorAll('.loc-tab').forEach(t => {
    const active = t.dataset.locTab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.loc-pane').forEach(p => {
    p.classList.toggle('active', p.dataset.pane === tabName);
  });
  setLocStatus('');
  document.getElementById('placeSuggestions')?.classList.add('hidden');
}

// ---- Place name search ----
async function handlePlaceSearch(query) {
  const q = (query ?? document.getElementById('placeSearchInput').value).trim();
  if (q.length < 2) {
    setLocStatus('Please enter at least 2 characters.', 'warn');
    return;
  }
  setLocStatus('Searching…', 'info');
  try {
    const results = await forwardGeocode(q);
    if (!results.length) {
      setLocStatus('No matching place found. Try a different name.', 'warn');
      document.getElementById('placeSuggestions').classList.add('hidden');
      return;
    }
    if (results.length === 1) {
      applyGeocodeResult(results[0]);
    } else {
      renderSuggestions(results);
      setLocStatus(`Found ${results.length} matches — pick one:`, 'info');
    }
  } catch (err) {
    console.error(err);
    setLocStatus('Search failed. Check your internet connection.', 'error');
  }
}

function applyGeocodeResult(r) {
  const name = formatPlaceName(r.address, r.display_name);
  setLocation(r.lat, r.lon, name);
  setLocStatus(`✔ Location set to ${name}`, 'success');
  document.getElementById('placeSuggestions').classList.add('hidden');
  setTimeout(() => toggleLocationPanel(false), 900);
}

function renderSuggestions(results) {
  const container = document.getElementById('placeSuggestions');
  container.innerHTML = results.map((r, i) => `
    <button class="loc-suggestion" data-i="${i}">
      <span class="s-name">${formatPlaceName(r.address, r.display_name)}</span>
      <span class="s-coords">${parseFloat(r.lat).toFixed(3)}°, ${parseFloat(r.lon).toFixed(3)}°</span>
    </button>`).join('');
  container.classList.remove('hidden');
  container.querySelectorAll('.loc-suggestion').forEach((btn, i) => {
    btn.addEventListener('click', () => applyGeocodeResult(results[i]));
  });
}

// Debounced live suggestions while typing
let placeDebounce = null;
function handlePlaceInput(e) {
  const q = e.target.value.trim();
  clearTimeout(placeDebounce);
  if (q.length < 3) {
    document.getElementById('placeSuggestions').classList.add('hidden');
    return;
  }
  placeDebounce = setTimeout(async () => {
    try {
      const results = await forwardGeocode(q);
      if (results.length) renderSuggestions(results.slice(0, 5));
      else document.getElementById('placeSuggestions').classList.add('hidden');
    } catch (_) { /* silent for live typing */ }
  }, 350);
}

// ---- Coordinates ----
async function handleCoordsApply() {
  const lat = parseFloat(document.getElementById('coordLatInput').value);
  const lng = parseFloat(document.getElementById('coordLngInput').value);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    setLocStatus('Please enter valid numeric latitude and longitude.', 'warn');
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    setLocStatus('Latitude must be -90 to 90 and longitude -180 to 180.', 'warn');
    return;
  }
  setLocStatus('Resolving place name…', 'info');
  try {
    const r = await reverseGeocode(lat, lng);
    const name = formatPlaceName(r.address, r.display_name);
    setLocation(lat, lng, name);
    setLocStatus(`✔ Location set to ${name}`, 'success');
    setTimeout(() => toggleLocationPanel(false), 900);
  } catch (err) {
    console.error(err);
    // Still apply, but with generic name
    setLocation(lat, lng, `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    setLocStatus('Coordinates applied, but reverse geocoding failed.', 'warn');
  }
}

// ---- Wire-up (runs once) ----
(function wireLocationUI() {
  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') bind();

  function bind() {
    const btn = document.getElementById('changeLocationBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => toggleLocationPanel());
    }

    document.querySelectorAll('.loc-tab').forEach(t => {
      if (t.dataset.bound) return;
      t.dataset.bound = '1';
      t.addEventListener('click', () => switchLocTab(t.dataset.locTab));
    });

    const placeBtn  = document.getElementById('placeSearchBtn');
    const placeInp  = document.getElementById('placeSearchInput');
    const latInp    = document.getElementById('coordLatInput');
    const lngInp    = document.getElementById('coordLngInput');
    const applyBtn  = document.getElementById('coordApplyBtn');

    if (placeBtn && !placeBtn.dataset.bound) {
      placeBtn.dataset.bound = '1';
      placeBtn.addEventListener('click', () => handlePlaceSearch());
    }
    if (placeInp && !placeInp.dataset.bound) {
      placeInp.dataset.bound = '1';
      placeInp.addEventListener('input', handlePlaceInput);
      placeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') handlePlaceSearch(); });
    }
    if (applyBtn && !applyBtn.dataset.bound) {
      applyBtn.dataset.bound = '1';
      applyBtn.addEventListener('click', handleCoordsApply);
    }
    [latInp, lngInp].forEach(inp => {
      if (inp && !inp.dataset.bound) {
        inp.dataset.bound = '1';
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleCoordsApply(); });
      }
    });
  }
})();
