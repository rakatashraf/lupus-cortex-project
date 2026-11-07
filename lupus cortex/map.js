// Map interaction only: it resolves a place, updates canonical location, and requests evidence.
(function () {
  'use strict';

  let mapInstance;
  let marker;
  let searchTimer;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function setStatus(message, level = 'info') {
    const status = document.getElementById('mapStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.level = level;
  }

  function showAwaiting(location) {
    const panel = document.getElementById('communityPanel');
    if (!panel) return;
    panel.innerHTML = `<section class="local-insights" aria-live="polite"><div class="local-insights__heading"><div><span class="eyebrow">Coordinate-centred intelligence</span><h2>${escapeHtml(location.name)}</h2><p>${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}</p></div><span class="local-insights__badge">Awaiting evidence</span></div><div class="empty-plan"><span>Analysis requested</span><h3>Awaiting model analysis</h3><p>Community needs, case studies, actions, confidence and provenance are unavailable until the model returns evidence for this exact location.</p></div></section>`;
  }

  function ensureMap() {
    if (mapInstance) return mapInstance;
    const element = document.getElementById('mapView');
    if (!element || typeof L === 'undefined') return null;
    mapInstance = L.map(element, { zoomControl: true, worldCopyJump: true }).setView([23.8103, 90.4125], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(mapInstance);
    mapInstance.on('click', async event => {
      const { lat, lng } = event.latlng;
      setStatus(`Resolving ${lat.toFixed(4)}, ${lng.toFixed(4)}...`);
      try {
        const result = await reverseGeocode(lat, lng);
        selectPlace(lat, lng, formatPlaceName(result.address, result.display_name));
      } catch (_) {
        selectPlace(lat, lng, `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      }
    });
    return mapInstance;
  }

  function selectPlace(lat, lng, name) {
    const map = ensureMap();
    if (!map) return;
    const location = { lat: Number(lat), lng: Number(lng), name };
    map.flyTo([location.lat, location.lng], Math.max(map.getZoom(), 11), { duration: 1.2 });
    if (marker) marker.remove();
    marker = L.marker([location.lat, location.lng]).addTo(map).bindPopup(`<strong>${escapeHtml(name)}</strong><br>${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`).openPopup();
    if (typeof setLocation === 'function') setLocation(location.lat, location.lng, location.name);
    else window.dispatchEvent(new CustomEvent('cortex:place-selected', { detail: location }));
    showAwaiting(location);
    setStatus(`Selected: ${name}. Analysis requested.`, 'ok');
  }

  async function search(query, pickFirst = false) {
    const suggestions = document.getElementById('mapPlaceSuggestions');
    if (!query || query.length < 2) return;
    setStatus(`Searching for "${query}"...`);
    try {
      const results = await forwardGeocode(query);
      if (!results.length) { setStatus('No matching place found.', 'warn'); return; }
      if (pickFirst) { const result = results[0]; selectPlace(Number(result.lat), Number(result.lon), formatPlaceName(result.address, result.display_name)); return; }
      suggestions.innerHTML = results.slice(0, 6).map((result, index) => `<li data-index="${index}"><span class="sug-name">${escapeHtml(result.display_name)}</span><span class="sug-meta">${Number(result.lat).toFixed(3)}, ${Number(result.lon).toFixed(3)}</span></li>`).join('');
      suggestions.classList.remove('hidden');
      suggestions.querySelectorAll('li').forEach(item => item.addEventListener('click', () => {
        const result = results[Number(item.dataset.index)];
        selectPlace(Number(result.lat), Number(result.lon), formatPlaceName(result.address, result.display_name));
        suggestions.classList.add('hidden');
      }));
    } catch (_) { setStatus('Search failed. Check your connection.', 'error'); }
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('[data-section="map"]')) return;
    setTimeout(() => ensureMap()?.invalidateSize(), 200);
  });

  const input = document.getElementById('mapPlaceSearch');
  input?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    if (query.length < 3) return;
    searchTimer = setTimeout(() => search(query), 350);
  });
  document.getElementById('mapPlaceSearchBtn')?.addEventListener('click', () => search(input?.value.trim(), true));
  document.getElementById('mapCoordsBtn')?.addEventListener('click', async () => {
    const lat = Number(document.getElementById('mapLat')?.value);
    const lng = Number(document.getElementById('mapLng')?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) { setStatus('Enter valid latitude and longitude.', 'error'); return; }
    try { const result = await reverseGeocode(lat, lng); selectPlace(lat, lng, formatPlaceName(result.address, result.display_name)); }
    catch (_) { selectPlace(lat, lng, `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`); }
  });

  setTimeout(() => ensureMap()?.invalidateSize(), 400);
}());
