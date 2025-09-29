// --- Firebase Imports ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Global Setup (Canvas Environment Variables) ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;

let db, auth;
let userId = 'anonymous';
let isAuthReady = false; 

// --- DOM Elements ---
const docCanvas = document.getElementById('documentCanvas');
const docCtx = docCanvas.getContext('2d');
const sigPreviewCanvas = document.getElementById('signaturePreviewCanvas');
const sigPreviewCtx = sigPreviewCanvas.getContext('2d');
const placeholderText = document.getElementById('placeholderText');
const placeSignatureBtn = document.getElementById('placeSignatureBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusMessage = document.getElementById('statusMessage');
const canvasWrapper = document.getElementById('canvasWrapper');
const signatureSelector = document.getElementById('signatureSelector');
const saveSignatureBtn = document.getElementById('saveSignatureBtn');
const currentSignatureLabel = document.getElementById('currentSignatureLabel');
const userIdDisplay = document.getElementById('userIdDisplay');
const documentInput = document.getElementById('documentInput');
const signatureUploadInput = document.getElementById('signatureUploadInput');
const clearSignatureBtn = document.getElementById('clearSignatureBtn');

// --- Global State ---
let documentImage = null; 
let signatureImage = null; 
let savedSignatures = []; 
let currentSignatureName = 'Belum Ada'; 
let placedSignaturesHistory = []; 
let activePlacedSignature = null; 
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
const RESIZE_STEP_PERCENTAGE = 0.05; 

// --- PDF.js Worker Configuration ---
const PDF_JS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER;
// -----------------------------------

// --- 1. INITIALIZATION & AUTHENTICATION ---

if (firebaseConfig) {
    try {
        const app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);

        const authToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
        
        onAuthStateChanged(auth, (user) => {
            if (user) {
                userId = user.uid;
                isAuthReady = true;
                userIdDisplay.textContent = `User ID: ${userId}`;
                console.log("Authenticated. User ID:", userId, "-> Auth Ready.");
                loadSavedSignatures(); 
            } else if (authToken) {
                 signInWithCustomToken(auth, authToken).catch(error => {
                    console.error("Custom Token Sign-in Failed:", error);
                    signInAnonymously(auth); 
                });
            } else {
                signInAnonymously(auth);
            }
        });
        
    } catch (e) {
        console.error("Firebase initialization failed:", e);
        showNotification("Kesalahan: Gagal inisialisasi Firebase.", 'bg-red-600');
    }
} else {
    userIdDisplay.textContent = `User ID: Offline (DB Nonaktif)`;
    showNotification("Mode Offline: Fitur simpan/muat TTD dinonaktifkan.", 'bg-yellow-600');
}

// --- 2. UTILITY & UI FUNCTIONS ---

function showNotification(message, bgColor = 'bg-indigo-600') {
    const box = document.getElementById('messageBox');
    box.textContent = message;
    box.className = `fixed top-4 right-4 ${bgColor} text-white p-4 rounded-lg shadow-xl z-50 transition-opacity duration-300`;
    box.classList.remove('hidden', 'opacity-0');

    setTimeout(() => {
        box.classList.add('opacity-0');
        setTimeout(() => box.classList.add('hidden'), 300);
    }, 3000);
}

function getCoords(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    let x, y;

    if (event.touches) {
        if (event.touches.length === 1) {
            x = event.touches[0].clientX - rect.left;
            y = event.touches[0].clientY - rect.top;
        } else if (event.touches.length === 2) {
            x = ((event.touches[0].clientX + event.touches[1].clientX) / 2) - rect.left;
            y = ((event.touches[0].clientY + event.touches[1].clientY) / 2) - rect.top;
        }
    } else {
        x = event.clientX - rect.left;
        y = event.clientY - rect.top;
    }
    return { x, y };
}

function getTouchDistance(event) {
    const dx = event.touches[0].clientX - event.touches[1].clientX;
    const dy = event.touches[0].clientY - event.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function updateSignatureLabel() {
     currentSignatureLabel.innerHTML = `Aktif: <span class="font-bold text-indigo-600">${currentSignatureName}</span>`;
}

// --- 3. DOCUMENT LOAD LOGIC ---

documentInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    placedSignaturesHistory = [];
    activePlacedSignature = null;

    if (file.type === 'application/pdf') {
        loadPdfDocument(file);
    } else if (file.type.startsWith('image/')) {
        loadImageDocument(file);
    } else {
        showNotification("Tolong unggah file PDF atau gambar (JPG/PNG).", 'bg-yellow-600');
    }
});

function loadImageDocument(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        documentImage = new Image();
        documentImage.onload = function() {
            setupCanvasDimensions(documentImage.width, documentImage.height);
            renderDisplayCanvas();
            downloadBtn.disabled = false;
            placeSignatureBtn.disabled = signatureImage === null;
            showNotification("Dokumen gambar berhasil dimuat. Siap ditempel.", 'bg-green-600');
        };
        documentImage.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function loadPdfDocument(file) {
    placeholderText.classList.add('hidden');
    statusMessage.textContent = 'Memproses PDF...';
    
    const fileReader = new FileReader();
    fileReader.onload = async function() {
        const pdfData = new Uint8Array(this.result);
        
        try {
            const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
            const page = await pdf.getPage(1); 
            
            const viewport = page.getViewport({ scale: 2 }); 
            
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = viewport.width;
            tempCanvas.height = viewport.height;
            
            const renderContext = {
                canvasContext: tempCtx,
                viewport: viewport
            };
            
            await page.render(renderContext).promise;
            
            const dataUrl = tempCanvas.toDataURL('image/png');
            documentImage = new Image();
            
            documentImage.onload = function() {
                setupCanvasDimensions(documentImage.width, documentImage.height);
                renderDisplayCanvas();
                downloadBtn.disabled = false;
                placeSignatureBtn.disabled = signatureImage === null;
                showNotification("Dokumen PDF (Halaman 1) berhasil dimuat. Siap ditempel.", 'bg-green-600');
                statusMessage.textContent = 'Dokumen siap ditandatangani.';
            };
            documentImage.src = dataUrl;
            
        } catch (error) {
            console.error("Error rendering PDF:", error);
            showNotification("Gagal memuat atau merender PDF. Cek konsol.", 'bg-red-600');
            placeholderText.classList.remove('hidden');
            statusMessage.textContent = 'Gagal memuat dokumen.';
        }
    };
    fileReader.readAsArrayBuffer(file);
}

function setupCanvasDimensions(imageWidth, imageHeight) {
    const aspectRatio = imageWidth / imageHeight;
    const wrapperWidth = canvasWrapper.clientWidth;
    let canvasWidth = wrapperWidth;
    let canvasHeight = wrapperWidth / aspectRatio;

    if (canvasHeight > 800) {
        canvasHeight = 800;
        canvasWidth = canvasHeight * aspectRatio;
    }

    docCanvas.width = canvasWidth;
    docCanvas.height = canvasHeight;
}

function drawBaseDocument() {
    if (documentImage) {
        docCtx.clearRect(0, 0, docCanvas.width, docCanvas.height);
        docCtx.drawImage(documentImage, 0, 0, docCanvas.width, docCanvas.height);
    }
}

function renderDisplayCanvas() {
    drawBaseDocument(); 

    // 1. Gambar semua TTD yang sudah difinalisasi (History)
    placedSignaturesHistory.forEach(sig => {
        docCtx.drawImage(
            sig.image,
            sig.x, sig.y,
            sig.width, sig.height
        );
    });

    // 2. Gambar TTD yang sedang aktif (Drag/Resize)
    if (activePlacedSignature) {
        docCtx.drawImage(
            activePlacedSignature.image,
            activePlacedSignature.x,
            activePlacedSignature.y,
            activePlacedSignature.width,
            activePlacedSignature.height
        );
    }
}

// --- 4. SIGNATURE LOAD & FIREBASE STORAGE LOGIC ---

signatureUploadInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (file.type !== 'image/png') {
        showNotification("Wajib: Harap unggah file PNG untuk tanda tangan.", 'bg-red-600');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        
        signatureImage = new Image();
        signatureImage.onload = function() {
            sigPreviewCtx.clearRect(0, 0, sigPreviewCanvas.width, sigPreviewCanvas.height);
            
            const ratio = Math.min(sigPreviewCanvas.width / signatureImage.width, sigPreviewCanvas.height / sigPreviewCanvas.height);
            const newWidth = signatureImage.width * ratio;
            const newHeight = signatureImage.height * ratio;
            const offsetX = (sigPreviewCanvas.width - newWidth) / 2;
            const offsetY = (sigPreviewCanvas.height - newHeight) / 2;

            sigPreviewCtx.drawImage(signatureImage, offsetX, offsetY, newWidth, newHeight);

            placeSignatureBtn.disabled = documentImage === null;
            saveSignatureBtn.disabled = false;
            currentSignatureName = 'Baru Diunggah';
            updateSignatureLabel();
            showNotification("File PNG tanda tangan berhasil dimuat. Siap disimpan atau ditempel.", 'bg-indigo-600');
        };
        signatureImage.src = dataUrl;
    };
    reader.readAsDataURL(file);
});

clearSignatureBtn.addEventListener('click', () => {
    sigPreviewCtx.clearRect(0, 0, sigPreviewCanvas.width, sigPreviewCanvas.height);
    signatureImage = null;
    placeSignatureBtn.disabled = true;
    saveSignatureBtn.disabled = true;
    currentSignatureName = 'Belum Ada';
    updateSignatureLabel();
    signatureUploadInput.value = '';

    activePlacedSignature = null;
    removeInteractionListeners(); 
    renderDisplayCanvas();
    
    placeSignatureBtn.classList.replace('bg-red-500', 'bg-green-500');
    placeSignatureBtn.classList.replace('shadow-red-200', 'shadow-green-200');
    placeSignatureBtn.textContent = 'Tempelkan Tanda Tangan (Pilih Lokasi)';
    docCanvas.style.cursor = 'crosshair';

    showNotification("Tanda tangan aktif telah dihapus.", 'bg-red-500');
});


function getSignatureCollectionPath() {
    return `artifacts/${appId}/users/${userId}/signatures`;
}

function loadSavedSignatures() {
    if (!db || !isAuthReady) {
         signatureSelector.innerHTML = '<p class="text-xs text-yellow-500 p-2">Menunggu autentikasi untuk memuat TTD...</p>';
         return;
    }
    
    signatureSelector.innerHTML = '<p class="text-xs text-gray-500 p-2">Memuat tanda tangan tersimpan...</p>';
    
    const collectionRef = collection(db, getSignatureCollectionPath());
    onSnapshot(collectionRef, (snapshot) => {
        savedSignatures = [];
        snapshot.forEach((doc) => {
            const data = doc.data();
            savedSignatures.push({ id: doc.id, name: data.name, dataUrl: data.dataUrl, timestamp: data.timestamp || 0 });
        });
        savedSignatures.sort((a, b) => b.timestamp - a.timestamp);
        renderSignatureSelector();
    }, (error) => {
        console.error("Error loading saved signatures:", error);
        signatureSelector.innerHTML = `<p class="text-xs text-red-500 p-2">Gagal memuat. (${error.message})</p>`;
        showNotification("Gagal memuat tanda tangan tersimpan. (Cek Izin Firestore)", 'bg-red-600');
    });
}

function renderSignatureSelector() {
    signatureSelector.innerHTML = ''; 
    if (savedSignatures.length === 0) {
        signatureSelector.innerHTML = '<p class="text-xs text-gray-500 p-2">Anda belum menyimpan tanda tangan apa pun.</p>';
        return;
    }

    savedSignatures.forEach(sig => {
        const container = document.createElement('div');
        container.className = 'flex items-center space-x-2';
        const selectButton = document.createElement('button');
        selectButton.className = 'flex-grow text-left py-2 px-3 text-sm rounded-lg border transition duration-150 truncate';
        
        if (sig.name === currentSignatureName) {
            selectButton.classList.add('bg-indigo-200', 'border-indigo-500', 'font-semibold', 'text-indigo-800');
        } else {
            selectButton.classList.add('bg-white', 'border-gray-300', 'text-gray-700', 'hover:bg-indigo-50');
        }
        
        selectButton.textContent = sig.name;
        selectButton.onclick = () => selectSignature(sig.dataUrl, sig.name);
        container.appendChild(selectButton);

        const deleteButton = document.createElement('button');
        deleteButton.className = 'p-2 rounded-full text-red-500 hover:bg-red-100 transition duration-150';
        deleteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>`;
        deleteButton.title = `Hapus tanda tangan ${sig.name}`;
        deleteButton.onclick = (e) => { e.stopPropagation(); deleteSignature(sig.id, sig.name); };
        container.appendChild(deleteButton);
        
        signatureSelector.appendChild(container);
    });
}

function selectSignature(dataUrl, name) {
    signatureImage = new Image();
    signatureImage.onload = () => {
        currentSignatureName = name;
        placeSignatureBtn.disabled = documentImage === null;
        
        sigPreviewCtx.clearRect(0, 0, sigPreviewCanvas.width, sigPreviewCanvas.height);
        const ratio = Math.min(sigPreviewCanvas.width / signatureImage.width, sigPreviewCanvas.height / signaturePreviewCanvas.height);
        const newWidth = signatureImage.width * ratio;
        const newHeight = signatureImage.height * ratio;
        const offsetX = (sigPreviewCanvas.width - newWidth) / 2;
        const offsetY = (sigPreviewCanvas.height - newHeight) / 2;
        sigPreviewCtx.drawImage(signatureImage, offsetX, offsetY, newWidth, newHeight);

        saveSignatureBtn.disabled = true; 
        updateSignatureLabel();
        renderSignatureSelector(); 
        showNotification(`Tanda tangan "${name}" siap ditempel.`, 'bg-indigo-600');
    };
    signatureImage.src = dataUrl;
}

saveSignatureBtn.addEventListener('click', () => {
    if (!signatureImage) { 
        showNotification("Harap unggah file PNG tanda tangan terlebih dahulu.", 'bg-yellow-600');
        return;
    }
    if (!db) {
         showNotification("Aplikasi tidak terhubung ke database. Otentikasi gagal.", 'bg-red-600');
         return;
    }
    if (!isAuthReady) { 
        showNotification("Autentikasi belum siap. Mohon tunggu sejenak dan coba lagi.", 'bg-yellow-600');
        console.warn("Save attempted before isAuthReady was true.");
        return;
    }

    saveSignatureBtn.disabled = true;

    const name = prompt("Masukkan nama untuk tanda tangan ini (contoh: Kapolda, Wakapolda):");
    if (name && name.trim() !== "") {
        saveCurrentSignatureToDb(name.trim());
    } else {
        saveSignatureBtn.disabled = false; 
        showNotification("Penyimpanan dibatalkan. Nama tidak valid.", 'bg-yellow-600');
    }
});

function saveCurrentSignatureToDb(name) {
     const collectionRef = collection(db, getSignatureCollectionPath());
     const dataUrl = signatureImage.src;
     const path = getSignatureCollectionPath();

     console.log("--- SAVE ATTEMPT ---");
     console.log("Current User ID:", userId);
     console.log("Collection Path:", path);
     
     addDoc(collectionRef, { name: name, dataUrl: dataUrl, timestamp: Date.now() 
     }).then(() => {
         currentSignatureName = name;
         saveSignatureBtn.disabled = true; 
         updateSignatureLabel();
         showNotification(`Tanda tangan "${name}" berhasil disimpan!`, 'bg-green-600');
     }).catch(error => {
         console.error("Error saving signature (WRITE FAILED):", error);
         saveSignatureBtn.disabled = false; 
         showNotification(`Gagal menyimpan tanda tangan. Kemungkinan masalah izin (Permission Denied). Cek konsol.`, 'bg-red-600');
     });
}

function deleteSignature(id, name) {
    if (!db) {
        showNotification("Aplikasi tidak terhubung ke database.", 'bg-red-600');
        return;
    }
    
    const confirmation = prompt(`Apakah Anda yakin ingin menghapus tanda tangan "${name}"? Ketik 'HAPUS' untuk melanjutkan:`);

    if (confirmation === 'HAPUS') {
        const docRef = doc(db, getSignatureCollectionPath(), id);
        deleteDoc(docRef)
            .then(() => {
                showNotification(`Tanda tangan "${name}" berhasil dihapus!`, 'bg-red-600');
                if (name === currentSignatureName) { clearSignature(); }
            })
            .catch(error => {
                console.error("Error deleting signature:", error);
                showNotification("Gagal menghapus tanda tangan.", 'bg-red-600');
            });
    } else if (confirmation !== null) {
        showNotification("Penghapusan dibatalkan.", 'bg-yellow-600');
    }
}

// --- 5. INTERACTION LOGIC (DRAG, RESIZE, PLACE) ---

placeSignatureBtn.addEventListener('click', () => {
    if (signatureImage === null) {
        showNotification("Harap muat atau pilih tanda tangan terlebih dahulu.", 'bg-yellow-600');
        return;
    }
    if (documentImage === null) {
         showNotification("Harap muat dokumen terlebih dahulu.", 'bg-yellow-600');
        return;
    }
    
    finalizeActiveSignature();
    renderDisplayCanvas(); 
    
    statusMessage.textContent = `Klik pada dokumen untuk menempatkan TTD: ${currentSignatureName}. (TTD sebelumnya telah difinalisasi)`;
    docCanvas.style.cursor = 'crosshair';
    
    docCanvas.removeEventListener('click', placeSignature); 
    docCanvas.addEventListener('click', placeSignature, { once: true });
    
    placeSignatureBtn.textContent = 'Tempelkan Tanda Tangan (Pilih Lokasi)';
    placeSignatureBtn.classList.replace('bg-red-500', 'bg-green-500');
    placeSignatureBtn.classList.replace('shadow-red-200', 'shadow-green-200');
});

function placeSignature(e) {
    if (!signatureImage || documentImage === null) return; 

    const { x, y } = getCoords(e, docCanvas);
    
    const sigWidth = docCanvas.width * 0.20; 
    const sigHeight = sigWidth * (signatureImage.height / signatureImage.width);

    finalizeActiveSignature();
    
    activePlacedSignature = {
        image: signatureImage,
        x: x - (sigWidth / 2), 
        y: y - (sigHeight / 2), 
        width: sigWidth,
        height: sigHeight,
        name: currentSignatureName 
    };

    renderDisplayCanvas();
    setupInteractionListeners(); 
    
    placeSignatureBtn.textContent = `TTD AKTIF: ${currentSignatureName} (Seret & Scroll/Pinch)`;
    placeSignatureBtn.classList.replace('bg-green-500', 'bg-red-500');
    placeSignatureBtn.classList.replace('shadow-green-200', 'shadow-red-200');
    docCanvas.style.cursor = 'grab';
    showNotification(`Tanda tangan ${currentSignatureName} ditempel, siap diseret dan diubah ukurannya.`, 'bg-indigo-600');
    statusMessage.textContent = 'Seret untuk memindahkannya. Gunakan roda scroll/pinch untuk ubah ukuran. Klik "Tempelkan Tanda Tangan" lagi untuk TTD baru.';
    
    docCanvas.removeEventListener('click', placeSignature);
}

function finalizeActiveSignature() {
    if (activePlacedSignature) {
        placedSignaturesHistory.push(activePlacedSignature); 
        activePlacedSignature = null; 
        removeInteractionListeners();
    }
}

function isOverSignature(x, y) {
    if (!activePlacedSignature) return false;

    return x >= activePlacedSignature.x &&
           x <= activePlacedSignature.x + activePlacedSignature.width &&
           y >= activePlacedSignature.y &&
           y <= activePlacedSignature.y + activePlacedSignature.height;
}

function handleStartDrag(e) {
    e.preventDefault();
    const { x, y } = getCoords(e, docCanvas);

    if (activePlacedSignature && isOverSignature(x, y)) {
        isDragging = true;
        docCanvas.style.cursor = 'grabbing';
        
        dragOffsetX = x - activePlacedSignature.x;
        dragOffsetY = y - activePlacedSignature.y;
    }
}

function handleDrag(e) {
    e.preventDefault();
    if (!isDragging || !activePlacedSignature) return;

    const { x, y } = getCoords(e, docCanvas);

    let newX = x - dragOffsetX;
    let newY = y - dragOffsetY;

    newX = Math.max(0, Math.min(newX, docCanvas.width - activePlacedSignature.width));
    newY = Math.max(0, Math.min(newY, docCanvas.height - activePlacedSignature.height));

    activePlacedSignature.x = newX;
    activePlacedSignature.y = newY;

    renderDisplayCanvas();
}

function handleEndDrag() {
    if (isDragging) {
        isDragging = false;
        if (activePlacedSignature) {
            docCanvas.style.cursor = 'grab'; 
        } else {
            docCanvas.style.cursor = 'crosshair';
        }
        showNotification('Posisi tanda tangan diperbarui (siap diunduh/finalisasi).', 'bg-indigo-500');
    }
}

docCanvas.addEventListener('wheel', handleScrollResize, { passive: false });

function handleScrollResize(e) {
    if (!activePlacedSignature || !isOverSignature(getCoords(e, docCanvas).x, getCoords(e, docCanvas).y)) return;

    e.preventDefault(); 
    
    const delta = e.deltaY; 
    const scaleFactor = delta < 0 ? (1 + RESIZE_STEP_PERCENTAGE) : (1 - RESIZE_STEP_PERCENTAGE);
    
    const newWidth = activePlacedSignature.width * scaleFactor;
    const newHeight = activePlacedSignature.height * scaleFactor;
    
    const minWidth = docCanvas.width * 0.05;
    const maxWidth = docCanvas.width * 0.40;
    
    if (newWidth > minWidth && newWidth < maxWidth) {
        activePlacedSignature.x -= (newWidth - activePlacedSignature.width) / 2;
        activePlacedSignature.y -= (newHeight - activePlacedSignature.height) / 2;
        activePlacedSignature.width = newWidth;
        activePlacedSignature.height = newHeight;
        
        renderDisplayCanvas();
        statusMessage.textContent = 'Ukuran tanda tangan disesuaikan. Seret untuk memindahkannya.';
    }
}

let initialPinchDistance = null;

function handleTouchStart(e) {
    if (e.touches.length === 2 && activePlacedSignature) {
        initialPinchDistance = getTouchDistance(e);
    }
    handleStartDrag(e);
}

function handleTouchMove(e) {
    if (e.touches.length === 2 && activePlacedSignature) {
        e.preventDefault();
        const currentDistance = getTouchDistance(e);
        
        if (initialPinchDistance) {
            const scaleChange = currentDistance / initialPinchDistance;
            let scaleFactor = 1;
            
            if (Math.abs(scaleChange - 1) > 0.01) { 
                scaleFactor = scaleChange;
            }

            const newWidth = activePlacedSignature.width * scaleFactor;
            const newHeight = activePlacedSignature.height * scaleFactor;

            const minWidth = docCanvas.width * 0.05;
            const maxWidth = docCanvas.width * 0.40;

            if (newWidth > minWidth && newWidth < maxWidth) {
                activePlacedSignature.x -= (newWidth - activePlacedSignature.width) / 2;
                activePlacedSignature.y -= (newHeight - activePlacedSignature.height) / 2;
                activePlacedSignature.width = newWidth;
                activePlacedSignature.height = newHeight;
                
                renderDisplayCanvas();
                initialPinchDistance = currentDistance; 
                statusMessage.textContent = 'Ukuran tanda tangan disesuaikan (Pinch). Seret untuk memindahkannya.';
            }
        }
    } else if (e.touches.length === 1) {
        handleDrag(e);
    }
}

function handleTouchEnd(e) {
    initialPinchDistance = null;
    handleEndDrag(e);
}

function setupInteractionListeners() {
    removeInteractionListeners(); 

    docCanvas.addEventListener('mousedown', handleStartDrag);
    docCanvas.addEventListener('mousemove', handleDrag);
    docCanvas.addEventListener('mouseup', handleEndDrag);
    docCanvas.addEventListener('mouseleave', handleEndDrag); 

    docCanvas.addEventListener('touchstart', handleTouchStart);
    docCanvas.addEventListener('touchmove', handleTouchMove);
    docCanvas.addEventListener('touchend', handleTouchEnd);
}

function removeInteractionListeners() {
    docCanvas.removeEventListener('mousedown', handleStartDrag);
    docCanvas.removeEventListener('mousemove', handleDrag);
    docCanvas.removeEventListener('mouseup', handleEndDrag);
    docCanvas.removeEventListener('mouseleave', handleEndDrag);

    docCanvas.removeEventListener('touchstart', handleTouchStart);
    docCanvas.removeEventListener('touchmove', handleTouchMove);
    docCanvas.removeEventListener('touchend', handleTouchEnd);
    
    docCanvas.removeEventListener('click', placeSignature);
    
    docCanvas.style.cursor = 'crosshair';
}


// --- 6. DOWNLOAD LOGIC (High-Res PDF Export) ---

downloadBtn.addEventListener('click', () => {
    if (documentImage === null) {
        showNotification("Dokumen belum dimuat.", 'bg-yellow-600');
        return;
    }
    
    finalizeActiveSignature();
    renderDisplayCanvas(); 
    
    const tempExportCanvas = document.createElement('canvas');
    const tempCtx = tempExportCanvas.getContext('2d');

    tempExportCanvas.width = documentImage.width;
    tempExportCanvas.height = documentImage.height;
    
    const scaleRatio = documentImage.width / docCanvas.width;

    tempCtx.drawImage(documentImage, 0, 0, tempExportCanvas.width, tempExportCanvas.height); 

    placedSignaturesHistory.forEach(sig => {
        tempCtx.drawImage(
            sig.image,
            sig.x * scaleRatio,
            sig.y * scaleRatio,
            sig.width * scaleRatio,
            sig.height * scaleRatio
        );
    });
    
    const imgData = tempExportCanvas.toDataURL('image/png'); 

    const pdfWidth = tempExportCanvas.width;
    const pdfHeight = tempExportCanvas.height;
    const orientation = pdfWidth > pdfHeight ? 'l' : 'p'; 
    
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF(orientation, 'px', [pdfWidth, pdfHeight]); 
    
    doc.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight, '', 'NONE'); 

    doc.save('dokumen_ditandatangani_HQ.pdf');
    
    placeSignatureBtn.classList.replace('bg-red-500', 'bg-green-500');
    placeSignatureBtn.classList.replace('shadow-red-200', 'shadow-green-200');
    placeSignatureBtn.textContent = 'Tempelkan Tanda Tangan (Pilih Lokasi)';
    docCanvas.style.cursor = 'crosshair';
    statusMessage.textContent = 'Selesai. Dokumen siap diunduh. Atau klik "Tempelkan Tanda Tangan" untuk TTD baru.';

    removeInteractionListeners();
    
    showNotification("Dokumen berhasil diunduh sebagai PDF dengan kualitas tinggi!", 'bg-indigo-600');
});

// Panggil untuk memastikan label dimuat di awal
updateSignatureLabel();
