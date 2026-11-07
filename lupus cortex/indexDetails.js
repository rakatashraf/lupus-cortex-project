// ===== DASHBOARD INDEX KNOWLEDGE BASE =====
// The component memberships below follow the supplied nine-index mapping table.

const COMPONENT_META = {
  PM2_5: { unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, PM10: { unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  NO2: { unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, O3: { unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  SO2: { unit: 'ug/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, CO: { unit: 'mg/m3', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' },
  AEROSOL_INDEX: { unit: 'index', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, LST: { unit: 'deg C anomaly', direction: 'Down', cadence: 'source-specific', modelMode: 'temporal_spatial' },
  AIR_TEMP: { unit: 'deg C', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' }, REL_HUMIDITY: { unit: '%', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' },
  BUILTUP_PCT: { unit: '% area', direction: 'Down', cadence: 'annual_or_static', modelMode: 'spatial' }, IMPERVIOUS_PCT: { unit: '% cover', direction: 'Down', cadence: 'source-specific', modelMode: 'spatial' },
  NDVI: { unit: '-1 to 1', direction: 'Up', cadence: 'source-specific', modelMode: 'temporal_spatial' }, POP_DENSITY: { unit: 'people/km2', direction: 'Contextual', cadence: 'annual_or_static', modelMode: 'spatial' },
  VULNERABLE_AGE_PCT: { unit: '% population', direction: 'Down', cadence: 'annual_or_static', modelMode: 'spatial' }, GREEN_ACCESS_PCT: { unit: '% within access threshold', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  GREEN_SPACE_PCT: { unit: '% area', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' }, PRECIPITATION: { unit: 'mm/day', direction: 'Optimal', cadence: 'daily', modelMode: 'temporal_spatial' },
  EXTREME_RAINFALL: { unit: 'percentile / return period', direction: 'Down', cadence: 'daily', modelMode: 'temporal_spatial' }, SOIL_MOISTURE: { unit: 'm3/m3', direction: 'Optimal', cadence: 'source-specific', modelMode: 'temporal_spatial' },
  SURFACE_WATER_EXTENT: { unit: '% area or km2', direction: 'Optimal', cadence: 'source-specific', modelMode: 'temporal_spatial' }, FLOOD_EXTENT: { unit: '% area or km2', direction: 'Down', cadence: 'event_based', modelMode: 'temporal_spatial' },
  DROUGHT_SPI: { unit: 'standardized anomaly', direction: 'Toward 0', cadence: 'monthly', modelMode: 'temporal_spatial' }, ELEVATION_SLOPE: { unit: 'm / degrees', direction: 'Contextual', cadence: 'static', modelMode: 'spatial' },
  ROAD_DENSITY: { unit: 'km/km2', direction: 'Contextual', cadence: 'source-specific', modelMode: 'spatial' }, TRANSPORT_ACCESS_PCT: { unit: '% within access threshold', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  HOSPITAL_ACCESS: { unit: 'minutes / km', direction: 'Down', cadence: 'source-specific', modelMode: 'spatial' }, CRIT_INFRA_DENSITY: { unit: 'facilities/km2', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' },
  NIGHT_LIGHTS: { unit: 'nW/cm2/sr', direction: 'Contextual', cadence: 'monthly', modelMode: 'temporal_spatial' }, DISASTER_READINESS: { unit: 'readiness score', direction: 'Up', cadence: 'source-specific', modelMode: 'spatial' }
};

const COMPONENT_SATELLITES = {
  PM2_5: 'GEOS-CF surface pollution fields', PM10: 'GEOS-CF surface pollution fields', NO2: 'Aura / OMI atmospheric composition',
  O3: 'Aura / OMI atmospheric composition', SO2: 'Aura / OMI atmospheric composition', CO: 'Aqua / AIRS + AMSU-A',
  AEROSOL_INDEX: 'Terra/Aqua MODIS and Aura OMI', LST: 'Terra/Aqua MODIS LST',
  AIR_TEMP: 'AIRS/AMSU-A with MERRA-2 / GEOS-CF', REL_HUMIDITY: 'AIRS/AMSU-A with MERRA-2 / GEOS-CF',
  NDVI: 'Terra/Aqua MODIS vegetation products', GREEN_SPACE_PCT: 'Landsat/HLS green-space mapping',
  BUILTUP_PCT: 'Landsat 8/9 OLI land-cover products', IMPERVIOUS_PCT: 'Landsat / HLS impervious-surface products',
  PRECIPITATION: 'GPM / IMERG multi-satellite precipitation', EXTREME_RAINFALL: 'GPM / IMERG multi-satellite precipitation', SOIL_MOISTURE: 'SMAP L-band radiometer',
  SURFACE_WATER_EXTENT: 'MODIS, Landsat/HLS, and OPERA DSWx-HLS', FLOOD_EXTENT: 'LANCE MODIS / VIIRS flood products',
  DROUGHT_SPI: 'GRACE / GRACE-FO terrestrial water-storage anomalies', ELEVATION_SLOPE: 'SRTM / NASADEM',
  POP_DENSITY: 'NASA SEDAC GPWv4 demographic dataset', VULNERABLE_AGE_PCT: 'NASA SEDAC demographic datasets',
  ROAD_DENSITY: 'OpenStreetMap / official road networks', TRANSPORT_ACCESS_PCT: 'GTFS, OSM, and operator data',
  HOSPITAL_ACCESS: 'Facility data with SRTM/NASADEM and road routing', GREEN_ACCESS_PCT: 'Landsat/HLS green-space mapping and routing',
  CRIT_INFRA_DENSITY: 'OSM, government inventories, and HDX datasets', NIGHT_LIGHTS: 'Suomi NPP VIIRS DNB / NASA Black Marble',
  DISASTER_READINESS: 'Multi-source: GPM, SMAP, GRACE, MODIS/VIIRS, Landsat/HLS, SRTM/NASADEM'
};

function makeComponents(codes) {
  const weight = Number((100 / codes.length).toFixed(2));
  return codes.map(code => {
    const meta = COMPONENT_META[code];
    return { name: code, weight, unit: meta.unit, direction: meta.direction, cadence: meta.cadence, modelMode: meta.modelMode, calculation: `Backend ${meta.direction}-aware normalization for ${code}` };
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
