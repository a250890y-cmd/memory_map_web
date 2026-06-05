import './style.css';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { saveMemory, getAllMemories, updateMemory, migrateLocalData, deleteMemory } from './storage';
import { processLocalPhoto } from './local_photos';
import { auth } from './firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';

const categoryLabels = {
  camera: '写真', food: '食事', cafe: 'カフェ', sightseeing: '観光',
  nature: '景色', hotel: '宿泊', shopping: '買い物'
};

const mapStyles = {
  standard: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap'
      }
    },
    layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm' }]
  },
  satellite: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      esri: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '&copy; Esri'
      }
    },
    layers: [{ id: 'esri-tiles', type: 'raster', source: 'esri' }]
  },
  dark: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      carto: {
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; CARTO'
      }
    },
    layers: [{ id: 'carto-tiles', type: 'raster', source: 'carto' }]
  }
};

let map;
let allMemories = [];
let tempMarker = null;
let currentPopup = null;
let tempPopup = null;
let tourTimeout = null;

let currentLat = 36.2048;
let currentLng = 138.2529;
let currentPhotoUrls = [];
let currentFilterAlbum = '';
let currentFilterTag = '';
let currentSearchQuery = '';
let currentDateFrom = '';
let currentDateTo = '';
let currentTags = [];

async function init() {
  const japanCenter = [138.2529, 36.2048]; // Lng, Lat
  
  map = new maplibregl.Map({
    container: 'map',
    style: mapStyles.standard,
    center: japanCenter,
    zoom: 4,
    pitch: 0,
    projection: { type: 'globe' }, // ENABLE 3D GLOBE
    attributionControl: false
  });
  
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  setupEventListeners();

  map.on('style.load', () => {
    initMapLayers();
    renderMarkers();
  });

  map.on('contextmenu', (e) => {
    placeTempMarker(e.lngLat.lat, e.lngLat.lng);
  });
  
  // Custom click handling for gallery and editing
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('btn-edit-popup')) {
      const id = e.target.getAttribute('data-id');
      openMemoryModal(id);
    }
    if (e.target && e.target.classList.contains('popup-image')) {
      openFullscreenImage(e.target.src);
    }
    if (e.target && e.target.classList.contains('carousel-btn')) {
      const dir = e.target.classList.contains('next') ? 1 : -1;
      const gallery = e.target.parentElement.querySelector('.popup-gallery');
      if (gallery) {
        gallery.scrollBy({ left: dir * gallery.clientWidth, behavior: 'smooth' });
      }
    }
  });

  const loginModal = document.getElementById('login-modal');
  const loadingOverlay = document.getElementById('loading-overlay');
  
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      loginModal.classList.add('hidden');
      loadingOverlay.classList.remove('hidden');
      try {
        await migrateLocalData();
        await loadMemories();
      } catch (e) {
        console.error("Error loading data:", e);
      }
      loadingOverlay.classList.add('hidden');
    } else {
      loginModal.classList.remove('hidden');
      allMemories = [];
      renderSidebar();
      renderMarkers();
    }
  });
}

function initMapLayers() {
  if (!map.getSource('memories')) {
    map.addSource('memories', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 50
    });

    // Clusters circle
    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'memories',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#3b82f6',
        'circle-radius': ['step', ['get', 'point_count'], 20, 10, 30, 50, 40],
        'circle-stroke-width': 3,
        'circle-stroke-color': '#ffffff'
      }
    });

    // Cluster count text
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'memories',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': '{point_count_abbreviated}',
        'text-size': 14
      },
      paint: {
        'text-color': '#ffffff'
      }
    });

    // Unclustered point (red dot)
    map.addLayer({
      id: 'unclustered-point',
      type: 'circle',
      source: 'memories',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#ef4444',
        'circle-radius': 10,
        'circle-stroke-width': 3,
        'circle-stroke-color': '#ffffff'
      }
    });

    // Interaction handlers
    map.on('click', 'clusters', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
      const clusterId = features[0].properties.cluster_id;
      map.getSource('memories').getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom });
      });
    });

    map.on('click', 'unclustered-point', (e) => {
      const props = JSON.parse(e.features[0].properties.memoryObj);
      const coordinates = e.features[0].geometry.coordinates.slice();
      
      while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
        coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
      }
      
      openPopup(props, coordinates);
    });

    map.on('mouseenter', 'clusters', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'clusters', () => map.getCanvas().style.cursor = '');
    map.on('mouseenter', 'unclustered-point', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'unclustered-point', () => map.getCanvas().style.cursor = '');
  }
}

function buildPopupHtml(memory) {
  const imagesHtml = (memory.imageUrls || []).map(url => `<img src="${url}" class="popup-image" style="cursor: pointer;" />`).join('');
  let displayDate = new Date(memory.timestamp).toLocaleDateString();
  if (memory.datetime) {
    const dt = new Date(memory.datetime);
    displayDate = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  }
  
  const galleryHtml = imagesHtml ? `
    <div class="popup-gallery-container">
      <div class="popup-gallery">${imagesHtml}</div>
      ${(memory.imageUrls || []).length > 1 ? `
        <button class="carousel-btn prev">❮</button>
        <button class="carousel-btn next">❯</button>
      ` : ''}
    </div>
  ` : '';
  
  const tagsHtml = (memory.tags || []).map(t => `<div class="popup-tag">${t}</div>`).join('');

  return `
    <div style="min-width: 240px; max-width: 300px;">
      ${galleryHtml}
      <div style="padding: 0 16px 16px 16px; margin-top: ${imagesHtml ? '0' : '16px'};">
        ${tagsHtml ? `<div class="popup-tags">${tagsHtml}</div>` : ''}
        ${memory.album ? `<div class="popup-category" style="margin-bottom: 4px;">📂 ${memory.album}</div>` : ''}
        <div class="popup-title">${memory.title || '無題の思い出'}</div>
        <div class="popup-diary">${memory.diary || ''}</div>
        <div class="popup-meta">
          <span>${displayDate}</span>
          <button class="btn-edit-popup" data-id="${memory.id}">編集する</button>
        </div>
      </div>
    </div>
  `;
}

function openPopup(memory, coordinates) {
  if (currentPopup) currentPopup.remove();
  const html = buildPopupHtml(memory);
  currentPopup = new maplibregl.Popup({ closeButton: false, maxWidth: '320px' })
    .setLngLat(coordinates)
    .setHTML(html)
    .addTo(map);
}

function placeTempMarker(lat, lng) {
  if (tempMarker) tempMarker.remove();
  
  const el = document.createElement('div');
  el.className = 'custom-div-icon';
  el.style.backgroundColor = '#3b82f6';
  el.style.width = '24px'; el.style.height = '24px';
  el.style.borderRadius = '50%'; el.style.border = '3px solid white';
  el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
  el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';
  el.style.color = 'white'; el.style.fontSize = '14px'; el.style.fontWeight = 'bold';
  el.innerHTML = '+';
  
  tempMarker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lng, lat])
    .addTo(map);
    
  const popupHtml = `<div style="display: flex; flex-direction: column; align-items: center; text-align: center; width: 100%;">
                      <button id="btn-add-here" class="btn primary" style="padding: 6px 12px; font-size: 0.9rem; border-radius: 8px; width: 100%;">この場所に思い出を追加</button>
                      <div style="font-size: 0.75rem; color: #666; margin-top: 8px;">ピンはドラッグして移動できます</div>
                    </div>`;
                    
  tempPopup = new maplibregl.Popup({ closeButton: false }).setHTML(popupHtml);
  tempMarker.setPopup(tempPopup);
  tempMarker.togglePopup();
  
  tempPopup.on('open', () => {
    const btn = document.getElementById('btn-add-here');
    if (btn) btn.addEventListener('click', () => openMemoryModal());
  });

  tempMarker.on('dragend', () => {
    const pos = tempMarker.getLngLat();
    currentLat = pos.lat;
    currentLng = pos.lng;
    tempMarker.togglePopup();
  });
  
  currentLat = lat;
  currentLng = lng;
}

async function loadMemories() {
  allMemories = await getAllMemories();
  allMemories.forEach(m => {
    if (m.imageUrl && !m.imageUrls) m.imageUrls = [m.imageUrl];
    if (m.category && !m.tags) m.tags = [categoryLabels[m.category] || m.category];
    if (!m.tags) m.tags = [];
  });
  renderSidebar();
  renderMarkers();
}

function renderMarkers() {
  if (!map.getSource('memories')) return; // Not loaded yet
  
  const filtered = getFilteredMemories();
  const features = filtered.map(m => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
    properties: { memoryObj: JSON.stringify(m) }
  }));
  
  map.getSource('memories').setData({
    type: 'FeatureCollection',
    features
  });
}

function getFilteredMemories() {
  let filtered = allMemories;
  if (currentFilterAlbum) filtered = filtered.filter(m => m.album === currentFilterAlbum);
  if (currentFilterTag) filtered = filtered.filter(m => m.tags && m.tags.includes(currentFilterTag));
  if (currentSearchQuery) {
    const q = currentSearchQuery.toLowerCase();
    filtered = filtered.filter(m => 
      (m.title && m.title.toLowerCase().includes(q)) || 
      (m.diary && m.diary.toLowerCase().includes(q))
    );
  }
  if (currentDateFrom) {
    const fromDate = new Date(currentDateFrom).getTime();
    filtered = filtered.filter(m => {
      const dt = m.datetime ? new Date(m.datetime) : new Date(m.timestamp);
      return dt.getTime() >= fromDate;
    });
  }
  if (currentDateTo) {
    const toDate = new Date(currentDateTo);
    toDate.setHours(23, 59, 59, 999);
    const toTime = toDate.getTime();
    filtered = filtered.filter(m => {
      const dt = m.datetime ? new Date(m.datetime) : new Date(m.timestamp);
      return dt.getTime() <= toTime;
    });
  }
  return filtered;
}

function renderSidebar() {
  // Albums
  const albums = [...new Set(allMemories.map(m => m.album).filter(Boolean))];
  const albumListEl = document.getElementById('sidebar-album-list');
  const albumDataList = document.getElementById('album-datalist');
  
  albumListEl.innerHTML = '';
  const albumAllLi = document.createElement('li');
  albumAllLi.textContent = 'すべて表示';
  if (currentFilterAlbum === '') albumAllLi.classList.add('active');
  albumAllLi.addEventListener('click', () => setAlbumFilter(''));
  albumListEl.appendChild(albumAllLi);
  
  albums.forEach(album => {
    const li = document.createElement('li');
    li.textContent = album;
    if (currentFilterAlbum === album) li.classList.add('active');
    li.addEventListener('click', () => setAlbumFilter(album));
    albumListEl.appendChild(li);
  });
  
  albumDataList.innerHTML = '';
  albums.forEach(album => {
    const opt = document.createElement('option');
    opt.value = album;
    albumDataList.appendChild(opt);
  });

  // Tags
  let allTags = [];
  allMemories.forEach(m => {
    if (m.tags) allTags.push(...m.tags);
  });
  const uniqueTags = [...new Set(allTags)];
  
  const tagListEl = document.getElementById('sidebar-tag-list');
  const tagDataList = document.getElementById('tag-datalist');
  
  tagListEl.innerHTML = '';
  const tagAllLi = document.createElement('li');
  tagAllLi.textContent = 'すべて表示';
  if (currentFilterTag === '') tagAllLi.classList.add('active');
  tagAllLi.addEventListener('click', () => setTagFilter(''));
  tagListEl.appendChild(tagAllLi);
  
  uniqueTags.forEach(tag => {
    const li = document.createElement('li');
    li.textContent = tag;
    if (currentFilterTag === tag) li.classList.add('active');
    li.addEventListener('click', () => setTagFilter(tag));
    tagListEl.appendChild(li);
  });

  tagDataList.innerHTML = '';
  uniqueTags.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    tagDataList.appendChild(opt);
  });
}

function setAlbumFilter(albumName) {
  currentFilterAlbum = albumName;
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  renderSidebar();
  renderMarkers();
}

function setTagFilter(tagName) {
  currentFilterTag = tagName;
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  renderSidebar();
  renderMarkers();
}

function toDatetimeLocal(date) {
  const d = new Date(date);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updatePreviewGallery() {
  const container = document.getElementById('preview-images-container');
  const placeholder = document.getElementById('preview-placeholder');
  
  container.innerHTML = '';
  
  if (currentPhotoUrls.length > 0) {
    currentPhotoUrls.forEach((url, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview-img-wrapper';
      
      const img = document.createElement('img');
      img.src = url;
      img.className = 'popup-image';
      img.style.cursor = 'pointer';
      
      const rmBtn = document.createElement('button');
      rmBtn.className = 'btn-remove-photo';
      rmBtn.innerHTML = '✕';
      rmBtn.onclick = (e) => {
        e.stopPropagation();
        currentPhotoUrls.splice(index, 1);
        updatePreviewGallery();
      };
      
      wrapper.appendChild(img);
      wrapper.appendChild(rmBtn);
      container.appendChild(wrapper);
    });
    container.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    container.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

function updateTagChips() {
  const container = document.getElementById('tags-container');
  const input = document.getElementById('memory-tag-input');
  
  container.querySelectorAll('.tag-chip').forEach(el => el.remove());
  
  currentTags.forEach((tag, index) => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.innerHTML = `${tag}<button type="button" data-index="${index}">✕</button>`;
    container.insertBefore(chip, input);
  });
  
  container.querySelectorAll('.tag-chip button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = e.target.getAttribute('data-index');
      currentTags.splice(idx, 1);
      updateTagChips();
    });
  });
}

function openMemoryModal(id = null) {
  if (tempMarker) tempMarker.remove(); tempMarker = null;
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  
  const modal = document.getElementById('memory-modal');
  const titleInput = document.getElementById('memory-title');
  const diaryInput = document.getElementById('memory-diary');
  const albumInput = document.getElementById('memory-album');
  const datetimeInput = document.getElementById('memory-datetime');
  const idInput = document.getElementById('memory-id');
  const modalTitle = document.getElementById('modal-title');
  const btnDelete = document.getElementById('btn-delete-memory');
  const tagInput = document.getElementById('memory-tag-input');
  
  tagInput.value = '';

  if (id !== null) {
    const memory = allMemories.find(m => m.id === id);
    if (!memory) return;
    
    modalTitle.textContent = '思い出を編集';
    idInput.value = memory.id;
    titleInput.value = memory.title || '';
    diaryInput.value = memory.diary || '';
    albumInput.value = memory.album || '';
    currentTags = [...(memory.tags || [])];
    currentPhotoUrls = [...(memory.imageUrls || [])];
    currentLat = memory.lat;
    currentLng = memory.lng;
    
    if (memory.datetime) {
      datetimeInput.value = toDatetimeLocal(memory.datetime);
    } else {
      datetimeInput.value = toDatetimeLocal(memory.timestamp);
    }
    
    btnDelete.classList.remove('hidden');
  } else {
    modalTitle.textContent = '思い出を記録';
    idInput.value = '';
    titleInput.value = '';
    diaryInput.value = '';
    albumInput.value = '';
    currentTags = [];
    datetimeInput.value = toDatetimeLocal(new Date());
    currentPhotoUrls = [];
    
    btnDelete.classList.add('hidden');
  }
  
  updatePreviewGallery();
  updateTagChips();
  modal.classList.remove('hidden');
}

function openFullscreenImage(src) {
  const modal = document.getElementById('fullscreen-image-modal');
  const img = document.getElementById('fullscreen-image');
  img.src = src;
  modal.classList.remove('hidden');
}

async function playAlbumTour() {
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  if (currentPopup) currentPopup.remove();
  
  let memoriesToPlay = getFilteredMemories();
  if (memoriesToPlay.length === 0) return alert("表示する思い出がありません。");
  
  memoriesToPlay.sort((a, b) => new Date(a.datetime || a.timestamp).getTime() - new Date(b.datetime || b.timestamp).getTime());
  
  const coordinates = memoriesToPlay.map(m => [m.lng, m.lat]);
  
  if (map.getSource('tour-line')) {
    map.getSource('tour-line').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates } });
  } else {
    map.addSource('tour-line', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates } } });
    map.addLayer({
      id: 'tour-line-layer',
      type: 'line',
      source: 'tour-line',
      paint: { 'line-color': '#ef4444', 'line-width': 3, 'line-dasharray': [3, 3] }
    });
  }
  
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  for (const coord of coordinates) bounds.extend(coord);
  map.fitBounds(bounds, { padding: 50, duration: 1000, pitch: 0, bearing: 0 });

  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('open');
    overlay.classList.add('hidden');
  }

  let index = 0;
  const playNext = () => {
    if (index >= memoriesToPlay.length) {
      if (map.getLayer('tour-line-layer')) map.removeLayer('tour-line-layer');
      if (map.getSource('tour-line')) map.removeSource('tour-line');
      map.easeTo({ pitch: 0, bearing: 0, duration: 2000 });
      return;
    }
    const mem = memoriesToPlay[index];
    
    // Cinematic 3D flyTo
    map.flyTo({
      center: [mem.lng, mem.lat],
      zoom: 16,
      pitch: 60,
      bearing: (index * 45) % 360, // Rotate camera around
      duration: 3000,
      essential: true
    });
    
    tourTimeout = setTimeout(() => {
      openPopup(mem, [mem.lng, mem.lat]);
      index++;
      tourTimeout = setTimeout(playNext, 4000);
    }, 3200);
  };
  
  tourTimeout = setTimeout(playNext, 1500);
}

function setupEventListeners() {
  const memoryModal = document.getElementById('memory-modal');
  const loadingOverlay = document.getElementById('loading-overlay');
  const btnHamburger = document.getElementById('btn-hamburger');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebar = document.querySelector('.sidebar');
  
  const toggleSidebar = () => {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('hidden');
  };
  const closeSidebar = () => {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.add('hidden');
  };
  
  btnHamburger.addEventListener('click', toggleSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);
  
  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const btnLogin = document.getElementById('btn-login');
  const btnSignup = document.getElementById('btn-signup');
  const btnLogout = document.getElementById('btn-logout');
  const loginError = document.getElementById('login-error');

  const handleAuth = async (action) => {
    const email = emailInput.value.trim();
    const pwd = passwordInput.value.trim();
    if (!email || !pwd) {
      loginError.textContent = "メールアドレスとパスワードを入力してください";
      loginError.style.display = 'block';
      return;
    }
    loginError.style.display = 'none';
    loadingOverlay.classList.remove('hidden');
    try {
      if (action === 'login') await signInWithEmailAndPassword(auth, email, pwd);
      else await createUserWithEmailAndPassword(auth, email, pwd);
      loadingOverlay.classList.add('hidden');
    } catch (e) {
      loadingOverlay.classList.add('hidden');
      loginError.textContent = "エラー: " + e.message;
      loginError.style.display = 'block';
    }
  };

  btnLogin.addEventListener('click', () => handleAuth('login'));
  btnSignup.addEventListener('click', () => handleAuth('signup'));
  btnLogout.addEventListener('click', () => signOut(auth));

  const fileInput = document.getElementById('file-input');
  const btnSelectPhoto = document.getElementById('btn-select-photo');
  const btnSave = document.getElementById('btn-save-memory');
  const btnDeleteMemory = document.getElementById('btn-delete-memory');
  const btnCloseList = document.querySelectorAll('.btn-close');

  const titleInput = document.getElementById('memory-title');
  const diaryInput = document.getElementById('memory-diary');
  const albumInput = document.getElementById('memory-album');
  const datetimeInput = document.getElementById('memory-datetime');
  const idInput = document.getElementById('memory-id');
  const tagInput = document.getElementById('memory-tag-input');
  const tagsContainer = document.getElementById('tags-container');
  
  tagsContainer.addEventListener('click', () => tagInput.focus());
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === '　' || e.key === ',') {
      e.preventDefault();
      const val = tagInput.value.trim().replace(',', '');
      if (val && !currentTags.includes(val)) {
        currentTags.push(val);
        updateTagChips();
      }
      tagInput.value = '';
    }
  });

  const mapStyleSelect = document.getElementById('map-style-select');
  mapStyleSelect.addEventListener('change', (e) => {
    map.setStyle(mapStyles[e.target.value]);
  });
  
  const searchInput = document.getElementById('search-input');
  const dateFrom = document.getElementById('filter-date-from');
  const dateTo = document.getElementById('filter-date-to');
  
  searchInput.addEventListener('input', (e) => { currentSearchQuery = e.target.value; renderMarkers(); });
  dateFrom.addEventListener('change', (e) => { currentDateFrom = e.target.value; renderMarkers(); });
  dateTo.addEventListener('change', (e) => { currentDateTo = e.target.value; renderMarkers(); });

  const btnCurrentLocation = document.getElementById('btn-current-location');
  const btnPinCurrent = document.getElementById('btn-pin-current');
  const btnPlayTour = document.getElementById('btn-play-tour');
  const fullscreenModal = document.getElementById('fullscreen-image-modal');
  const btnCloseFullscreen = document.getElementById('btn-close-fullscreen');
  
  btnPlayTour.addEventListener('click', playAlbumTour);
  btnCloseFullscreen.addEventListener('click', () => fullscreenModal.classList.add('hidden'));
  fullscreenModal.addEventListener('click', (e) => { if (e.target === fullscreenModal) fullscreenModal.classList.add('hidden'); });

  btnCurrentLocation.addEventListener('click', () => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(position => {
        map.flyTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 15 });
      }, err => alert("現在地の取得に失敗しました。"));
    } else alert("ブラウザが非対応です。");
  });

  btnPinCurrent.addEventListener('click', () => {
    if ("geolocation" in navigator) {
      loadingOverlay.classList.remove('hidden');
      navigator.geolocation.getCurrentPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        map.flyTo({ center: [lng, lat], zoom: 15 });
        placeTempMarker(lat, lng);
        setTimeout(() => openMemoryModal(), 600);
        loadingOverlay.classList.add('hidden');
      }, err => {
        loadingOverlay.classList.add('hidden');
        alert("現在地の取得に失敗しました。");
      });
    } else alert("ブラウザが非対応です。");
  });
  
  const hideModal = () => {
    memoryModal.classList.add('hidden');
    if (tempMarker && idInput.value === '') {
      tempMarker.remove();
      tempMarker = null;
    }
  };

  btnCloseList.forEach(btn => btn.addEventListener('click', hideModal));

  btnSelectPhoto.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG' || e.target.closest('.btn-remove-photo')) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      loadingOverlay.classList.remove('hidden');
      try {
        const files = Array.from(e.target.files);
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const data = await processLocalPhoto(file);
          currentPhotoUrls.push(data.imageUrl);
          
          if (i === 0 && idInput.value === '' && currentPhotoUrls.length === 1) {
             if (data.lat !== null && data.lng !== null) {
               currentLat = data.lat;
               currentLng = data.lng;
               if (tempMarker) tempMarker.setLngLat([currentLng, currentLat]);
               map.flyTo({ center: [currentLng, currentLat], zoom: 13 });
             }
             if (data.datetime) datetimeInput.value = toDatetimeLocal(data.datetime);
          }
        }
        updatePreviewGallery();
        loadingOverlay.classList.add('hidden');
      } catch (err) {
        alert("画像の処理に失敗しました");
        loadingOverlay.classList.add('hidden');
      }
    }
    fileInput.value = '';
  });
  
  btnDeleteMemory.addEventListener('click', async () => {
    if (!confirm("本当にこの思い出を削除しますか？")) return;
    const id = idInput.value;
    if (!id) return;
    
    loadingOverlay.classList.remove('hidden');
    try {
      const memory = allMemories.find(m => m.id === id);
      await deleteMemory(id, memory ? memory.imageUrls : []);
      allMemories = allMemories.filter(m => m.id !== id);
      
      renderSidebar();
      renderMarkers();
      hideModal();
      if (currentPopup) currentPopup.remove();
    } catch(err) {
      console.error(err);
      alert("削除に失敗しました");
    }
    loadingOverlay.classList.add('hidden');
  });

  btnSave.addEventListener('click', async () => {
    if (currentPhotoUrls.length === 0 && !titleInput.value) return alert("写真かタイトルを入力してください！");
    
    const leftoverTag = tagInput.value.trim().replace(',', '');
    if (leftoverTag && !currentTags.includes(leftoverTag)) currentTags.push(leftoverTag);
    
    const title = titleInput.value.trim();
    const diary = diaryInput.value.trim();
    const album = albumInput.value.trim();
    const datetimeStr = datetimeInput.value;
    const isEdit = idInput.value !== '';
    
    const memory = {
      lat: currentLat,
      lng: currentLng,
      imageUrls: currentPhotoUrls,
      title, diary, album, tags: currentTags,
      datetime: datetimeStr ? new Date(datetimeStr).toISOString() : null
    };
    
    loadingOverlay.classList.remove('hidden');
    try {
      if (isEdit) {
        memory.id = idInput.value;
        const existing = allMemories.find(m => m.id === memory.id);
        memory.timestamp = existing ? existing.timestamp : new Date().toISOString();
        await updateMemory(memory);
        const index = allMemories.findIndex(m => m.id === memory.id);
        if (index !== -1) allMemories[index] = memory;
      } else {
        memory.id = await saveMemory(memory);
        memory.timestamp = new Date().toISOString();
        allMemories.push(memory);
      }
      
      renderSidebar();
      renderMarkers();
      map.flyTo({ center: [memory.lng, memory.lat], zoom: 13 });
      hideModal();
    } catch (err) {
      console.error(err);
      alert("保存に失敗しました: " + err.message);
    }
    loadingOverlay.classList.add('hidden');
  });
}

init();
