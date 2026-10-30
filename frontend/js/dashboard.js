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
    if (user.role === 'superadmin') {
      badge.style.display = ''; badge.textContent = 'SUPERADMIN'; badge.classList.add('badge-super');
      document.getElementById('btn-k3i').style.display = '';   // Sync K3I: khusus superadmin
    }
    else if (user.role === 'admin') { badge.style.display = ''; badge.textContent = 'ADMIN'; }
    if (user.role === 'admin' || user.role === 'superadmin') {
      document.getElementById('btn-users').style.display = '';
      refreshPendingCount();
    }
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
    // Di layar sempit (tablet/HP) halaman bisa di-scroll; tanpa ini map
    // "menangkap" scroll satu-jari → sulit turun ke grid. cooperativeGestures
    // membuat pan/zoom butuh dua jari (atau Ctrl+scroll), scroll biasa lewat.
    cooperativeGestures: window.matchMedia('(max-width: 1024px)').matches,
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

// Stream berhasil diputar → status kamera jadi online (akurat, real-time).
function markCameraAlive(cam) {
  api.post(`/api/cameras/${cam.id}/alive`, {}).catch(() => {});
  const c = state.cameras.find(x => x.id === cam.id);
  if (c && c.stream_status !== 'online') {
    c.health_status = 'LIVE';
    c.stream_status = 'online';
    updateMapData();
    loadStats();
  }
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
    // Muat semua kamera (jumlah tumbuh seiring sumber baru ditambah).
    const params = new URLSearchParams({ limit: 50000, ...filters });
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
  // Slot yang dipilih (aktif) selalu diganti; jika tidak ada yang dipilih,
  // pakai slot kosong berikutnya, lalu slot 0.
  let targetSlot = state.activeSlot;
  if (targetSlot === null || targetSlot >= state.gridSize) {
    targetSlot = -1;
    for (let i = 0; i < state.gridSize; i++) { if (!state.slots[i]) { targetSlot = i; break; } }
    if (targetSlot === -1) targetSlot = 0;
  }
  addCameraToSlot(cameraId, targetSlot);
}

async function addCameraToSlot(cameraId, slotIdx, isAuto = false) {
  const cam = state.cameras.find(c => c.id === cameraId);
  if (!cam) return;

  cancelSlotRetry(slotIdx);                 // batalkan retry tertunda
  if (!isAuto) slotRetry.count[slotIdx] = 0; // aksi manual = mulai hitung dari nol

  // Stop existing if any
  if (state.slots[slotIdx]) destroySlot(slotIdx);

  state.slots[slotIdx] = { camera: cam };
  showLoading(slotIdx);

  try {
    const info = await api.get(`/api/stream/info/${cameraId}`);
    await api.put(`/api/cameras/slots/${slotIdx + 1}`, { cameraId });
    mountVideoStream(slotIdx, cam, info);
    // Jika slot ini sedang aktif (mis. mengganti kamera mati), segarkan panel PTZ
    // agar menampilkan kamera baru, bukan kamera lama.
    if (slotIdx === state.activeSlot) updatePtzPanel(state.slots[slotIdx]);
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

function renderEmptySlot(idx) {
  const el = document.getElementById(`slot-${idx}`);
  if (el) el.innerHTML = '<div class="slot-empty"><div class="plus">+</div><div class="hint">Pilih CCTV dari peta</div></div>';
}

// ── Auto-recovery per slot ──────────────────────────────────────────────────
// Stream bisa gagal sesaat (rate-limit transien, UUID jmlive berputar, upstream
// goyang). Alih-alih menunggu user reload/klik, pasang ulang OTOMATIS (ambil
// /info segar) dgn backoff, dibatasi agar tak loop pada kamera yg benar mati.
const slotRetry = { count: {}, timer: {} };
function cancelSlotRetry(idx) {
  if (slotRetry.timer[idx]) { clearTimeout(slotRetry.timer[idx]); delete slotRetry.timer[idx]; }
}
function scheduleSlotRetry(idx, camId) {
  cancelSlotRetry(idx);
  const n = (slotRetry.count[idx] || 0) + 1;
  slotRetry.count[idx] = n;
  if (n > 6) return false;                               // menyerah → tombol manual
  const delay = Math.min(10000 + (n - 1) * 5000, 30000); // 10,15,20,25,30,30 dtk
  slotRetry.timer[idx] = setTimeout(() => {
    delete slotRetry.timer[idx];
    if (!state.slots[idx]) addCameraToSlot(camId, idx, true); // hanya bila slot masih kosong
  }, delay);
  return true;
}

function showSlotError(idx, msg) {
  // Bebaskan slot supaya CCTV mati bisa diganti kamera lain.
  const slot = state.slots[idx];
  const cam = slot?.camera;
  if (slot?.hls) { try { slot.hls.destroy(); } catch {} }
  if (slot?.stillTimer) { try { clearInterval(slot.stillTimer); } catch {} }
  state.slots[idx] = null;
  if (state.activeSlot === idx) { updatePtzPanel(null); }

  // Jadwalkan pemasangan ulang otomatis (bila belum menyerah).
  const willRetry = cam ? scheduleSlotRetry(idx, cam.id) : false;

  const el = document.getElementById(`slot-${idx}`);
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'slot-error';
  const title = document.createElement('div'); title.textContent = '⚠ Stream gagal';
  const detail = document.createElement('div');
  detail.style.cssText = 'font-size:10px;color:var(--text-muted);margin:4px 0 8px';
  detail.textContent = willRetry ? `${msg} · mencoba ulang otomatis…` : msg;
  box.append(title, detail);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px';
  if (cam) {
    const retry = document.createElement('button');
    retry.className = 'slot-btn'; retry.textContent = '⟳ Coba lagi';
    retry.addEventListener('click', (e) => { e.stopPropagation(); addCameraToSlot(cam.id, idx); });
    actions.appendChild(retry);
  }
  const clear = document.createElement('button');
  clear.className = 'slot-btn'; clear.textContent = '✕ Kosongkan';
  clear.addEventListener('click', (e) => { e.stopPropagation(); removeSlot(idx); });
  actions.appendChild(clear);
  box.appendChild(actions);
  el.appendChild(box);
}

// Jalur primer gagal → coba endpoint BACKUP (bila ada & belum dicoba); kalau
// tetap gagal, baru tampilkan error. Memberi cadangan saat CCTV utama offline.
function failover(idx, cam, info, msg) {
  const slot = state.slots[idx];
  const bk = info && info.backup;
  if (bk && bk.streamUrl && slot && !slot.triedBackup) {
    slot.triedBackup = true;
    if (slot.stillTimer) { clearInterval(slot.stillTimer); slot.stillTimer = null; }
    if (slot.hls) { try { slot.hls.destroy(); } catch {} slot.hls = null; }
    mountVideoStream(idx, cam, {
      streamUrl: bk.streamUrl, playerType: bk.playerType, direct: bk.direct,
      refreshSec: bk.refreshSec, linkType: bk.linkType, directUrl: bk.directUrl,
      accessClass: info.accessClass, backup: null,
    });
    return;
  }
  showSlotError(idx, msg);
}

function mountVideoStream(idx, cam, info) {
  const { streamUrl, playerType, linkType, directUrl, accessClass, direct, refreshSec } = info;
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
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    img.alt = cam.name;
    img.src = streamUrl + '&_auth=' + encodeURIComponent(token || '');
    img.onerror = () => { failover(idx, cam, info, 'MJPEG tidak dapat dimuat'); };
    slotEl.appendChild(img);
    enableFullscreenClick(img, idx);
    renderSlotOverlay(idx, cam);
    return;
  }

  // ── STILL: gambar JPEG yang di-refresh berkala (lewat proxy /still) ──
  if (playerType === 'still') {
    slotEl.innerHTML = '';
    const token = localStorage.getItem('p4us_token');
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#000';
    img.alt = cam.name;
    const sec = Math.max(5, refreshSec || 15);
    const authUrl = streamUrl + (streamUrl.includes('?') ? '&' : '?') + '_auth=' + encodeURIComponent(token || '');
    const load = () => { img.src = authUrl + '&_t=' + Date.now(); };
    let fails = 0;
    img.onload = () => { fails = 0; markCameraAlive(cam); };
    img.onerror = () => { if (++fails >= 2) { if (st) clearInterval(st); failover(idx, cam, info, 'Gambar tak dapat dimuat'); } };
    load();
    const st = setInterval(load, sec * 1000);
    if (state.slots[idx]) state.slots[idx].stillTimer = st;
    slotEl.appendChild(img);
    enableFullscreenClick(img, idx);
    renderSlotOverlay(idx, cam);
    return;
  }

  // ── FRAME / YouTube: halaman embed resmi lewat <iframe> ──
  if (playerType === 'frame') {
    slotEl.innerHTML = '';
    const ifr = document.createElement('iframe');
    ifr.src = streamUrl;
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000';
    ifr.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    ifr.setAttribute('allowfullscreen', '');
    ifr.referrerPolicy = 'no-referrer';
    slotEl.appendChild(ifr);
    markCameraAlive(cam);
    renderSlotOverlay(idx, cam);
    return;
  }

  if (!streamUrl) {
    failover(idx, cam, info, 'Tidak ada stream URL untuk tipe ' + (linkType || '?'));
    return;
  }

  // ── HLS/M3U8 ──
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  // Begitu frame pertama benar-benar diputar, hilangkan indikator "memuat"
  // dan reset hitungan auto-retry (stream sehat lagi).
  video.addEventListener('playing', () => { removeSlotLoading(idx); slotRetry.count[idx] = 0; });
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
      // Transcode butuh beberapa detik untuk playlist pertama. Server sudah
      // fast-fail kamera tak terjangkau (3 dtk), jadi timeout cukup pendek.
      manifestLoadingTimeOut: 14000,
      manifestLoadingMaxRetry: 1,
      manifestLoadingRetryDelay: 1500,
      // Direct (CORS-open) streams are fetched straight from the source, so
      // don't attach our own Authorization header; only proxied URLs need it.
      xhrSetup(xhr) {
        if (!direct && token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      },
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      markCameraAlive(cam);   // stream valid → tandai online (status real)
    });
    let netRetries = 0, mediaRecovered = false;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      // Server sudah memastikan kamera takkan keluar gambar → jangan retry,
      // langsung tampilkan pesan (hemat waktu, tak ada spinner berkepanjangan).
      //   503 = tak terjangkau (port mati)   502 = kredensial/channel ditolak
      const code = data.response && data.response.code;
      if (code === 503) { try { hls.destroy(); } catch {} return failover(idx, cam, info, 'Kamera tidak terjangkau dari server'); }
      if (code === 502) { try { hls.destroy(); } catch {} return failover(idx, cam, info, 'Kredensial/channel kamera ditolak (401)'); }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 2) {
        netRetries++;
        setTimeout(() => { try { hls.startLoad(); } catch {} }, 1000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
        mediaRecovered = true;
        try { hls.recoverMediaError(); } catch { hls.destroy(); failover(idx, cam, info, data.details || 'media error'); }
      } else {
        hls.destroy();
        failover(idx, cam, info, data.details || 'stream error');
      }
    });
    hlsInstance = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.play().catch(() => {});
  } else {
    failover(idx, cam, info, 'Browser tidak mendukung HLS');
    return;
  }

  if (state.slots[idx]) state.slots[idx].hls = hlsInstance;

  slotEl.innerHTML = '';
  slotEl.appendChild(video);
  enableFullscreenClick(video, idx);

  const top = document.createElement('div');
  top.className = 'slot-top';
  top.innerHTML = `<span class="slot-num">Slot ${idx + 1}</span>`;
  slotEl.appendChild(top);

  // RTSP/transcode butuh beberapa detik menyiapkan segmen pertama → tampilkan
  // indikator "memuat" alih-alih layar hitam polos (dibersihkan saat 'playing'
  // atau diganti pesan error bila gagal).
  setSlotLoading(idx, linkType === 'RTSP' ? 'Menyiapkan stream (transcode)…' : 'Menyambungkan…');

  renderSlotOverlay(idx, cam);
}

// Indikator "memuat" per-slot (spinner + teks) di atas <video> yang masih hitam.
function setSlotLoading(idx, text) {
  const slotEl = document.getElementById(`slot-${idx}`);
  if (!slotEl) return;
  if (!document.getElementById('p4-spin-kf')) {
    const st = document.createElement('style');
    st.id = 'p4-spin-kf';
    st.textContent = '@keyframes p4spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
  removeSlotLoading(idx);
  const el = document.createElement('div');
  el.className = 'slot-loading';
  el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9fb3c8;font-size:12px;pointer-events:none;background:rgba(0,0,0,.35);z-index:3';
  el.innerHTML = '<div style="width:26px;height:26px;border:3px solid rgba(255,255,255,.18);border-top-color:#6ea8fe;border-radius:50%;animation:p4spin .8s linear infinite"></div><div>' + text + '</div>';
  slotEl.appendChild(el);
}
function removeSlotLoading(idx) {
  const slotEl = document.getElementById(`slot-${idx}`);
  const e = slotEl && slotEl.querySelector('.slot-loading');
  if (e) e.remove();
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

  const fsBtn = document.createElement('button');
  fsBtn.className = 'slot-btn';
  fsBtn.textContent = '⛶';
  fsBtn.title = 'Layar penuh';
  fsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(idx); });
  actions.appendChild(fsBtn);

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

// Klik video / tombol ⛶ → layar penuh.
function toggleFullscreen(idx) {
  const slotEl = document.getElementById(`slot-${idx}`);
  if (!slotEl) return;
  const target = slotEl.querySelector('video') || slotEl.querySelector('img') || slotEl;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    (target.requestFullscreen || target.webkitRequestFullscreen || slotEl.requestFullscreen)?.call(target);
  }
}

function enableFullscreenClick(el, idx) {
  el.style.cursor = 'zoom-in';
  el.title = 'Klik untuk layar penuh';
  el.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(idx); });
}

function destroySlot(idx) {
  const slot = state.slots[idx];
  if (!slot) return;
  if (slot.hls) { slot.hls.destroy(); }
  if (slot.stillTimer) { clearInterval(slot.stillTimer); slot.stillTimer = null; }
  if (slot.recordingId) stopRecording(idx);
  state.slots[idx] = null;
}

function removeSlot(idx) {
  cancelSlotRetry(idx); slotRetry.count[idx] = 0;
  destroySlot(idx);
  api.delete(`/api/cameras/slots/${idx + 1}`).catch(() => {});
  renderEmptySlot(idx);
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

// ─── Refresh Health (manual) ────────────────────────────────────────────────
// Probe ulang status kamera yang sedang tampil di grid (hasil langsung), lalu
// tarik ulang daftar + statistik agar peta ikut diperbarui. Berguna saat sebuah
// kamera tampil "offline" padahal sebenarnya hidup.
async function refreshHealth() {
  const btn = document.getElementById('btn-refresh-health');
  if (!btn || btn.disabled) return;
  btn.classList.add('spinning'); btn.disabled = true;
  try {
    const gridIds = [...new Set(
      state.slots.filter(Boolean).map(s => s.camera?.id || s.id).filter(Boolean)
    )];
    if (gridIds.length) {
      try {
        const { updated } = await api.post('/api/cameras/health/recheck', { ids: gridIds });
        (updated || []).forEach(u => {
          const c = state.cameras.find(x => x.id === u.id);
          if (c) { c.health_status = u.health_status; c.health_latency_ms = u.health_latency_ms; c.stream_status = u.stream_status; }
        });
      } catch (err) { console.warn('recheck:', err.message); }
    }
    // Tarik ulang seluruh daftar + statistik (mengambil hasil cek terbaru).
    await loadCameras();
  } finally {
    btn.classList.remove('spinning'); btn.disabled = false;
  }
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

// ─── Verifikasi pendaftaran user (admin) ────────────────────────────────────
async function refreshPendingCount() {
  try {
    const { users } = await api.get('/api/auth/users');
    const pending = users.filter(u => u.status === 'pending').length;
    const badge = document.getElementById('user-pending-badge');
    badge.textContent = pending;
    badge.style.display = pending > 0 ? '' : 'none';
  } catch {}
}

async function openUsersModal() {
  document.getElementById('users-modal').style.display = 'flex';
  await loadUsers();
}
function closeUsersModal() {
  document.getElementById('users-modal').style.display = 'none';
}

async function loadUsers() {
  const list = document.getElementById('users-list');
  list.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text-muted)">Memuat…</div>';
  try {
    const { users } = await api.get('/api/auth/users');
    renderUsers(users);
  } catch (err) {
    list.innerHTML = `<div style="padding:16px;font-size:12px;color:#ff8080">Gagal memuat: ${escHtml(err.message)}</div>`;
  }
}

function renderUsers(users) {
  const list = document.getElementById('users-list');
  list.innerHTML = '';
  if (!users.length) {
    list.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text-muted)">Belum ada user</div>';
    return;
  }
  // Pending dulu, lalu sisanya.
  users.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
  users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row' + (u.status === 'pending' ? ' pending' : '');
    const when = u.created_at ? new Date(u.created_at * 1000).toLocaleDateString('id-ID') : '';
    const info = document.createElement('div');
    info.className = 'user-info';
    info.innerHTML = `
      <div class="u-name">${escHtml(u.name)} <span class="u-status ${escHtml(u.status)}">${escHtml(u.status)}</span></div>
      <div class="u-meta">${escHtml(u.email)} · ${escHtml(u.role)} · daftar ${escHtml(when)}</div>`;
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'u-actions';
    if (u.role !== 'superadmin') {
      if (u.status !== 'active') {
        const ok = document.createElement('button');
        ok.className = 'u-btn ok'; ok.textContent = '✓ Setujui';
        ok.addEventListener('click', () => updateUser(u.id, { status: 'active' }));
        actions.appendChild(ok);
      }
      if (u.status === 'active') {
        const off = document.createElement('button');
        off.className = 'u-btn off'; off.textContent = 'Nonaktifkan';
        off.addEventListener('click', () => updateUser(u.id, { status: 'disabled' }));
        actions.appendChild(off);
      }
      const no = document.createElement('button');
      no.className = 'u-btn no'; no.textContent = '✕ Tolak';
      no.addEventListener('click', () => rejectUser(u.id, u.name));
      actions.appendChild(no);
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function updateUser(id, body) {
  try {
    await api.patch(`/api/auth/users/${id}`, body);
    await loadUsers();
    refreshPendingCount();
  } catch (err) { alert('Gagal: ' + err.message); }
}

async function rejectUser(id, name) {
  if (!confirm(`Tolak & hapus pendaftaran "${name}"?`)) return;
  try {
    await api.delete(`/api/auth/users/${id}`);
    await loadUsers();
    refreshPendingCount();
  } catch (err) { alert('Gagal: ' + err.message); }
}

// ─── Sync K3I via token browser (KHUSUS SUPERADMIN) ───────────────────────
function openK3iModal() {
  document.getElementById('k3i-result').textContent = '';
  document.getElementById('k3i-modal').style.display = 'flex';
}
function closeK3iModal() { document.getElementById('k3i-modal').style.display = 'none'; }
async function syncK3iToken() {
  const input = document.getElementById('k3i-token-input');
  const result = document.getElementById('k3i-result');
  const btn = document.getElementById('btn-k3i-sync');
  const token = (input.value || '').trim();
  if (token.length < 20) { result.style.color = '#f87171'; result.textContent = 'Token tidak valid.'; return; }
  btn.disabled = true; result.style.color = 'var(--text-muted)'; result.textContent = 'Menyinkronkan… (bisa beberapa detik)';
  try {
    const r = await api.post('/api/stream/k3i/token', { token });
    result.style.color = '#4ade80';
    result.textContent = `Berhasil: ${r.updated ?? 0} kamera diperbarui dari ${r.fetched ?? 0} (koordinat: ${r.withCoords ?? 0}).`;
    input.value = '';
    await loadCameras();
  } catch (e) {
    result.style.color = '#f87171';
    result.textContent = 'Gagal: ' + (e.message || 'error') + ' — pastikan token K3I masih valid.';
  } finally { btn.disabled = false; }
}

// ─── Static event listeners (no inline handlers in HTML) ──────────────────
document.getElementById('btn-users').addEventListener('click', openUsersModal);
document.getElementById('btn-users-close').addEventListener('click', closeUsersModal);
document.getElementById('users-modal').addEventListener('click', (e) => {
  if (e.target.id === 'users-modal') closeUsersModal();
});
document.getElementById('btn-k3i').addEventListener('click', openK3iModal);
document.getElementById('btn-k3i-close').addEventListener('click', closeK3iModal);
document.getElementById('btn-k3i-sync').addEventListener('click', syncK3iToken);
document.getElementById('k3i-modal').addEventListener('click', (e) => {
  if (e.target.id === 'k3i-modal') closeK3iModal();
});
document.getElementById('btn-logout').addEventListener('click', doLogout);
document.getElementById('btn-clear-all').addEventListener('click', clearAllSlots);
document.getElementById('btn-grid-4').addEventListener('click', function() { setGridSize(4, this); });
document.getElementById('btn-grid-8').addEventListener('click', function() { setGridSize(8, this); });

// ── Grid layar penuh (video wall) ──────────────────────────────────────────
function toggleGridFullscreen() {
  const el = document.querySelector('.grid-panel');
  const btn = document.getElementById('btn-fullscreen');
  const on = el.classList.toggle('grid-fullscreen');   // utama: class (andal)
  if (btn) btn.textContent = on ? '⛶ Keluar' : '⛶ Layar Penuh';
  try {
    if (on) { const req = el.requestFullscreen || el.webkitRequestFullscreen; if (req) req.call(el).catch(() => {}); }
    else if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
  } catch {}
}
document.getElementById('btn-fullscreen').addEventListener('click', toggleGridFullscreen);
// Sinkron saat user keluar fullscreen via Esc / gesture OS.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    const el = document.querySelector('.grid-panel');
    if (el && el.classList.contains('grid-fullscreen')) {
      el.classList.remove('grid-fullscreen');
      const btn = document.getElementById('btn-fullscreen');
      if (btn) btn.textContent = '⛶ Layar Penuh';
    }
  }
});
document.getElementById('topbar-logo-img').addEventListener('error', function() { this.style.display = 'none'; });
document.getElementById('filter-all').addEventListener('click', function() { setStatusFilter('all', this); });
document.getElementById('filter-online').addEventListener('click', function() { setStatusFilter('online', this); });
document.getElementById('filter-offline').addEventListener('click', function() { setStatusFilter('offline', this); });
document.getElementById('btn-refresh-health').addEventListener('click', refreshHealth);

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
