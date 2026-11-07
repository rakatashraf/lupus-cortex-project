// ===== DASHBOARD INDEX KNOWLEDGE BASE =====
// The component memberships below follow the supplied nine-index mapping table.

// canonicalId: the registry component id (C01..C30b) this short name maps to.
// trained: true only for the 18 components the model was trained on.
// derived: true for C14 / C16, which are computed from C13 / C15 and are
// never collected as standalone components.
// Mapping notes:
//  - GREEN_SPACE_PCT and GREEN_ACCESS_PCT are two views of C26 (green-space
//    share derived from MCD12Q1, and green-space accessibility).
//  - ELEVATION_SLOPE spans C29a (elevation) and C29b (slope, derived from
//    the DEM); both are static and untrained.
const COMPONENT_META = {
  PM2_5: { canonicalId: 'C01', trained: true, unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, PM10: { canonicalId: 'C02', trained: true, unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  NO2: { canonicalId: 'C03', trained: true, unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, O3: { canonicalId: 'C04', trained: true, unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  SO2: { canonicalId: 'C05', trained: true, unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, CO: { canonicalId: 'C06', trained: true, unit: 'mg/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  AEROSOL_INDEX: { canonicalId: 'C07', trained: true, unit: 'index', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, LST: { canonicalId: 'C08', trained: true, unit: 'deg C anomaly', direction: 'Down', cadence: 'source-specific', modelMode: 'temporal_spatial' },
  AIR_TEMP: { canonicalId: 'C09', trained: true, unit: 'deg C', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' }, REL_HUMIDITY: { canonicalId: 'C10', trained: true, unit: '%', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' },
  BUILTUP_PCT: { canonicalId: 'C13', trained: false, unit: '% area', direction: 'Down', cadence: 'annual_or_static', modelMode: 'spatial' }, IMPERVIOUS_PCT: { canonicalId: 'C14', trained: false, derived: true, derivedFrom: 'C13', unit: '% cover', direction: 'Down', cadence: 'source-specific', modelMode: 'spatial' },
  NDVI: { canonicalId: 'C11', trained: true, unit: '-1 to 1', direction: 'Up', cadence: 'source-specific', modelMode: 'temporal_spatial' }, POP_DENSITY: { canonicalId: 'C21', trained: false, unit: 'people/km2', direction: 'Contextual', cadence: 'annual_or_static', modelMode: 'spatial' },
  VULNERABLE_AGE_PCT: { canonicalId: 'C22', trained: false, unit: '% population', direction: 'Down', cadence: 'annual_or_static', modelMode: 'spatial' }, GREEN_ACCESS_PCT: { canonicalId: 'C26', trained: false, unit: '% within access threshold', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  GREEN_SPACE_PCT: { canonicalId: 'C26', trained: false, unit: '% area', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' }, PRECIPITATION: { canonicalId: 'C15', trained: true, unit: 'mm/day', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' },
  EXTREME_RAINFALL: { canonicalId: 'C16', trained: false, derived: true, derivedFrom: 'C15', unit: 'percentile / return period', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, SOIL_MOISTURE: { canonicalId: 'C17', trained: true, unit: 'm3/m3', direction: 'Optimal', cadence: 'source-specific', modelMode: 'temporal_spatial' },
  SURFACE_WATER_EXTENT: { canonicalId: 'C18', trained: true, unit: '% area or km2', direction: 'Optimal', cadence: 'source-specific', modelMode: 'temporal_spatial' }, FLOOD_EXTENT: { canonicalId: 'C19', trained: true, unit: '% area or km2', direction: 'Down', cadence: 'event_based', modelMode: 'temporal_spatial' },
  DROUGHT_SPI: { canonicalId: 'C20', trained: true, unit: 'standardized anomaly', direction: 'Toward 0', cadence: 'monthly', modelMode: 'temporal_spatial' }, ELEVATION_SLOPE: { canonicalId: 'C29a', trained: false, alsoCovers: 'C29b', unit: 'm / degrees', direction: 'Contextual', cadence: 'static', modelMode: 'spatial' },
  ROAD_DENSITY: { canonicalId: 'C23', trained: false, unit: 'km/km2', direction: 'Contextual', cadence: 'source-specific', modelMode: 'spatial' }, TRANSPORT_ACCESS_PCT: { canonicalId: 'C24', trained: false, unit: '% within access threshold', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  HOSPITAL_ACCESS: { canonicalId: 'C25', trained: false, unit: 'minutes / km', direction: 'Down', cadence: 'source-specific', modelMode: 'spatial' }, CRIT_INFRA_DENSITY: { canonicalId: 'C27', trained: false, unit: 'facilities/km2', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  NIGHT_LIGHTS: { canonicalId: 'C28', trained: true, unit: 'nW/cm2/sr', direction: 'Contextual', cadence: 'monthly', modelMode: 'temporal_spatial' }, DISASTER_READINESS: { canonicalId: 'C30b', trained: false, unit: 'readiness score', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' }
};

// Real data sources used by the collection pipeline. "Unavailable" entries
// mean no validated 2025 study-area data exists for that component — the
// value is never fabricated.
const COMPONENT_SATELLITES = {
  PM2_5: 'OpenAQ ground monitors + MERRA-2 + CAMS reanalysis', PM10: 'OpenAQ ground monitors + MERRA-2 + CAMS reanalysis', NO2: 'OpenAQ + OMI OMNO2d + CAMS',
  O3: 'OpenAQ + MERRA-2 total-column O3 + CAMS', SO2: 'OpenAQ + OMI OMSO2e + CAMS', CO: 'MERRA-2 + CAMS (OpenAQ where available)',
  AEROSOL_INDEX: 'MODIS MCD19A2.061 + CAMS AOD', LST: 'Landsat 8/9 Collection 2 + MODIS LST',
  AIR_TEMP: 'MERRA-2', REL_HUMIDITY: 'MERRA-2',
  NDVI: 'HLS HLSS30_VI / MODIS vegetation', GREEN_SPACE_PCT: 'MODIS MCD12Q1.061 — IGBP classes 1–10, 12, 14 (derived)',
  BUILTUP_PCT: 'MODIS MCD12Q1.061 — IGBP class 13 (derived)', IMPERVIOUS_PCT: 'Derived from C13 built-up % (not collected)',
  PRECIPITATION: 'GPM IMERG Final V07', EXTREME_RAINFALL: 'Derived from C15 precipitation (95th-percentile exceedance)', SOIL_MOISTURE: 'SMAP SPL3SMP / SPL2SMAP_S',
  SURFACE_WATER_EXTENT: 'MODIS MCD12Q1.061 — IGBP class 17 (derived)', FLOOD_EXTENT: 'MODIS/VIIRS flood products (event-based)',
  DROUGHT_SPI: 'Derived from IMERG precipitation (WMO SPI)', ELEVATION_SLOPE: 'SRTM / Copernicus DEM GLO-30 (static); slope derived from DEM',
  POP_DENSITY: 'WorldPop', VULNERABLE_AGE_PCT: 'UN DESA World Population Prospects / WorldPop age structures',
  ROAD_DENSITY: 'OpenStreetMap — no 2025 study-area data (unavailable)', TRANSPORT_ACCESS_PCT: 'OpenStreetMap — no 2025 study-area data (unavailable)',
  HOSPITAL_ACCESS: 'OpenStreetMap — no 2025 study-area data (unavailable)', GREEN_ACCESS_PCT: 'MODIS MCD12Q1.061 — IGBP classes 1–10, 12, 14 (derived)',
  CRIT_INFRA_DENSITY: 'OpenStreetMap — no 2025 study-area data (unavailable)', NIGHT_LIGHTS: 'VIIRS Black Marble VNP46A2',
  DISASTER_READINESS: 'UNDRR Sendai Monitor — no 2025 study-area data (unavailable)'
};

function makeComponents(codes) {
  const weight = Number((100 / codes.length).toFixed(2));
  return codes.map(code => {
    const meta = COMPONENT_META[code];
    return { name: code, canonicalId: meta.canonicalId, trained: meta.trained, derived: !!meta.derived, derivedFrom: meta.derivedFrom || null, weight, unit: meta.unit, direction: meta.direction, cadence: meta.cadence, modelMode: meta.modelMode, calculation: `Backend ${meta.direction}-aware normalization for ${code}` };
  });
}

function makeDetail(key, name, category, target, codes) {
  const dataSources = codes.reduce((groups, code) => {
    const satellite = COMPONENT_SATELLITES[code];
    const group = groups.find(source => source.satellite === satellite);
    if (group) {
      group.parameters.push(code);
      group.paramCount = group.parameters.length;
    } else {
      groups.push({
        satellite,
        agency: 'NASA / geospatial data provider',
        resolution: 'Component-specific', frequency: 'Component-specific', paramCount: 1,
        parameters: [code], status: 'Component source'
      });
    }
    return groups;
  }, []);

  return {
    name, category, target, components: makeComponents(codes),
    dataSources,
    technology: {
      algorithm: 'Direction-aware normalization followed by equal-weight composite scoring.',
      processing: 'Normalize each listed component to a 0-100 score using its defined direction, then aggregate the component scores.',
      fusion: 'All constituent components in the supplied index mapping are combined into one composite score.',
      aiModels: ['Data-quality screening', 'Spatial aggregation', 'Time-series anomaly detection']
    },
    formula: {
      expression: `${key} = average(${codes.map(code => `S_${code}`).join(', ')})`,
      variables: codes.map(code => ({ symbol: `S_${code}`, meaning: `Normalized score for ${code}` })),
      weights: codes.map(code => ({ name: code, w: Number((1 / codes.length).toFixed(4)) })),
      normalization: 'Each component is normalized to 0-100 according to its direction. The listed components receive equal weight unless a future methodology specifies otherwise.'
    }
  };
}

const HWI_WEIGHTS = {
  AQHI: 0.12, UHVI: 0.12, GEA: 0.12, WSII: 0.12, DRI: 0.12,
  TAI: 0.10, HAI: 0.10, CRI: 0.10, SCI: 0.10
};

function makeHwiDetail() {
  const codes = Object.keys(HWI_WEIGHTS);
  return {
    name: 'Human Wellbeing Index',
    category: 'Apex Metric',
    target: 81,
    components: codes.map(code => ({
      name: code,
      weight: HWI_WEIGHTS[code] * 100,
      unit: 'domain score /100',
      direction: 'Up',
      calculation: `Renormalized HWI weight: ${HWI_WEIGHTS[code].toFixed(2)}`
    })),
    dataSources: codes.map(code => ({
      satellite: `${code} composite domain index`,
      agency: 'Derived from the dashboard component-source pipeline',
      resolution: 'Inherited from constituent components',
      frequency: 'Updated with domain score',
      paramCount: 1,
      parameters: [code],
      status: 'Derived domain input'
    })),
    technology: {
      algorithm: 'Two-stage hierarchical aggregation with renormalized fixed weights.',
      processing: 'Use available domain-index scores and renormalize the listed HWI weights over that available subset.',
      fusion: 'Environmental quality, climate resilience, infrastructure accessibility, and social vulnerability are fused through the nine domain indices.',
      aiModels: ['Component data-quality screening', 'Domain-index aggregation', 'Missing-data-aware weight renormalization']
    },
    formula: {
      expression: 'HWI = sum(w_k * I_k) / sum(w_k), over available domain indices',
      variables: codes.map(code => ({ symbol: code, meaning: `${code} domain-index score` })),
      weights: codes.map(code => ({ name: code, w: HWI_WEIGHTS[code] })),
      normalization: 'HWI is not calculated directly from raw observations. Component scores form domain indices first; available domain-index weights are then renormalized before HWI aggregation.'
    }
  };
}

const INDEX_DETAILS = {
  AQHI: makeDetail('AQHI', 'Air Quality Health Index', 'Atmospheric Exposure', 78, ['PM2_5', 'PM10', 'NO2', 'O3', 'SO2', 'CO', 'AEROSOL_INDEX']),
  UHVI: makeDetail('UHVI', 'Urban Heat Vulnerability Index', 'Heat & Climate', 76, ['LST', 'AIR_TEMP', 'REL_HUMIDITY', 'BUILTUP_PCT', 'IMPERVIOUS_PCT', 'NDVI', 'POP_DENSITY', 'VULNERABLE_AGE_PCT', 'GREEN_ACCESS_PCT']),
  GEA: makeDetail('GEA', 'Green Environment Accessibility Index', 'Ecological Condition', 78, ['NDVI', 'GREEN_SPACE_PCT', 'GREEN_ACCESS_PCT']),
  WSII: makeDetail('WSII', 'Water Security & Infrastructure Index', 'Water & Infrastructure', 75, ['PRECIPITATION', 'EXTREME_RAINFALL', 'SOIL_MOISTURE', 'SURFACE_WATER_EXTENT', 'FLOOD_EXTENT', 'DROUGHT_SPI', 'ELEVATION_SLOPE']),
  TAI: makeDetail('TAI', 'Transport Accessibility Index', 'Access Systems', 78, ['ROAD_DENSITY', 'TRANSPORT_ACCESS_PCT']),
  HAI: makeDetail('HAI', 'Healthcare Accessibility Index', 'Access Systems', 78, ['HOSPITAL_ACCESS', 'CRIT_INFRA_DENSITY', 'POP_DENSITY']),
  CRI: makeDetail('CRI', 'Climate Resilience Index', 'Climate Resilience', 76, ['EXTREME_RAINFALL', 'FLOOD_EXTENT', 'DROUGHT_SPI', 'SOIL_MOISTURE', 'ELEVATION_SLOPE', 'DISASTER_READINESS']),
  SCI: makeDetail('SCI', 'Social / Urban Vulnerability Index', 'Social Vulnerability', 74, ['POP_DENSITY', 'VULNERABLE_AGE_PCT', 'ROAD_DENSITY', 'BUILTUP_PCT', 'NIGHT_LIGHTS', 'CRIT_INFRA_DENSITY', 'GREEN_ACCESS_PCT', 'GREEN_SPACE_PCT', 'TRANSPORT_ACCESS_PCT']),
  DRI: makeDetail('DRI', 'Disaster Readiness Index', 'Disaster Readiness', 76, ['DISASTER_READINESS', 'FLOOD_EXTENT', 'EXTREME_RAINFALL', 'ELEVATION_SLOPE', 'CRIT_INFRA_DENSITY', 'POP_DENSITY', 'AIR_TEMP', 'LST']),
  HWI: makeHwiDetail()
};

window.INDEX_DETAILS = INDEX_DETAILS;
window.HWI_WEIGHTS = HWI_WEIGHTS;
