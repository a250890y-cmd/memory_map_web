import './style.css';
import 'leaflet/dist/leaflet.css';
import L from './leaflet-setup';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { saveMemory, getAllMemories, updateMemory, migrateLocalData, deleteMemory } from './storage';
import { processLocalPhoto } from './local_photos';
import { auth } from './firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';

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
  standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '&copy; Esri' }),
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

async function init() {
  const japanCenter = [36.2048, 138.2529];
  map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView(japanCenter, 5);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  currentLayer.addTo(map);
  
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
  if (tourPolyline) {
    map.removeLayer(tourPolyline);
    tourPolyline = null;
  }
  
  let filtered = getFilteredMemories();
    
  filtered.forEach(memory => {
    const customIcon = L.divIcon({
      className: 'custom-div-icon',
      html: `<div style="background-color: #ef4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
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

async function playAlbumTour() {
  if (tourTimeout) { clearTimeout(tourTimeout); tourTimeout = null; }
  
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

  const latlngs = memoriesToPlay.map(m => [m.lat, m.lng]);
  
  if (tourPolyline) map.removeLayer(tourPolyline);
  tourPolyline = L.polyline(latlngs, {color: '#ef4444', weight: 3, dashArray: '10, 10'}).addTo(map);
  
  map.fitBounds(tourPolyline.getBounds(), { padding: [50, 50] });
  map.closePopup();

  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('open');
    overlay.classList.add('hidden');
  }

  let index = 0;
  const playNext = () => {
    if (index >= memoriesToPlay.length) {
      if (tourPolyline) map.removeLayer(tourPolyline);
      tourPolyline = null;
      return;
    }
    const mem = memoriesToPlay[index];
    
    markersLayer.zoomToShowLayer(mem.marker, () => {
      mem.marker.openPopup();
      index++;
      tourTimeout = setTimeout(playNext, 4000);
    });
  };
  
  tourTimeout = setTimeout(playNext, 1000);
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
      if (action === 'login') {
        await signInWithEmailAndPassword(auth, email, pwd);
      } else {
        await createUserWithEmailAndPassword(auth, email, pwd);
      }
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
  
  btnPlayTour.addEventListener('click', playAlbumTour);
  
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
