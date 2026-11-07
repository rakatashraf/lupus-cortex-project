// NASA Eyes presentation with server-proxied weather evidence. No provider key is exposed here.
const WEATHER_API_PATH = '/api/weather';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
let nasaEyesIframe = null;
let currentWeatherLocation = null;

const weatherEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function init3DView() {
  const container = document.getElementById('earth3DContainer');
  if (!container) return;
  if (!nasaEyesIframe) {
    nasaEyesIframe = document.createElement('iframe');
    nasaEyesIframe.src = 'https://eyes.nasa.gov/apps/earth/#/';
    nasaEyesIframe.title = 'NASA Eyes on Earth';
    nasaEyesIframe.allow = 'fullscreen';
    nasaEyesIframe.style.cssText = 'width:100%;height:100%;border:0;border-radius:24px';
    container.replaceChildren(nasaEyesIframe);
    window.addEventListener('message', handleNasaLocationMessage);
  }
  const button = document.getElementById('searchLocationBtn');
  const input = document.getElementById('locationSearch');
  if (button) button.onclick = performLocationSearch;
  if (input) input.onkeydown = event => { if (event.key === 'Enter') performLocationSearch(); };
  const toggle = document.getElementById('toggle3DView');
  if (toggle) { toggle.textContent = 'Switch to Map'; toggle.onclick = () => navigateToSection('map'); }
}

function retryNasaEyes() { nasaEyesIframe = null; init3DView(); }

async function performLocationSearch() {
  const input = document.getElementById('locationSearch');
  const query = input?.value.trim();
  if (!query) return showWeatherUnavailable('Enter a place name or coordinates.');
  const match = query.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (match) return selectWeatherLocation(Number(match[1]), Number(match[2]), 'Selected coordinates');
  try {
    const results = await forwardGeocode(query);
    if (!results?.length) return showWeatherUnavailable('Location not found.');
    const place = results[0];
    return selectWeatherLocation(Number(place.lat), Number(place.lon), formatPlaceName(place.address, place.display_name));
  } catch (_) { showWeatherUnavailable('Location search is unavailable.'); }
}

function searchExample(query) { const input = document.getElementById('locationSearch'); if (input) input.value = query; performLocationSearch(); }

async function selectWeatherLocation(lat, lng, name) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return showWeatherUnavailable('Coordinates are invalid.');
  if (typeof setLocation === 'function') setLocation(lat, lng, name);
  showWeatherLoading(name, lat, lng);
  try {
    const apiBase = String(window.LUPUS_CORTEX_API_BASE || '').replace(/\/$/, '');
    const payload = apiBase
      ? await fetchProxyWeather(apiBase, lat, lng)
      : await fetchOpenMeteoWeather(lat, lng);
    const weather = payload.weather || payload.current;
    if (!weather?.main || !weather.weather?.length) throw new Error('Weather response is incomplete.');
    currentWeatherLocation = { lat, lng, name, weather, forecast: payload.forecast || { list: [] }, provenance: payload.provenance || null };
    renderWeatherPopup(currentWeatherLocation);
  } catch (error) { showWeatherUnavailable(error.message); }
}

async function fetchProxyWeather(apiBase, lat, lng) {
  const response = await fetch(`${apiBase}${WEATHER_API_PATH}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`);
  if (!response.ok) throw new Error(`Weather service unavailable (${response.status}).`);
  return response.json();
}

async function fetchOpenMeteoWeather(lat, lng) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng), timezone: 'auto', forecast_days: '5',
    current: 'temperature_2m,apparent_temperature,precipitation,rain,pressure_msl,wind_speed_10m,wind_direction_10m,weather_code',
    hourly: 'temperature_2m,precipitation,rain,pressure_msl,wind_speed_10m,wind_direction_10m,weather_code'
  });
  const response = await fetch(`${OPEN_METEO_FORECAST_URL}?${params}`);
  if (!response.ok) throw new Error(`Weather service unavailable (${response.status}).`);
  const data = await response.json();
  if (!data?.current) throw new Error('Weather response is incomplete.');
  const current = data.current;
  const forecast = (data.hourly?.time || []).map((time, index) => ({
    dt: Math.floor(new Date(time).getTime() / 1000),
    main: { temp_min: data.hourly.temperature_2m?.[index], temp_max: data.hourly.temperature_2m?.[index] },
    rain: { '3h': data.hourly.rain?.[index] }, snow: {},
    weather: [{ description: weatherCodeLabel(data.hourly.weather_code?.[index]), icon: weatherCodeIcon(data.hourly.weather_code?.[index]) }],
    wind: { speed: data.hourly.wind_speed_10m?.[index], deg: data.hourly.wind_direction_10m?.[index] },
    pressure: data.hourly.pressure_msl?.[index], precipitation: data.hourly.precipitation?.[index]
  }));
  return {
    weather: {
      dt: Math.floor(new Date(current.time).getTime() / 1000), name: 'Selected location',
      main: { temp: current.temperature_2m, feels_like: current.apparent_temperature, pressure: current.pressure_msl },
      weather: [{ description: weatherCodeLabel(current.weather_code), icon: weatherCodeIcon(current.weather_code) }],
      wind: { speed: current.wind_speed_10m, deg: current.wind_direction_10m },
      rain: { '1h': current.rain, '3h': current.precipitation }
    },
    forecast: { list: forecast },
    provenance: { source: 'Open-Meteo forecast API', status: 'observed_and_forecast' }
  };
}

function weatherCodeLabel(code) {
  const labels = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers', 95: 'Thunderstorm' };
  return labels[code] || 'Weather condition unavailable';
}

function weatherCodeIcon(code) { return [61, 63, 65, 80, 81, 82].includes(code) ? '10d' : [71, 73, 75].includes(code) ? '13d' : [2, 3, 45, 48].includes(code) ? '03d' : '01d'; }

function showWeatherLoading(name, lat, lng) {
  const popup = document.getElementById('weatherPopup'); const content = document.getElementById('weatherContent');
  if (!popup || !content) return;
  popup.classList.remove('hidden'); content.textContent = `Fetching latest weather evidence for ${name} (${lat.toFixed(5)}, ${lng.toFixed(5)})…`;
}

function showWeatherUnavailable(message) {
  const popup = document.getElementById('weatherPopup'); const content = document.getElementById('weatherContent');
  if (!popup || !content) return;
  popup.classList.remove('hidden'); content.textContent = `Weather information unavailable. ${message}`;
}

function dailyForecast(forecast) {
  const days = new Map();
  (forecast?.list || []).forEach(item => {
    const date = new Date((item.dt || 0) * 1000).toLocaleDateString(undefined, { weekday: 'short' });
    const day = days.get(date) || { date, min: Infinity, max: -Infinity, precipitation: 0, rainfall: 0, condition: item.weather?.[0]?.description || 'Unavailable' };
    day.min = Math.min(day.min, Number(item.main?.temp_min)); day.max = Math.max(day.max, Number(item.main?.temp_max));
    day.rainfall += Number(item.rain?.['3h'] || 0); day.precipitation += Number(item.rain?.['3h'] || 0) + Number(item.snow?.['3h'] || 0); days.set(date, day);
  });
  return [...days.values()].slice(0, 5);
}

function windDirection(degrees) { const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']; return Number.isFinite(Number(degrees)) ? labels[Math.round(Number(degrees) / 22.5) % 16] : 'Unavailable'; }

function renderWeatherPopup(location) {
  const popup = document.getElementById('weatherPopup'); const content = document.getElementById('weatherContent');
  if (!popup || !content) return;
  const { weather, forecast, name, lat, lng } = location; const main = weather.main; const wind = weather.wind || {}; const condition = weather.weather[0] || {}; const days = dailyForecast(forecast);
  const detail = (label, value) => `<article class="detail-item"><div><div class="detail-label">${weatherEscape(label)}</div><div class="detail-value">${weatherEscape(value)}</div></div></article>`;
  content.innerHTML = `<section class="weather-location"><h4>${weatherEscape(name)}</h4><p class="coordinates">Exact coordinates: ${lat.toFixed(6)}°, ${lng.toFixed(6)}°</p><p class="update-time">Latest available observation: ${weather.dt ? weatherEscape(new Date(weather.dt * 1000).toLocaleString()) : 'Unavailable'}</p></section><section class="weather-main"><img class="weather-icon" src="https://openweathermap.org/img/wn/${weatherEscape(condition.icon || '01d')}@2x.png" alt="${weatherEscape(condition.description || 'Weather')}"/><div class="temperature">${Number.isFinite(Number(main.temp)) ? `${Math.round(main.temp)}°C` : 'Unavailable'}</div><div class="weather-description">${weatherEscape(condition.description || 'Unavailable')}</div><div class="feels-like">Feels like ${Number.isFinite(Number(main.feels_like)) ? `${Math.round(main.feels_like)}°C` : 'Unavailable'}</div></section><section class="weather-details">${detail('Temperature', `${main.temp ?? 'Unavailable'} °C`)}${detail('Air pressure', `${main.pressure ?? 'Unavailable'} hPa`)}${detail('Precipitation', `${weather.rain?.['1h'] ?? weather.rain?.['3h'] ?? 'Not reported'} mm`)}${detail('Rainfall', `${weather.rain?.['1h'] ?? 'Not reported'} mm / 1h`)}${detail('Wind speed', `${wind.speed ?? 'Unavailable'} m/s`)}${detail('Wind direction', `${wind.deg ?? 'Unavailable'}° ${windDirection(wind.deg)}`)}</section><section class="forecast-section"><div class="forecast-heading"><h5>Forecast</h5><span>Provider forecast</span></div><div class="forecast-grid">${days.length ? days.map(day => `<article class="forecast-day"><strong>${weatherEscape(day.date)}</strong><span>${weatherEscape(day.condition)}</span><span>${Number.isFinite(day.max) ? `${Math.round(day.max)}° / ${Math.round(day.min)}°C` : 'Unavailable'}</span><span>Precip. ${day.precipitation.toFixed(1)} mm</span><span>Rain ${day.rainfall.toFixed(1)} mm</span></article>`).join('') : '<p class="forecast-empty">Forecast unavailable.</p>'}</div></section><div class="popup-actions"><button class="btn primary small" id="refreshWeatherBtn">Refresh</button><button class="btn secondary small" id="closeWeatherBtn">Close</button></div>`;
  content.querySelector('#refreshWeatherBtn')?.addEventListener('click', () => selectWeatherLocation(lat, lng, name));
  content.querySelector('#closeWeatherBtn')?.addEventListener('click', closeWeatherPopup); popup.classList.remove('hidden');
}

function closeWeatherPopup() { document.getElementById('weatherPopup')?.classList.add('hidden'); }
function refreshWeatherData() { if (currentWeatherLocation) selectWeatherLocation(currentWeatherLocation.lat, currentWeatherLocation.lng, currentWeatherLocation.name); }
function handleNasaLocationMessage(event) { if (event.origin !== 'https://eyes.nasa.gov') return; const data = event.data || {}; const lat = Number(data.lat ?? data.latitude), lng = Number(data.lng ?? data.lon ?? data.longitude); if (Number.isFinite(lat) && Number.isFinite(lng)) selectWeatherLocation(lat, lng, data.name || 'NASA Eyes selection'); }
function showNasaEyesInfo() { showWeatherUnavailable('NASA Eyes is available for visual exploration. Search above to select a coordinate and retrieve weather evidence.'); }
