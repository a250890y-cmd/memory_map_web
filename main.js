import './style.css';
import 'leaflet/dist/leaflet.css';
import L from './leaflet-setup';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet-control-geocoder/dist/Control.Geocoder.css';
import 'leaflet-control-geocoder';
import { saveMemory, getAllMemories, updateMemory, deleteMemory } from './storage';
import { processLocalPhoto } from './local_photos';
import { auth } from './firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

const categoryLabels = {
  camera: '写真', food: '食事', cafe: 'カフェ', sightseeing: '観光',
  nature: '景色', hotel: '宿泊', shopping: '買い物'
};

const mapLayers = {
  standard: L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], attribution: '&copy; Google' }),
  satellite: L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], attribution: '&copy; Google' }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CARTO' })
};

let map;
let currentLayer = mapLayers.standard;
let allMemories = [];
let markersLayer;
let tempMarker = null;
let tourPolyline = null;
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
let customAlbumCovers = JSON.parse(localStorage.getItem('customAlbumCovers')) || {};
let currentEditingAlbumName = null;
let currentSelectedCoverUrl = null;

let homeLocation = JSON.parse(localStorage.getItem('homeLocation')) || null;
let homeMarker = null;

function renderHomeMarker() {
  if (homeMarker) {
    map.removeLayer(homeMarker);
    homeMarker = null;
  }
  if (homeLocation) {
    const homeIcon = L.divIcon({
      className: 'custom-div-icon',
      html: `
        <svg width="28" height="37" viewBox="0 0 44 58" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0px 3px 4px rgba(0,0,0,0.4));">
          <path d="M 22 2 C 10.95 2 2 10.95 2 22 C 2 37 22 56 22 56 C 22 56 42 37 42 22 C 42 10.95 33.05 2 22 2 Z" fill="#3b3b3b" stroke="white" stroke-width="2"/>
          <path d="M 12 23 L 22 14 L 32 23 V 31 A 2 2 0 0 1 30 33 H 14 A 2 2 0 0 1 12 31 Z" fill="white"/>
          <path d="M 19 33 V 26 H 25 V 33 Z" fill="#3b3b3b"/>
        </svg>
      `,
      iconSize: [28, 37],
      iconAnchor: [14, 36]
    });
    homeMarker = L.marker([homeLocation.lat, homeLocation.lng], { icon: homeIcon }).addTo(map);
    homeMarker.bindPopup('<div style="text-align: center;"><b>自宅</b><br><button class="btn primary" style="padding: 4px 8px; margin-top: 8px; font-size: 0.8rem; border-radius: 4px;" onclick="clearHomeLocation()">解除する</button></div>');
  }
}

window.clearHomeLocation = function() {
  homeLocation = null;
  localStorage.removeItem('homeLocation');
  renderHomeMarker();
  if (currentFilterAlbum) drawAlbumRoute(getFilteredMemories());
};

async function drawAlbumRoute(memories) {
  if (tourPolyline) {
    map.removeLayer(tourPolyline);
    tourPolyline = null;
  }

  if (!memories || memories.length === 0) return;

  const sorted = [...memories].sort((a, b) => {
    const tA = new Date(a.datetime || a.timestamp).getTime();
    const tB = new Date(b.datetime || b.timestamp).getTime();
    return tA - tB;
  });

  const latlngs = sorted.map(m => [m.lat, m.lng]);
  if (homeLocation) {
    latlngs.unshift([homeLocation.lat, homeLocation.lng]);
    latlngs.push([homeLocation.lat, homeLocation.lng]);
  }

  let routeCoords = latlngs;
  if (latlngs.length >= 2) {
    try {
      const coordsString = latlngs.map(ll => `${ll[1]},${ll[0]}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("OSRM API error");
      const data = await res.json();
      if (data.code === "Ok" && data.routes && data.routes.length > 0) {
        routeCoords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      }
    } catch (e) {
      console.warn("OSRMルート取得失敗、直線描画に切り替えます:", e);
    }
    tourPolyline = L.polyline(routeCoords, {color: '#ef4444', weight: 3, dashArray: '10, 10'}).addTo(map);
  }
}

async function init() {
  const japanCenter = [36.2048, 138.2529];
  map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView(japanCenter, 5);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.Control.geocoder({
    position: 'topright',
    placeholder: '場所を検索...',
    defaultMarkGeocode: false
  })
  .on('markgeocode', function(e) {
    const latlng = e.geocode.center;
    map.flyTo(latlng, 13);
  })
  .addTo(map);

  currentLayer.addTo(map);
  
  renderHomeMarker();

  map.on('contextmenu', (e) => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const popupContent = document.createElement('div');
    popupContent.innerHTML = `<div style="text-align: center;">
      <button class="btn primary" style="padding: 6px 12px; font-size: 0.9rem; border-radius: 8px; width: 100%;">ここを自宅に設定する</button>
    </div>`;
    
    popupContent.querySelector('button').addEventListener('click', () => {
      homeLocation = { lat, lng };
      localStorage.setItem('homeLocation', JSON.stringify(homeLocation));
      renderHomeMarker();
      map.closePopup();
      if (currentFilterAlbum) drawAlbumRoute(getFilteredMemories());
    });
    
    L.popup()
      .setLatLng(e.latlng)
      .setContent(popupContent)
      .openOn(map);
  });
  
  markersLayer = L.markerClusterGroup({
    maxClusterRadius: 40,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true
  });
  map.addLayer(markersLayer);

  setupEventListeners();

  map.on('contextmenu', (e) => {
    placeTempMarker(e.latlng.lat, e.latlng.lng);
  });
  
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('btn-edit-popup')) {
      const id = e.target.getAttribute('data-id');
      openMemoryModal(id);
    }
    if (e.target && e.target.classList.contains('popup-image')) {
      const container = e.target.closest('.popup-gallery-container');
      if (container) {
        const imgs = Array.from(container.querySelectorAll('.popup-image'));
        const urls = imgs.map(img => img.src);
        const idx = imgs.indexOf(e.target);
        openFullscreenImage(urls, idx >= 0 ? idx : 0);
      } else {
        openFullscreenImage([e.target.src], 0);
      }
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
  const userInfoBar = document.getElementById('user-info-bar');
  const userEmailText = document.getElementById('user-email-text');
  const btnOpenLogin = document.getElementById('btn-open-login');
  
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      if (loginModal) loginModal.classList.add('hidden');
      if (userInfoBar) userInfoBar.style.display = 'flex';
      if (btnOpenLogin) btnOpenLogin.style.display = 'none';
      if (userEmailText) userEmailText.textContent = user.email || 'ログイン中';

      if (loadingOverlay) loadingOverlay.classList.remove('hidden');
      try {
        await loadMemories();
      } catch (e) {
        console.error("Error loading data:", e);
      }
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    } else {
      if (loginModal) loginModal.classList.remove('hidden');
      if (userInfoBar) userInfoBar.style.display = 'none';
      if (btnOpenLogin) btnOpenLogin.style.display = 'flex';
      allMemories = [];
      renderSidebar();
      renderMarkers();
    }
  });
}

function placeTempMarker(lat, lng) {
  if (tempMarker) {
    tempMarker.setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      className: 'custom-div-icon',
      html: `<div style="background-color: #3b82f6; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 10px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; color: white; font-size: 14px; font-weight: bold;">+</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    tempMarker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
    
    const popupContent = document.createElement('div');
    popupContent.innerHTML = `<div style="display: flex; flex-direction: column; align-items: center; text-align: center; width: 100%;">
                                <button class="btn primary" style="padding: 6px 12px; font-size: 0.9rem; border-radius: 8px; width: 100%;">この場所に思い出を追加</button>
                                <div style="font-size: 0.75rem; color: #666; margin-top: 8px;">ピンはドラッグして移動できます</div>
                              </div>`;
    popupContent.querySelector('button').addEventListener('click', () => {
      openMemoryModal();
    });
    
    tempMarker.bindPopup(popupContent, { closeButton: false });
    
    tempMarker.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      currentLat = pos.lat;
      currentLng = pos.lng;
      tempMarker.openPopup();
    });
  }
  
  currentLat = lat;
  currentLng = lng;
  tempMarker.openPopup();
}

async function loadMemories() {
  allMemories = await getAllMemories();
  allMemories.forEach(m => {
    if (m.imageUrl && !m.imageUrls) m.imageUrls = [m.imageUrl];
    if (m.category && !m.tags) {
      m.tags = [categoryLabels[m.category] || m.category];
    }
    if (!m.tags) m.tags = [];
  });
  renderSidebar();
  renderMarkers();
}

function renderMarkers() {
  markersLayer.clearLayers();
  
  let filtered = getFilteredMemories();
    
  filtered.forEach(memory => {
    let iconHtml = `<div style="background-color: #ef4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`;
    let iconSize = [20, 20];
    let iconAnchor = [10, 10];
    
    if (memory.imageUrls && memory.imageUrls.length > 0) {
      iconHtml = `
        <div style="
          width: 40px; 
          height: 40px; 
          border-radius: 50%; 
          border: 3px solid white; 
          box-shadow: 0 4px 8px rgba(0,0,0,0.3); 
          background-image: url('${memory.imageUrls[0]}'); 
          background-size: cover; 
          background-position: center;
        "></div>
      `;
      iconSize = [46, 46];
      iconAnchor = [23, 23];
    }

    const customIcon = L.divIcon({
      className: 'custom-div-icon',
      html: iconHtml,
      iconSize: iconSize,
      iconAnchor: iconAnchor
    });

    const marker = L.marker([memory.lat, memory.lng], { icon: customIcon }).addTo(markersLayer);
    memory.marker = marker;
    
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

    const popupContent = `
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
    marker.bindPopup(popupContent);
  });
}

function getFilteredMemories() {
  let filtered = allMemories;
  if (currentFilterAlbum) {
    filtered = filtered.filter(m => m.album === currentFilterAlbum);
  }
  if (currentFilterTag) {
    filtered = filtered.filter(m => m.tags && m.tags.includes(currentFilterTag));
  }
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
  
  if (currentFilterAlbum !== '') {
    const selectedLi = document.createElement('li');
    selectedLi.className = 'active';
    selectedLi.style.display = 'flex';
    selectedLi.style.justifyContent = 'space-between';
    selectedLi.style.alignItems = 'center';
    selectedLi.innerHTML = `<span>選択中: <b>${currentFilterAlbum}</b></span><span style="font-size: 0.8rem; margin-left: 6px; opacity: 0.7;">✕</span>`;
    selectedLi.addEventListener('click', () => setAlbumFilter(''));
    albumListEl.appendChild(selectedLi);
  }
  
  const countText = document.getElementById('sidebar-album-count-text');
  if (countText) {
    countText.textContent = `(全${albums.length}件)`;
  }
  
  const previewGrid = document.getElementById('sidebar-album-preview-grid');
  if (previewGrid) {
    const allPhotos = [];
    allMemories.forEach(m => {
      if (m.imageUrls && m.imageUrls.length > 0) {
        allPhotos.push(...m.imageUrls);
      }
    });

    previewGrid.innerHTML = '';
    if (allPhotos.length === 0) {
      previewGrid.style.display = 'none';
    } else {
      previewGrid.style.display = 'grid';
      const first4 = allPhotos.slice(0, 4);
      const remainingCount = allPhotos.length - 3;

      first4.forEach((url, i) => {
        const cell = document.createElement('div');
        cell.style.position = 'relative';
        cell.style.width = '100%';
        cell.style.height = '100%';

        const img = document.createElement('img');
        img.src = url;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        cell.appendChild(img);

        if (i === 3 && remainingCount > 1) {
          const overlay = document.createElement('div');
          overlay.style.position = 'absolute';
          overlay.style.top = '0';
          overlay.style.left = '0';
          overlay.style.width = '100%';
          overlay.style.height = '100%';
          overlay.style.background = 'rgba(0,0,0,0.55)';
          overlay.style.color = 'white';
          overlay.style.fontSize = '0.65rem';
          overlay.style.fontWeight = '700';
          overlay.style.display = 'flex';
          overlay.style.alignItems = 'center';
          overlay.style.justifyContent = 'center';
          overlay.textContent = `+${remainingCount}`;
          cell.appendChild(overlay);
        }

        previewGrid.appendChild(cell);
      });
    }
  }
  
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
  
  if (tagListEl) {
    tagListEl.innerHTML = '';
    const tagAllBtn = document.createElement('button');
    tagAllBtn.className = 'sidebar-tag-chip';
    if (currentFilterTag === '') tagAllBtn.classList.add('active');
    tagAllBtn.textContent = 'すべて表示';
    tagAllBtn.addEventListener('click', () => setTagFilter(''));
    tagListEl.appendChild(tagAllBtn);
    
    uniqueTags.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'sidebar-tag-chip';
      if (currentFilterTag === tag) btn.classList.add('active');
      btn.textContent = `#${tag}`;
      btn.addEventListener('click', () => setTagFilter(tag));
      tagListEl.appendChild(btn);
    });
  }

  tagDataList.innerHTML = '';
  uniqueTags.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    tagDataList.appendChild(opt);
  });

  renderYearChips();
}

function renderYearChips() {
  const container = document.getElementById('year-chips-container');
  if (!container) return;

  const yearsSet = new Set();
  allMemories.forEach(m => {
    const rawDate = m.datetime || m.timestamp;
    if (rawDate) {
      const dt = new Date(rawDate);
      if (!isNaN(dt.getTime())) {
        yearsSet.add(dt.getFullYear());
      }
    }
  });

  const sortedYears = [...yearsSet].sort((a, b) => b - a);

  container.innerHTML = '';
  
  const allChip = document.createElement('button');
  allChip.className = 'year-chip';
  if (!currentDateFrom && !currentDateTo) allChip.classList.add('active');
  allChip.textContent = 'すべて';
  allChip.addEventListener('click', () => {
    currentDateFrom = '';
    currentDateTo = '';
    const dFrom = document.getElementById('filter-date-from');
    const dTo = document.getElementById('filter-date-to');
    if (dFrom) dFrom.value = '';
    if (dTo) dTo.value = '';
    updateYearChipsActive();
    renderMarkers();
  });
  container.appendChild(allChip);

  sortedYears.forEach(yr => {
    const chip = document.createElement('button');
    chip.className = 'year-chip';
    
    if (currentDateFrom === `${yr}-01-01` && currentDateTo === `${yr}-12-31`) {
      chip.classList.add('active');
    }
    
    chip.textContent = `${yr}年`;
    chip.addEventListener('click', () => {
      currentDateFrom = `${yr}-01-01`;
      currentDateTo = `${yr}-12-31`;
      const dFrom = document.getElementById('filter-date-from');
      const dTo = document.getElementById('filter-date-to');
      if (dFrom) dFrom.value = currentDateFrom;
      if (dTo) dTo.value = currentDateTo;
      updateYearChipsActive();
      renderMarkers();
    });
    container.appendChild(chip);
  });
  
  updateClearDateFilterBtn();
}

function updateYearChipsActive() {
  const container = document.getElementById('year-chips-container');
  if (!container) return;
  
  container.querySelectorAll('.year-chip').forEach(chip => {
    chip.classList.remove('active');
    const text = chip.textContent;
    if (text === 'すべて' && !currentDateFrom && !currentDateTo) {
      chip.classList.add('active');
    } else if (text.endsWith('年')) {
      const yr = text.replace('年', '');
      if (currentDateFrom === `${yr}-01-01` && currentDateTo === `${yr}-12-31`) {
        chip.classList.add('active');
      }
    }
  });
  
  updateClearDateFilterBtn();
}

function updateClearDateFilterBtn() {
  const btnClear = document.getElementById('btn-clear-date-filter');
  if (!btnClear) return;
  if (currentDateFrom || currentDateTo) {
    btnClear.style.display = 'inline-block';
  } else {
    btnClear.style.display = 'none';
  }
}

function setAlbumFilter(albumName) {
  currentFilterAlbum = albumName;
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  renderSidebar();
  renderMarkers();
  
  if (albumName) {
    drawAlbumRoute(getFilteredMemories());
  } else {
    if (tourPolyline) {
      map.removeLayer(tourPolyline);
      tourPolyline = null;
    }
  }
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
  const btnAddMore = document.getElementById('btn-add-more-photos');
  
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
    if (btnAddMore) {
      btnAddMore.classList.remove('hidden');
      btnAddMore.style.display = 'inline-flex';
    }
  } else {
    container.classList.add('hidden');
    placeholder.classList.remove('hidden');
    if (btnAddMore) btnAddMore.classList.add('hidden');
  }
}

function updateTagChips() {
  const container = document.getElementById('tags-container');
  const input = document.getElementById('memory-tag-input');
  
  // Remove existing chips
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
  if (tempMarker) tempMarker.closePopup();
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

let fullscreenImages = [];
let fullscreenCurrentIndex = 0;

function openFullscreenImage(images, index = 0) {
  if (typeof images === 'string') {
    fullscreenImages = [images];
    fullscreenCurrentIndex = 0;
  } else if (Array.isArray(images) && images.length > 0) {
    fullscreenImages = images;
    fullscreenCurrentIndex = index >= 0 && index < images.length ? index : 0;
  } else {
    return;
  }

  const modal = document.getElementById('fullscreen-image-modal');
  if (!modal) return;

  updateFullscreenContent();
  modal.classList.remove('hidden');
}

function updateFullscreenContent() {
  const imgEl = document.getElementById('fullscreen-image');
  const counterEl = document.getElementById('fullscreen-counter');
  const btnPrev = document.getElementById('btn-fullscreen-prev');
  const btnNext = document.getElementById('btn-fullscreen-next');

  if (!fullscreenImages || fullscreenImages.length === 0) return;

  if (fullscreenCurrentIndex < 0) fullscreenCurrentIndex = fullscreenImages.length - 1;
  if (fullscreenCurrentIndex >= fullscreenImages.length) fullscreenCurrentIndex = 0;

  if (imgEl) {
    imgEl.style.opacity = '0.3';
    imgEl.src = fullscreenImages[fullscreenCurrentIndex];
    setTimeout(() => { imgEl.style.opacity = '1'; }, 40);
  }

  if (counterEl) {
    counterEl.textContent = `${fullscreenCurrentIndex + 1} / ${fullscreenImages.length}`;
  }

  if (btnPrev && btnNext) {
    if (fullscreenImages.length > 1) {
      btnPrev.style.display = 'flex';
      btnNext.style.display = 'flex';
    } else {
      btnPrev.style.display = 'none';
      btnNext.style.display = 'none';
    }
  }
}

function nextFullscreenImage() {
  if (fullscreenImages.length <= 1) return;
  fullscreenCurrentIndex = (fullscreenCurrentIndex + 1) % fullscreenImages.length;
  updateFullscreenContent();
}

function prevFullscreenImage() {
  if (fullscreenImages.length <= 1) return;
  fullscreenCurrentIndex = (fullscreenCurrentIndex - 1 + fullscreenImages.length) % fullscreenImages.length;
  updateFullscreenContent();
}

let tourIsPlaying = false;
let tourSlideInterval = null;

function stopTour() {
  tourIsPlaying = false;
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  if (tourSlideInterval) { clearInterval(tourSlideInterval); tourSlideInterval = null; }
  const overlay = document.getElementById('tour-slideshow-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.add('fade-out');
  }
}

async function playAlbumTour() {
  stopTour();
  tourIsPlaying = true;
  
  let memoriesToPlay = getFilteredMemories();
  if (memoriesToPlay.length === 0) {
    alert("表示する思い出がありません。");
    return;
  }
  
  memoriesToPlay.sort((a, b) => {
    const tA = new Date(a.datetime || a.timestamp).getTime();
    const tB = new Date(b.datetime || b.timestamp).getTime();
    return tA - tB;
  });

  if (homeLocation) {
    memoriesToPlay.unshift({
      lat: homeLocation.lat,
      lng: homeLocation.lng,
      title: '自宅 (出発地点)',
      diary: 'ここから旅がスタートします！',
      imageUrls: []
    });
    memoriesToPlay.push({
      lat: homeLocation.lat,
      lng: homeLocation.lng,
      title: '自宅 (帰宅)',
      diary: '無事に家に帰ってきました！お疲れ様でした。',
      imageUrls: []
    });
  }

  // Draw the route (drawAlbumRoute prepends and appends homeLocation internally, so pass memories without home)
  drawAlbumRoute(memoriesToPlay.filter(m => m.title !== '自宅 (出発地点)' && m.title !== '自宅 (帰宅)'));
  
  map.closePopup();

  const sidebar = document.querySelector('.sidebar');
  const overlaySidebar = document.getElementById('sidebar-overlay');
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('open');
    overlaySidebar.classList.add('hidden');
  }

  const tourOverlay = document.getElementById('tour-slideshow-overlay');
  const tourImage = document.getElementById('tour-image');
  const tourImageContainer = document.getElementById('tour-image-container');
  const tourTitle = document.getElementById('tour-title');
  const tourDate = document.getElementById('tour-date');
  const tourDiary = document.getElementById('tour-diary');

  tourOverlay.classList.remove('hidden');
  tourOverlay.classList.add('fade-out'); // Start faded out

  let index = 0;

  const playNext = async () => {
    if (!tourIsPlaying) return;
    
    if (index >= memoriesToPlay.length) {
      stopTour();
      alert("ツアーが終了しました！");
      return;
    }

    const mem = memoriesToPlay[index];
    
    // 1. Fade out current content
    tourOverlay.classList.add('fade-out');
    
    // Wait for fade out
    await new Promise(r => setTimeout(r, 800));
    if (!tourIsPlaying) return;

    // 2. Move map to next location
    map.flyTo([mem.lat, mem.lng], 15, { animate: true, duration: 1.5 });
    
    // Wait for map to finish moving (approx 1.5s)
    await new Promise(r => setTimeout(r, 1600));
    if (!tourIsPlaying) return;

    // 3. Update overlay content
    if (tourSlideInterval) { clearInterval(tourSlideInterval); tourSlideInterval = null; }
    tourImageContainer.innerHTML = '';
    
    if (mem.imageUrls && mem.imageUrls.length > 0) {
      mem.imageUrls.forEach((url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.className = i === 0 ? 'tour-slide-img active' : 'tour-slide-img';
        tourImageContainer.appendChild(img);
      });
      tourImageContainer.classList.remove('no-image');
      
      if (mem.imageUrls.length > 1) {
        let currentImgIdx = 0;
        tourSlideInterval = setInterval(() => {
          const imgs = tourImageContainer.querySelectorAll('.tour-slide-img');
          if (imgs.length > 1) {
            imgs[currentImgIdx].classList.remove('active');
            currentImgIdx = (currentImgIdx + 1) % imgs.length;
            imgs[currentImgIdx].classList.add('active');
          }
        }, 3000);
      }
    } else {
      tourImageContainer.classList.add('no-image');
    }

    tourTitle.textContent = mem.title || '無題の思い出';
    
    let displayDate = '';
    if (mem.datetime) {
      const dt = new Date(mem.datetime);
      if (!isNaN(dt.getTime())) {
        displayDate = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      }
    } else if (mem.timestamp) {
      const dt = new Date(mem.timestamp);
      if (!isNaN(dt.getTime())) {
        displayDate = dt.toLocaleDateString();
      }
    }
    tourDate.textContent = displayDate;
    tourDiary.textContent = mem.diary || '';

    // 4. Fade in
    tourOverlay.classList.remove('fade-out');

    index++;
    // 5. Wait before next (dynamic based on image count)
    let displayDuration = mem.imageUrls && mem.imageUrls.length > 1 
      ? Math.max(5000, mem.imageUrls.length * 3000) 
      : 5000;
      
    if (mem.title === '自宅 (出発地点)' || mem.title === '自宅 (帰宅)') {
      displayDuration = 2000; // 短く表示する
    }
    
    tourTimeout = setTimeout(playNext, displayDuration); // Display longer if multiple images
  };
  
  // Start the first animation loop
  playNext();
}

function renderAlbumModalGrid(searchQuery = '', sortBy = 'oldest') {
  const grid = document.getElementById('album-modal-grid');
  if (!grid) return;

  const albumsMap = {};
  allMemories.forEach(mem => {
    const albumName = mem.album ? mem.album.trim() : '';
    if (!albumName) return;
    if (!albumsMap[albumName]) {
      albumsMap[albumName] = [];
    }
    albumsMap[albumName].push(mem);
  });

  let albumNames = Object.keys(albumsMap).filter(name => {
    if (!searchQuery) return true;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Calculate dates and counts for sorting
  const albumMetaMap = {};
  albumNames.forEach(name => {
    const memories = albumsMap[name];
    const timestamps = memories
      .map(m => m.datetime || m.timestamp)
      .filter(Boolean)
      .map(d => new Date(d).getTime())
      .filter(t => !isNaN(t));

    const minDate = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const maxDate = timestamps.length > 0 ? Math.max(...timestamps) : 0;

    albumMetaMap[name] = { minDate, maxDate, count: memories.length };
  });

  // Sort albumNames
  albumNames.sort((a, b) => {
    const metaA = albumMetaMap[a];
    const metaB = albumMetaMap[b];

    if (sortBy === 'oldest') {
      return metaA.minDate - metaB.minDate;
    } else if (sortBy === 'newest') {
      return metaB.maxDate - metaA.maxDate;
    } else if (sortBy === 'count') {
      return metaB.count - metaA.count;
    } else if (sortBy === 'name') {
      return a.localeCompare(b, 'ja');
    }
    return 0;
  });

  if (albumNames.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 3rem 1rem;">
        <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">該当するアルバムが見つかりませんでした</p>
        <p style="font-size: 0.85rem;">新しい思い出を記録してアルバムを作成してみましょう！</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';

  albumNames.forEach(name => {
    const memories = albumsMap[name];
    memories.sort((a, b) => new Date(a.datetime || a.timestamp) - new Date(b.datetime || b.timestamp));

    const customCover = customAlbumCovers[name];
    const coverMem = memories.find(m => m.imageUrls && m.imageUrls.length > 0);
    const coverUrl = customCover || (coverMem ? coverMem.imageUrls[0] : null);

    let dateStr = '';
    if (memories.length > 0) {
      const validDates = memories
        .map(m => m.datetime || m.timestamp)
        .filter(Boolean)
        .map(d => new Date(d))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);

      if (validDates.length > 0) {
        const first = validDates[0];
        const last = validDates[validDates.length - 1];
        const fmt = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
        const d1 = fmt(first);
        const d2 = fmt(last);
        dateStr = d1 === d2 ? d1 : `${d1} 〜 ${d2}`;
      }
    }

    const card = document.createElement('div');
    card.className = 'album-card';

    const thumbHtml = coverUrl
      ? `<img src="${coverUrl}" alt="${name}" class="album-card-thumb" />`
      : `<div class="album-card-thumb"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></div>`;

    card.innerHTML = `
      ${thumbHtml}
      <div class="album-card-body">
        <h3 class="album-card-title">${name}</h3>
        <div class="album-card-meta">
          <span class="album-card-count">${memories.length} 件の思い出</span>
          ${dateStr ? `<span class="album-card-date">${dateStr}</span>` : ''}
        </div>
        <div class="album-card-actions" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 0.8rem;">
          <button class="album-card-btn primary btn-select-album">選択</button>
          <button class="album-card-btn btn-tour-album">ツアー</button>
          <button class="album-card-btn btn-photobook-album" style="background: rgba(37,99,235,0.08); color: #2563eb; font-weight: 600;">旅本</button>
          <button class="album-card-btn btn-edit-album" style="background: rgba(0,0,0,0.05); color: var(--text-main);">編集</button>
        </div>
      </div>
    `;

    const btnSelect = card.querySelector('.btn-select-album');
    const btnTour = card.querySelector('.btn-tour-album');
    const btnPhotobook = card.querySelector('.btn-photobook-album');
    const btnEdit = card.querySelector('.btn-edit-album');
    const albumModal = document.getElementById('album-modal');

    const selectAlbum = () => {
      currentFilterAlbum = name;
      setAlbumFilter(name);
      albumModal.classList.add('hidden');

      const albumMemories = getFilteredMemories();
      if (albumMemories.length > 0) {
        const bounds = L.latLngBounds(albumMemories.map(m => [m.lat, m.lng]));
        map.fitBounds(bounds, { padding: [50, 50] });
      }
    };

    btnSelect.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAlbum();
    });

    btnTour.addEventListener('click', (e) => {
      e.stopPropagation();
      currentFilterAlbum = name;
      setAlbumFilter(name);
      albumModal.classList.add('hidden');
      playAlbumTour();
    });

    if (btnPhotobook) {
      btnPhotobook.addEventListener('click', (e) => {
        e.stopPropagation();
        openPhotobookModal(name);
      });
    }

    if (btnEdit) {
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        openAlbumEditModal(name);
      });
    }

    card.addEventListener('click', () => {
      selectAlbum();
    });

    grid.appendChild(card);
  });
}

function openAlbumEditModal(albumName) {
  currentEditingAlbumName = albumName;
  currentSelectedCoverUrl = customAlbumCovers[albumName] || null;

  const editModal = document.getElementById('album-edit-modal');
  const nameInput = document.getElementById('album-edit-name-input');
  const grid = document.getElementById('album-edit-cover-grid');
  if (!editModal || !nameInput || !grid) return;

  nameInput.value = albumName;

  const albumMemories = allMemories.filter(m => m.album && m.album.trim() === albumName);
  const photos = [];
  albumMemories.forEach(m => {
    if (m.imageUrls && m.imageUrls.length > 0) {
      photos.push(...m.imageUrls);
    }
  });

  const uniquePhotos = [...new Set(photos)];

  grid.innerHTML = '';
  if (uniquePhotos.length === 0) {
    grid.innerHTML = `<p style="grid-column: 1 / -1; font-size: 0.85rem; color: var(--text-muted); text-align: center; padding: 1rem 0;">このアルバムには画像付きの思い出がありません。</p>`;
  } else {
    if (!currentSelectedCoverUrl) {
      currentSelectedCoverUrl = uniquePhotos[0];
    }

    uniquePhotos.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'album-edit-cover-item';
      if (url === currentSelectedCoverUrl) {
        img.classList.add('selected');
      }

      img.addEventListener('click', () => {
        grid.querySelectorAll('.album-edit-cover-item').forEach(el => el.classList.remove('selected'));
        img.classList.add('selected');
        currentSelectedCoverUrl = url;
      });

      grid.appendChild(img);
    });
  }

  editModal.classList.remove('hidden');
}

async function saveAlbumEdit() {
  const nameInput = document.getElementById('album-edit-name-input');
  if (!nameInput) return;
  const newName = nameInput.value.trim();

  if (!newName) {
    alert("アルバム名を入力してください。");
    return;
  }

  const oldName = currentEditingAlbumName;
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.classList.remove('hidden');

  try {
    if (currentSelectedCoverUrl) {
      customAlbumCovers[newName] = currentSelectedCoverUrl;
    }

    if (newName !== oldName) {
      if (customAlbumCovers[oldName]) {
        delete customAlbumCovers[oldName];
      }

      const matchingMemories = allMemories.filter(m => m.album === oldName);
      for (const mem of matchingMemories) {
        mem.album = newName;
        await updateMemory(mem);
      }

      if (currentFilterAlbum === oldName) {
        currentFilterAlbum = newName;
      }
    }

    localStorage.setItem('customAlbumCovers', JSON.stringify(customAlbumCovers));

    const editModal = document.getElementById('album-edit-modal');
    if (editModal) editModal.classList.add('hidden');

    renderSidebar();
    renderAlbumModalGrid(
      document.getElementById('album-modal-search') ? document.getElementById('album-modal-search').value.trim() : '',
      document.getElementById('album-modal-sort') ? document.getElementById('album-modal-sort').value : 'oldest'
    );
    renderMarkers();

    alert("アルバム情報を更新しました！");
  } catch (err) {
    console.error("Error updating album:", err);
    alert("アルバムの更新中にエラーが発生しました。");
  } finally {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }
}

let currentPhotobookAlbumName = '';

function printPhotobookWindow(albumName) {
  const container = document.getElementById('photobook-content');
  if (!container) {
    window.print();
    return;
  }

  const printWin = window.open('', '_blank', 'width=900,height=1000');
  if (!printWin) {
    window.print();
    return;
  }

  const contentHtml = container.innerHTML;

  printWin.document.write(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <title>${albumName || 'MemoryMap'} - 旅のフォトブック</title>
      <style>
        @page {
          size: A4 portrait;
          margin: 12mm;
        }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          margin: 0;
          padding: 0;
          background: white;
          color: #0f172a;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .photobook-container {
          display: block;
          width: 100%;
        }
        .photobook-page {
          background: white;
          padding: 10mm 6mm;
          min-height: 265mm;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          page-break-after: always;
          break-after: page;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .photobook-cover-title {
          font-size: 2.4rem;
          font-weight: 800;
          color: #0f172a;
          margin-bottom: 0.5rem;
        }
        .photobook-cover-date {
          font-size: 1.1rem;
          color: #2563eb;
          font-weight: 600;
          margin-bottom: 1.5rem;
        }
        .photobook-cover-img {
          width: 100%;
          max-height: 440px;
          object-fit: cover;
          border-radius: 12px;
          margin-bottom: 1.5rem;
        }
        .photobook-section-title {
          font-size: 1.4rem;
          font-weight: 700;
          color: #0f172a;
          margin-bottom: 1.2rem;
          padding-bottom: 0.5rem;
          border-bottom: 2px solid #e2e8f0;
        }
        .photobook-itinerary-item {
          display: flex;
          align-items: flex-start;
          gap: 14px;
          margin-bottom: 1rem;
          padding-bottom: 0.8rem;
          border-bottom: 1px dashed #e2e8f0;
        }
        .photobook-step-badge {
          background: #2563eb;
          color: white;
          font-weight: 700;
          font-size: 0.78rem;
          padding: 4px 10px;
          border-radius: 20px;
          white-space: nowrap;
        }
      </style>
    </head>
    <body>
      <div class="photobook-container">
        ${contentHtml}
      </div>
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.print();
            window.close();
          }, 350);
        };
      </script>
    </body>
    </html>
  `);
  printWin.document.close();
}

function openPhotobookModal(albumName) {
  currentPhotobookAlbumName = albumName;
  const modal = document.getElementById('photobook-modal');
  const container = document.getElementById('photobook-content');
  if (!modal || !container) return;

  const memories = allMemories
    .filter(m => m.album && m.album.trim() === albumName)
    .sort((a, b) => new Date(a.datetime || a.timestamp) - new Date(b.datetime || b.timestamp));

  if (memories.length === 0) {
    alert("このアルバムには思い出が含まれていません。");
    return;
  }

  const customCover = customAlbumCovers[albumName];
  const coverMem = memories.find(m => m.imageUrls && m.imageUrls.length > 0);
  const coverUrl = customCover || (coverMem ? coverMem.imageUrls[0] : null);

  let dateStr = '日付なし';
  const validDates = memories
    .map(m => m.datetime || m.timestamp)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);

  if (validDates.length > 0) {
    const first = validDates[0];
    const last = validDates[validDates.length - 1];
    const fmt = d => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const d1 = fmt(first);
    const d2 = fmt(last);
    dateStr = d1 === d2 ? d1 : `${d1} 〜 ${d2}`;
  }

  const fullLogoUrl = new URL('logo.png', window.location.href).href;

  let html = '';

  // Page 1: COVER PAGE
  html += `
    <div class="photobook-page">
      <div style="text-align: center; margin-top: 1rem;">
        <img src="${fullLogoUrl}" alt="MemoryMap Logo" style="height: 52px; object-fit: contain; margin-bottom: 2rem;" />
        <h1 class="photobook-cover-title">${albumName}</h1>
        <div class="photobook-cover-date">${dateStr}</div>
        <div style="font-size: 0.9rem; color: #64748b; margin-bottom: 2rem;">全 ${memories.length} 件の旅の思い出</div>
      </div>
      
      ${coverUrl ? `<div style="text-align: center; margin-bottom: 1.5rem;"><img src="${coverUrl}" class="photobook-cover-img" style="max-width: 100%; max-height: 420px; width: auto; height: auto; object-fit: contain; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);" alt="${albumName}" /></div>` : ''}

      <div style="text-align: center; border-top: 1px solid #e2e8f0; padding-top: 1.5rem; font-size: 0.85rem; color: #94a3b8; font-weight: 500;">
        Memory Map Travel Photobook
      </div>
    </div>
  `;

  // Page 2: ITINERARY & SPOT OVERVIEW
  html += `
    <div class="photobook-page">
      <div>
        <div class="photobook-section-title">旅のロケーション & 行程一覧</div>
        <p style="font-size: 0.9rem; color: #64748b; margin-bottom: 1.8rem; line-height: 1.6;">
          本アルバム「${albumName}」に記録された ${memories.length} か所の立ち寄りスポットの一覧です。
        </p>

        <div style="display: flex; flex-direction: column;">
  `;

  memories.forEach((m, idx) => {
    let spotDate = '日付なし';
    const rawDate = m.datetime || m.timestamp;
    if (rawDate) {
      const dt = new Date(rawDate);
      if (!isNaN(dt.getTime())) {
        spotDate = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
      }
    }

    html += `
      <div class="photobook-itinerary-item">
        <span class="photobook-step-badge">SPOT ${idx + 1}</span>
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <strong style="font-size: 1rem; color: #0f172a;">${m.title || '無題の思い出'}</strong>
            <span style="font-size: 0.78rem; color: #64748b;">${spotDate}</span>
          </div>
          ${m.diary ? `<div style="font-size: 0.84rem; color: #475569; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${m.diary}</div>` : ''}
        </div>
      </div>
    `;
  });

  html += `
        </div>
      </div>
      <div style="display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 1rem; font-size: 0.8rem; color: #94a3b8;">
        <span>Memory Map</span>
        <span>Page 2</span>
      </div>
    </div>
  `;

  // Page 3+: MEMORY JOURNAL PAGES
  memories.forEach((m, idx) => {
    let spotDate = '日付なし';
    const rawDate = m.datetime || m.timestamp;
    if (rawDate) {
      const dt = new Date(rawDate);
      if (!isNaN(dt.getTime())) {
        spotDate = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
      }
    }

    const photos = m.imageUrls || [];
    const tagsHtml = (m.tags || []).map(t => `<span style="background: #f1f5f9; color: #475569; padding: 4px 10px; border-radius: 12px; font-size: 0.78rem; font-weight: 500;">#${t}</span>`).join(' ');

    let photosLayoutHtml = '';
    if (photos.length === 1) {
      photosLayoutHtml = `
        <div style="text-align: center; margin-bottom: 1.5rem;">
          <img src="${photos[0]}" style="max-width: 100%; max-height: 480px; width: auto; height: auto; object-fit: contain; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08);" />
        </div>
      `;
    } else if (photos.length > 1) {
      const maxW = photos.length === 2 ? '48%' : (photos.length === 3 ? '31%' : '48%');
      photosLayoutHtml = `
        <div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; align-items: center; margin-bottom: 1.5rem;">
          ${photos.map(url => `<img src="${url}" style="max-width: ${maxW}; max-height: 320px; width: auto; height: auto; object-fit: contain; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.06);" />`).join('')}
        </div>
      `;
    }

    html += `
      <div class="photobook-page">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.8rem;">
            <span class="photobook-step-badge">SPOT ${idx + 1} / ${memories.length}</span>
            <span style="font-size: 0.85rem; color: #64748b; font-weight: 600;">${spotDate}</span>
          </div>

          <h2 style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-bottom: 1.2rem;">${m.title || '無題の思い出'}</h2>

          ${photosLayoutHtml}

          ${m.diary ? `
            <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 1.2rem; border-radius: 0 10px 10px 0; font-size: 0.95rem; color: #334155; line-height: 1.7; white-space: pre-wrap; margin-bottom: 1.2rem;">${m.diary}</div>
          ` : ''}

          ${tagsHtml ? `<div style="display: flex; gap: 6px; flex-wrap: wrap;">${tagsHtml}</div>` : ''}
        </div>

        <div style="display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 1rem; font-size: 0.8rem; color: #94a3b8;">
          <span>${albumName}</span>
          <span>Page ${idx + 3}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  modal.classList.remove('hidden');
}

function setupEventListeners() {
  const memoryModal = document.getElementById('memory-modal');
  const loadingOverlay = document.getElementById('loading-overlay');

  const emailInput = document.getElementById('login-email');
  const passwordInput = document.getElementById('login-password');
  const btnLogin = document.getElementById('btn-login');
  const btnSignup = document.getElementById('btn-signup');
  const btnLogout = document.getElementById('btn-logout');
  const loginError = document.getElementById('login-error');

  const handleAuth = async (action) => {
    if (!emailInput || !passwordInput) return;
    const email = emailInput.value.trim();
    const pwd = passwordInput.value.trim();
    if (!email || !pwd) {
      if (loginError) {
        loginError.textContent = "メールアドレスとパスワードを入力してください";
        loginError.style.display = 'block';
      }
      return;
    }
    if (loginError) loginError.style.display = 'none';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    try {
      if (action === 'login') {
        await signInWithEmailAndPassword(auth, email, pwd);
      } else {
        await createUserWithEmailAndPassword(auth, email, pwd);
      }
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    } catch (e) {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      if (loginError) {
        let msg = e.message || "認証に失敗しました";
        if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') {
          msg = "メールアドレスまたはパスワードが正しくありません";
        } else if (e.code === 'auth/email-already-in-use') {
          msg = "このメールアドレスは既に登録されています";
        } else if (e.code === 'auth/weak-password') {
          msg = "パスワードは6文字以上で入力してください";
        }
        loginError.textContent = msg;
        loginError.style.display = 'block';
      }
    }
  };

  if (btnLogin) btnLogin.addEventListener('click', () => handleAuth('login'));
  if (btnSignup) btnSignup.addEventListener('click', () => handleAuth('signup'));
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await signOut(auth);
      } catch (e) {
        console.error("Signout error:", e);
      }
    });
  }

  const btnOpenLogin = document.getElementById('btn-open-login');
  if (btnOpenLogin && loginModal) {
    btnOpenLogin.addEventListener('click', () => {
      loginModal.classList.remove('hidden');
    });
  }

  const btnCloseLogin = document.getElementById('btn-close-login');
  if (btnCloseLogin && loginModal) {
    btnCloseLogin.addEventListener('click', () => {
      loginModal.classList.add('hidden');
    });
  }

  const btnPrintPhotobook = document.getElementById('btn-print-photobook');
  const btnClosePhotobook = document.getElementById('btn-close-photobook');
  const photobookModal = document.getElementById('photobook-modal');

  if (btnPrintPhotobook) {
    btnPrintPhotobook.addEventListener('click', () => {
      printPhotobookWindow(currentPhotobookAlbumName);
    });
  }
  if (btnClosePhotobook && photobookModal) {
    btnClosePhotobook.addEventListener('click', () => {
      photobookModal.classList.add('hidden');
    });
  }
  if (photobookModal) {
    photobookModal.addEventListener('click', (e) => {
      if (e.target === photobookModal) {
        photobookModal.classList.add('hidden');
      }
    });
  }
  
  const btnHamburger = document.getElementById('btn-hamburger');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebar = document.querySelector('.sidebar');

  const btnCloseAlbumEdit = document.getElementById('btn-close-album-edit');
  const btnCancelAlbumEdit = document.getElementById('btn-cancel-album-edit');
  const btnSaveAlbumEdit = document.getElementById('btn-save-album-edit');
  const albumEditModal = document.getElementById('album-edit-modal');

  if (btnCloseAlbumEdit && albumEditModal) {
    btnCloseAlbumEdit.addEventListener('click', () => albumEditModal.classList.add('hidden'));
  }
  if (btnCancelAlbumEdit && albumEditModal) {
    btnCancelAlbumEdit.addEventListener('click', () => albumEditModal.classList.add('hidden'));
  }
  if (btnSaveAlbumEdit) {
    btnSaveAlbumEdit.addEventListener('click', saveAlbumEdit);
  }
  if (albumEditModal) {
    albumEditModal.addEventListener('click', (e) => {
      if (e.target === albumEditModal) albumEditModal.classList.add('hidden');
    });
  }
  
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

  const btnOpenAlbumModal = document.getElementById('btn-open-album-modal');
  const btnCloseAlbumModal = document.getElementById('btn-close-album-modal');
  const albumModal = document.getElementById('album-modal');
  const albumModalSearch = document.getElementById('album-modal-search');
  const albumModalSort = document.getElementById('album-modal-sort');

  if (btnOpenAlbumModal && albumModal) {
    const triggerRender = () => {
      const query = albumModalSearch ? albumModalSearch.value.trim() : '';
      const sort = albumModalSort ? albumModalSort.value : 'oldest';
      renderAlbumModalGrid(query, sort);
    };

    btnOpenAlbumModal.addEventListener('click', () => {
      triggerRender();
      albumModal.classList.remove('hidden');
      if (window.innerWidth <= 768) {
        closeSidebar();
      }
    });

    if (btnCloseAlbumModal) {
      btnCloseAlbumModal.addEventListener('click', () => {
        albumModal.classList.add('hidden');
      });
    }

    albumModal.addEventListener('click', (e) => {
      if (e.target === albumModal) {
        albumModal.classList.add('hidden');
      }
    });

    if (albumModalSearch) {
      albumModalSearch.addEventListener('input', triggerRender);
    }

    if (albumModalSort) {
      albumModalSort.addEventListener('change', triggerRender);
    }
  }
  
  const btnSetHome = document.getElementById('btn-set-home');
  if (btnSetHome) {
    btnSetHome.addEventListener('click', () => {
      alert("地図上で自宅に設定したい場所をクリックしてください。");
      document.getElementById('map').style.cursor = 'crosshair';
      if (window.innerWidth <= 768) {
        closeSidebar();
      }
      
      map.once('click', (e) => {
        document.getElementById('map').style.cursor = '';
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        homeLocation = { lat, lng };
        localStorage.setItem('homeLocation', JSON.stringify(homeLocation));
        renderHomeMarker();
        if (currentFilterAlbum) drawAlbumRoute(getFilteredMemories());
        alert("自宅を設定しました！");
      });
    });
  }




  const fileInput = document.getElementById('file-input');
  const btnSelectPhoto = document.getElementById('btn-select-photo');
  const btnSave = document.getElementById('btn-save-memory');
  const btnDeleteMemory = document.getElementById('btn-delete-memory');
  const btnCloseList = document.querySelectorAll('.btn-close');
  const btnAddMorePhotos = document.getElementById('btn-add-more-photos');

  if (btnAddMorePhotos) {
    btnAddMorePhotos.addEventListener('click', () => {
      fileInput.click();
    });
  }

  const titleInput = document.getElementById('memory-title');
  const diaryInput = document.getElementById('memory-diary');
  const albumInput = document.getElementById('memory-album');
  const datetimeInput = document.getElementById('memory-datetime');
  const idInput = document.getElementById('memory-id');
  const tagInput = document.getElementById('memory-tag-input');
  const tagsContainer = document.getElementById('tags-container');
  
  tagsContainer.addEventListener('click', () => tagInput.focus());
  
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // 日本語入力中のEnterやSpaceを無視する
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
    map.removeLayer(currentLayer);
    currentLayer = mapLayers[e.target.value];
    currentLayer.addTo(map);
  });
  
  const searchInput = document.getElementById('search-input');
  const dateFrom = document.getElementById('filter-date-from');
  const dateTo = document.getElementById('filter-date-to');
  const btnClearDateFilter = document.getElementById('btn-clear-date-filter');
  
  searchInput.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value;
    renderMarkers();
  });
  dateFrom.addEventListener('change', (e) => {
    currentDateFrom = e.target.value;
    updateYearChipsActive();
    renderMarkers();
  });
  dateTo.addEventListener('change', (e) => {
    currentDateTo = e.target.value;
    updateYearChipsActive();
    renderMarkers();
  });
  if (btnClearDateFilter) {
    btnClearDateFilter.addEventListener('click', () => {
      currentDateFrom = '';
      currentDateTo = '';
      dateFrom.value = '';
      dateTo.value = '';
      updateYearChipsActive();
      renderMarkers();
    });
  }

  const btnShowAllTags = document.getElementById('btn-show-all-tags');
  if (btnShowAllTags) {
    btnShowAllTags.addEventListener('click', () => {
      setTagFilter('');
    });
  }

  const btnCurrentLocation = document.getElementById('btn-current-location');
  const btnPinCurrent = document.getElementById('btn-pin-current');
  const btnPlayTour = document.getElementById('btn-play-tour');
  const fullscreenModal = document.getElementById('fullscreen-image-modal');
  const btnCloseFullscreen = document.getElementById('btn-close-fullscreen');
  const btnFullscreenPrev = document.getElementById('btn-fullscreen-prev');
  const btnFullscreenNext = document.getElementById('btn-fullscreen-next');
  const btnCloseTour = document.getElementById('btn-close-tour');
  
  btnPlayTour.addEventListener('click', playAlbumTour);
  if (btnCloseTour) {
    btnCloseTour.addEventListener('click', stopTour);
  }
  
  if (btnCloseFullscreen) {
    btnCloseFullscreen.addEventListener('click', () => fullscreenModal.classList.add('hidden'));
  }
  if (btnFullscreenPrev) {
    btnFullscreenPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      prevFullscreenImage();
    });
  }
  if (btnFullscreenNext) {
    btnFullscreenNext.addEventListener('click', (e) => {
      e.stopPropagation();
      nextFullscreenImage();
    });
  }
  if (fullscreenModal) {
    fullscreenModal.addEventListener('click', (e) => {
      if (e.target === fullscreenModal) fullscreenModal.classList.add('hidden');
    });

    let touchStartX = 0;
    let touchEndX = 0;
    fullscreenModal.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    fullscreenModal.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      const diff = touchEndX - touchStartX;
      if (Math.abs(diff) > 40) {
        if (diff < 0) {
          nextFullscreenImage();
        } else {
          prevFullscreenImage();
        }
      }
    }, { passive: true });
  }

  document.addEventListener('keydown', (e) => {
    if (fullscreenModal && !fullscreenModal.classList.contains('hidden')) {
      if (e.key === 'ArrowRight') nextFullscreenImage();
      if (e.key === 'ArrowLeft') prevFullscreenImage();
      if (e.key === 'Escape') fullscreenModal.classList.add('hidden');
    }
  });

  btnCurrentLocation.addEventListener('click', () => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        map.flyTo([lat, lng], 15);
      }, err => alert("現在地の取得に失敗しました。設定を確認してください。"));
    } else {
      alert("お使いのブラウザは現在地取得に対応していません。");
    }
  });

  btnPinCurrent.addEventListener('click', () => {
    if ("geolocation" in navigator) {
      loadingOverlay.classList.remove('hidden');
      navigator.geolocation.getCurrentPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        map.flyTo([lat, lng], 15);
        placeTempMarker(lat, lng);
        setTimeout(() => openMemoryModal(), 600);
        loadingOverlay.classList.add('hidden');
      }, err => {
        loadingOverlay.classList.add('hidden');
        alert("現在地の取得に失敗しました。設定を確認してください。");
      });
    } else {
      alert("お使いのブラウザは現在地取得に対応していません。");
    }
  });
  
  const hideModal = () => {
    memoryModal.classList.add('hidden');
    if (tempMarker && idInput.value === '') {
      map.removeLayer(tempMarker);
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
               if (tempMarker) tempMarker.setLatLng([currentLat, currentLng]);
               map.flyTo([currentLat, currentLng], 13);
             }
             if (data.datetime) {
               datetimeInput.value = toDatetimeLocal(data.datetime);
             }
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
    } catch(err) {
      console.error(err);
      alert("削除に失敗しました");
    }
    loadingOverlay.classList.add('hidden');
  });

  btnSave.addEventListener('click', async () => {
    if (currentPhotoUrls.length === 0 && !titleInput.value) {
      alert("写真を選択するか、タイトルを入力してください！");
      return;
    }
    
    // Auto-add text in input if any
    const leftoverTag = tagInput.value.trim().replace(',', '');
    if (leftoverTag && !currentTags.includes(leftoverTag)) {
      currentTags.push(leftoverTag);
    }
    
    const title = titleInput.value.trim();
    const diary = diaryInput.value.trim();
    const album = albumInput.value.trim();
    const datetimeStr = datetimeInput.value;
    const isEdit = idInput.value !== '';
    
    const memory = {
      lat: currentLat,
      lng: currentLng,
      imageUrls: currentPhotoUrls,
      title,
      diary,
      album,
      tags: currentTags,
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
        const id = await saveMemory(memory);
        memory.id = id;
        memory.timestamp = new Date().toISOString();
        allMemories.push(memory);
      }
      
      renderSidebar();
      renderMarkers();
      
      map.flyTo([memory.lat, memory.lng], 13);
      hideModal();
    } catch (err) {
      console.error(err);
      alert("保存に失敗しました: " + err.message);
    }
    loadingOverlay.classList.add('hidden');
  });
}

init();
