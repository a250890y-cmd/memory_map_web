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

  const loadingOverlay = document.getElementById('loading-overlay');
  
  loadingOverlay.classList.remove('hidden');
  try {
    await loadMemories();
  } catch (e) {
    console.error("Error loading data:", e);
  }
  loadingOverlay.classList.add('hidden');
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

function openFullscreenImage(src) {
  const modal = document.getElementById('fullscreen-image-modal');
  const img = document.getElementById('fullscreen-image');
  img.src = src;
  modal.classList.remove('hidden');
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
  const btnAbout = document.getElementById('btn-about');
  const aboutModal = document.getElementById('about-modal');
  const btnCloseAbout = document.getElementById('btn-close-about');

  if (btnAbout && aboutModal && btnCloseAbout) {
    btnAbout.addEventListener('click', () => {
      aboutModal.classList.remove('hidden');
      if (window.innerWidth <= 768) {
        closeSidebar();
      }
    });

    btnCloseAbout.addEventListener('click', () => {
      aboutModal.classList.add('hidden');
    });

    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) {
        aboutModal.classList.add('hidden');
      }
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
  
  searchInput.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value;
    renderMarkers();
  });
  dateFrom.addEventListener('change', (e) => {
    currentDateFrom = e.target.value;
    renderMarkers();
  });
  dateTo.addEventListener('change', (e) => {
    currentDateTo = e.target.value;
    renderMarkers();
  });

  const btnCurrentLocation = document.getElementById('btn-current-location');
  const btnPinCurrent = document.getElementById('btn-pin-current');
  const btnPlayTour = document.getElementById('btn-play-tour');
  const fullscreenModal = document.getElementById('fullscreen-image-modal');
  const btnCloseFullscreen = document.getElementById('btn-close-fullscreen');
  const btnCloseTour = document.getElementById('btn-close-tour');
  
  btnPlayTour.addEventListener('click', playAlbumTour);
  if (btnCloseTour) {
    btnCloseTour.addEventListener('click', stopTour);
  }
  
  btnCloseFullscreen.addEventListener('click', () => fullscreenModal.classList.add('hidden'));
  fullscreenModal.addEventListener('click', (e) => {
    if (e.target === fullscreenModal) fullscreenModal.classList.add('hidden');
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
