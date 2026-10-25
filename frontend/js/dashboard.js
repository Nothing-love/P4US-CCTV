/* P4US CCTV — Dashboard Controller */
'use strict';

if (!requireAuth()) throw new Error('Not authenticated');

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  cameras: [],
  slots: new Array(8).fill(null),          // { camera, hls, recording }
  gridSize: 4,
  activeSlot: null,                        // currently focused slot index (0-based)
  activePtzCamId: null,
  healthPollTimer: null,
  statusFilter: 'all',                     // 'all' | 'online' | 'offline'
  map: null,
  mapLoaded: false,
};

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  const user = currentUser();
  if (user) {
    document.getElementById('user-name').textContent = user.name;
    const badge = document.getElementById('user-badge');
    if (user.role === 'superadmin') { badge.style.display = ''; badge.textContent = 'SUPERADMIN'; badge.classList.add('badge-super'); }
    else if (user.role === 'admin') { badge.style.display = ''; badge.textContent = 'ADMIN'; }
  }

  renderGrid();
  initMap();
  await loadCameras();
  await loadSlots();
  await loadRecordings();

  startHealthPoll();
}

// ─── Map (MapLibre GL — gaya vektor seperti K3I) ────────────────────────────
function initMap() {
  // Google Hybrid tiles (satelit + label jalan) — seperti dashboard K3I.
  const style = {
    version: 8,
    glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
    sources: {
      gmaps: {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution: '© Google',
      },
    },
    layers: [{ id: 'gmaps', type: 'raster', source: 'gmaps' }],
  };

  state.map = new maplibregl.Map({
    container: 'map',
    style,
    center: [117.5, -2.5],   // Indonesia
    zoom: 4.2,
    maxZoom: 20,
    attributionControl: false,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  state.map.on('load', () => {
    state.map.addSource('cctv', {
      type: 'geojson',
      data: cameraGeoJSON(),
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 13,
    });

    // Cluster bubbles
    state.map.addLayer({
      id: 'clusters', type: 'circle', source: 'cctv', filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#2980b9', 50, '#8e44ad', 200, '#c0392b'],
        'circle-radius': ['step', ['get', 'point_count'], 14, 50, 18, 200, 24],
        'circle-opacity': 0.85,
        'circle-stroke-width': 2, 'circle-stroke-color': 'rgba(255,255,255,.4)',
      },
    });
    state.map.addLayer({
      id: 'cluster-count', type: 'symbol', source: 'cctv', filter: ['has', 'point_count'],
      layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 12, 'text-font': ['Open Sans Regular'] },
      paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.6)', 'text-halo-width': 1 },
    });

    // Individual cameras coloured by status
    state.map.addLayer({
      id: 'cctv-point', type: 'circle', source: 'cctv', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['match', ['get', 'status'], 'online', '#2ee66b', 'offline', '#ff2e4d', '#b9b9cf'],
        'circle-radius': 6,
        'circle-stroke-width': 2, 'circle-stroke-color': 'rgba(0,0,0,.65)',
      },
    });

    // Zoom into a cluster on click
    state.map.on('click', 'clusters', async (e) => {
      const f = state.map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      const zoom = await state.map.getSource('cctv').getClusterExpansionZoom(f.properties.cluster_id);
      state.map.easeTo({ center: f.geometry.coordinates, zoom });
    });

    // Popup + add-to-grid on a camera click
    state.map.on('click', 'cctv-point', (e) => {
      const p = e.features[0].properties;
      showCameraPopup(
        { id: p.id, name: p.name, status: p.status, link_type: p.link_type, province: p.province },
        e.features[0].geometry.coordinates.slice()
      );
    });

    const setCursor = (c) => () => { state.map.getCanvas().style.cursor = c; };
    state.map.on('mouseenter', 'cctv-point', setCursor('pointer'));
    state.map.on('mouseleave', 'cctv-point', setCursor(''));
    state.map.on('mouseenter', 'clusters', setCursor('pointer'));
    state.map.on('mouseleave', 'clusters', setCursor(''));

    state.mapLoaded = true;
    updateMapData();
  });
}

// Build a GeoJSON FeatureCollection of cameras (with coords) honouring the filter.
// Cameras sharing the exact same coordinate (e.g. Wisma Nusantara & Hyatt
// Bundaran HI) are spread in a small circle so each marker is clickable. The DB
// coordinates are untouched — the offset is display-only.
function cameraGeoJSON() {
  const visible = state.cameras.filter(c =>
    c.lat != null && c.lng != null && matchesStatusFilter(c));

  // Group co-located cameras by rounded coordinate.
  const groups = new Map();
  for (const c of visible) {
    const key = c.lat.toFixed(5) + ',' + c.lng.toFixed(5);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(c);
  }

  const SPREAD = 0.00018; // ~20 m radius
  const features = [];
  for (const cams of groups.values()) {
    const n = cams.length;
    cams.forEach((c, i) => {
      let lng = c.lng, lat = c.lat;
      if (n > 1) {
        const ang = (2 * Math.PI * i) / n;
        lat = c.lat + SPREAD * Math.sin(ang);
        lng = c.lng + SPREAD * Math.cos(ang) / Math.cos(c.lat * Math.PI / 180);
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: {
          id: c.id, name: c.name, status: c.stream_status,
          link_type: c.link_type, province: c.province_name || '',
        },
      });
    });
  }
  return { type: 'FeatureCollection', features };
}

function updateMapData() {
  if (!state.mapLoaded || !state.map) return;
  const src = state.map.getSource('cctv');
  if (src) src.setData(cameraGeoJSON());
  const withCoords = state.cameras.filter(c => c.lat != null && c.lng != null).length;
  const hint = document.getElementById('map-hint');
  if (hint) hint.textContent = withCoords
    ? 'Klik titik CCTV di peta untuk menampilkan di grid'
    : 'Koordinat belum disinkron — jalankan Sync K3I';
}

// Reusable camera popup (map click + search result).
function showCameraPopup(info, lngLat) {
  const statusLbl = info.status === 'online' ? 'Hidup' : info.status === 'offline' ? 'Mati' : 'Perlu cek';
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="popup-name">${escHtml(info.name)}</div>
    <div class="popup-meta">${escHtml(info.province || '')} · ${escHtml(info.link_type || '')} · ${statusLbl}</div>
    <button class="popup-add">+ Tampilkan di Grid</button>`;
  node.querySelector('.popup-add').addEventListener('click', () => {
    addCameraToNextSlot(info.id);
    popup.remove();
  });
  const popup = new maplibregl.Popup({ offset: 12, maxWidth: '240px' })
    .setLngLat(lngLat).setDOMContent(node).addTo(state.map);
  return popup;
}

// ─── Map Search ─────────────────────────────────────────────────────────────
function onMapSearch(query) {
  const q = query.trim().toLowerCase();
  const box = document.getElementById('map-search-results');
  if (q.length < 2) { box.innerHTML = ''; box.style.display = 'none'; return; }

  const matches = state.cameras
    .filter(c => c.name && c.name.toLowerCase().includes(q))
    .slice(0, 12);

  box.innerHTML = '';
  if (!matches.length) {
    box.innerHTML = '<div class="map-search-empty">Tidak ditemukan</div>';
    box.style.display = 'block';
    return;
  }
  matches.forEach(c => {
    const st = c.stream_status === 'online' ? 'live' : c.stream_status === 'offline' ? 'dead' : 'unknown';
    const row = document.createElement('div');
    row.className = 'map-search-item';
    row.innerHTML = `
      <span class="dot dot-${st}"></span>
      <span class="ms-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
      <span class="ms-loc">${escHtml(c.province_name || '')}</span>`;
    row.addEventListener('click', () => selectSearchResult(c));
    box.appendChild(row);
  });
  box.style.display = 'block';
}

function selectSearchResult(c) {
  const box = document.getElementById('map-search-results');
  box.style.display = 'none';
  document.getElementById('map-search-input').value = c.name;

  if (c.lat == null || c.lng == null) {
    // No coordinates: just add to the grid.
    addCameraToNextSlot(c.id);
    return;
  }
  // Popup is anchored to the camera's coordinates, so it tracks the map while
  // it flies there — no need to wait for moveend (which can race).
  if (state._searchPopup) state._searchPopup.remove();
  state.map.flyTo({ center: [c.lng, c.lat], zoom: 16, speed: 1.4 });
  state._searchPopup = showCameraPopup(
    { id: c.id, name: c.name, status: c.stream_status, link_type: c.link_type, province: c.province_name },
    [c.lng, c.lat]
  );
}

// ─── Data Loading ─────────────────────────────────────────────────────────
async function loadCameras(filters = {}) {
  try {
    const params = new URLSearchParams({ limit: 6000, ...filters });
    const { cameras, total } = await api.get(`/api/cameras?${params}`);
    state.cameras = cameras;
    document.getElementById('topbar-stats').textContent = `${total} kamera terdaftar`;
    updateMapData();
    await loadStats();
  } catch (err) {
    console.error('loadCameras:', err.message);
  }
}

async function loadStats() {
  try {
    const s = await api.get('/api/cameras/stats');
    document.getElementById('stat-live').textContent = s.online ?? 0;
    document.getElementById('stat-slow').textContent = s.unknown ?? 0;
    document.getElementById('stat-dead').textContent = s.offline ?? 0;
  } catch {}
}

async function loadSlots() {
  try {
    const { slots } = await api.get('/api/cameras/slots/me');
    // If the user previously used an 8-grid, restore that layout first.
    if (slots.some(s => s.slot > 4) && state.gridSize !== 8) {
      state.gridSize = 8;
      document.getElementById('btn-grid-4').classList.remove('active');
      document.getElementById('btn-grid-8').classList.add('active');
      renderGrid();
    }
    slots.forEach(s => {
      const idx = s.slot - 1;
      if (idx >= 0 && idx < state.gridSize) {
        state.slots[idx] = s;
        mountSlot(idx, s);
      }
    });
  } catch {}
}

async function loadRecordings() {
  try {
    const { recordings } = await api.get('/api/recordings');
    renderRecordings(recordings);
  } catch {}
}

// Does a camera pass the current Online/Offline filter?
function matchesStatusFilter(c) {
  if (state.statusFilter === 'all') return true;
  return c.stream_status === state.statusFilter;
}

// Online/Offline filter buttons — only affect the map now.
function setStatusFilter(filter, btn) {
  state.statusFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  updateMapData();
}

// ─── Video Grid (landscape, 4 atau 8 kamera) ────────────────────────────────
function setGridSize(size, btn) {
  if (size === state.gridSize) return;
  // Remember which cameras are loaded, then rebuild the grid at the new size.
  const camIds = state.slots.map(s => (s ? (s.camera?.id || s.id || null) : null));
  for (let i = 0; i < state.slots.length; i++) if (state.slots[i]) destroySlot(i);

  state.gridSize = size;
  document.querySelectorAll('.grid-size-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGrid();

  camIds.slice(0, size).forEach((id, i) => { if (id) addCameraToSlot(id, i); });
}

function renderGrid() {
  const grid = document.getElementById('video-grid');
  grid.className = `video-grid grid-${state.gridSize}`;
  grid.innerHTML = '';
  for (let i = 0; i < state.gridSize; i++) {
    const slot = document.createElement('div');
    slot.className = 'video-slot';
    slot.id = `slot-${i}`;
    slot.dataset.slot = i;
    slot.innerHTML = `
      <div class="slot-empty">
        <div class="plus">+</div>
        <div class="hint">Pilih CCTV dari peta</div>
      </div>
    `;
    slot.addEventListener('click', () => selectSlot(i));
    grid.appendChild(slot);
  }
}

function selectSlot(idx) {
  document.querySelectorAll('.video-slot').forEach(s => s.classList.remove('active-slot'));
  document.getElementById(`slot-${idx}`).classList.add('active-slot');
  state.activeSlot = idx;

  const slotData = state.slots[idx];
  updatePtzPanel(slotData);
}

function addCameraToNextSlot(cameraId) {
  // Prefer the active slot, else the next empty slot within the current grid.
  let targetSlot = state.activeSlot;
  if (targetSlot === null || targetSlot >= state.gridSize || state.slots[targetSlot] !== null) {
    targetSlot = -1;
    for (let i = 0; i < state.gridSize; i++) { if (!state.slots[i]) { targetSlot = i; break; } }
  }
  if (targetSlot === -1) targetSlot = 0; // all full → overwrite slot 0

  addCameraToSlot(cameraId, targetSlot);
}

async function addCameraToSlot(cameraId, slotIdx) {
  const cam = state.cameras.find(c => c.id === cameraId);
  if (!cam) return;

  // Stop existing if any
  if (state.slots[slotIdx]) destroySlot(slotIdx);

  state.slots[slotIdx] = { camera: cam };
  showLoading(slotIdx);

  try {
    const info = await api.get(`/api/stream/info/${cameraId}`);
    await api.put(`/api/cameras/slots/${slotIdx + 1}`, { cameraId });
    mountVideoStream(slotIdx, cam, info);
  } catch (err) {
    showSlotError(slotIdx, err.message);
    state.slots[slotIdx] = null;
  }
}

function mountSlot(idx, slotData) {
  if (!slotData || !slotData.id) return;
  addCameraToSlot(slotData.id, idx);
}

function showLoading(idx) {
  const el = document.getElementById(`slot-${idx}`);
  el.innerHTML = `<div class="slot-loading"><div class="spinner"></div><div style="font-size:11px;color:var(--text-muted)">Menghubungkan…</div></div>`;
}

function showSlotError(idx, msg) {
  const el = document.getElementById(`slot-${idx}`);
  el.innerHTML = `
    <div class="slot-error">
      <div>⚠ Gagal memuat stream</div>
      <div style="font-size:10px;color:var(--text-muted)">${escHtml(msg)}</div>
    </div>
    <div class="slot-empty" style="margin-top:4px">
      <div class="hint" onclick="document.getElementById('slot-${idx}').querySelector('.slot-empty').style.display='none'">Klik untuk hapus</div>
    </div>
  `;
}

function mountVideoStream(idx, cam, info) {
  const { streamUrl, playerType, linkType, directUrl, accessClass } = info;
  const slotEl = document.getElementById(`slot-${idx}`);

  // ── RTSP: tidak bisa diputar di browser tanpa FFmpeg ──
  if (playerType === 'rtsp') {
    slotEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'slot-error';
    msg.innerHTML = `
      <div style="font-size:22px">📡</div>
      <div>Stream RTSP</div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Memerlukan FFmpeg untuk diputar di browser</div>
    `;
    slotEl.appendChild(msg);
    renderSlotOverlay(idx, cam);
    return;
  }

  // ── WSS: tampilkan URL koneksi langsung ──
  if (playerType === 'wss') {
    slotEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'slot-error';
    const small = document.createElement('small');
    small.textContent = directUrl || '';
    msg.innerHTML = `<div style="font-size:22px">🌐</div><div>Stream WebSocket (WSS)</div><div style="font-size:10px;color:var(--text-muted);margin-top:4px">Hubungkan langsung dari browser</div>`;
    slotEl.appendChild(msg);
    renderSlotOverlay(idx, cam);
    return;
  }

  // ── MJPEG: tampilkan dengan tag <img> yang di-proxy ──
  if (playerType === 'mjpeg') {
    slotEl.innerHTML = '';
    const token = localStorage.getItem('p4us_token');
    // Fetch MJPEG as blob URL with auth header
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    img.alt = cam.name;
    img.src = streamUrl + '&_auth=' + encodeURIComponent(token || '');
    img.onerror = () => { showSlotError(idx, 'MJPEG tidak dapat dimuat'); };
    slotEl.appendChild(img);
    renderSlotOverlay(idx, cam);
    return;
  }

  if (!streamUrl) {
    showSlotError(idx, 'Tidak ada stream URL untuk tipe ' + (linkType || '?'));
    return;
  }

  // ── HLS/M3U8 ──
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  let hlsInstance = null;

  if (Hls.isSupported()) {
    const token = localStorage.getItem('p4us_token');
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 8,
      maxMaxBufferLength: 15,
      backBufferLength: 8,
      startLevel: -1,
      debug: false,
      // RTSP transcode can take a few seconds to produce the first playlist.
      manifestLoadingTimeOut: 25000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 2000,
      xhrSetup(xhr) {
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      },
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else {
          hls.destroy();
          showSlotError(idx, 'Stream error: ' + (data.details || 'unknown'));
        }
      }
    });
    hlsInstance = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play().catch(() => {});
  } else {
    showSlotError(idx, 'Browser tidak mendukung HLS');
    return;
  }

  if (state.slots[idx]) state.slots[idx].hls = hlsInstance;

  slotEl.innerHTML = '';
  slotEl.appendChild(video);

  const top = document.createElement('div');
  top.className = 'slot-top';
  top.innerHTML = `<span class="slot-num">Slot ${idx + 1}</span>`;
  slotEl.appendChild(top);

  renderSlotOverlay(idx, cam);
}

function renderSlotOverlay(idx, cam) {
  const slotEl = document.getElementById(`slot-${idx}`);
  const existing = slotEl.querySelector('.slot-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'slot-overlay';

  const name = document.createElement('span');
  name.className = 'slot-name';
  name.title = cam.name;
  name.textContent = cam.name;
  overlay.appendChild(name);

  const actions = document.createElement('div');
  actions.className = 'slot-actions';

  if (cam.ptz_capable) {
    const ptzBtn = document.createElement('button');
    ptzBtn.className = 'slot-btn';
    ptzBtn.textContent = 'PTZ';
    ptzBtn.addEventListener('click', (e) => { e.stopPropagation(); activatePtz(idx); });
    actions.appendChild(ptzBtn);
  }

  const recBtn = document.createElement('button');
  recBtn.className = 'slot-btn rec';
  recBtn.id = `rec-btn-${idx}`;
  recBtn.textContent = '⏺ REC';
  recBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRecording(idx); });
  actions.appendChild(recBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'slot-btn';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeSlot(idx); });
  actions.appendChild(removeBtn);

  overlay.appendChild(actions);
  slotEl.appendChild(overlay);
}

function destroySlot(idx) {
  const slot = state.slots[idx];
  if (!slot) return;
  if (slot.hls) { slot.hls.destroy(); }
  if (slot.recordingId) stopRecording(idx);
  state.slots[idx] = null;
}

function removeSlot(idx) {
  destroySlot(idx);
  api.delete(`/api/cameras/slots/${idx + 1}`).catch(() => {});

  const el = document.getElementById(`slot-${idx}`);
  el.innerHTML = `
    <div class="slot-empty">
      <div class="plus">+</div>
      <div class="hint">Pilih CCTV dari peta</div>
    </div>
  `;
  if (state.activeSlot === idx) {
    state.activeSlot = null;
    updatePtzPanel(null);
  }
}

function clearAllSlots() {
  for (let i = 0; i < state.slots.length; i++) {
    if (state.slots[i]) removeSlot(i);
  }
}

// ─── PTZ ──────────────────────────────────────────────────────────────────
function activatePtz(slotIdx) {
  const slot = state.slots[slotIdx];
  if (!slot || !slot.camera) return;
  state.activePtzCamId = slot.camera.id;
  updatePtzPanel(slot);
  selectSlot(slotIdx);
}

function updatePtzPanel(slotData) {
  const nameEl = document.getElementById('ptz-cam-name');
  const noEl = document.getElementById('ptz-no');
  const ctrlEl = document.getElementById('ptz-controls');

  if (!slotData || !slotData.camera) {
    nameEl.textContent = '—';
    noEl.style.display = '';
    ctrlEl.style.display = 'none';
    state.activePtzCamId = null;
    return;
  }

  const cam = slotData.camera;
  nameEl.textContent = cam.name.slice(0, 20);

  if (!cam.ptz_capable) {
    noEl.textContent = 'Kamera ini tidak mendukung PTZ';
    noEl.style.display = '';
    ctrlEl.style.display = 'none';
    return;
  }

  noEl.style.display = 'none';
  ctrlEl.style.display = '';
  state.activePtzCamId = cam.id;
}

async function ptzCmd(command) {
  if (!state.activePtzCamId) return;
  try {
    await api.post(`/api/ptz/${state.activePtzCamId}/command`, { command });
  } catch (err) {
    console.warn('PTZ error:', err.message);
  }
}

// ─── Recording ────────────────────────────────────────────────────────────
async function toggleRecording(slotIdx) {
  const slot = state.slots[slotIdx];
  if (!slot || !slot.camera) return;

  const btn = document.getElementById(`rec-btn-${slotIdx}`);

  if (slot.recordingId) {
    // Stop
    try {
      await api.post(`/api/recordings/stop/${slot.recordingId}`);
      slot.recordingId = null;
      btn.textContent = '⏺ REC';
      btn.classList.remove('rec-stop');
      btn.classList.add('rec');
      await loadRecordings();
    } catch (err) {
      console.error('Stop recording:', err.message);
    }
  } else {
    // Start
    try {
      const { recordingId } = await api.post('/api/recordings/start', { cameraId: slot.camera.id });
      slot.recordingId = recordingId;
      btn.textContent = '■ STOP';
      btn.classList.remove('rec');
      btn.classList.add('rec-stop');
    } catch (err) {
      alert('Gagal memulai rekaman: ' + err.message);
    }
  }
}

async function stopRecording(slotIdx) {
  const slot = state.slots[slotIdx];
  if (!slot?.recordingId) return;
  try { await api.post(`/api/recordings/stop/${slot.recordingId}`); } catch {}
  slot.recordingId = null;
}

function renderRecordings(recordings) {
  const el = document.getElementById('rec-list');
  el.innerHTML = '';

  if (!recordings.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;font-size:11px;color:var(--text-muted)">Tidak ada rekaman</div>';
    return;
  }

  recordings.forEach(r => {
    const item = document.createElement('div');
    item.className = 'rec-item';
    item.id = `rec-item-${r.id}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'rec-item-name';
    nameEl.textContent = r.camera_name;
    item.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'rec-item-meta';
    metaEl.textContent = `${r.status === 'recording' ? '● Merekam' : formatDuration(r.duration_sec)} · ${formatSize(r.file_size)}`;
    if (r.status === 'recording') metaEl.style.color = 'var(--red)';
    item.appendChild(metaEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'rec-actions';

    if (r.status === 'completed') {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'rec-dl';
      dlBtn.textContent = 'Unduh';
      dlBtn.addEventListener('click', () => downloadRec(r.id));
      actionsEl.appendChild(dlBtn);
    }

    const rmBtn = document.createElement('button');
    rmBtn.className = 'rec-rm';
    rmBtn.textContent = 'Hapus';
    rmBtn.addEventListener('click', () => deleteRec(r.id));
    actionsEl.appendChild(rmBtn);

    item.appendChild(actionsEl);
    el.appendChild(item);
  });
}

async function downloadRec(id) {
  try {
    const token = localStorage.getItem('p4us_token');
    const res = await fetch(`/api/recordings/download/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert('Gagal mengunduh rekaman'); return; }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const nameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = nameMatch ? nameMatch[1] : `recording_${id}.mp4`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert('Gagal: ' + err.message);
  }
}

async function deleteRec(id) {
  if (!confirm('Hapus rekaman ini?')) return;
  try {
    await api.delete(`/api/recordings/${id}`);
    document.getElementById(`rec-item-${id}`)?.remove();
  } catch (err) {
    alert('Gagal: ' + err.message);
  }
}

// ─── Health Polling ───────────────────────────────────────────────────────
function startHealthPoll() {
  state.healthPollTimer = setInterval(async () => {
    try {
      const { health } = await api.get('/api/cameras/health');
      const healthMap = Object.fromEntries(health.map(h => [h.id, h]));

      let changed = false;
      state.cameras.forEach(cam => {
        const h = healthMap[cam.id];
        if (h) {
          cam.health_status = h.health_status;
          cam.health_latency_ms = h.health_latency_ms;
          const ns = deriveStatus(cam);
          if (ns !== cam.stream_status) { cam.stream_status = ns; changed = true; }
        }
      });

      loadStats();
      if (changed) updateMapData();
    } catch {}
  }, 30_000);
}

// Mirror of the server's STATUS_SQL so live health updates reflect instantly.
function deriveStatus(c) {
  if (['LIVE', 'SLOW'].includes(c.health_status)) return 'online';
  if (c.health_status === 'DEAD') return 'offline';
  if (c.k3i_active === 1) return 'online';
  if (c.k3i_active === 0) return 'offline';
  if (['OFFLINE', 'UNREACHABLE', 'HOST_ERROR', 'NOT_A_STREAM'].includes(c.access_class)) return 'offline';
  if (['OPEN_NO_AUTH', 'CRED_REQUIRED_CRED_IN_CATALOG'].includes(c.access_class)) return 'online';
  return 'unknown';
}

// ─── Utils ────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function doLogout() {
  if (state.healthPollTimer) clearInterval(state.healthPollTimer);
  logout();
}

// ─── Static event listeners (no inline handlers in HTML) ──────────────────
document.getElementById('btn-logout').addEventListener('click', doLogout);
document.getElementById('btn-clear-all').addEventListener('click', clearAllSlots);
document.getElementById('btn-grid-4').addEventListener('click', function() { setGridSize(4, this); });
document.getElementById('btn-grid-8').addEventListener('click', function() { setGridSize(8, this); });
document.getElementById('topbar-logo-img').addEventListener('error', function() { this.style.display = 'none'; });
document.getElementById('filter-all').addEventListener('click', function() { setStatusFilter('all', this); });
document.getElementById('filter-online').addEventListener('click', function() { setStatusFilter('online', this); });
document.getElementById('filter-offline').addEventListener('click', function() { setStatusFilter('offline', this); });

const mapSearchInput = document.getElementById('map-search-input');
mapSearchInput.addEventListener('input', function() { onMapSearch(this.value); });
// Hide results when clicking elsewhere on the map/page.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.map-search')) {
    document.getElementById('map-search-results').style.display = 'none';
  }
});

function bindPtz(id, cmd) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', () => ptzCmd(cmd));
  el.addEventListener('mouseup', () => ptzCmd('stop'));
  el.addEventListener('touchstart', (e) => { e.preventDefault(); ptzCmd(cmd); }, { passive: false });
  el.addEventListener('touchend', (e) => { e.preventDefault(); ptzCmd('stop'); }, { passive: false });
}
bindPtz('ptz-up', 'up');
bindPtz('ptz-down', 'down');
bindPtz('ptz-left', 'left');
bindPtz('ptz-right', 'right');
bindPtz('ptz-zoom-in', 'zoom_in');
bindPtz('ptz-zoom-out', 'zoom_out');
document.getElementById('ptz-stop').addEventListener('click', () => ptzCmd('stop'));

// ─── Bootstrap ────────────────────────────────────────────────────────────
init().catch(err => {
  console.error('Dashboard init error:', err);
  document.getElementById('status-text').textContent = 'Error: ' + err.message;
  document.getElementById('status-dot').style.background = 'var(--red)';
});
