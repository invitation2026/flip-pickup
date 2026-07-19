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

// ========== BILL / AADHAAR IMAGE STATE (Pickup) ==========
// Multi-image support (max 3 per document)
const PICKUP_MAX_IMAGES = 3;
let pickupBillImages = [];      // array of compressed base64 dataURLs
let pickupAadhaarImages = [];   // array of compressed base64 dataURLs

// Compress image file -> JPEG dataURL (max 1400px, quality ~0.72)
// Works for both camera capture and gallery pick via <input type="file" accept="image/*">
function compressImageFile(file, maxDim = 1400, quality = 0.72) {
    return new Promise((resolve, reject) => {
        if (!file) return reject('No file');
        if (!file.type.startsWith('image/')) return reject('Not an image');
        const reader = new FileReader();
        reader.onerror = () => reject('Read error');
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject('Image decode error');
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
                    else                { width  = Math.round(width  * maxDim / height); height = maxDim; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                try {
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    resolve(dataUrl);
                } catch (e) { reject(e); }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

// Render preview thumbnails for pickup images (with remove button per image)
function renderPickupImgList(which) {
    const arr = which === 'bill' ? pickupBillImages : pickupAadhaarImages;
    const previewEl = document.getElementById(which === 'bill' ? 'billImgPreview' : 'aadhaarImgPreview');
    const infoEl = document.getElementById(which === 'bill' ? 'billImgInfo' : 'aadhaarImgInfo');
    if (!previewEl) return;
    if (!arr.length) {
        previewEl.innerHTML = '';
        if (infoEl) infoEl.textContent = `${PICKUP_MAX_IMAGES} images max · ${PICKUP_MAX_IMAGES} slots free`;
        return;
    }
    let totalKB = 0;
    previewEl.innerHTML = `<div class="grid grid-cols-3 gap-2">` + arr.map((d, i) => {
        const kb = Math.round((d.length * 3 / 4) / 1024);
        totalKB += kb;
        return `<div class="relative group">
            <img src="${d}" class="w-full h-20 object-cover rounded-lg border border-gray-200" alt="p${i}">
            <button type="button" onclick="removePickupImage('${which}',${i})" class="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold shadow-md">✕</button>
            <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] text-center rounded-b-lg">${kb}KB</div>
        </div>`;
    }).join('') + `</div>`;
    if (infoEl) infoEl.textContent = `✅ ${arr.length}/${PICKUP_MAX_IMAGES} · total ~${totalKB} KB`;
}

// Handle image pick for pickup form — appends to array (max PICKUP_MAX_IMAGES)
async function handlePickupImagePick(inputEl, which) {
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    if (!files.length) return;
    const arr = which === 'bill' ? pickupBillImages : pickupAadhaarImages;
    const infoEl = document.getElementById(which === 'bill' ? 'billImgInfo' : 'aadhaarImgInfo');
    if (arr.length >= PICKUP_MAX_IMAGES) {
        showToast(`Max ${PICKUP_MAX_IMAGES} images allowed`, 'error');
        inputEl.value = '';
        return;
    }
    const room = PICKUP_MAX_IMAGES - arr.length;
    const toProcess = files.slice(0, room);
    if (infoEl) infoEl.textContent = '⏳ Compressing…';
    for (const f of toProcess) {
        try {
            const dataUrl = await compressImageFile(f);
            arr.push(dataUrl);
        } catch (e) {
            console.error(e);
            showToast('Image process failed', 'error');
        }
    }
    inputEl.value = '';  // allow re-picking same file
    renderPickupImgList(which);
}

function removePickupImage(which, idx) {
    const arr = which === 'bill' ? pickupBillImages : pickupAadhaarImages;
    arr.splice(idx, 1);
    renderPickupImgList(which);
}

function clearPickupImageState() {
    pickupBillImages = [];
    pickupAadhaarImages = [];
}


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
// USER LISTENER (Real-time – delete/force logout)
// ==========================================
let userListenerRef = null;

function startUserExistenceCheck() {
    if (!currentUser) return;
    stopUserExistenceCheck();
    const userRef = db.ref('users/' + currentUser.username);
    userRef.on('value', (snapshot) => {
        if (!snapshot.exists()) {
            logoutUser();
            showToast('❌ Your account has been deleted. Logged out.', 'error');
            return;
        }
        const data = snapshot.val();
        if (data.forceLogout === true) {
            userRef.update({ forceLogout: null }).catch(() => {});
            logoutUser();
            showToast('🔒 You have been logged out by admin.', 'info');
        }
        // Check if blocked (only for agents)
        if (data.is_blocked === true && data.role !== 'admin') {
            document.getElementById('blockedOverlay').style.display = 'flex';
        } else {
            document.getElementById('blockedOverlay').style.display = 'none';
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
            errorEl.textContent = 'User not found. Check username.';
            errorEl.style.display = 'block';
            return;
        }
        const userData = snap.val();
        if (userData.password !== password) {
            errorEl.textContent = 'Incorrect password.';
            errorEl.style.display = 'block';
            return;
        }
        currentUser = { username, name: userData.name, ...userData };
        localStorage.setItem('flipkart_agent_user', JSON.stringify(currentUser));
        showMainApp();
        showToast('✅ Welcome, ' + currentUser.name + '!', 'success');
        // FIX: admin skip attendance
        if (currentUser.role !== 'admin') {
            await checkAttendanceAndBlock();
            loadAttendanceHistory();
        } else {
            // Hide attendance tab for admin
            document.getElementById('attendanceTabBtn').style.display = 'none';
            // Ensure blocked overlay is hidden
            document.getElementById('blockedOverlay').style.display = 'none';
        }
        loadTodayStats();
        loadPendingOrders();
        startUserExistenceCheck();
    } catch (e) {
        console.error(e);
        errorEl.textContent = 'Something went wrong. Try again.';
        errorEl.style.display = 'block';
    }
}

function logoutUser() {
    stopUserExistenceCheck();
    localStorage.removeItem('flipkart_agent_user');
    currentUser = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('authOverlay').style.display = 'flex';
    document.getElementById('blockedOverlay').style.display = 'none';
    showToast('Logged out', 'info');
}

function checkAuth() {
    const stored = localStorage.getItem('flipkart_agent_user');
    if (stored) {
        try {
            currentUser = JSON.parse(stored);
            verifyUserExists(currentUser.username).then(async exists => {
                if (exists) {
                    showMainApp();
                    if (currentUser.role !== 'admin') {
                        await checkAttendanceAndBlock();
                        loadAttendanceHistory();
                    } else {
                        document.getElementById('attendanceTabBtn').style.display = 'none';
                        document.getElementById('blockedOverlay').style.display = 'none';
                    }
                    loadTodayStats();
                    loadPendingOrders();
                    startUserExistenceCheck();
                } else {
                    logoutUser();
                    showToast('❌ Account deleted. Please contact admin.', 'error');
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
    startUserExistenceCheck();
}

// ==========================================
// CHANGE PASSWORD
// ==========================================
function showChangePassword() {
    if (!currentUser) return;
    Swal.fire({
        title: 'Change Password',
        html: `
            <p class="text-sm text-gray-600 mb-2">Change your login password</p>
            <input type="password" id="newPw" class="swal2-input" placeholder="New password" minlength="4">
            <input type="password" id="confirmPw" class="swal2-input" placeholder="Confirm" minlength="4">
        `,
        showCancelButton: true,
        confirmButtonText: 'Update Password',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#64748b',
        preConfirm: () => {
            const n = document.getElementById('newPw').value;
            const c = document.getElementById('confirmPw').value;
            if (!n || n.length < 4) { Swal.showValidationMessage('Min 4 chars'); return false; }
            if (n !== c) { Swal.showValidationMessage('No match'); return false; }
            return n;
        }
    }).then(async (r) => {
        if (r.isConfirmed) {
            try {
                await db.ref('users/' + currentUser.username + '/password').set(r.value);
                currentUser.password = r.value;
                localStorage.setItem('flipkart_agent_user', JSON.stringify(currentUser));
                showToast('✅ Password updated', 'success');
            } catch (e) { showToast('Error', 'error'); }
        }
    });
}

// ==========================================
// ATTENDANCE SYSTEM (Agent Side – No "Later" option)
// ==========================================
async function checkAttendanceAndBlock() {
    if (!currentUser) return;
    // FIX: if admin, skip attendance entirely
    if (currentUser.role === 'admin') {
        return;
    }
    const today = new Date().toISOString().split('T')[0];
    // Check if user is blocked
    const userSnap = await db.ref('users/' + currentUser.username + '/is_blocked').once('value');
    if (userSnap.val() === true) {
        showToast('🔒 You are blocked for today. Contact admin.', 'error');
        document.getElementById('blockedOverlay').style.display = 'flex';
        return;
    }
    // Check attendance
    const attSnap = await db.ref('attendance/' + currentUser.username + '/' + today).once('value');
    const att = attSnap.val();
    if (att && att.status === 'present') {
        // Already present
        updateAttendanceUI('present');
        return;
    }
    if (att && att.status === 'absent' && att.blocked) {
        document.getElementById('blockedOverlay').style.display = 'flex';
        showToast('🔒 You are blocked for today.', 'error');
        updateAttendanceUI('blocked');
        return;
    }
    // Show Attendance Prompt (NO "Later" option)
    showAttendancePrompt();
}

function showAttendancePrompt() {
    Swal.fire({
        title: '📋 Attendance',
        text: 'Mark your attendance for today:',
        icon: 'question',
        showDenyButton: true,
        showCancelButton: false,  // NO "Later" option
        confirmButtonText: '✅ Present',
        denyButtonText: '❌ Not Present',
        confirmButtonColor: '#059669',
        denyButtonColor: '#dc2626',
        allowOutsideClick: false,
        allowEscapeKey: false
    }).then(async (result) => {
        if (result.isConfirmed) {
            // Present -> ask for OTP
            await promptOTP();
        } else if (result.isDenied) {
            // Not Present -> ask reason and block
            const { value: reason, isConfirmed } = await Swal.fire({
                title: 'Are you sure?',
                text: 'If you are not present, you will be BLOCKED for the full day. Salary will be deducted (unless admin unblocks with pay).',
                input: 'text',
                inputPlaceholder: 'Reason for absence...',
                showCancelButton: true,
                confirmButtonText: 'Yes, Block Me',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#dc2626',
                cancelButtonColor: '#64748b'
            });
            if (isConfirmed && reason) {
                await markAbsent(reason);
            } else {
                // If cancelled, ask again (no "Later")
                showAttendancePrompt();
            }
        }
    });
}

async function promptOTP() {
    const { value: otp, isConfirmed } = await Swal.fire({
        title: '🔐 Enter OTP',
        text: 'Please enter the OTP provided by admin for today.',
        input: 'text',
        inputPlaceholder: '6-digit OTP',
        inputAttributes: { maxlength: 6, inputmode: 'numeric' },
        showCancelButton: true,
        confirmButtonText: 'Verify',
        cancelButtonText: 'Cancel',
        confirmButtonColor: '#4f46e5',
        cancelButtonColor: '#64748b'
    });
    if (!isConfirmed) {
        showToast('Attendance cancelled. Please login again.', 'info');
        logoutUser();
        return;
    }
    // Verify OTP
    const today = new Date().toISOString().split('T')[0];
    const otpSnap = await db.ref('daily_otp/' + today + '/' + currentUser.username).once('value');
    const otpData = otpSnap.val();
    if (!otpData || otpData.otp !== otp) {
        await Swal.fire({ icon: 'error', title: 'Invalid OTP', text: 'Please try again.', confirmButtonColor: '#dc2626' });
        promptOTP();
        return;
    }
    // Mark Present
    await db.ref('attendance/' + currentUser.username + '/' + today).set({
        status: 'present',
        timestamp: Date.now(),
        otp_used: otp,
        blocked: false,
        salary_counted: true
    });
    showToast('✅ Attendance marked present!', 'success');
    updateAttendanceUI('present');
    loadAttendanceHistory();
}

async function markAbsent(reason) {
    const today = new Date().toISOString().split('T')[0];
    await db.ref('attendance/' + currentUser.username + '/' + today).set({
        status: 'absent',
        reason: reason,
        timestamp: Date.now(),
        blocked: true,
        salary_counted: false
    });
    await db.ref('users/' + currentUser.username + '/is_blocked').set(true);
    showToast('🔒 You have been blocked for the day.', 'error');
    document.getElementById('blockedOverlay').style.display = 'flex';
    updateAttendanceUI('blocked');
    loadAttendanceHistory();
}

async function verifyOTP() {
    const otpInput = document.getElementById('otpInput');
    const otp = otpInput.value.trim();
    if (!otp || otp.length < 6) {
        showToast('Please enter 6-digit OTP', 'error');
        return;
    }
    const today = new Date().toISOString().split('T')[0];
    const otpSnap = await db.ref('daily_otp/' + today + '/' + currentUser.username).once('value');
    const otpData = otpSnap.val();
    if (!otpData || otpData.otp !== otp) {
        showToast('❌ Invalid OTP. Try again.', 'error');
        return;
    }
    // Mark Present
    await db.ref('attendance/' + currentUser.username + '/' + today).set({
        status: 'present',
        timestamp: Date.now(),
        otp_used: otp,
        blocked: false,
        salary_counted: true
    });
    showToast('✅ Attendance marked present!', 'success');
    updateAttendanceUI('present');
    loadAttendanceHistory();
    document.getElementById('otpInput').value = '';
}

async function refreshOTP() {
    if (!currentUser) return;
    const today = new Date().toISOString().split('T')[0];
    const otpSnap = await db.ref('daily_otp/' + today + '/' + currentUser.username).once('value');
    const otpData = otpSnap.val();
    if (otpData && otpData.otp) {
        showToast('Your OTP: ' + otpData.otp, 'info');
    } else {
        showToast('No OTP generated for today. Contact admin.', 'error');
    }
}

function updateAttendanceUI(status) {
    const box = document.getElementById('attendanceStatusBox');
    const statusEl = box.querySelector('.attendance-status');
    const msgEl = box.querySelector('p');
    if (status === 'present') {
        statusEl.textContent = '✅ Present';
        statusEl.className = 'attendance-status present';
        msgEl.textContent = 'You have marked your attendance today.';
    } else if (status === 'blocked') {
        statusEl.textContent = '🚫 Blocked';
        statusEl.className = 'attendance-status blocked';
        msgEl.textContent = 'You are blocked for today. Contact admin.';
    } else {
        statusEl.textContent = 'Not Marked';
        statusEl.className = 'attendance-status not-marked';
        msgEl.textContent = 'Please enter the OTP to mark your attendance';
    }
}

async function loadAttendanceHistory() {
    if (!currentUser) return;
    // FIX: if admin, don't load history
    if (currentUser.role === 'admin') {
        document.getElementById('attendanceHistory').innerHTML = '<div class="text-sm text-gray-400">Admin has no attendance</div>';
        return;
    }
    const container = document.getElementById('attendanceHistory');
    container.innerHTML = '<div class="text-sm text-gray-400 text-center">Loading...</div>';
    try {
        const today = new Date();
        let html = '';
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const attSnap = await db.ref('attendance/' + currentUser.username + '/' + dateStr).once('value');
            const att = attSnap.val() || {};
            const status = att.status || 'Not Marked';
            let statusClass = 'not-marked';
            let displayStatus = '—';
            if (status === 'present') { statusClass = 'present'; displayStatus = '✅ Present'; }
            else if (status === 'absent' && att.blocked) { statusClass = 'blocked'; displayStatus = '🚫 Blocked'; }
            else if (status === 'absent') { statusClass = 'absent'; displayStatus = '❌ Absent'; }
            const displayDate = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
            html += `<div class="day-item"><span class="date">${displayDate}</span><span class="status ${statusClass}">${displayStatus}</span></div>`;
        }
        container.innerHTML = html || '<div class="text-sm text-gray-400">No history</div>';
    } catch (e) {
        container.innerHTML = '<div class="text-sm text-red-500">Error loading history</div>';
    }
}

// ==========================================
// TAB SWITCHING
// ==========================================
function switchTab(tab) {
    document.querySelectorAll('#mainTabBar button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + tab).style.display = 'block';
    if (tab === 'pending') loadPendingOrders();
    if (tab === 'attendance') { loadAttendanceHistory(); updateAttendanceUI(); }
}

// ==========================================
// OFFLINE DETECTION
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

// ==========================================
// TODAY'S STATS
// ==========================================
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
    } catch (e) { console.log(e); }
}

// ==========================================
// PENDING ORDERS
// ==========================================
async function loadPendingOrders() {
    if (!currentUser) return;
    try {
        const snapshot = await db.ref('pending').once('value');
        const data = snapshot.val() || {};
        allPendingOrders = [];
        for (const [orderId, item] of Object.entries(data)) {
            if (item.agent === currentUser.username) {
                allPendingOrders.push({ orderId, ...item });
            }
        }
        allPendingOrders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        renderPendingList();
        updatePendingCounts();
    } catch (e) {
        console.log(e);
        document.getElementById('pendingList').innerHTML = '<div class="pending-empty"><i data-lucide="alert-circle"></i><p class="text-sm font-medium text-red-500">Error loading</p></div>';
        lucide.createIcons();
    }
}

function updatePendingCounts() {
    const count = allPendingOrders.length;
    document.getElementById('pendingCountBadge').textContent = count;
    document.getElementById('pendingCountBadgeMain').textContent = count;
    document.getElementById('pendingCountBadge').style.display = count > 0 ? 'inline-block' : 'none';
    document.getElementById('pendingCountBadgeMain').style.display = count > 0 ? 'inline-block' : 'none';
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
        filtered = filtered.filter(item => item.reason && item.reason.toLowerCase().includes('on the way'));
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
                        <p class="text-xs text-gray-500 mt-1"><i data-lucide="message-circle" class="w-3 h-3 inline"></i> ${reason}</p>
                        <p class="text-xs text-gray-400 mt-0.5"><i data-lucide="clock" class="w-3 h-3 inline"></i> ${time}</p>
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
    switchTab('pickup');
    showForm('pickup');
    showToast(`📦 Pending order ${orderId} — fill pickup details`, 'info');
}

// ==========================================
// PASTE ORDER ID
// ==========================================
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
// SHOW FORM
// ==========================================
function showForm(status) {
    clearPickupImageState();
    let orderId = document.getElementById('orderId').value.trim().toUpperCase();
    if (!orderId && pendingDoneOrderId) {
        orderId = pendingDoneOrderId;
        document.getElementById('orderId').value = orderId;
    }
    if (!orderId) {
        Swal.fire({ icon: 'warning', title: 'Order ID Missing', text: 'Please enter the Order ID first', confirmButtonColor: '#3b82f6' });
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

            <!-- ============ DOCUMENTS (Bill + Aadhaar) ============ -->
            <div class="pt-2 border-t border-gray-100">
                <p class="text-xs font-bold text-gray-500 mb-2 tracking-wide">📄 DOCUMENTS <span class="text-gray-400 font-medium">(All Optional)</span></p>

                <div class="mb-3">
                    <label class="text-xs font-semibold text-gray-500 mb-1 block">Bill Number</label>
                    <input type="text" id="billNumber" placeholder="Bill / Invoice no." class="input-field w-full p-3 rounded-xl outline-none">
                </div>
                <div class="mb-4">
                    <label class="text-xs font-semibold text-gray-500 mb-1 block">Bill Images <span class="text-gray-400 font-normal">(up to 3)</span></label>
                    <div class="grid grid-cols-2 gap-2">
                        <label for="billImageCam" class="btn-bounce cursor-pointer flex items-center justify-center gap-2 p-3 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50 text-blue-700 font-semibold text-sm">
                            <i data-lucide="camera" class="w-4 h-4"></i> Camera
                        </label>
                        <label for="billImageGal" class="btn-bounce cursor-pointer flex items-center justify-center gap-2 p-3 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50 text-blue-700 font-semibold text-sm">
                            <i data-lucide="image" class="w-4 h-4"></i> Gallery
                        </label>
                    </div>
                    <input id="billImageCam" type="file" accept="image/*" capture="environment" class="hidden" onchange="handlePickupImagePick(this,'bill')">
                    <input id="billImageGal" type="file" accept="image/*" multiple class="hidden" onchange="handlePickupImagePick(this,'bill')">
                    <div id="billImgPreview" class="mt-2"></div>
                    <div id="billImgInfo" class="text-[11px] text-gray-500 mt-1">3 images max · 3 slots free</div>
                </div>

                <div class="mb-3">
                    <label class="text-xs font-semibold text-gray-500 mb-1 block">Aadhaar Number</label>
                    <input type="text" id="aadhaarNumber" placeholder="12-digit Aadhaar" inputmode="numeric" maxlength="14" class="input-field w-full p-3 rounded-xl outline-none font-mono">
                </div>
                <div>
                    <label class="text-xs font-semibold text-gray-500 mb-1 block">Aadhaar Images <span class="text-gray-400 font-normal">(up to 3)</span></label>
                    <div class="grid grid-cols-2 gap-2">
                        <label for="aadhaarImageCam" class="btn-bounce cursor-pointer flex items-center justify-center gap-2 p-3 rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50 text-indigo-700 font-semibold text-sm">
                            <i data-lucide="camera" class="w-4 h-4"></i> Camera
                        </label>
                        <label for="aadhaarImageGal" class="btn-bounce cursor-pointer flex items-center justify-center gap-2 p-3 rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50 text-indigo-700 font-semibold text-sm">
                            <i data-lucide="image" class="w-4 h-4"></i> Gallery
                        </label>
                    </div>
                    <input id="aadhaarImageCam" type="file" accept="image/*" capture="environment" class="hidden" onchange="handlePickupImagePick(this,'aadhaar')">
                    <input id="aadhaarImageGal" type="file" accept="image/*" multiple class="hidden" onchange="handlePickupImagePick(this,'aadhaar')">
                    <div id="aadhaarImgPreview" class="mt-2"></div>
                    <div id="aadhaarImgInfo" class="text-[11px] text-gray-500 mt-1">3 images max · 3 slots free</div>
                </div>
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
            if (firstBtn) selectReason(firstBtn, firstBtn.dataset.reason);
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
// SUBMIT DATA
// ==========================================
async function submitData() {
    if (!currentUser) {
        showToast('Please login first', 'error');
        return;
    }
    // Check if blocked (only for agents)
    if (currentUser.role !== 'admin') {
        const userSnap = await db.ref('users/' + currentUser.username + '/is_blocked').once('value');
        if (userSnap.val() === true) {
            showToast('🔒 You are blocked for today!', 'error');
            return;
        }
    }

    const orderId = document.getElementById('orderId').value.trim().toUpperCase();
    let existingData = null, exists = false;
    try {
        const existingSnap = await db.ref('pickups/' + orderId).once('value');
        exists = existingSnap.exists();
        if (exists) existingData = existingSnap.val();
    } catch (e) {
        console.error(e);
        showToast('Error checking order', 'error');
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
            preConfirm: (input) => { if (!input) { Swal.showValidationMessage('Enter password'); return false; } return input; }
        });
        if (!isConfirmed) { showToast('Cancelled', 'error'); return; }
        if (password !== 'admin123') {
            Swal.fire({ icon: 'error', title: 'Wrong Password', text: 'Invalid admin password.', confirmButtonColor: '#dc2626' });
            return;
        }
        showToast('✅ Password verified!', 'success');
    }

    // Duplicate pickup prevention
    if (exists && existingData.status === 'pickup' && currentStatus === 'pickup') {
        Swal.fire({ icon: 'error', title: 'Already Pickup Completed', text: `Order ${orderId} already marked.`, confirmButtonColor: '#3b82f6' });
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
            Swal.fire({ icon: 'error', title: 'Missing Details', text: 'Fill Model, IMEI, Value', confirmButtonColor: '#3b82f6' });
            return;
        }
        dbData.phoneModel = phoneModel;
        dbData.imei = imei;
        if (hiddenImei2) dbData.imei2 = hiddenImei2;
        dbData.value = parseInt(value);
        dbData.customerName = custName || 'N/A';
        // Bill / Aadhaar (all optional)
        const _billNo = (document.getElementById('billNumber')?.value || '').trim();
        const _aadNo  = (document.getElementById('aadhaarNumber')?.value || '').trim();
        if (_billNo) dbData.billNumber = _billNo;
        if (_aadNo)  dbData.aadhaarNumber = _aadNo;
        if (pickupBillImages.length)    { dbData.billImages = pickupBillImages;    dbData.billImage = pickupBillImages[0]; }
        if (pickupAadhaarImages.length) { dbData.aadhaarImages = pickupAadhaarImages; dbData.aadhaarImage = pickupAadhaarImages[0]; }
        whatsappMsg = `Order ID: ${orderId}\nStatus: Pickup Completed`;
    } else {
        const phoneModel = document.getElementById('phoneModelRejectReschedule').value.trim();
        if (!phoneModel) {
            Swal.fire({ icon: 'error', title: 'Missing Model', text: 'Enter phone model', confirmButtonColor: '#3b82f6' });
            return;
        }
        dbData.phoneModel = phoneModel;
        let reason = selectedReason;
        if (reason.toLowerCase().includes('other')) {
            reason = document.getElementById('otherReason').value.trim();
            if (!reason) {
                Swal.fire({ icon: 'warning', title: 'Reason Required', text: 'Type the reason', confirmButtonColor: '#3b82f6' });
                return;
            }
        }
        if (!reason) {
            Swal.fire({ icon: 'warning', title: 'Select Reason', text: 'Choose a reason', confirmButtonColor: '#3b82f6' });
            return;
        }
        dbData.reason = reason;
        if (currentStatus === 'rejected') {
            whatsappMsg = `Order ID: ${orderId}\nStatus: Rejected\nModel: ${phoneModel}\nReason: ${reason}`;
            dbData.incentive_approved = false;
            dbData.incentive_paid = false;
        } else {
            whatsappMsg = `Order ID: ${orderId}\nModel: ${phoneModel}\nReason: ${reason}`;
        }
    }

    if (currentStatus === 'reschedule') {
        try {
            const pendingSnap = await db.ref('pending/' + orderId).once('value');
            if (pendingSnap.exists()) {
                const existingReason = pendingSnap.val().reason || '';
                if (existingReason !== dbData.reason) {
                    const r = await Swal.fire({
                        title: 'Change Reason?',
                        text: `Existing: "${existingReason}". Update to "${dbData.reason}"?`,
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonColor: '#f59e0b',
                        confirmButtonText: 'Update',
                        cancelButtonText: 'Cancel'
                    });
                    if (!r.isConfirmed) { showToast('Cancelled', 'error'); return; }
                }
            }
        } catch (e) { console.error(e); }
    }

    Swal.fire({ title: 'Saving...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        if (exists) await db.ref('pickups/' + orderId).update(dbData);
        else await db.ref('pickups/' + orderId).set(dbData);

        if (currentStatus === 'pickup' || currentStatus === 'rejected') {
            const pendingSnap = await db.ref('pending/' + orderId).once('value');
            if (pendingSnap.exists()) {
                await db.ref('pending/' + orderId).remove();
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
            await loadPendingOrders();
        }

        const result = await Swal.fire({
            icon: 'success',
            title: '✅ Saved!',
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
            window.open(`https://wa.me/?text=${encodeURIComponent(whatsappMsg)}`, '_blank');
        } else if (result.isDenied) {
            try {
                await navigator.clipboard.writeText(whatsappMsg);
                showToast('✅ Copied!', 'success');
            } catch (e) {
                const ta = document.createElement('textarea');
                ta.value = whatsappMsg;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast('✅ Copied!', 'success');
            }
        }
        document.getElementById('orderId').value = '';
        hiddenImei2 = '';
        goBack();
        loadTodayStats();
        loadPendingOrders();
    } catch (error) {
        Swal.fire({ icon: 'error', title: 'Error', text: error.message });
    }
}

// ==========================================
// SCANNER FUNCTIONS (Barcode + OCR)
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
        tip.innerHTML = '<strong>💡 Tip:</strong> Phone box ya back panel pe IMEI barcode hota hai.';
        captureBtn.style.display = 'none';
        document.getElementById('imeiResult').classList.remove('show');
    } else {
        hint.textContent = '📱 *#06# screen dikhao — phir Capture dabao';
        tip.innerHTML = '<strong>💡 Tip:</strong> Phone me *#06# dial karo, IMEI screen dikhao.';
        captureBtn.style.display = 'flex';
        document.getElementById('imeiResult').classList.remove('show');
        captureBtn.disabled = false;
        captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
        lucide.createIcons();
    }
    lucide.createIcons();
}

async function initTesseract() {
    if (typeof Tesseract === 'undefined') { console.warn('Tesseract not loaded'); return null; }
    try {
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
            tessedit_ocr_engine_mode: '3'
        });
        return worker;
    } catch (e) { console.error(e); return null; }
}

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
    if (scanMode === 'ocr') { tesseractWorker = await initTesseract(); }
    try {
        if (typeof ZXing === 'undefined' || !ZXing.BrowserMultiFormatReader) throw new Error('ZXing not loaded');
        const hints = new Map();
        const formats = [
            ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39,
            ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
            ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
            ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.QR_CODE,
            ZXing.BarcodeFormat.DATA_MATRIX, ZXing.BarcodeFormat.CODE_93
        ];
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(ZXing.DecodeHintType.CHARACTER_SET, 'UTF-8');
        zxingCodeReader = new ZXing.BrowserMultiFormatReader(hints);
        const devices = await zxingCodeReader.listVideoInputDevices();
        let deviceId = null;
        for (const d of devices) {
            if (d.label && /back|rear|environment/i.test(d.label)) {
                deviceId = d.deviceId;
                break;
            }
        }
        if (!deviceId && devices.length > 0) deviceId = devices[devices.length - 1].deviceId;
        statusText.textContent = '📷 Camera ready';
        await zxingCodeReader.decodeFromVideoDevice(
            deviceId,
            'scanVideo',
            (result, err) => {
                if (result && scanMode === 'barcode') {
                    const raw = result.getText();
                    const imeis = extractIMEIs(raw);
                    if (imeis.imei1 && imeis.imei1.length >= 14) onScanSuccess(imeis.imei1, imeis.imei2);
                } else if (err && !(err instanceof ZXing.NotFoundException)) {
                    console.error(err);
                }
            }
        );
        isScanning = true;
        statusText.textContent = scanMode === 'barcode' ? '🎯 Scanning...' : '📱 Ready';
        spinner.style.display = 'none';
        if (scanMode === 'ocr') {
            document.getElementById('captureBtn').style.display = 'flex';
            document.getElementById('captureBtn').disabled = false;
            document.getElementById('captureBtn').innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
            lucide.createIcons();
        } else {
            document.getElementById('captureBtn').style.display = 'none';
        }
    } catch (err) {
        console.error(err);
        stopScanner();
        let msg = 'Camera access failed';
        if (err.name === 'NotAllowedError') msg = 'Allow camera permission';
        else if (err.name === 'NotFoundError') msg = 'No camera found';
        else if (err.name === 'NotSecureError' || window.location.protocol === 'file:') msg = 'Camera needs HTTPS.';
        Swal.fire({ icon: 'error', title: 'Camera Error', text: msg });
    }
}

async function startOCRScanning() {
    if (scanMode !== 'ocr' || isOcrScanning) return;
    if (!tesseractWorker) {
        showToast('⏳ Initializing OCR...', 'info');
        tesseractWorker = await initTesseract();
        if (!tesseractWorker) { showToast('❌ OCR failed', 'error'); return; }
    }
    const video = document.getElementById('scanVideo');
    if (!video.videoWidth) { showToast('⏳ Camera not ready', 'error'); return; }
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
    statusText.textContent = '📸 Capturing...';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const maxW = 800;
    const scale = Math.min(1, maxW / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
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
        const imeis = extractIMEIs(text);
        if (imeis.imei1 && imeis.imei1.length >= 14) {
            handleImeiFound(imeis.imei1, imeis.imei2);
            return;
        }
    } catch (e) { console.error(e); }

    statusText.textContent = '🔍 Scanning in background...';
    progressBar.style.width = '0%';
    ocrAttemptCount = 0;
    if (ocrInterval) clearInterval(ocrInterval);
    ocrInterval = setInterval(async () => {
        if (!isScanning || !isOcrScanning) { stopOCRScanning(); return; }
        if (!video.videoWidth) return;
        ocrAttemptCount++;
        const c2 = document.createElement('canvas');
        const ctx2 = c2.getContext('2d');
        const maxW2 = 640;
        const scale2 = Math.min(1, maxW2 / video.videoWidth);
        c2.width = Math.round(video.videoWidth * scale2);
        c2.height = Math.round(video.videoHeight * scale2);
        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = 'high';
        ctx2.drawImage(video, 0, 0, c2.width, c2.height);
        const imgData2 = ctx2.getImageData(0, 0, c2.width, c2.height);
        const d2 = imgData2.data;
        for (let i = 0; i < d2.length; i += 4) {
            const gray = d2[i] * 0.299 + d2[i + 1] * 0.587 + d2[i + 2] * 0.114;
            const adjusted = ((gray / 255 - 0.5) * 2.2 + 0.5) * 255;
            const val = Math.max(0, Math.min(255, adjusted));
            d2[i] = d2[i + 1] = d2[i + 2] = val;
        }
        ctx2.putImageData(imgData2, 0, 0);
        progressBar.style.width = Math.min(100, (ocrAttemptCount / 15) * 100) + '%';
        try {
            const { data: { text } } = await tesseractWorker.recognize(c2);
            const imeis = extractIMEIs(text);
            if (imeis.imei1 && imeis.imei1.length >= 14) {
                handleImeiFound(imeis.imei1, imeis.imei2);
                return;
            }
        } catch (e) { console.error(e); }
    }, 1500);
}

function handleImeiFound(imei1, imei2) {
    if (!isOcrScanning && !isScanning) return;
    if (imei1 === lastDetectedImei) return;
    lastDetectedImei = imei1;
    document.getElementById('imeiResultText').textContent = '✅ IMEI: ' + imei1 + (imei2 ? ' | IMEI2 captured' : '');
    document.getElementById('imeiResult').classList.add('show');
    const imeiInput = document.getElementById('imei');
    if (imeiInput) {
        imeiInput.value = imei1;
        imeiInput.classList.add('flash-green');
        setTimeout(() => imeiInput.classList.remove('flash-green'), 500);
    }
    if (imei2) hiddenImei2 = imei2;
    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    document.getElementById('scanStatusText').textContent = '✅ IMEI captured!';
    showToast('✅ IMEI: ' + imei1, 'success');
    stopOCRScanning();
    setTimeout(() => stopScanner(), 800);
}

function stopOCRScanning() {
    isOcrScanning = false;
    if (ocrInterval) { clearInterval(ocrInterval); ocrInterval = null; }
    const captureBtn = document.getElementById('captureBtn');
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
    lucide.createIcons();
    document.getElementById('ocrProgress').style.display = 'none';
    document.getElementById('ocrProgressBar').style.width = '0%';
}

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

function extractIMEIs(text) {
    let imei1 = null, imei2 = null, candidates = [];
    let clean = text.replace(/[Oo]/g,'0').replace(/[Ss]/g,'5').replace(/[Bb]/g,'8').replace(/[Zz]/g,'2').replace(/[Gg]/g,'6').replace(/[Tt]/g,'7').replace(/[Ll]/g,'1').replace(/\s+/g,' ').trim();
    const all15Digits = clean.match(/\d{15}/g) || [];
    const all14Digits = clean.match(/\d{14}/g) || [];
    for (let num of all15Digits) {
        if (/^[3-9]/.test(num) && isValidIMEI(num)) candidates.push(num);
    }
    const imeiPatterns = [
        /IMEI\s*1\s*[:\-]?\s*(\d{15})/i,
        /IMEI\s*[:\-]?\s*(\d{15})/i,
        /IMEI1\s*[:\-]?\s*(\d{15})/i,
        /IMEI2\s*[:\-]?\s*(\d{15})/i
    ];
    for (let pattern of imeiPatterns) {
        const match = clean.match(pattern);
        if (match && match[1]) {
            const num = match[1];
            if (/^[3-9]/.test(num) && isValidIMEI(num)) {
                if (!imei1) imei1 = num;
                else if (num !== imei1 && !imei2) imei2 = num;
            }
        }
    }
    if (!imei1 && candidates.length > 0) imei1 = candidates[0];
    if (!imei2 && candidates.length > 1) {
        for (let c of candidates) {
            if (c !== imei1) { imei2 = c; break; }
        }
    }
    if (!imei1 && all14Digits.length > 0) {
        for (let num of all14Digits) {
            if (!/^[3-9]/.test(num)) continue;
            for (let check = 0; check <= 9; check++) {
                const candidate = num + check;
                if (isValidIMEI(candidate)) {
                    if (!imei1) imei1 = candidate;
                    else if (candidate !== imei1 && !imei2) imei2 = candidate;
                    break;
                }
            }
            if (imei1 && imei2) break;
        }
    }
    if (imei1 && !isValidIMEI(imei1)) imei1 = null;
    if (imei2 && !isValidIMEI(imei2)) imei2 = null;
    return { imei1, imei2 };
}

function onScanSuccess(imei1, imei2) {
    if (!isScanning) return;
    isScanning = false;
    const imeiInput = document.getElementById('imei');
    if (imeiInput) {
        imeiInput.value = imei1;
        imeiInput.classList.add('flash-green');
        setTimeout(() => imeiInput.classList.remove('flash-green'), 500);
    }
    if (imei2) hiddenImei2 = imei2;
    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    stopScanner();
    showToast('✅ IMEI: ' + imei1, 'success');
}

function stopScanner() {
    isScanning = false;
    stopOCRScanning();
    if (zxingCodeReader) { try { zxingCodeReader.reset(); } catch (e) {} zxingCodeReader = null; }
    const video = document.getElementById('scanVideo');
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
    if (tesseractWorker) { try { tesseractWorker.terminate(); } catch (e) {} tesseractWorker = null; }
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
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dd = String(istTime.getUTCDate()).padStart(2,'0');
    const mmm = months[istTime.getUTCMonth()];
    const yyyy = istTime.getUTCFullYear();
    let hours = istTime.getUTCHours();
    const minutes = String(istTime.getUTCMinutes()).padStart(2,'0');
    const seconds = String(istTime.getUTCSeconds()).padStart(2,'0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const hh = String(hours).padStart(2,'0');
    return `${dd}-${mmm}-${yyyy}, ${hh}:${minutes}:${seconds} ${ampm} IST`;
}

// ==========================================
// INIT
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // Add blocked overlay to body
    const overlay = document.createElement('div');
    overlay.id = 'blockedOverlay';
    overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:9999; align-items:center; justify-content:center; color:white; font-size:20px; font-weight:bold; flex-direction:column; padding:20px; text-align:center;';
    overlay.innerHTML = `<i data-lucide="lock" class="w-16 h-16 text-red-500 mb-4"></i><p>🔒 You are blocked for today.</p><p class="text-sm text-gray-400 mt-2">Contact admin to unblock.</p><button onclick="logoutUser()" class="mt-4 bg-red-600 px-6 py-3 rounded-xl">Logout</button>`;
    document.body.appendChild(overlay);
    lucide.createIcons();

    document.getElementById('offlineBanner').classList.add('hidden');
    const loggedIn = checkAuth();
    if (!loggedIn) {
        document.getElementById('authOverlay').style.display = 'flex';
    }
    if (loggedIn) {
        db.ref('pending').on('value', () => { loadPendingOrders(); });
        // set today's date for attendance
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('attendanceDateDisplay').textContent = today;
        // Set default tab
        switchTab('pickup');
    }
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loginUser();
    });
    document.getElementById('loginUsername').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginPassword').focus();
    });
});
