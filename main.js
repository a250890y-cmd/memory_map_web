import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { saveMemory, getAllMemories, updateMemory, migrateLocalData } from './storage';
import { processLocalPhoto } from './local_photos';
import { auth } from './firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
});

const categoryEmojis = {
  camera: '📷', food: '🍽️', cafe: '☕', sightseeing: '🗼',
  nature: '⛰️', hotel: '🏨', shopping: '🛍️'
};
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

let currentLat = 36.2048;
let currentLng = 138.2529;
let currentPhotoUrls = [];
let currentFilterAlbum = '';
let currentSearchQuery = '';
let currentDateFrom = '';
let currentDateTo = '';

async function init() {
  const japanCenter = [36.2048, 138.2529];
  map = L.map('map', { zoomControl: false }).setView(japanCenter, 5);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  currentLayer.addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  setupEventListeners();

  map.on('click', (e) => {
    placeTempMarker(e.latlng.lat, e.latlng.lng);
  });
  
  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('btn-edit-popup')) {
      const id = e.target.getAttribute('data-id'); // String ID for Firestore
      openMemoryModal(id);
    }
  });

  // Setup Auth Listener
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
    popupContent.innerHTML = `<button class="btn primary" style="padding: 6px 12px; font-size: 0.9rem; border-radius: 8px;">この場所に思い出を追加</button>
                              <div style="font-size: 0.75rem; color: #666; margin-top: 8px; text-align: center;">ピンはドラッグして移動できます</div>`;
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
    if (m.imageUrl && !m.imageUrls) {
      m.imageUrls = [m.imageUrl];
    }
  });
  
  renderSidebar();
  renderMarkers();
}

function renderMarkers() {
  markersLayer.clearLayers();
  
  let filtered = allMemories;
  
  if (currentFilterAlbum) {
    filtered = filtered.filter(m => m.album === currentFilterAlbum);
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
    
  filtered.forEach(memory => {
    const emoji = categoryEmojis[memory.category] || '📷';
    const catLabel = categoryLabels[memory.category] || 'その他';
    
    const customIcon = L.divIcon({
      className: 'custom-div-icon',
      html: `<div style="background-color: white; width: 36px; height: 36px; border-radius: 50%; border: 2px solid #ef4444; box-shadow: 0 4px 8px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; font-size: 18px;">${emoji}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    const marker = L.marker([memory.lat, memory.lng], { icon: customIcon }).addTo(markersLayer);
    
    const imagesHtml = (memory.imageUrls || []).map(url => `<img src="${url}" />`).join('');
    
    let displayDate = new Date(memory.timestamp).toLocaleDateString();
    if (memory.datetime) {
      const dt = new Date(memory.datetime);
      displayDate = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }
    
    const popupContent = `
      <div style="min-width: 240px; max-width: 300px;">
        ${imagesHtml ? `<div class="popup-gallery">${imagesHtml}</div>` : ''}
        <div style="padding: 0 16px 16px 16px;">
          <div class="popup-category">${catLabel} ${memory.album ? `| ${memory.album}` : ''}</div>
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

function renderSidebar() {
  const albums = [...new Set(allMemories.map(m => m.album).filter(Boolean))];
  const listEl = document.getElementById('sidebar-album-list');
  const dataList = document.getElementById('album-datalist');
  
  listEl.innerHTML = '';
  
  const allLi = document.createElement('li');
  allLi.textContent = 'すべて表示';
  allLi.dataset.album = '';
  if (currentFilterAlbum === '') allLi.classList.add('active');
  allLi.addEventListener('click', () => setFilter(''));
  listEl.appendChild(allLi);
  
  albums.forEach(album => {
    const li = document.createElement('li');
    li.textContent = album;
    li.dataset.album = album;
    if (currentFilterAlbum === album) li.classList.add('active');
    li.addEventListener('click', () => setFilter(album));
    listEl.appendChild(li);
  });
  
  dataList.innerHTML = '';
  albums.forEach(album => {
    const opt = document.createElement('option');
    opt.value = album;
    dataList.appendChild(opt);
  });
}

function setFilter(albumName) {
  currentFilterAlbum = albumName;
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
    currentPhotoUrls.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      container.appendChild(img);
    });
    container.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    container.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

function openMemoryModal(id = null) {
  if (tempMarker) tempMarker.closePopup();
  
  const modal = document.getElementById('memory-modal');
  const titleInput = document.getElementById('memory-title');
  const diaryInput = document.getElementById('memory-diary');
  const albumInput = document.getElementById('memory-album');
  const categorySelect = document.getElementById('memory-category');
  const datetimeInput = document.getElementById('memory-datetime');
  const idInput = document.getElementById('memory-id');
  const modalTitle = document.getElementById('modal-title');
  
  if (id !== null) {
    const memory = allMemories.find(m => m.id === id);
    if (!memory) return;
    
    modalTitle.textContent = '思い出を編集';
    idInput.value = memory.id;
    titleInput.value = memory.title || '';
    diaryInput.value = memory.diary || '';
    albumInput.value = memory.album || '';
    categorySelect.value = memory.category || 'camera';
    currentPhotoUrls = [...(memory.imageUrls || [])];
    currentLat = memory.lat;
    currentLng = memory.lng;
    
    if (memory.datetime) {
      datetimeInput.value = toDatetimeLocal(memory.datetime);
    } else {
      datetimeInput.value = toDatetimeLocal(memory.timestamp);
    }
    
    updatePreviewGallery();
  } else {
    modalTitle.textContent = '思い出を記録';
    idInput.value = '';
    titleInput.value = '';
    diaryInput.value = '';
    albumInput.value = '';
    categorySelect.value = 'camera';
    datetimeInput.value = toDatetimeLocal(new Date());
    currentPhotoUrls = [];
    
    updatePreviewGallery();
  }
  
  modal.classList.remove('hidden');
}

function setupEventListeners() {
  const memoryModal = document.getElementById('memory-modal');
  const loadingOverlay = document.getElementById('loading-overlay');
  
  // Auth Elements
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
  btnLogout.addEventListener('click', () => {
    signOut(auth);
  });

  const fileInput = document.getElementById('file-input');
  const btnSelectPhoto = document.getElementById('btn-select-photo');
  const btnSave = document.getElementById('btn-save-memory');
  const btnCloseList = document.querySelectorAll('.btn-close');

  const titleInput = document.getElementById('memory-title');
  const diaryInput = document.getElementById('memory-diary');
  const albumInput = document.getElementById('memory-album');
  const categorySelect = document.getElementById('memory-category');
  const datetimeInput = document.getElementById('memory-datetime');
  const idInput = document.getElementById('memory-id');
  
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
  
  btnCurrentLocation.addEventListener('click', () => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(position => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        map.flyTo([lat, lng], 15);
      }, err => {
        alert("現在地の取得に失敗しました。設定を確認してください。");
      });
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

  btnSelectPhoto.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      loadingOverlay.classList.remove('hidden');
      try {
        const files = Array.from(e.target.files);
        
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const data = await processLocalPhoto(file);
          
          currentPhotoUrls.push(data.imageUrl);
          
          if (i === 0 && idInput.value === '') {
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
  });

  btnSave.addEventListener('click', async () => {
    if (currentPhotoUrls.length === 0) {
      alert("写真を選択してください！");
      return;
    }
    
    const title = titleInput.value.trim();
    const diary = diaryInput.value.trim();
    const album = albumInput.value.trim();
    const category = categorySelect.value;
    const datetimeStr = datetimeInput.value;
    const isEdit = idInput.value !== '';
    
    const memory = {
      lat: currentLat,
      lng: currentLng,
      imageUrls: currentPhotoUrls,
      title,
      diary,
      album,
      category,
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
