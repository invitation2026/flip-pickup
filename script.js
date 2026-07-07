// ==========================================
// FIREBASE CONFIG
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyDGJWdgj2GBL-44gXZ9W0mWnOfsczwPXdw",
    authDomain: "mobile-shop-9ea44.firebaseapp.com",
    databaseURL: "https://mobile-shop-9ea44-default-rtdb.firebaseio.com",
    projectId: "mobile-shop-9ea44",
    storageBucket: "mobile-shop-9ea44.firebasestorage.app",
    messagingSenderId: "902893829958",
    appId: "1:902893829958:web:f2f429ad9290c56f4d6f47",
    measurementId: "G-V4JQT7Z8T9"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ==========================================
// STATE
// ==========================================
let currentUser = null;
let currentStatus = '';
let selectedReason = '';
let zxingCodeReader = null;
let isScanning = false;
let hiddenImei2 = '';
let scanMode = 'barcode';
let pendingFilter = 'all';
let allPendingOrders = [];
let pendingDoneOrderId = null;

let tesseractWorker = null;
let ocrInterval = null;
let isOcrScanning = false;
let ocrAttemptCount = 0;
let lastDetectedImei = '';

// ==========================================
// REASONS
// ==========================================
const rejectReasons = [
    { text: 'Customer wanted price only', icon: 'indian-rupee' },
    { text: 'Customer denied price drop', icon: 'trending-down' },
    { text: 'Device details mismatch', icon: 'alert-triangle' },
    { text: 'Fake device detected', icon: 'shield-alert' },
    { text: 'Phone has loan / finance lock', icon: 'landmark' },
    { text: 'Phone is dead / not working', icon: 'battery-warning' },
    { text: 'Other reason', icon: 'more-horizontal' }
];

const rescheduleReasons = [
    { text: 'On the way', icon: 'map-pin' },
    { text: 'Customer not picking call', icon: 'phone-missed' },
    { text: 'Wrong address / pin code', icon: 'map-pin-off' },
    { text: 'Customer asked for tomorrow', icon: 'calendar' },
    { text: 'Customer not at home', icon: 'home' },
    { text: 'Other reason', icon: 'more-horizontal' }
];

// ==========================================
// USER LISTENER (Real-time, no polling)
// ==========================================
let userListenerRef = null;

function startUserExistenceCheck() {
    if (!currentUser) return;
    stopUserExistenceCheck(); // cleanup previous listener
    const userRef = db.ref('users/' + currentUser.username);
    userRef.on('value', (snapshot) => {
        if (!snapshot.exists()) {
            // User deleted by admin
            logoutUser();
            showToast('❌ Your account has been deleted. You have been logged out.', 'error');
            return;
        }
        const data = snapshot.val();
        if (data.forceLogout === true) {
            // Admin forced logout
            // Remove the flag so it doesn't trigger again
            userRef.update({ forceLogout: null }).catch(() => {});
            logoutUser();
            showToast('🔒 You have been logged out by admin.', 'info');
        }
    });
    userListenerRef = userRef;
}

function stopUserExistenceCheck() {
    if (userListenerRef) {
        userListenerRef.off();
        userListenerRef = null;
    }
}

// ==========================================
// AUTH FUNCTIONS
// ==========================================
async function loginUser() {
    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value.trim();
    const errorEl = document.getElementById('loginError');

    if (!username || !password) {
        errorEl.textContent = 'Please enter both username and password.';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display = 'none';

    try {
        const snap = await db.ref('users/' + username).once('value');
        if (!snap.exists()) {
            errorEl.textContent = 'User not found. Please check your username.';
            errorEl.style.display = 'block';
            return;
        }
        const userData = snap.val();
        if (userData.password !== password) {
            errorEl.textContent = 'Incorrect password. Please try again.';
            errorEl.style.display = 'block';
            return;
        }

        currentUser = {
            username: username,
            name: userData.name,
            ...userData
        };
        localStorage.setItem('flipkart_agent_user', JSON.stringify(currentUser));
        showMainApp();
        showToast('✅ Welcome, ' + currentUser.name + '!', 'success');

        loadTodayStats();
        loadPendingOrders();

        // Start real-time listener
        startUserExistenceCheck();

    } catch (e) {
        console.error('Login error:', e);
        errorEl.textContent = 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
    }
}

function logoutUser() {
    stopUserExistenceCheck(); // cleanup listener
    localStorage.removeItem('flipkart_agent_user');
    currentUser = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('authOverlay').style.display = 'flex';
    showToast('Logged out', 'info');
}

function checkAuth() {
    const stored = localStorage.getItem('flipkart_agent_user');
    if (stored) {
        try {
            currentUser = JSON.parse(stored);
            verifyUserExists(currentUser.username).then(exists => {
                if (exists) {
                    showMainApp();
                    loadTodayStats();
                    loadPendingOrders();
                    startUserExistenceCheck(); // start listener
                } else {
                    logoutUser();
                    showToast('❌ Your account has been deleted. Please contact admin.', 'error');
                }
            });
            return true;
        } catch (e) {
            localStorage.removeItem('flipkart_agent_user');
        }
    }
    return false;
}

function verifyUserExists(username) {
    return db.ref('users/' + username).once('value').then(snap => snap.exists());
}

function showMainApp() {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    document.getElementById('userNameDisplay').textContent = currentUser.name || currentUser.username;
    setupOfflineDetection();
    lucide.createIcons();
    // Start listener if not already started
    startUserExistenceCheck();
}

// ==========================================
// CHANGE PASSWORD (for agent)
// ==========================================
function showChangePassword() {
    if (!currentUser) return;
    Swal.fire({
        title: 'Change Password',
        html: `
            <p class="text-sm text-gray-600 mb-2">Change your login password</p>
            <input type="password" id="newPw" class="swal2-input" placeholder="New password" minlength="4">
            <input type="password" id="confirmPw" class="swal2-input" placeholder="Confirm new password" minlength="4">
        `,
        showCancelButton: true,
        confirmButtonText: 'Update Password',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#64748b',
        preConfirm: () => {
            const newPw = document.getElementById('newPw').value;
            const confirmPw = document.getElementById('confirmPw').value;
            if (!newPw || newPw.length < 4) {
                Swal.showValidationMessage('Password must be at least 4 characters');
                return false;
            }
            if (newPw !== confirmPw) {
                Swal.showValidationMessage('Passwords do not match');
                return false;
            }
            return newPw;
        }
    }).then(async (result) => {
        if (result.isConfirmed) {
            try {
                await db.ref('users/' + currentUser.username + '/password').set(result.value);
                currentUser.password = result.value;
                localStorage.setItem('flipkart_agent_user', JSON.stringify(currentUser));
                showToast('✅ Password updated successfully', 'success');
            } catch (e) {
                showToast('Error updating password', 'error');
                console.error(e);
            }
        }
    });
}

// ==========================================
// INIT
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('offlineBanner').classList.add('hidden');
    const loggedIn = checkAuth();
    if (!loggedIn) {
        document.getElementById('authOverlay').style.display = 'flex';
    }
    if (loggedIn) {
        db.ref('pending').on('value', (snap) => {
            loadPendingOrders();
        });
    }
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loginUser();
    });
    document.getElementById('loginUsername').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginPassword').focus();
    });
});

// ==========================================
// ORIGINAL FUNCTIONS (unchanged from your original code)
// ==========================================

function setupOfflineDetection() {
    const updateStatus = () => {
        const isOnline = navigator.onLine;
        document.getElementById('offlineBanner').classList.toggle('hidden', isOnline);
        const statusEl = document.getElementById('connectionStatus');
        if (isOnline) {
            statusEl.className = 'flex items-center gap-1 px-2 py-1 bg-green-50 rounded-full';
            statusEl.innerHTML = '<div class="w-1.5 h-1.5 bg-green-500 rounded-full pulse-ring"></div><span class="text-[10px] font-medium text-green-700 hidden sm:inline">Online</span>';
        } else {
            statusEl.className = 'flex items-center gap-1 px-2 py-1 bg-red-50 rounded-full';
            statusEl.innerHTML = '<div class="w-1.5 h-1.5 bg-red-500 rounded-full"></div><span class="text-[10px] font-medium text-red-700 hidden sm:inline">Offline</span>';
        }
    };
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();
}

async function loadTodayStats() {
    if (!currentUser) return;
    try {
        const today = new Date().toDateString();
        const snapshot = await db.ref('pickups').once('value');
        const data = snapshot.val() || {};

        let pickup = 0, reject = 0, reschedule = 0;
        Object.values(data).forEach(item => {
            if (item.agent === currentUser.username && new Date(item.timestamp).toDateString() === today) {
                if (item.status === 'pickup') pickup++;
                else if (item.status === 'rejected') reject++;
                else if (item.status === 'reschedule') reschedule++;
            }
        });

        document.getElementById('statPickup').textContent = pickup;
        document.getElementById('statReject').textContent = reject;
        document.getElementById('statReschedule').textContent = reschedule;
    } catch (e) {
        console.log('Stats error:', e);
    }
}

async function loadPendingOrders() {
    if (!currentUser) return;
    try {
        const snapshot = await db.ref('pending').once('value');
        const data = snapshot.val() || {};
        allPendingOrders = [];

        for (const [orderId, item] of Object.entries(data)) {
            if (item.agent === currentUser.username) {
                allPendingOrders.push({
                    orderId,
                    ...item
                });
            }
        }

        allPendingOrders.sort((a, b) => {
            return (b.timestamp || 0) - (a.timestamp || 0);
        });

        renderPendingList();
        updatePendingCount();

    } catch (e) {
        console.log('Pending load error:', e);
        document.getElementById('pendingList').innerHTML =
            '<div class="pending-empty"><i data-lucide="alert-circle"></i><p class="text-sm font-medium text-red-500">Error loading pending</p></div>';
        lucide.createIcons();
    }
}

function updatePendingCount() {
    const count = allPendingOrders.length;
    document.getElementById('pendingCountBadge').textContent = count;
    document.getElementById('pendingCountBadge').style.display = count > 0 ? 'inline-block' : 'none';
}

function setPendingFilter(filter) {
    pendingFilter = filter;
    document.querySelectorAll('#pendingTabBar button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderPendingList();
}

function renderPendingList() {
    const container = document.getElementById('pendingList');
    let filtered = [...allPendingOrders];

    if (pendingFilter === 'onway') {
        filtered = filtered.filter(item =>
            item.reason && item.reason.toLowerCase().includes('on the way')
        );
    }

    if (filtered.length === 0) {
        const msg = pendingFilter === 'onway' ? 'No "On the way" orders' : 'No pending orders';
        container.innerHTML = `
            <div class="pending-empty">
                <i data-lucide="inbox"></i>
                <p class="text-sm font-medium">${msg}</p>
                <p class="text-xs text-gray-400 mt-1">Orders you reschedule will appear here</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    let html = '';
    filtered.forEach(item => {
        const isOnWay = item.reason && item.reason.toLowerCase().includes('on the way');
        const badge = isOnWay ? '<span class="badge-onway">🚗 On the way</span>' : '<span class="badge-pending">⏳ Pending</span>';
        const time = item.timestampIST || item.timestamp || '';
        const reason = item.reason || '—';
        const model = item.phoneModel || '—';

        html += `
            <div class="pending-item glass rounded-xl p-4 mb-3 shadow">
                <div class="flex items-start justify-between">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-mono font-bold text-gray-800 text-sm">${item.orderId}</span>
                            ${badge}
                            <span class="text-xs text-gray-400">(${model})</span>
                        </div>
                        <p class="text-xs text-gray-500 mt-1 flex items-center gap-1">
                            <i data-lucide="message-circle" class="w-3 h-3"></i>
                            ${reason}
                        </p>
                        <p class="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                            <i data-lucide="clock" class="w-3 h-3"></i>
                            ${time}
                        </p>
                    </div>
                    <button onclick="markPendingDone('${item.orderId}')" class="done-btn flex-shrink-0 ml-3">
                        <i data-lucide="check-circle"></i> Done
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
    lucide.createIcons();
}

function markPendingDone(orderId) {
    pendingDoneOrderId = orderId;
    document.getElementById('orderId').value = orderId;
    showForm('pickup');
    showToast(`📦 Pending order ${orderId} — fill pickup details`, 'info');
}

async function pasteOrderId() {
    try {
        const text = await navigator.clipboard.readText();
        document.getElementById('orderId').value = text.trim().toUpperCase();
        showToast('Pasted!', 'success');
    } catch (e) {
        showToast('Cannot access clipboard', 'error');
    }
}

// ==========================================
// SHOW FORM — with model field for reject & reschedule
// ==========================================
function showForm(status) {
    let orderId = document.getElementById('orderId').value.trim().toUpperCase();

    if (!orderId && pendingDoneOrderId) {
        orderId = pendingDoneOrderId;
        document.getElementById('orderId').value = orderId;
    }

    if (!orderId) {
        Swal.fire({
            icon: 'warning',
            title: 'Order ID Missing',
            text: 'Please enter the Order ID first',
            confirmButtonColor: '#3b82f6',
            timer: 2000
        });
        document.getElementById('orderId').focus();
        return;
    }

    pendingDoneOrderId = null;

    currentStatus = status;
    selectedReason = '';
    hiddenImei2 = '';
    document.getElementById('step-order').classList.add('hidden');
    document.getElementById('step-form').classList.remove('hidden');
    document.getElementById('displayOrderId').textContent = orderId;

    const formFields = document.getElementById('formFields');
    const formTitle = document.getElementById('formTitle');
    const formSubtitle = document.getElementById('formSubtitle');
    const formIcon = document.getElementById('formIcon');
    const submitBtn = document.getElementById('submitBtn');

    formFields.innerHTML = '';

    if (status === 'pickup') {
        formTitle.innerText = "Pickup Details";
        formSubtitle.innerText = "Fill device information";
        formIcon.className = "w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br from-green-500 to-emerald-600";
        formIcon.innerHTML = '<i data-lucide="check-circle-2" class="w-7 h-7 text-white"></i>';
        submitBtn.className = 'btn-bounce w-full bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4 rounded-2xl font-bold text-lg shadow-xl flex items-center justify-center gap-2';

        formFields.innerHTML = `
            <div>
                <label class="text-xs font-bold text-gray-500 mb-1.5 block">PHONE MODEL *</label>
                <input type="text" id="phoneModel" placeholder="e.g., iPhone 12, Samsung S21" class="input-field w-full p-3.5 rounded-xl outline-none">
            </div>
            <div>
                <label class="text-xs font-bold text-gray-500 mb-1.5 block">IMEI NUMBER *</label>
                <div class="relative">
                    <input type="text" id="imei" placeholder="15-digit IMEI" class="input-field w-full p-3.5 rounded-xl outline-none pr-28 font-mono" inputmode="numeric" maxlength="15">
                    <button onclick="startScanner()" class="btn-scan-imei absolute right-1.5 top-1/2 -translate-y-1/2">
                        <i data-lucide="scan-line"></i> Scan
                    </button>
                </div>
                <p class="text-xs text-gray-400 mt-1.5 flex items-center gap-1">
                    <span>📱</span>
                    <span>Barcode scan karo ya <strong>*#06#</strong> screen — Capture dabao, fatafat ho jaega!</span>
                </p>
            </div>
            <div>
                <label class="text-xs font-bold text-gray-500 mb-1.5 block">AGREED VALUE (₹) *</label>
                <div class="relative">
                    <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 font-bold">₹</span>
                    <input type="number" id="value" placeholder="0" class="input-field w-full p-3.5 pl-8 rounded-xl outline-none font-bold text-lg" inputmode="numeric">
                </div>
            </div>
            <div>
                <label class="text-xs font-bold text-gray-500 mb-1.5 block">CUSTOMER NAME <span class="text-gray-400">(Optional)</span></label>
                <input type="text" id="custName" placeholder="Enter name" class="input-field w-full p-3.5 rounded-xl outline-none">
            </div>
        `;
    } else {
        const reasons = (status === 'rejected') ? rejectReasons : rescheduleReasons;
        const isReject = status === 'rejected';

        formTitle.innerText = isReject ? "Rejection Reason" : "Reschedule / Pending";
        formSubtitle.innerText = isReject ? "Select the most appropriate reason" : "Select reason — 'On the way' means you're heading there";
        formIcon.className = `w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br ${isReject ? 'from-red-500 to-rose-600' : 'from-amber-500 to-orange-600'}`;
        formIcon.innerHTML = `<i data-lucide="${isReject ? 'x-circle' : 'clock'}" class="w-7 h-7 text-white"></i>`;
        submitBtn.className = `btn-bounce w-full bg-gradient-to-r ${isReject ? 'from-red-500 to-rose-600' : 'from-amber-500 to-orange-600'} text-white p-4 rounded-2xl font-bold text-lg shadow-xl flex items-center justify-center gap-2`;

        let reasonsHtml = `
            <div>
                <label class="text-xs font-bold text-gray-500 mb-1.5 block">PHONE MODEL *</label>
                <input type="text" id="phoneModelRejectReschedule" placeholder="e.g., iPhone 12, Samsung S21" class="input-field w-full p-3.5 rounded-xl outline-none">
            </div>
            <div class="space-y-2">
        `;
        reasons.forEach(r => {
            reasonsHtml += `
                <button onclick="selectReason(this, '${r.text}')" data-reason="${r.text}" class="reason-btn w-full text-left p-3.5 rounded-xl flex items-center gap-3 hover:bg-gray-50">
                    <div class="icon-wrap w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <i data-lucide="${r.icon}" class="w-4 h-4 text-gray-600"></i>
                    </div>
                    <span class="font-medium text-sm">${r.text}</span>
                </button>
            `;
        });
        reasonsHtml += '</div>';
        reasonsHtml += '<input type="text" id="otherReason" placeholder="Type your reason here..." class="input-field w-full p-3.5 rounded-xl outline-none hidden mt-3">';
        formFields.innerHTML = reasonsHtml;

        setTimeout(() => {
            const firstBtn = document.querySelector('.reason-btn');
            if (firstBtn) {
                selectReason(firstBtn, firstBtn.dataset.reason);
            }
        }, 100);
    }

    lucide.createIcons();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goBack() {
    document.getElementById('step-order').classList.remove('hidden');
    document.getElementById('step-form').classList.add('hidden');
    pendingDoneOrderId = null;
}

function selectReason(btn, reason) {
    document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedReason = reason;

    const otherInput = document.getElementById('otherReason');
    if (reason.toLowerCase().includes('other')) {
        otherInput.classList.remove('hidden');
        otherInput.focus();
    } else {
        otherInput.classList.add('hidden');
    }
}

// ==========================================
// SCAN MODE TOGGLE
// ==========================================
function setScanMode(mode) {
    scanMode = mode;
    document.querySelectorAll('#scanModeToggle button').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    const hint = document.getElementById('scanHint');
    const tip = document.getElementById('scanTip');
    const captureBtn = document.getElementById('captureBtn');

    if (mode === 'barcode') {
        hint.textContent = '📱 Barcode ko box me align karo';
        tip.innerHTML = '<strong>💡 Tip:</strong> Phone box ya back panel pe IMEI barcode hota hai. Usko scan karo. Fatafat ho jaega!';
        captureBtn.style.display = 'none';
        document.getElementById('imeiResult').classList.remove('show');
    } else {
        hint.textContent = '📱 *#06# screen dikhao — phir Capture dabao, auto detect ho jaega';
        tip.innerHTML = '<strong>💡 Tip:</strong> Phone me *#06# dial karo, IMEI screen dikhao. <strong>Capture</strong> dabao — background scan start ho jaega, IMEI detect hote hi fill ho jaega!';
        captureBtn.style.display = 'flex';
        document.getElementById('imeiResult').classList.remove('show');
        captureBtn.disabled = false;
        captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
        lucide.createIcons();
    }
    lucide.createIcons();
}

// ==========================================
// TESSERACT INIT
// ==========================================
async function initTesseract() {
    if (typeof Tesseract === 'undefined') {
        console.warn('⚠️ Tesseract.js not loaded');
        return null;
    }
    try {
        console.log('🔄 Initializing Tesseract OCR...');
        const worker = await Tesseract.createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    const pct = Math.round(m.progress * 100);
                    document.getElementById('ocrProgressBar').style.width = pct + '%';
                }
            }
        });
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789IMEI: ',
            tessedit_pageseg_mode: '6',
            tessedit_ocr_engine_mode: '3',
        });
        console.log('✅ Tesseract ready');
        return worker;
    } catch (e) {
        console.error('❌ Tesseract init error:', e);
        return null;
    }
}

// ==========================================
// START SCANNER
// ==========================================
async function startScanner() {
    const modal = document.getElementById('scannerModal');
    const video = document.getElementById('scanVideo');
    const statusText = document.getElementById('scanStatusText');
    const spinner = document.getElementById('scanSpinner');

    modal.classList.remove('hidden');
    statusText.textContent = '🔄 Starting camera...';
    spinner.style.display = 'inline-block';
    lucide.createIcons();

    document.getElementById('imeiResult').classList.remove('show');
    document.getElementById('ocrProgress').style.display = 'none';
    document.getElementById('ocrProgressBar').style.width = '0%';

    if (scanMode === 'ocr') {
        tesseractWorker = await initTesseract();
    }

    try {
        if (typeof ZXing === 'undefined' || !ZXing.BrowserMultiFormatReader) {
            throw new Error('ZXing library not loaded');
        }

        const hints = new Map();
        const formats = [
            ZXing.BarcodeFormat.CODE_128,
            ZXing.BarcodeFormat.CODE_39,
            ZXing.BarcodeFormat.EAN_13,
            ZXing.BarcodeFormat.EAN_8,
            ZXing.BarcodeFormat.UPC_A,
            ZXing.BarcodeFormat.UPC_E,
            ZXing.BarcodeFormat.ITF,
            ZXing.BarcodeFormat.QR_CODE,
            ZXing.BarcodeFormat.DATA_MATRIX,
            ZXing.BarcodeFormat.CODE_93
        ];
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(ZXing.DecodeHintType.CHARACTER_SET, 'UTF-8');

        zxingCodeReader = new ZXing.BrowserMultiFormatReader(hints);

        const devices = await zxingCodeReader.listVideoInputDevices();
        console.log('📷 Cameras:', devices);

        let deviceId = null;
        for (const d of devices) {
            if (d.label && /back|rear|environment/i.test(d.label)) {
                deviceId = d.deviceId;
                break;
            }
        }
        if (!deviceId && devices.length > 0) {
            deviceId = devices[devices.length - 1].deviceId;
        }

        statusText.textContent = '📷 Camera ready';

        await zxingCodeReader.decodeFromVideoDevice(
            deviceId,
            'scanVideo',
            (result, err) => {
                if (result && scanMode === 'barcode') {
                    const raw = result.getText();
                    console.log('✅ Barcode:', raw);
                    const imeis = extractIMEIs(raw);
                    if (imeis.imei1 && imeis.imei1.length >= 14) {
                        onScanSuccess(imeis.imei1, imeis.imei2);
                    }
                } else if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error('Scan error:', err);
                }
            }
        );

        isScanning = true;
        statusText.textContent = scanMode === 'barcode' ? '🎯 Scanning barcode...' : '📱 Ready — tap Capture';
        spinner.style.display = 'none';

        if (scanMode === 'ocr') {
            document.getElementById('captureBtn').style.display = 'flex';
            document.getElementById('captureBtn').disabled = false;
            document.getElementById('captureBtn').innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
            lucide.createIcons();
        } else {
            document.getElementById('captureBtn').style.display = 'none';
        }

        const tip = document.getElementById('scanTip');
        if (scanMode === 'barcode') {
            tip.innerHTML = '<strong>💡 Tip:</strong> Phone box ya back panel pe IMEI barcode hota hai. Auto scan ho jaega!';
        } else {
            tip.innerHTML = '<strong>💡 Tip:</strong> Phone me *#06# dial karo, IMEI screen dikhao. <strong>Capture</strong> dabao — background scan start ho jaega, IMEI detect hote hi fill ho jaega!';
        }

    } catch (err) {
        console.error('Scanner error:', err);
        stopScanner();
        let msg = 'Camera access failed';
        if (err.name === 'NotAllowedError') msg = 'Please allow camera permission in browser settings';
        else if (err.name === 'NotFoundError') msg = 'No camera found on this device';
        else if (err.name === 'NotSecureError' || window.location.protocol === 'file:') {
            msg = 'Camera needs HTTPS. Host this page online (Netlify/Vercel).';
        } else if (err.message && err.message.includes('ZXing')) {
            msg = 'Scanner library failed to load. Check internet.';
        }
        Swal.fire({ icon: 'error', title: 'Camera Error', text: msg, confirmButtonColor: '#3b82f6' });
    }
}

// ==========================================
// START OCR SCANNING
// ==========================================
async function startOCRScanning() {
    if (scanMode !== 'ocr') return;
    if (isOcrScanning) {
        showToast('Already scanning...', 'info');
        return;
    }

    if (!tesseractWorker) {
        showToast('⏳ Initializing OCR...', 'info');
        tesseractWorker = await initTesseract();
        if (!tesseractWorker) {
            showToast('❌ OCR initialization failed', 'error');
            return;
        }
    }

    const video = document.getElementById('scanVideo');
    if (!video.videoWidth || video.videoWidth === 0) {
        showToast('⏳ Camera not ready', 'error');
        return;
    }

    isOcrScanning = true;
    lastDetectedImei = '';
    ocrAttemptCount = 0;

    const captureBtn = document.getElementById('captureBtn');
    captureBtn.disabled = true;
    captureBtn.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2px;"></span> Scanning...';

    const statusText = document.getElementById('scanStatusText');
    const progress = document.getElementById('ocrProgress');
    const progressBar = document.getElementById('ocrProgressBar');
    progress.style.display = 'block';
    progressBar.style.width = '0%';

    statusText.textContent = '📸 Capturing & scanning...';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const maxW = 800;
    const scale = Math.min(1, maxW / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    canvas.width = w;
    canvas.height = h;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, w, h);

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const adjusted = ((gray / 255 - 0.5) * 2.2 + 0.5) * 255;
        const val = Math.max(0, Math.min(255, adjusted));
        d[i] = d[i + 1] = d[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);

    try {
        const { data: { text } } = await tesseractWorker.recognize(canvas);
        console.log('🔍 Immediate OCR result:', text);
        const imeis = extractIMEIs(text);
        if (imeis.imei1 && imeis.imei1.length >= 14) {
            handleImeiFound(imeis.imei1, imeis.imei2);
            return;
        }
    } catch (e) {
        console.error('Immediate OCR error:', e);
    }

    statusText.textContent = '🔍 Scanning in background...';
    progressBar.style.width = '0%';
    ocrAttemptCount = 0;

    if (ocrInterval) clearInterval(ocrInterval);

    ocrInterval = setInterval(async () => {
        if (!isScanning || !isOcrScanning) {
            stopOCRScanning();
            return;
        }

        if (!video.videoWidth || video.videoWidth === 0) {
            return;
        }

        ocrAttemptCount++;

        const c2 = document.createElement('canvas');
        const ctx2 = c2.getContext('2d');
        const maxW2 = 640;
        const scale2 = Math.min(1, maxW2 / video.videoWidth);
        const w2 = Math.round(video.videoWidth * scale2);
        const h2 = Math.round(video.videoHeight * scale2);
        c2.width = w2;
        c2.height = h2;

        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = 'high';
        ctx2.drawImage(video, 0, 0, w2, h2);

        const imgData2 = ctx2.getImageData(0, 0, w2, h2);
        const d2 = imgData2.data;
        for (let i = 0; i < d2.length; i += 4) {
            const gray = d2[i] * 0.299 + d2[i + 1] * 0.587 + d2[i + 2] * 0.114;
            const adjusted = ((gray / 255 - 0.5) * 2.2 + 0.5) * 255;
            const val = Math.max(0, Math.min(255, adjusted));
            d2[i] = d2[i + 1] = d2[i + 2] = val;
        }
        ctx2.putImageData(imgData2, 0, 0);

        const pct = Math.min(100, (ocrAttemptCount / 15) * 100);
        progressBar.style.width = pct + '%';

        try {
            const { data: { text } } = await tesseractWorker.recognize(c2);
            console.log('🔍 Background OCR #' + ocrAttemptCount);
            const imeis = extractIMEIs(text);
            if (imeis.imei1 && imeis.imei1.length >= 14) {
                handleImeiFound(imeis.imei1, imeis.imei2);
                return;
            }
        } catch (e) {
            console.error('Background OCR error:', e);
        }
    }, 1500);
}

// ==========================================
// HANDLE IMEI FOUND
// ==========================================
function handleImeiFound(imei1, imei2) {
    if (!isOcrScanning && !isScanning) return;

    if (imei1 === lastDetectedImei) return;
    lastDetectedImei = imei1;

    console.log('✅ IMEI detected:', imei1);

    const resultEl = document.getElementById('imeiResult');
    const resultText = document.getElementById('imeiResultText');
    resultText.textContent = '✅ IMEI: ' + imei1 + (imei2 ? ' | IMEI2 captured' : '');
    resultEl.classList.add('show');

    const imeiInput = document.getElementById('imei');
    if (imeiInput) {
        imeiInput.value = imei1;
        imeiInput.classList.add('flash-green');
        setTimeout(() => imeiInput.classList.remove('flash-green'), 500);
    }

    if (imei2) {
        hiddenImei2 = imei2;
        console.log('🤫 IMEI2 stored:', hiddenImei2);
    }

    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);

    document.getElementById('scanStatusText').textContent = '✅ IMEI captured!';
    showToast('✅ IMEI: ' + imei1, 'success');

    stopOCRScanning();
    setTimeout(() => stopScanner(), 800);
}

// ==========================================
// STOP OCR SCANNING
// ==========================================
function stopOCRScanning() {
    isOcrScanning = false;
    if (ocrInterval) {
        clearInterval(ocrInterval);
        ocrInterval = null;
    }

    const captureBtn = document.getElementById('captureBtn');
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
    lucide.createIcons();

    document.getElementById('ocrProgress').style.display = 'none';
    document.getElementById('ocrProgressBar').style.width = '0%';
}

// ==========================================
// IMEI LUHN VALIDATION
// ==========================================
function isValidIMEI(imei) {
    if (!imei || imei.length !== 15) return false;
    if (!/^\d{15}$/.test(imei)) return false;
    if (!/^[3-9]/.test(imei)) return false;
    let sum = 0;
    for (let i = 0; i < 15; i++) {
        let digit = parseInt(imei[i]);
        if (i % 2 === 1) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

// ==========================================
// EXTRACT IMEI
// ==========================================
function extractIMEIs(text) {
    console.log('🔍 Extracting IMEI from:', text);

    let imei1 = null, imei2 = null;
    const candidates = [];

    let clean = text
        .replace(/[Oo]/g, '0')
        .replace(/[Ss]/g, '5')
        .replace(/[Bb]/g, '8')
        .replace(/[Zz]/g, '2')
        .replace(/[Gg]/g, '6')
        .replace(/[Tt]/g, '7')
        .replace(/[Ll]/g, '1')
        .replace(/\s+/g, ' ')
        .trim();

    console.log('🧹 Cleaned:', clean);

    const all15Digits = clean.match(/\d{15}/g) || [];
    const all14Digits = clean.match(/\d{14}/g) || [];

    for (let num of all15Digits) {
        if (/^[3-9]/.test(num) && isValidIMEI(num)) {
            candidates.push(num);
            console.log('✅ Valid IMEI found:', num);
        }
    }

    const imeiPatterns = [
        /IMEI\s*1\s*[:\-]?\s*(\d{15})/i,
        /IMEI\s*[:\-]?\s*(\d{15})/i,
        /IMEI1\s*[:\-]?\s*(\d{15})/i,
        /IMEI2\s*[:\-]?\s*(\d{15})/i,
    ];

    for (let pattern of imeiPatterns) {
        const match = clean.match(pattern);
        if (match && match[1]) {
            const num = match[1];
            if (/^[3-9]/.test(num) && isValidIMEI(num)) {
                if (!imei1) {
                    imei1 = num;
                    console.log('✅ IMEI1 from keyword:', imei1);
                } else if (num !== imei1 && !imei2) {
                    imei2 = num;
                    console.log('✅ IMEI2 from keyword:', imei2);
                }
            }
        }
    }

    if (!imei1 && candidates.length > 0) {
        imei1 = candidates[0];
        console.log('✅ IMEI1 from candidates:', imei1);
    }
    if (!imei2 && candidates.length > 1) {
        for (let c of candidates) {
            if (c !== imei1) {
                imei2 = c;
                console.log('✅ IMEI2 from candidates:', imei2);
                break;
            }
        }
    }

    if (!imei1 && all14Digits.length > 0) {
        for (let num of all14Digits) {
            if (!/^[3-9]/.test(num)) continue;
            for (let check = 0; check <= 9; check++) {
                const candidate = num + check;
                if (isValidIMEI(candidate)) {
                    if (!imei1) {
                        imei1 = candidate;
                        console.log('✅ IMEI1 from 14-digit + check:', imei1);
                    } else if (candidate !== imei1 && !imei2) {
                        imei2 = candidate;
                        console.log('✅ IMEI2 from 14-digit + check:', imei2);
                    }
                    break;
                }
            }
            if (imei1 && imei2) break;
        }
    }

    if (imei1 && !isValidIMEI(imei1)) {
        console.log('❌ IMEI1 failed Luhn check, rejecting:', imei1);
        imei1 = null;
    }
    if (imei2 && !isValidIMEI(imei2)) {
        console.log('❌ IMEI2 failed Luhn check, rejecting:', imei2);
        imei2 = null;
    }

    console.log('📱 Final IMEI1:', imei1, '| IMEI2:', imei2);
    return { imei1, imei2 };
}

// ==========================================
// ON SCAN SUCCESS
// ==========================================
function onScanSuccess(imei1, imei2) {
    if (!isScanning) return;
    isScanning = false;

    const imeiInput = document.getElementById('imei');
    if (imeiInput) {
        imeiInput.value = imei1;
        imeiInput.classList.add('flash-green');
        setTimeout(() => imeiInput.classList.remove('flash-green'), 500);
    }

    if (imei2) {
        hiddenImei2 = imei2;
        console.log('🤫 IMEI2 stored:', hiddenImei2);
    }

    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);

    stopScanner();
    const msg = imei2 ? `✅ IMEI: ${imei1}\n✅ IMEI2 also captured!` : `✅ IMEI: ${imei1}`;
    showToast(msg, 'success');
}

// ==========================================
// STOP SCANNER
// ==========================================
function stopScanner() {
    isScanning = false;
    stopOCRScanning();

    if (zxingCodeReader) {
        try { zxingCodeReader.reset(); } catch (e) {}
        zxingCodeReader = null;
    }

    const video = document.getElementById('scanVideo');
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }

    if (tesseractWorker) {
        try { tesseractWorker.terminate(); } catch (e) {}
        tesseractWorker = null;
    }

    document.getElementById('scannerModal').classList.add('hidden');
    document.getElementById('scanSpinner').style.display = 'none';
    document.getElementById('scanStatusText').textContent = 'Stopped';
    document.getElementById('ocrProgress').style.display = 'none';
    document.getElementById('captureBtn').style.display = 'none';
    document.getElementById('imeiResult').classList.remove('show');

    const captureBtn = document.getElementById('captureBtn');
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
    lucide.createIcons();
}

// ==========================================
// TOAST
// ==========================================
function showToast(message, type = 'info') {
    const colors = { success: 'bg-green-500', error: 'bg-red-500', info: 'bg-blue-500' };
    const toast = document.createElement('div');
    toast.className = `fixed top-20 left-1/2 -translate-x-1/2 ${colors[type]} text-white px-5 py-3 rounded-xl shadow-2xl z-[60] font-semibold text-sm fade-in max-w-[90%]`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}

// ==========================================
// GET IST DATE/TIME
// ==========================================
function getISTDateTime() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dd = String(istTime.getUTCDate()).padStart(2, '0');
    const mmm = months[istTime.getUTCMonth()];
    const yyyy = istTime.getUTCFullYear();
    let hours = istTime.getUTCHours();
    const minutes = String(istTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(istTime.getUTCSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hh = String(hours).padStart(2, '0');
    return `${dd}-${mmm}-${yyyy}, ${hh}:${minutes}:${seconds} ${ampm} IST`;
}

// ==========================================
// SUBMIT DATA — with model for reject & reschedule
// ==========================================
async function submitData() {
    if (!currentUser) {
        showToast('Please login first', 'error');
        return;
    }

    const orderId = document.getElementById('orderId').value.trim().toUpperCase();

    let existingData = null;
    let exists = false;
    try {
        const existingSnap = await db.ref('pickups/' + orderId).once('value');
        exists = existingSnap.exists();
        if (exists) {
            existingData = existingSnap.val();
        }
    } catch (e) {
        console.error('Check error:', e);
        showToast('Error checking order status', 'error');
        return;
    }

    // Password required for rejected -> pickup
    if (exists && existingData.status === 'rejected' && currentStatus === 'pickup') {
        const { value: password, isConfirmed } = await Swal.fire({
            title: '🔐 Admin Password Required',
            html: `
                <p class="text-sm text-gray-600 mb-2">This order was previously <span class="text-red-600 font-bold">REJECTED</span>.</p>
                <p class="text-sm text-gray-600 mb-2">Enter admin password to mark as <span class="text-green-600 font-bold">PICKUP COMPLETED</span>.</p>
                <p class="text-xs text-gray-400 mt-2">Only admin knows this password.</p>
            `,
            input: 'password',
            inputPlaceholder: 'Enter admin password',
            inputAttributes: { autocapitalize: 'off', autocorrect: 'off' },
            showCancelButton: true,
            confirmButtonColor: '#3b82f6',
            cancelButtonColor: '#dc2626',
            confirmButtonText: '✅ Verify & Proceed',
            cancelButtonText: 'Cancel',
            allowOutsideClick: false,
            preConfirm: (input) => {
                if (!input) {
                    Swal.showValidationMessage('Please enter the password');
                    return false;
                }
                return input;
            }
        });

        if (!isConfirmed) {
            showToast('❌ Operation cancelled', 'error');
            return;
        }

        if (password !== 'admin123') {
            Swal.fire({
                icon: 'error',
                title: '❌ Wrong Password',
                text: 'Invalid admin password. Access denied.',
                confirmButtonColor: '#dc2626'
            });
            return;
        }

        showToast('✅ Password verified! Proceeding...', 'success');
    }

    // Duplicate pickup prevention
    if (exists && existingData.status === 'pickup' && currentStatus === 'pickup') {
        Swal.fire({
            icon: 'error',
            title: 'Already Pickup Completed',
            text: `Order ID "${orderId}" is already marked as Pickup Completed. You cannot submit it again.`,
            confirmButtonColor: '#3b82f6'
        });
        return;
    }

    const now = new Date();
    const istDateTime = getISTDateTime();

    let dbData = {
        orderId,
        status: currentStatus,
        timestamp: now.toISOString(),
        timestampIST: istDateTime,
        date: now.toLocaleDateString('en-IN'),
        time: now.toLocaleTimeString('en-IN'),
        agent: currentUser.username
    };

    let whatsappMsg = '';

    if (currentStatus === 'pickup') {
        const phoneModel = document.getElementById('phoneModel').value.trim();
        const imei = document.getElementById('imei').value.trim();
        const value = document.getElementById('value').value.trim();
        const custName = document.getElementById('custName').value.trim();

        if (!phoneModel || !imei || !value) {
            Swal.fire({
                icon: 'error',
                title: 'Missing Details',
                text: 'Please fill Model, IMEI, and Value',
                confirmButtonColor: '#3b82f6'
            });
            return;
        }

        dbData.phoneModel = phoneModel;
        dbData.imei = imei;
        if (hiddenImei2) dbData.imei2 = hiddenImei2;
        dbData.value = parseInt(value);
        dbData.customerName = custName || 'N/A';

        whatsappMsg = `Order ID: ${orderId}\nStatus: Pickup Completed`;

    } else {
        // Reject or Reschedule: get model and reason
        const phoneModel = document.getElementById('phoneModelRejectReschedule').value.trim();
        if (!phoneModel) {
            Swal.fire({
                icon: 'error',
                title: 'Missing Model',
                text: 'Please enter the phone model.',
                confirmButtonColor: '#3b82f6'
            });
            return;
        }
        dbData.phoneModel = phoneModel;

        let reason = selectedReason;
        if (reason.toLowerCase().includes('other')) {
            reason = document.getElementById('otherReason').value.trim();
            if (!reason) {
                Swal.fire({
                    icon: 'warning',
                    title: 'Reason Required',
                    text: 'Please type the reason',
                    confirmButtonColor: '#3b82f6'
                });
                return;
            }
        }
        if (!reason) {
            Swal.fire({
                icon: 'warning',
                title: 'Select Reason',
                text: 'Please choose a reason',
                confirmButtonColor: '#3b82f6'
            });
            return;
        }

        dbData.reason = reason;

        if (currentStatus === 'rejected') {
            whatsappMsg = `Order ID: ${orderId}\nStatus: Rejected\nModel: ${phoneModel}\nReason: ${reason}`;
        } else {
            whatsappMsg = `Order ID: ${orderId}\nModel: ${phoneModel}\nReason: ${reason}`;
        }
    }

    // Check if this is a reschedule and order is already pending with a different reason
    if (currentStatus === 'reschedule') {
        try {
            const pendingSnap = await db.ref('pending/' + orderId).once('value');
            if (pendingSnap.exists()) {
                const existingPending = pendingSnap.val();
                const existingReason = existingPending.reason || '';
                const newReason = dbData.reason || selectedReason;

                if (existingReason !== newReason) {
                    const result = await Swal.fire({
                        title: 'Change Reason?',
                        text: `This order is already pending with reason: "${existingReason}". Do you want to update it to "${newReason}"?`,
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonColor: '#f59e0b',
                        cancelButtonColor: '#64748b',
                        confirmButtonText: 'Yes, update reason',
                        cancelButtonText: 'Cancel'
                    });
                    if (!result.isConfirmed) {
                        showToast('❌ Update cancelled', 'error');
                        return;
                    }
                }
            }
        } catch (e) {
            console.error('Pending check error:', e);
        }
    }

    Swal.fire({
        title: 'Saving...',
        html: 'Please wait',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try {
        if (exists) {
            await db.ref('pickups/' + orderId).update(dbData);
            console.log('🔄 Updated existing order:', orderId);
        } else {
            await db.ref('pickups/' + orderId).set(dbData);
            console.log('✅ Created new order:', orderId);
        }

        if (currentStatus === 'pickup' || currentStatus === 'rejected') {
            const pendingSnap = await db.ref('pending/' + orderId).once('value');
            if (pendingSnap.exists()) {
                await db.ref('pending/' + orderId).remove();
                console.log('🗑️ Pending removed:', orderId);
                await loadPendingOrders();
            }
        }

        if (currentStatus === 'reschedule') {
            const pendingData = {
                orderId,
                phoneModel: dbData.phoneModel,
                reason: dbData.reason || selectedReason,
                status: 'reschedule',
                timestamp: now.toISOString(),
                timestampIST: istDateTime,
                agent: currentUser.username
            };
            await db.ref('pending/' + orderId).set(pendingData);
            console.log('📌 Pending saved/updated:', orderId);
            await loadPendingOrders();
        }

        const result = await Swal.fire({
            icon: 'success',
            title: '✅ Saved Successfully!',
            html: `
                <p class="text-sm text-gray-600 mb-2">📊 Firebase me time save ho gaya:</p>
                <div class="text-left bg-blue-50 p-2 rounded-lg text-xs font-mono mb-3">${istDateTime}</div>
                <p class="text-sm text-gray-600 mb-2">📱 WhatsApp message (no time):</p>
                <div class="text-left bg-gray-50 p-3 rounded-lg text-xs font-mono whitespace-pre-wrap">${whatsappMsg}</div>
            `,
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '📤 Open WhatsApp',
            denyButtonText: '📋 Copy Message',
            cancelButtonText: 'Close',
            confirmButtonColor: '#25D366',
            denyButtonColor: '#3b82f6'
        });

        if (result.isConfirmed) {
            const encoded = encodeURIComponent(whatsappMsg);
            window.open(`https://wa.me/?text=${encoded}`, '_blank');
            showToast('Select your group in WhatsApp', 'success');
        } else if (result.isDenied) {
            try {
                await navigator.clipboard.writeText(whatsappMsg);
                showToast('✅ Message copied!', 'success');
            } catch (e) {
                const ta = document.createElement('textarea');
                ta.value = whatsappMsg;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast('✅ Message copied!', 'success');
            }
        }

        document.getElementById('orderId').value = '';
        hiddenImei2 = '';
        goBack();
        loadTodayStats();
        loadPendingOrders();

    } catch (error) {
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: error.message,
            confirmButtonColor: '#3b82f6'
        });
    }
}