import exifr from 'exifr';
import heic2any from 'heic2any';

export async function processLocalPhoto(file) {
  try {
    // Extract GPS data using exifr
    const gpsData = await exifr.gps(file);
    const parsedData = await exifr.parse(file, ['DateTimeOriginal']);
    
    let lat = null;
    let lng = null;
    let datetime = null;
    
    if (gpsData && gpsData.latitude != null && gpsData.longitude != null) {
      lat = gpsData.latitude;
      lng = gpsData.longitude;
    }
    
    if (parsedData && parsedData.DateTimeOriginal) {
      datetime = parsedData.DateTimeOriginal;
    }

    let fileToResize = file;
    if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
      try {
        const convertedBlob = await heic2any({ blob: file, toType: "image/jpeg" });
        fileToResize = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
      } catch (err) {
        console.error("HEIC conversion failed:", err);
      }
    }

    // Resize and convert to Base64 to persist in IndexedDB
    const base64Url = await resizeImageToBase64(fileToResize, 1024);
    
    return {
      imageUrl: base64Url,
      lat,
      lng,
      datetime
    };
  } catch (error) {
    console.error("Error processing local photo:", error);
    
    let fileToResize = file;
    if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
      try {
        const convertedBlob = await heic2any({ blob: file, toType: "image/jpeg" });
        fileToResize = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
      } catch(e) {}
    }
    
    // Fallback to defaults with base64
    const base64Url = await resizeImageToBase64(fileToResize, 1024).catch(() => URL.createObjectURL(fileToResize));
    return {
      imageUrl: base64Url,
      lat: null,
      lng: null,
      datetime: null
    };
  }
}

function resizeImageToBase64(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
