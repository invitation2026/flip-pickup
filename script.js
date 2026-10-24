// === SECTION 1: FIREBASE CONFIG ===
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
const storage = firebase.storage();

// === SECTION 2: HELPER FUNCTIONS (getLocalDate) ===
function getLocalDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// === SECTION 3: GLOBAL STATE ===
let currentUser = null;
let currentStatus = '';
let attendanceGateOpen = false;
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

// ========== SPEC (RAM / STORAGE / NETWORK) STATE ==========
let selectedRam = '';
let selectedStorage = '';
let selectedNetwork = '';
const RAM_OPTIONS = ['1GB','2GB','3GB','4GB','6GB','8GB','12GB','16GB','18GB','24GB'];
const STORAGE_OPTIONS = ['8GB','16GB','32GB','64GB','128GB','256GB','512GB','1TB','2TB'];
// 🔥 Updated per spec: include 1G
const NETWORK_OPTIONS = ['1G','2G','3G','4G','5G'];

function resetSpecSelection() {
    selectedRam = '';
    selectedStorage = '';
    selectedNetwork = '';
}

function buildSpecChips(kind, options, extraClass) {
    return options.map(o =>
        `<button type="button" class="spec-chip ${extraClass || ''}" data-kind="${kind}" data-val="${o}" onclick="selectSpec('${kind}','${o}',this)">${o}</button>`
    ).join('');
}

function selectSpec(kind, val, el) {
    const group = el.parentElement;
    const already = el.classList.contains('active');
    group.querySelectorAll('.spec-chip').forEach(b => b.classList.remove('active'));
    const finalVal = already ? '' : val;
    if (!already) el.classList.add('active');
    if (kind === 'ram') selectedRam = finalVal;
    if (kind === 'storage') selectedStorage = finalVal;
    if (kind === 'network') selectedNetwork = finalVal;
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch(_){} }
    updateSpecUI();
}

function updateSpecUI() {
    const ramPick = document.getElementById('ramPick');
    const stoPick = document.getElementById('storagePick');
    const netPick = document.getElementById('networkPick');
    if (ramPick) { ramPick.textContent = selectedRam || 'Not selected'; ramPick.className = 'picked' + (selectedRam ? '' : ' empty'); }
    if (stoPick) { stoPick.textContent = selectedStorage || 'Not selected'; stoPick.className = 'picked' + (selectedStorage ? '' : ' empty'); }
    if (netPick) { netPick.textContent = selectedNetwork || 'Not selected'; netPick.className = 'picked' + (selectedNetwork ? '' : ' empty'); }
    const ramStorageInput = document.getElementById('ramStorage');
    const networkInput = document.getElementById('networkType');
    const combo = (selectedRam && selectedStorage) ? (selectedRam + '/' + selectedStorage) : '';
    if (ramStorageInput) ramStorageInput.value = combo;
    if (networkInput) networkInput.value = selectedNetwork;
    const box = document.getElementById('specSummary');
    if (!box) return;
    const done = selectedRam && selectedStorage && selectedNetwork;
    box.className = 'spec-summary' + (done ? ' ok' : '');
    const missing = [];
    if (!selectedRam) missing.push('RAM');
    if (!selectedStorage) missing.push('Storage');
    if (!selectedNetwork) missing.push('Network');
    box.innerHTML = `
        <div class="head">SELECTED DEVICE SPECS</div>
        <div class="body">${selectedRam || '—'} RAM &nbsp;·&nbsp; ${selectedStorage || '—'} Storage &nbsp;·&nbsp; ${selectedNetwork || '—'}</div>
        ${done ? '' : `<div class="spec-missing">⚠️ Please select: ${missing.join(', ')}</div>`}
    `;
}

// ========== BILL / AADHAAR IMAGE STATE (Pickup) ==========
const PICKUP_MAX_IMAGES = 3;
let pickupBillImages = [];
let pickupAadhaarImages = [];

// === SECTION 4: IMAGE HANDLING ===
function compressImageFile(file, maxDim = 800, quality = 0.55) {
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
                if (width > height) {
                    if (width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
                } else {
                    if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch (e) { reject(e); }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

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
        const kb = Math.round((d.length * 3 / 4) / 1024); totalKB += kb;
        return `<div class="relative group">
            <img src="${d}" class="w-full h-20 object-cover rounded-lg border border-gray-200" alt="p${i}">
            <button type="button" onclick="removePickupImage('${which}',${i})" class="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold shadow-md">✕</button>
            <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] text-center rounded-b-lg">${kb}KB</div>
        </div>`;
    }).join('') + `</div>`;
    if (infoEl) infoEl.textContent = `✅ ${arr.length}/${PICKUP_MAX_IMAGES} · total ~${totalKB} KB`;
}

async function handlePickupImagePick(inputEl, which) {
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    if (!files.length) return;
    const arr = which === 'bill' ? pickupBillImages : pickupAadhaarImages;
    const infoEl = document.getElementById(which === 'bill' ? 'billImgInfo' : 'aadhaarImgInfo');
    if (arr.length >= PICKUP_MAX_IMAGES) {
        showToast(`Max ${PICKUP_MAX_IMAGES} images allowed`, 'error');
        inputEl.value = ''; return;
    }
    const room = PICKUP_MAX_IMAGES - arr.length;
    const toProcess = files.slice(0, room);
    if (infoEl) infoEl.textContent = '⏳ Compressing…';
    for (const f of toProcess) {
        try { arr.push(await compressImageFile(f)); }
        catch (e) { console.error(e); showToast('Image process failed', 'error'); }
    }
    inputEl.value = '';
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

// === SECTION 5: REASONS ===
function selectReason(el, text) {
    selectedReason = text || '';
    document.querySelectorAll('.reason-btn').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');
    const otherInput = document.getElementById('otherReason');
    if (otherInput) {
        if (selectedReason && selectedReason.toLowerCase().includes('other')) {
            otherInput.classList.remove('hidden');
            otherInput.focus();
        } else {
            otherInput.classList.add('hidden');
            otherInput.value = '';
        }
    }
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
}

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

// === SECTION 6: USER LISTENER ===
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
        if (data.is_active === false) {
            logoutUser();
            showToast('🔒 Your account has been deactivated (employee left).', 'error');
            return;
        }
        if (data.forceLogout === true) {
            userRef.update({ forceLogout: null }).catch(() => {});
            logoutUser();
            showToast('🔒 You have been logged out by admin.', 'info');
            return;
        }
        if (data.is_blocked === true && data.role !== 'admin') {
            const today = getLocalDate();
            const blockedDate = data.blocked_date || '';
            if (blockedDate !== today) {
                userRef.update({ is_blocked: false, blocked_date: null }).catch(() => {});
                document.getElementById('blockedOverlay').style.display = 'none';
                showToast('🔓 Auto-unblocked (new day)', 'info');
            } else {
                document.getElementById('blockedOverlay').style.display = 'flex';
            }
        } else {
            document.getElementById('blockedOverlay').style.display = 'none';
        }
    });
    userListenerRef = userRef;
}

function stopUserExistenceCheck() {
    if (userListenerRef) { userListenerRef.off(); userListenerRef = null; }
}

// === SECTION 7: AUTHENTICATION ===
async function loginUser() {
    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value.trim();
    const errorEl = document.getElementById('loginError');
    if (!username || !password) {
        errorEl.textContent = 'Please enter both username and password.';
        errorEl.style.display = 'block'; return;
    }
    errorEl.style.display = 'none';
    try {
        const snap = await db.ref('users/' + username).once('value');
        if (!snap.exists()) {
            errorEl.textContent = 'User not found. Check username.';
            errorEl.style.display = 'block'; return;
        }
        const userData = snap.val();
        if (userData.password !== password) {
            errorEl.textContent = 'Incorrect password.';
            errorEl.style.display = 'block'; return;
        }
        if (userData.is_active === false) {
            errorEl.textContent = '❌ Account disabled (employee left). Contact admin.';
            errorEl.style.display = 'block'; return;
        }
        currentUser = { username, name: userData.name, ...userData };
        localStorage.setItem('flipkart_agent_user', JSON.stringify(currentUser));
        showMainApp();
        showToast('✅ Welcome, ' + currentUser.name + '!', 'success');
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
    } catch (e) {
        console.error(e);
        errorEl.textContent = 'Something went wrong. Try again.';
        errorEl.style.display = 'block';
    }
}

function logoutUser() {
    if (attendanceGateOpen) Swal.close();
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
                    const userSnap = await db.ref('users/' + currentUser.username).once('value');
                    const userData = userSnap.val();
                    if (userData && userData.is_active === false) {
                        logoutUser();
                        showToast('🔒 Your account has been deactivated (left).', 'error');
                        return;
                    }
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

// === SECTION 8: CHANGE PASSWORD ===
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

// === SECTION 9: ATTENDANCE & SALARY SYSTEM ===
async function checkAttendanceAndBlock() {
    if (!currentUser) return;
    if (currentUser.role === 'admin') return;
    const today = getLocalDate();
    const dateEl = document.getElementById('attendanceDateDisplay');
    if (dateEl) dateEl.textContent = today;
    try {
        const userSnap = await db.ref('users/' + currentUser.username).once('value');
        const userData = userSnap.val() || {};
        if (userData.is_blocked === true && userData.blocked_date !== today) {
            await db.ref('users/' + currentUser.username).update({ is_blocked: false, blocked_date: null });
            const overlay = document.getElementById('blockedOverlay');
            if (overlay) overlay.style.display = 'none';
        }
        const freshSnap = await db.ref('users/' + currentUser.username + '/is_blocked').once('value');
        if (freshSnap.val() === true) {
            const overlay = document.getElementById('blockedOverlay');
            if (overlay) overlay.style.display = 'flex';
            updateAttendanceUI('blocked');
            return;
        }
        const attSnap = await db.ref('attendance/' + currentUser.username + '/' + today).once('value');
        const att = attSnap.val();
        if (att && att.status === 'present') {
            updateAttendanceUI('present');
            loadAttendanceHistory();
            loadAgentSalarySummary();
            return;
        }
        if (att && att.status === 'absent' && att.blocked) {
            const overlay = document.getElementById('blockedOverlay');
            if (overlay) overlay.style.display = 'flex';
            updateAttendanceUI('blocked');
            loadAttendanceHistory();
            return;
        }
        updateAttendanceUI('unmarked');
        loadAttendanceHistory();
        loadAgentSalarySummary();
        showAttendanceOtpGate();
    } catch (e) { console.error('Error checking attendance:', e); }
}

function updateAttendanceUI(status) {
    const badge = document.getElementById('currentStatusBadge');
    const actionGrid = document.getElementById('attendanceActionGrid');
    const lockNotice = document.getElementById('attendanceLockNotice');
    const overlay = document.getElementById('blockedOverlay');
    if (!badge) return;
    if (status === 'present') {
        badge.className = 'px-3 py-1 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800';
        badge.textContent = '✅ Present';
        if (actionGrid) actionGrid.style.display = 'none';
        if (lockNotice) { lockNotice.classList.remove('hidden'); lockNotice.textContent = '✅ Attendance recorded as Present for today.'; }
        if (overlay) overlay.style.display = 'none';
    } else if (status === 'blocked' || status === 'absent') {
        badge.className = 'px-3 py-1 text-xs font-semibold rounded-full bg-rose-100 text-rose-800';
        badge.textContent = '❌ Blocked / Absent';
        if (actionGrid) actionGrid.style.display = 'none';
        if (lockNotice) { lockNotice.classList.remove('hidden'); lockNotice.textContent = '🔒 You are marked Absent/Blocked for today. Contact admin to unblock.'; }
    } else {
        badge.className = 'px-3 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800';
        badge.textContent = '⚠️ Not Marked';
        if (actionGrid) actionGrid.style.display = 'grid';
        if (lockNotice) lockNotice.classList.add('hidden');
        if (overlay) overlay.style.display = 'none';
    }
}

async function openAttendanceOtpModal() {
    const today = getLocalDate();
    const attSnap = await db.ref('attendance/' + currentUser.username + '/' + today).once('value');
    if (attSnap.exists() && attSnap.val().status) {
        Swal.fire({ icon: 'info', title: 'Already Marked', text: 'Attendance is already recorded for today.' });
        return;
    }
    const { value: otp, isConfirmed } = await Swal.fire({
        title: '🔐 Verify OTP',
        text: 'Enter the 6-digit OTP shared by Admin for today:',
        input: 'text', inputPlaceholder: '6-digit OTP',
        inputAttributes: { maxlength: 6, inputmode: 'numeric' },
        showCancelButton: true, confirmButtonText: 'Verify & Mark Present',
        cancelButtonText: 'Cancel', confirmButtonColor: '#059669', cancelButtonColor: '#64748b'
    });
    if (!isConfirmed || !otp) return;
    try {
        await markAttendanceWithOtp(otp);
        showToast('✅ Attendance marked Present!', 'success');
        updateAttendanceUI('present');
        loadAttendanceHistory();
        loadAgentSalarySummary();
    } catch (e) {
        if (e.message === 'INVALID_OTP') {
            Swal.fire({ icon: 'error', title: 'Invalid OTP', text: 'Please enter a valid 6-digit OTP.' });
        } else if (e.message === 'INCORRECT_OTP') {
            Swal.fire({ icon: 'error', title: 'Incorrect OTP', text: "The OTP entered is incorrect. Ask Admin for today's OTP." });
        } else if (e.message === 'OTP_USED') {
            Swal.fire({ icon: 'error', title: 'OTP Already Used', text: 'This OTP has already been used.' });
        } else {
            console.error('Error verifying attendance OTP:', e);
            showToast('Verification failed. Check network.', 'error');
        }
    }
}

async function markAttendanceWithOtp(otp) {
    const trimmedOtp = String(otp || '').trim();
    if (!/^\d{6}$/.test(trimmedOtp)) throw new Error('INVALID_OTP');

    const today = getLocalDate();
    let otpData = null;
    const dailySnap = await db.ref('daily_otp/' + today + '/' + currentUser.username).once('value');
    if (dailySnap.exists()) otpData = dailySnap.val();
    else {
        const agentOtpSnap = await db.ref('otp/' + currentUser.username).once('value');
        if (agentOtpSnap.exists()) otpData = agentOtpSnap.val();
    }
    if (!otpData || String(otpData.otp).trim() !== trimmedOtp) throw new Error('INCORRECT_OTP');
    if (otpData.used === true) throw new Error('OTP_USED');

    await db.ref('attendance/' + currentUser.username + '/' + today).set({
        status: 'present', timestamp: Date.now(), otp_used: trimmedOtp,
        blocked: false, salary_counted: true, marked_by: 'agent_otp'
    });
    if (dailySnap.exists()) await db.ref('daily_otp/' + today + '/' + currentUser.username + '/used').set(true);
    else await db.ref('otp/' + currentUser.username + '/used').set(true);
}

function showAttendanceOtpGate() {
    if (!currentUser || currentUser.role === 'admin' || attendanceGateOpen) return;

    const today = getLocalDate();
    const attendanceRef = db.ref('attendance/' + currentUser.username + '/' + today);
    let attendanceMarkedPresent = false;
    const onAttendanceChange = snapshot => {
        const attendance = snapshot.val();
        if (!attendance || attendance.status !== 'present') return;
        attendanceMarkedPresent = true;
        updateAttendanceUI('present');
        Swal.close();
    };
    const onAttendanceError = error => {
        console.error('Attendance gate listener failed:', error);
        showToast('Could not check attendance. Check your connection.', 'error');
    };

    attendanceGateOpen = true;
    attendanceRef.on('value', onAttendanceChange, onAttendanceError);

    Swal.fire({
        title: '🔐 Verify Attendance OTP',
        text: 'Enter today’s 6-digit OTP, or wait for Admin to mark you Present.',
        input: 'text',
        inputPlaceholder: '6-digit OTP',
        inputAttributes: { maxlength: 6, inputmode: 'numeric', autocomplete: 'one-time-code' },
        confirmButtonText: 'Verify & Continue',
        confirmButtonColor: '#059669',
        allowOutsideClick: false,
        allowEscapeKey: false,
        allowEnterKey: true,
        showCancelButton: false,
        preConfirm: async otp => {
            try {
                await markAttendanceWithOtp(otp);
                return true;
            } catch (e) {
                const messages = {
                    INVALID_OTP: 'Please enter a valid 6-digit OTP.',
                    INCORRECT_OTP: "Incorrect OTP. Ask Admin for today's OTP.",
                    OTP_USED: 'This OTP has already been used.'
                };
                if (!messages[e.message]) {
                    console.error('Attendance OTP verification failed:', e);
                    Swal.showValidationMessage('Verification failed. Check your connection and try again.');
                    return false;
                }
                Swal.showValidationMessage(messages[e.message]);
                return false;
            }
        }
    }).then(result => {
        attendanceRef.off('value', onAttendanceChange);
        attendanceGateOpen = false;
        if (attendanceMarkedPresent || result.isConfirmed) {
            updateAttendanceUI('present');
            loadAttendanceHistory();
            loadAgentSalarySummary();
            return;
        }
        if (currentUser) showAttendanceOtpGate();
    });
}

async function handleMarkAbsent() {
    const { value: reason, isConfirmed } = await Swal.fire({
        title: 'Mark as Absent?',
        text: 'You will be locked for the day. Salary for today will not be counted unless admin unblocks.',
        input: 'text', inputPlaceholder: 'Reason for absence...',
        showCancelButton: true, confirmButtonText: 'Yes, Mark Absent',
        cancelButtonText: 'Cancel', confirmButtonColor: '#dc2626', cancelButtonColor: '#64748b'
    });
    if (!isConfirmed) return;
    const today = getLocalDate();
    try {
        await db.ref('attendance/' + currentUser.username + '/' + today).set({
            status: 'absent', reason: reason || 'Not specified', timestamp: Date.now(),
            blocked: true, salary_counted: false, marked_by: 'agent_self'
        });
        await db.ref('users/' + currentUser.username).update({ is_blocked: true, blocked_date: today });
        showToast('🔒 Marked as Absent. Account locked for today.', 'info');
        updateAttendanceUI('blocked');
        const overlay = document.getElementById('blockedOverlay');
        if (overlay) overlay.style.display = 'flex';
        loadAttendanceHistory();
    } catch (e) {
        console.error(e);
        showToast('Failed to mark absent.', 'error');
    }
}

async function loadAttendanceHistory() {
    const container = document.getElementById('attendanceHistoryList');
    if (!container || !currentUser) return;
    try {
        const snap = await db.ref('attendance/' + currentUser.username).limitToLast(7).once('value');
        const data = snap.val() || {};
        const dates = Object.keys(data).sort().reverse();
        if (dates.length === 0) {
            container.innerHTML = '<div class="text-gray-400 text-center py-2">No recent records found.</div>';
            return;
        }
        let html = '';
        dates.forEach(d => {
            const item = data[d];
            const isPres = item.status === 'present';
            const isHalf = item.half_day === true;
            const badgeClass = isHalf ? 'bg-amber-100 text-amber-800' : (isPres ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800');
            const label = isHalf ? 'Half Day' : (isPres ? 'Present' : 'Absent');
            html += `<div class="flex items-center justify-between p-2 rounded-lg bg-gray-50 border border-gray-100">
                <span class="font-medium text-gray-700">${d}</span>
                <span class="px-2 py-0.5 rounded text-[11px] font-semibold ${badgeClass}">${label}</span>
            </div>`;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<div class="text-gray-400 text-center py-2">Failed to load history.</div>';
    }
}

async function loadAgentSalarySummary() {
    const approvedContent = document.getElementById('salaryApprovedContent');
    const pendingNotice = document.getElementById('salaryPendingNotice');
    const badge = document.getElementById('salaryStatusBadge');
    if (!currentUser || !approvedContent) return;
    const today = new Date();
    const curMonth = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
    try {
        const snap = await db.ref('salaries/' + curMonth + '/' + currentUser.username).once('value');
        const sal = snap.val();
        if (sal && (sal.approved === true || sal.status === 'approved' || sal.visible_to_agent === true)) {
            if (badge) {
                badge.className = 'text-[11px] px-2.5 py-0.5 rounded-full font-semibold bg-emerald-100 text-emerald-800';
                badge.textContent = 'Approved by Admin';
            }
            approvedContent.style.display = 'block';
            if (pendingNotice) pendingNotice.style.display = 'none';
            const base = sal.base_salary || sal.total_salary || 0;
            const ded = sal.deductions || sal.cut || 0;
            const net = sal.net_salary || sal.final_payable || (base - ded);
            const elTotal = document.getElementById('agentTotalSalary');
            const elDed = document.getElementById('agentDeductions');
            const elNet = document.getElementById('agentFinalSalary');
            if (elTotal) elTotal.textContent = '₹' + Number(base).toLocaleString('en-IN');
            if (elDed) elDed.textContent = '-₹' + Number(ded).toLocaleString('en-IN');
            if (elNet) elNet.textContent = '₹' + Number(net).toLocaleString('en-IN');
        } else {
            if (badge) {
                badge.className = 'text-[11px] px-2.5 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-600';
                badge.textContent = 'Pending Admin Approval';
            }
            approvedContent.style.display = 'none';
            if (pendingNotice) pendingNotice.style.display = 'block';
        }
    } catch (e) { console.error('Error fetching agent salary:', e); }
}

// === SECTION 10: TAB SWITCHING ===
function switchTab(tab) {
    document.querySelectorAll('#mainTabBar button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + tab).style.display = 'block';
    if (tab === 'pending') loadPendingOrders();
    if (tab === 'attendance') { loadAttendanceHistory(); updateAttendanceUI(); }
}

// === SECTION 11: OFFLINE DETECTION ===
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

// === SECTION 12: TODAY'S STATS ===
async function loadTodayStats() {
    if (!currentUser) return;
    try {
        const today = new Date().toDateString();
        const snapshot = await db.ref('pickups').orderByChild('agent').equalTo(currentUser.username).once('value');
        const data = snapshot.val() || {};
        let pickup = 0, reject = 0, reschedule = 0;
        Object.values(data).forEach(item => {
            if (new Date(item.timestamp).toDateString() === today) {
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

// === SECTION 13: PENDING ORDERS ===
async function loadPendingOrders() {
    if (!currentUser) return;
    try {
        const snapshot = await db.ref('pending').orderByChild('agent').equalTo(currentUser.username).once('value');
        const data = snapshot.val() || {};
        allPendingOrders = [];
        for (const [orderId, item] of Object.entries(data || {})) {
            allPendingOrders.push({ orderId, ...item });
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
            </div>`;
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
            </div>`;
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

// === SECTION 14: PASTE ORDER ID ===
async function pasteOrderId() {
    try {
        const text = await navigator.clipboard.readText();
        document.getElementById('orderId').value = text.trim().toUpperCase();
        showToast('Pasted!', 'success');
    } catch (e) {
        showToast('Cannot access clipboard', 'error');
    }
}

// === SECTION 15: SHOW FORM ===
let backNavigationReady = false;

function setupBackNavigation() {
    if (backNavigationReady) return;
    backNavigationReady = true;
    history.replaceState({ view: 'order' }, '', window.location.href);
    window.addEventListener('popstate', () => {
        const scannerModal = document.getElementById('scannerModal');
        if (scannerModal && !scannerModal.classList.contains('hidden')) {
            stopScanner(); return;
        }
        const stepForm = document.getElementById('step-form');
        if (stepForm && !stepForm.classList.contains('hidden')) goBack();
    });
}

function goBack() {
    const stepOrder = document.getElementById('step-order');
    const stepForm = document.getElementById('step-form');
    if (stepForm && !stepForm.classList.contains('hidden')) {
        stepForm.classList.add('hidden');
        stepOrder.classList.remove('hidden');
        currentStatus = ''; selectedReason = ''; hiddenImei2 = '';
        const orderInput = document.getElementById('orderId');
        if (orderInput) orderInput.focus();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        history.replaceState({ view: 'order' }, '', window.location.href);
        return true;
    }
    return false;
}

function showForm(status) {
    clearPickupImageState();
    resetSpecSelection();
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
    currentStatus = status; selectedReason = ''; hiddenImei2 = '';
    document.getElementById('step-order').classList.add('hidden');
    document.getElementById('step-form').classList.remove('hidden');
    document.getElementById('displayOrderId').textContent = orderId;
    history.pushState({ view: 'form', status }, '', window.location.href);

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

            <div class="pt-2 border-t border-gray-100">
                <p class="text-xs font-bold text-gray-500 mb-3 tracking-wide">⚙️ DEVICE SPECS <span class="text-red-500 font-bold">(Required)</span></p>

                <div class="spec-group">
                    <div class="spec-label"><span class="t">RAM *</span><span class="picked empty" id="ramPick">Not selected</span></div>
                    <div class="chip-grid">${buildSpecChips('ram', RAM_OPTIONS)}</div>
                </div>

                <div class="spec-group mt-4">
                    <div class="spec-label"><span class="t">STORAGE (ROM) *</span><span class="picked empty" id="storagePick">Not selected</span></div>
                    <div class="chip-grid">${buildSpecChips('storage', STORAGE_OPTIONS)}</div>
                </div>

                <div class="spec-group mt-4">
                    <div class="spec-label"><span class="t">NETWORK *</span><span class="picked empty" id="networkPick">Not selected</span></div>
                    <div class="chip-grid cols-5">${buildSpecChips('network', NETWORK_OPTIONS, 'net')}</div>
                </div>

                <div class="spec-summary" id="specSummary"></div>
                <input type="hidden" id="ramStorage" value="">
                <input type="hidden" id="networkType" value="">
            </div>

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
                <button type="button" onclick="selectReason(this, '${r.text}')" data-reason="${r.text}" class="reason-btn w-full text-left p-3.5 rounded-xl flex items-center gap-3 hover:bg-gray-50">
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
    if (status === 'pickup') updateSpecUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// === SECTION 16: SUBMIT DATA (REGULAR PICKUP — UNCHANGED) ===
async function submitData() {
    if (!currentUser) { showToast('Please login first', 'error'); return; }
    if (currentUser.role !== 'admin') {
        const userSnap = await db.ref('users/' + currentUser.username + '/is_blocked').once('value');
        if (userSnap.val() === true) { showToast('🔒 You are blocked for today!', 'error'); return; }
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
    if (exists && existingData.status === 'rejected' && currentStatus === 'pickup') {
        const { value: password, isConfirmed } = await Swal.fire({
            title: '🔐 Admin Password Required',
            html: `
                <p class="text-sm text-gray-600 mb-2">This order was previously <span class="text-red-600 font-bold">REJECTED</span>.</p>
                <p class="text-sm text-gray-600 mb-2">Enter admin password to mark as <span class="text-green-600 font-bold">PICKUP COMPLETED</span>.</p>
                <p class="text-xs text-gray-400 mt-2">Only admin knows this password.</p>
            `,
            input: 'password', inputPlaceholder: 'Enter admin password',
            inputAttributes: { autocapitalize: 'off', autocorrect: 'off' },
            showCancelButton: true, confirmButtonColor: '#3b82f6', cancelButtonColor: '#dc2626',
            confirmButtonText: '✅ Verify & Proceed', cancelButtonText: 'Cancel',
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
    if (exists && existingData.status === 'pickup' && currentStatus === 'pickup') {
        Swal.fire({ icon: 'error', title: 'Already Pickup Completed', text: `Order ${orderId} already marked.`, confirmButtonColor: '#3b82f6' });
        return;
    }
    const now = new Date();
    const istDateTime = getISTDateTime();
    let dbData = {
        orderId, status: currentStatus,
        timestamp: now.toISOString(), timestampIST: istDateTime,
        date: now.toLocaleDateString('en-IN'), time: now.toLocaleTimeString('en-IN'),
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
        if (!selectedRam || !selectedStorage || !selectedNetwork) {
            const miss = [];
            if (!selectedRam) miss.push('RAM');
            if (!selectedStorage) miss.push('Storage');
            if (!selectedNetwork) miss.push('Network');
            Swal.fire({
                icon: 'warning', title: 'Device Specs Required',
                html: `<p class="text-sm text-gray-600">Please select <b>${miss.join(', ')}</b> before submitting.</p>`,
                confirmButtonColor: '#3b82f6'
            });
            const box = document.getElementById('specSummary');
            if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        dbData.ram = selectedRam;
        dbData.storage = selectedStorage;
        dbData.ramStorage = selectedRam + '/' + selectedStorage;
        dbData.networkType = selectedNetwork;
        const _billNo = (document.getElementById('billNumber')?.value || '').trim();
        const _aadNo = (document.getElementById('aadhaarNumber')?.value || '').trim();
        if (_billNo) dbData.billNumber = _billNo;
        if (_aadNo) dbData.aadhaarNumber = _aadNo;
        if (pickupBillImages.length) {
            Swal.fire({ title: 'Uploading Bill Images...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const billUrls = [];
            for (let i = 0; i < pickupBillImages.length; i++) {
                try {
                    const blob = await (await fetch(pickupBillImages[i])).blob();
                    const fileName = `${orderId}_bill_${i}_${Date.now()}.jpg`;
                    const storageRef = storage.ref(`pickup_docs/${orderId}/bill/${fileName}`);
                    const snapshot = await storageRef.put(blob, { contentType: 'image/jpeg' });
                    billUrls.push(await snapshot.ref.getDownloadURL());
                } catch (e) {
                    console.error('Bill image upload failed:', e);
                    Swal.close();
                    showToast('❌ Bill image upload failed', 'error');
                    return;
                }
            }
            dbData.billImages = billUrls;
            dbData.billImage = billUrls[0];
            Swal.close();
        }
        if (pickupAadhaarImages.length) {
            Swal.fire({ title: 'Uploading Aadhaar Images...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const aadhaarUrls = [];
            for (let i = 0; i < pickupAadhaarImages.length; i++) {
                try {
                    const blob = await (await fetch(pickupAadhaarImages[i])).blob();
                    const fileName = `${orderId}_aadhaar_${i}_${Date.now()}.jpg`;
                    const storageRef = storage.ref(`pickup_docs/${orderId}/aadhaar/${fileName}`);
                    const snapshot = await storageRef.put(blob, { contentType: 'image/jpeg' });
                    aadhaarUrls.push(await snapshot.ref.getDownloadURL());
                } catch (e) {
                    console.error('Aadhaar image upload failed:', e);
                    Swal.close();
                    showToast('❌ Aadhaar image upload failed', 'error');
                    return;
                }
            }
            dbData.aadhaarImages = aadhaarUrls;
            dbData.aadhaarImage = aadhaarUrls[0];
            Swal.close();
        }
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
            whatsappMsg = `Order ID: ${orderId}\nModel: ${dbData.phoneModel}\nReason: ${dbData.reason}\nStatus: Rejected`;
            dbData.incentive_approved = false;
            dbData.incentive_paid = false;
        } else {
            whatsappMsg = `Order ID: ${orderId}\nModel: ${dbData.phoneModel}\nReason: ${dbData.reason}\nStatus: Rescheduled`;
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
                        icon: 'question', showCancelButton: true,
                        confirmButtonColor: '#f59e0b', confirmButtonText: 'Update', cancelButtonText: 'Cancel'
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
                orderId, phoneModel: dbData.phoneModel,
                reason: dbData.reason || selectedReason, status: 'reschedule',
                timestamp: now.toISOString(), timestampIST: istDateTime,
                agent: currentUser.username
            };
            await db.ref('pending/' + orderId).set(pendingData);
            await loadPendingOrders();
        }
        const result = await Swal.fire({
            icon: 'success', title: '✅ Saved!',
            html: `
                <p class="text-sm text-gray-600 mb-2">📊 Firebase me time save ho gaya:</p>
                <div class="text-left bg-blue-50 p-2 rounded-lg text-xs font-mono mb-3">${istDateTime}</div>
                <p class="text-sm text-gray-600 mb-2">📱 WhatsApp message (no time):</p>
                <div class="text-left bg-gray-50 p-3 rounded-lg text-xs font-mono whitespace-pre-wrap">${whatsappMsg}</div>
            `,
            showCancelButton: true, showDenyButton: true,
            confirmButtonText: '📤 Open WhatsApp', denyButtonText: '📋 Copy Message', cancelButtonText: 'Close',
            confirmButtonColor: '#25D366', denyButtonColor: '#3b82f6'
        });
        if (result.isConfirmed) window.open(`https://wa.me/?text=${encodeURIComponent(whatsappMsg)}`, '_blank');
        else if (result.isDenied) {
            try { await navigator.clipboard.writeText(whatsappMsg); showToast('✅ Copied!', 'success'); }
            catch (e) {
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

// === SECTION 17: SCANNER FUNCTIONS (Barcode + OCR) ===
// 🔥 Modified: routes IMEI to correct input based on scannerTarget

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
            if (d.label && /back|rear|environment/i.test(d.label)) { deviceId = d.deviceId; break; }
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
        if (imeis.imei1 && imeis.imei1.length >= 14) { handleImeiFound(imeis.imei1, imeis.imei2); return; }
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
            if (imeis.imei1 && imeis.imei1.length >= 14) { handleImeiFound(imeis.imei1, imeis.imei2); return; }
        } catch (e) { console.error(e); }
    }, 1500);
}

// 🔥 Modified: target input based on scannerTarget
function handleImeiFound(imei1, imei2) {
    if (!isOcrScanning && !isScanning) return;
    if (imei1 === lastDetectedImei) return;
    lastDetectedImei = imei1;
    document.getElementById('imeiResultText').textContent = '✅ IMEI: ' + imei1 + (imei2 ? ' | IMEI2 captured' : '');
    document.getElementById('imeiResult').classList.add('show');
    const targetInput = scannerTarget === 'outside'
        ? document.getElementById('opImei')
        : document.getElementById('imei');
    if (targetInput) {
        targetInput.value = imei1;
        targetInput.classList.add('flash-green');
        setTimeout(() => targetInput.classList.remove('flash-green'), 500);
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
    if (captureBtn) {
        captureBtn.disabled = false;
        captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
    }
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
        if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
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

// 🔥 Modified: target input based on scannerTarget
function onScanSuccess(imei1, imei2) {
    if (!isScanning) return;
    isScanning = false;
    const targetInput = scannerTarget === 'outside'
        ? document.getElementById('opImei')
        : document.getElementById('imei');
    if (targetInput) {
        targetInput.value = imei1;
        targetInput.classList.add('flash-green');
        setTimeout(() => targetInput.classList.remove('flash-green'), 500);
    }
    if (imei2) hiddenImei2 = imei2;
    if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    stopScanner();
    showToast('✅ IMEI: ' + imei1, 'success');
}

function stopScanner() {
    isScanning = false;
    scannerTarget = 'regular'; // 🔥 reset target after scan completes/cancels
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
    if (captureBtn) {
        captureBtn.disabled = false;
        captureBtn.innerHTML = '<i data-lucide="camera"></i> Capture & Read IMEI';
    }
    lucide.createIcons();
}

// === SECTION 18: TOAST ===
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

// === SECTION 19: IST DATE/TIME FORMATTER ===
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

// ================================================================
// === SECTION 20: OUTSIDE PICKUP — NEW FEATURE ===================
// ================================================================
// ID format: OP-YYMMDD-NNNN
//   - OP      = Outside Pickup prefix
//   - YYMMDD  = date (readable, sortable)
//   - NNNN    = daily counter via Firebase transaction (0001-9999,
//               extends to 10000+ naturally if needed)
//   Backend uniqueness enforced by `outside_pickup_counters/{YYMMDD}`
//   transaction — safe across concurrent riders, no collisions.
//   IMPORTANT: the number is only RESERVED on a successful submit. Opening
//   the form (or refreshing) merely PEEKS at the next number, so the shown
//   ID never changes until a new pickup is actually created.
// Record path: outside_pickups/{pickupId}
// Inventory impact: NONE until admin approval (which writes to
// `pickups/{pickupId}` and thus appears in existing inventory filters).
// ================================================================

let scannerTarget = 'regular'; // 'regular' | 'outside'
let opSelectedRam = '';
let opSelectedStorage = '';
let opSelectedNetwork = '';
const OP_NETWORK_OPTIONS = ['1G','2G','3G','4G','5G'];
let outsidePickupId = '';
let outsidePickupImages = [];
const OUTSIDE_MAX_IMAGES = 5;
// Short-lived per-IMEI lock used to stop two concurrent submissions of the
// same phone from creating two records. Expires by itself (no cleanup needed),
// so a rejected/deleted pickup can be submitted again later.
const OP_CLAIM_TTL_MS = 90 * 1000;
let opSubmitInFlight = false;

// ---- Chip helpers for Outside Pickup ----
function buildOutsideChips(kind, options, extraClass) {
    return options.map(o =>
        `<button type="button" class="spec-chip ${extraClass || ''}" data-kind="${kind}" data-val="${o}" onclick="selectOutsideSpec('${kind}','${o}',this)">${o}</button>`
    ).join('');
}

function selectOutsideSpec(kind, val, el) {
    const group = el.parentElement;
    const already = el.classList.contains('active');
    group.querySelectorAll('.spec-chip').forEach(b => b.classList.remove('active'));
    const finalVal = already ? '' : val;
    if (!already) el.classList.add('active');
    if (kind === 'ram') opSelectedRam = finalVal;
    if (kind === 'storage') opSelectedStorage = finalVal;
    if (kind === 'network') opSelectedNetwork = finalVal;
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch(_){} }
    updateOutsideSpecUI();
}

function updateOutsideSpecUI() {
    const r = document.getElementById('opRamPick');
    const s = document.getElementById('opStoragePick');
    const n = document.getElementById('opNetworkPick');
    if (r) { r.textContent = opSelectedRam || 'Not selected'; r.className = 'picked' + (opSelectedRam ? '' : ' empty'); }
    if (s) { s.textContent = opSelectedStorage || 'Not selected'; s.className = 'picked' + (opSelectedStorage ? '' : ' empty'); }
    if (n) { n.textContent = opSelectedNetwork || 'Not selected'; n.className = 'picked' + (opSelectedNetwork ? '' : ' empty'); }
}

// ---- ID helpers: stable preview + transactional reservation ----
function getOutsidePickupDateKey(d = new Date()) {
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

// READ-ONLY preview of the next ID. Does not increment the counter, so
// opening / refreshing / re-opening the form always shows the same number.
async function peekOutsidePickupId() {
    const dateKey = getOutsidePickupDateKey();
    const snap = await db.ref('outside_pickup_counters/' + dateKey).once('value');
    const current = Number(snap.val()) || 0;
    return `OP-${dateKey}-${String(current + 1).padStart(4, '0')}`;
}

// Give a number back when a submit fails before the record is saved, so a
// failed attempt never burns a pickup number.
async function releaseOutsidePickupCounter(pickupId) {
    const m = /^OP-(\d{6})-(\d+)$/.exec(String(pickupId || ''));
    if (!m) return;
    const dateKey = m[1];
    const seq = parseInt(m[2], 10);
    try {
        await db.ref('outside_pickup_counters/' + dateKey).transaction(current => {
            if (current === null || current === undefined) return; // abort — nothing to release
            const value = Number(current) || 0;
            if (value !== seq) return; // someone already took a newer number — leave gap
            return value > 1 ? value - 1 : null;
        });
    } catch (e) {
        console.warn('Counter rollback failed:', e);
    }
}

// ---- Duplicate protection helpers ----
// Atomic, short-lived claim per IMEI: blocks two concurrent submissions of the
// same phone. Auto-expires so a rejected pickup can be submitted again later.
// If the database rules do not allow this helper node, we degrade gracefully
// (returns supported:false) instead of breaking the submit flow.
async function acquireOutsidePickupClaim(imei) {
    try {
        const nowTs = Date.now();
        const result = await db.ref('outside_pickup_claims/' + imei).transaction(current => {
            if (current && typeof current === 'object') {
                const ts = Number(current.ts) || 0;
                if (nowTs - ts < OP_CLAIM_TTL_MS) return; // abort — submission already running
            }
            return { ts: nowTs, by: currentUser.username };
        });
        return { supported: true, held: result.committed };
    } catch (e) {
        console.warn('Concurrency lock unavailable — continuing with duplicate checks only:', e);
        return { supported: false, held: false };
    }
}

function releaseOutsidePickupClaim(imei) {
    return db.ref('outside_pickup_claims/' + imei).remove().catch(() => {});
}

// Returns the existing (non-rejected) outside pickup that already uses this
// IMEI, or null. IMEI is the ONLY duplicate key — the model is returned just
// so the warning can identify the existing entry (many phones share a model).
async function findDuplicateOutsidePickup(imei) {
    const target = String(imei || '').trim();
    if (!target) return null;
    const snap = await db.ref('outside_pickups').once('value');
    const all = snap.val() || {};
    const id = Object.keys(all).find(k => {
        const rec = all[k];
        if (!rec) return false;
        if ((rec.status || 'pending') === 'rejected') return false; // rejected = can be re-entered
        return String(rec.imei || '').trim() === target;
    });
    if (!id) return null;
    const rec = all[id] || {};
    return {
        pickupId: id,
        phoneModel: rec.phoneModel || '',
        status: rec.status || 'pending',
        rider: rec.rider || rec.agentName || rec.agent || '',
        date: rec.date || rec.timestampIST || ''
    };
}

// ---- ID Reservation (transactional — guarantees uniqueness) ----
async function reserveOutsidePickupId() {
    const dateKey = getOutsidePickupDateKey();
    const counterRef = db.ref('outside_pickup_counters/' + dateKey);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await counterRef.transaction(current => {
                return (current || 0) + 1;
            });
            if (result.committed) {
                const num = result.snapshot.val();
                return `OP-${dateKey}-${String(num).padStart(4, '0')}`;
            }
        } catch (e) {
            console.warn('ID reservation attempt ' + attempt + ' failed:', e);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Could not reserve ID. Please retry.');
}

// ---- Open / Close Outside Pickup Page ----
async function openOutsidePickup() {
    if (!currentUser) { showToast('Please login first', 'error'); return; }

    // Reset state
    outsidePickupId = '';
    outsidePickupImages = [];
    opSelectedRam = ''; opSelectedStorage = ''; opSelectedNetwork = '';
    hiddenImei2 = '';

    // Switch views: hide tabs, show outside page
    document.getElementById('mainTabBar').style.display = 'none';
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.getElementById('outsidePickupPage').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Placeholder while the preview loads
    const idEl = document.getElementById('outsidePickupIdDisplay');
    if (idEl) idEl.textContent = '⏳ Generating…';

    // Build chips
    const ramChipsEl = document.getElementById('opRamChips');
    const stoChipsEl = document.getElementById('opStorageChips');
    const netChipsEl = document.getElementById('opNetworkChips');
    if (ramChipsEl) ramChipsEl.innerHTML = buildOutsideChips('ram', RAM_OPTIONS);
    if (stoChipsEl) stoChipsEl.innerHTML = buildOutsideChips('storage', STORAGE_OPTIONS);
    if (netChipsEl) netChipsEl.innerHTML = buildOutsideChips('network', OP_NETWORK_OPTIONS, 'net');

    // Reset inputs
    document.getElementById('opPhoneModel').value = '';
    document.getElementById('opImei').value = '';
    document.getElementById('opValue').value = '';
    document.getElementById('opCustomerName').value = '';
    document.getElementById('opAadhaarNumber').value = '';
    document.getElementById('opBillNumber').value = '';
    document.getElementById('opPhotoPreview').innerHTML = '';
    document.getElementById('opPhotoInfo').textContent = '0 photos added · optional';
    updateOutsideSpecUI();
    lucide.createIcons();

    // Preview the next ID (read-only). The number is only consumed when a
    // pickup is successfully created, so refresh / reopen keeps it stable.
    try {
        outsidePickupId = await peekOutsidePickupId();
        if (idEl) idEl.textContent = outsidePickupId;
    } catch (e) {
        console.warn('ID preview failed:', e);
        outsidePickupId = '';
        if (idEl) idEl.textContent = 'Auto-generated on submit';
    }
}

async function closeOutsidePickup() {
    // Confirm discard if form has any data
    const hasData =
        (document.getElementById('opPhoneModel')?.value || '').trim() ||
        (document.getElementById('opImei')?.value || '').trim() ||
        (document.getElementById('opValue')?.value || '').trim() ||
        outsidePickupImages.length > 0 ||
        opSelectedRam || opSelectedStorage || opSelectedNetwork;

    if (hasData) {
        const c = await Swal.fire({
            title: 'Discard this pickup?',
            text: 'Your entered details will be lost.',
            icon: 'warning', showCancelButton: true,
            confirmButtonColor: '#dc2626', cancelButtonColor: '#64748b',
            confirmButtonText: 'Yes, discard', cancelButtonText: 'Stay'
        });
        if (!c.isConfirmed) return;
    }

    // Reset
    outsidePickupImages = [];
    outsidePickupId = '';
    opSelectedRam = ''; opSelectedStorage = ''; opSelectedNetwork = '';
    hiddenImei2 = '';

    // Switch views back
    document.getElementById('outsidePickupPage').style.display = 'none';
    document.getElementById('mainTabBar').style.display = 'flex';
    switchTab('pickup');
}

// ---- Photo Handling for Outside Pickup ----
async function handleOutsidePhotoPick(inputEl) {
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    if (!files.length) return;
    if (outsidePickupImages.length >= OUTSIDE_MAX_IMAGES) {
        showToast(`Max ${OUTSIDE_MAX_IMAGES} photos`, 'error');
        inputEl.value = '';
        return;
    }
    const room = OUTSIDE_MAX_IMAGES - outsidePickupImages.length;
    const infoEl = document.getElementById('opPhotoInfo');
    if (infoEl) infoEl.textContent = '⏳ Compressing...';
    for (const f of files.slice(0, room)) {
        try { outsidePickupImages.push(await compressImageFile(f)); }
        catch (e) { console.error(e); }
    }
    inputEl.value = '';
    renderOutsidePhotos();
}

function renderOutsidePhotos() {
    const preview = document.getElementById('opPhotoPreview');
    const info = document.getElementById('opPhotoInfo');
    if (!preview) return;
    if (!outsidePickupImages.length) {
        preview.innerHTML = '';
        if (info) info.textContent = '0 photos added · optional';
        return;
    }
    let totalKB = 0;
    preview.innerHTML = `<div class="grid grid-cols-3 gap-2">` + outsidePickupImages.map((d, i) => {
        const kb = Math.round((d.length * 3 / 4) / 1024); totalKB += kb;
        return `<div class="relative">
            <img src="${d}" class="w-full h-20 object-cover rounded-lg border border-gray-200" alt="p${i}">
            <button type="button" onclick="removeOutsidePhoto(${i})" class="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold shadow-md">✕</button>
            <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] text-center rounded-b-lg">${kb}KB</div>
        </div>`;
    }).join('') + `</div>`;
    if (info) info.textContent = `✅ ${outsidePickupImages.length}/${OUTSIDE_MAX_IMAGES} · ~${totalKB} KB`;
}

function removeOutsidePhoto(idx) {
    outsidePickupImages.splice(idx, 1);
    renderOutsidePhotos();
}

// ---- Open Scanner for Outside Pickup ----
function openOutsideScanner() {
    scannerTarget = 'outside';
    startScanner();
}

// ---- Review & Submit ----
function escapeHtmlOP(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function reviewOutsidePickup() {
    if (!currentUser) { showToast('Please login first', 'error'); return; }

    const phoneModel = (document.getElementById('opPhoneModel').value || '').trim();
    const imei = (document.getElementById('opImei').value || '').trim();
    const valueRaw = (document.getElementById('opValue').value || '').trim();
    const customerName = (document.getElementById('opCustomerName').value || '').trim();
    const aadhaarNumber = (document.getElementById('opAadhaarNumber').value || '').trim();
    const billNumber = (document.getElementById('opBillNumber').value || '').trim();

    // Validations
    if (!phoneModel) { showToast('Enter phone model', 'error'); document.getElementById('opPhoneModel').focus(); return; }
    if (!imei || imei.length !== 15 || !/^\d{15}$/.test(imei)) {
        showToast('Enter valid 15-digit IMEI', 'error'); document.getElementById('opImei').focus(); return;
    }
    const value = parseInt(valueRaw);
    if (!value || value <= 0 || isNaN(value)) {
        showToast('Enter valid agreed value', 'error'); document.getElementById('opValue').focus(); return;
    }
    if (!opSelectedRam) { showToast('Select RAM', 'error'); return; }
    if (!opSelectedStorage) { showToast('Select Storage', 'error'); return; }
    if (!opSelectedNetwork) { showToast('Select Network', 'error'); return; }
    const summaryHtml = `
        <div style="text-align:left;font-size:13px;line-height:1.6;">
            <div style="background:linear-gradient(135deg,#faf5ff,#f3e8ff);border:1px solid #d8b4fe;border-radius:12px;padding:10px 12px;margin-bottom:10px;text-align:center;">
                <div style="font-size:9px;font-weight:800;color:#7c3aed;letter-spacing:1.5px;">PICKUP ID</div>
                <div style="font-family:monospace;font-size:14px;font-weight:800;color:#4c1d95;margin-top:2px;">${escapeHtmlOP(outsidePickupId || 'Auto-generated on submit')}</div>
            </div>
            <p><strong>Model:</strong> ${escapeHtmlOP(phoneModel)}</p>
            <p><strong>IMEI:</strong> <span style="font-family:monospace;">${escapeHtmlOP(imei)}</span></p>
            <p><strong>RAM / Storage:</strong> ${opSelectedRam} / ${opSelectedStorage}</p>
            <p><strong>Network:</strong> ${opSelectedNetwork}</p>
            <p><strong>Agreed Value:</strong> ₹${value.toLocaleString('en-IN')}</p>
            <p><strong>Photos:</strong> ${outsidePickupImages.length ? `${outsidePickupImages.length} uploaded` : 'None (optional)'}</p>
            ${customerName ? `<p><strong>Customer:</strong> ${escapeHtmlOP(customerName)}</p>` : ''}
            ${aadhaarNumber ? `<p><strong>Aadhaar:</strong> ${escapeHtmlOP(aadhaarNumber)}</p>` : ''}
            ${billNumber ? `<p><strong>Bill No:</strong> ${escapeHtmlOP(billNumber)}</p>` : ''}
            <div style="margin-top:10px;padding:8px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;font-size:11px;color:#92400e;">
                <strong>ℹ️ Status:</strong> Record will be saved as <strong>Pending Approval</strong>. Admin will verify and approve. No WhatsApp message will be sent.
            </div>
        </div>`;

    const result = await Swal.fire({
        title: 'Review Outside Pickup',
        html: summaryHtml,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: '✅ Submit for Approval',
        cancelButtonText: 'Edit',
        confirmButtonColor: '#7c3aed',
        cancelButtonColor: '#64748b',
        width: 'min(520px, 96vw)'
    });
    if (result.isConfirmed) submitOutsidePickup();
}

async function submitOutsidePickup() {
    if (!currentUser) { showToast('Please login first', 'error'); return; }
    if (opSubmitInFlight) { showToast('Submission already in progress…', 'info'); return; }

    const phoneModel = (document.getElementById('opPhoneModel').value || '').trim();
    const imei = (document.getElementById('opImei').value || '').trim();
    const value = parseInt((document.getElementById('opValue').value || '').trim());
    const customerName = (document.getElementById('opCustomerName').value || '').trim();
    const aadhaarNumber = (document.getElementById('opAadhaarNumber').value || '').trim();
    const billNumber = (document.getElementById('opBillNumber').value || '').trim();

    if (!imei) { showToast('IMEI missing. Please re-enter.', 'error'); return; }

    opSubmitInFlight = true;
    let reservedId = '';
    let recordSaved = false;
    let claimHeld = false;

    try {
        // ---- 1) Only one submission per phone at a time (atomic, auto-expiring) ----
        const claim = await acquireOutsidePickupClaim(imei);
        claimHeld = claim.held;
        if (claim.supported && !claim.held) {
            Swal.fire({
                icon: 'info',
                title: 'Already Submitting',
                html: 'This phone is being submitted right now.<br><span style="font-size:12px;color:#6b7280;">Please wait a few seconds, then check the pickup list.</span>',
                confirmButtonColor: '#7c3aed'
            });
            return;
        }

        // ---- 2) Reject repeats of a phone that is already pending / approved ----
        // IMEI is the unique key. Same model alone is NOT a duplicate.
        const duplicate = await findDuplicateOutsidePickup(imei);
        if (duplicate) {
            const dupModel = duplicate.phoneModel || '—';
            const statusLabel = duplicate.status === 'approved' ? 'Approved (in inventory)' : 'Pending Approval';
            const modelNote = (phoneModel && duplicate.phoneModel &&
                phoneModel.toLowerCase() !== dupModel.toLowerCase())
                ? `<div style="margin-top:4px;">New entry model: <b>${escapeHtmlOP(phoneModel)}</b> <span style="color:#b91c1c;">(different from above)</span></div>`
                : '';
            Swal.fire({
                icon: 'warning',
                title: 'Duplicate Entry: This IMEI number already exists.',
                html: `
                    <div style="text-align:left;font-size:13px;line-height:1.75;">
                        <div>IMEI: <b style="font-family:monospace;">${escapeHtmlOP(imei)}</b></div>
                        <div>Existing Model: <b>${escapeHtmlOP(dupModel)}</b></div>
                        <div>Existing Pickup ID: <b style="font-family:monospace;">${escapeHtmlOP(duplicate.pickupId)}</b></div>
                        <div>Status: <b>${escapeHtmlOP(statusLabel)}</b></div>
                        ${duplicate.rider ? `<div>Rider: <b>${escapeHtmlOP(duplicate.rider)}</b></div>` : ''}
                        ${duplicate.date ? `<div style="color:#6b7280;">Date: ${escapeHtmlOP(duplicate.date)}</div>` : ''}
                        ${modelNote}
                        <div style="margin-top:10px;padding:9px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:11.5px;color:#991b1b;">
                            This entry was NOT saved. The same IMEI cannot be added twice.
                        </div>
                    </div>`,
                confirmButtonText: 'OK',
                confirmButtonColor: '#dc2626',
                width: 'min(460px, 94vw)'
            });
            return;
        }

        // ---- 3) Upload photos first, so a failed upload never burns a number ----
        Swal.fire({ title: outsidePickupImages.length ? 'Uploading photos...' : 'Saving pickup...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const photoUrls = [];
        const uploadToken = `${currentUser.username}_${Date.now()}`;
        for (let i = 0; i < outsidePickupImages.length; i++) {
            try {
                const blob = await (await fetch(outsidePickupImages[i])).blob();
                const fileName = `${i}_${Date.now()}.jpg`;
                const storageRef = storage.ref(`outside_pickup_docs/pending/${uploadToken}/${fileName}`);
                const snapshot = await storageRef.put(blob, { contentType: 'image/jpeg' });
                photoUrls.push(await snapshot.ref.getDownloadURL());
            } catch (e) {
                console.error('Photo upload failed:', e);
                Swal.close();
                showToast('❌ Photo upload failed. Try again.', 'error');
                return;
            }
        }

        // ---- 4) Reserve the number only now, then write atomically ----
        const now = new Date();
        const istDateTime = getISTDateTime();

        for (let attempt = 0; attempt < 2 && !recordSaved; attempt++) {
            reservedId = await reserveOutsidePickupId();
            outsidePickupId = reservedId;
            const idEl = document.getElementById('outsidePickupIdDisplay');
            if (idEl) idEl.textContent = reservedId;

            const record = {
                pickupId: reservedId,
                status: 'pending',
                // Rider = logged-in user (same person as agent). Never hardcode.
                rider: currentUser.name || currentUser.username,
                agent: currentUser.username,
                agentName: currentUser.name || currentUser.username,
                phoneModel,
                imei,
                value,
                ram: opSelectedRam,
                storage: opSelectedStorage,
                ramStorage: opSelectedRam + '/' + opSelectedStorage,
                networkType: opSelectedNetwork,
                customerName: customerName || '',
                aadhaarNumber: aadhaarNumber || '',
                billNumber: billNumber || '',
                phoneImages: photoUrls,
                createdAt: Date.now(),
                timestamp: now.toISOString(),
                timestampIST: istDateTime,
                date: now.toLocaleDateString('en-IN'),
                inventoryCreated: false
            };

            // Atomic create: abort if this key already has a record (no overwrite,
            // so a repeated request can never create/edit a second entry).
            const write = await db.ref('outside_pickups/' + reservedId).transaction(current => {
                if (current !== null) return; // abort — ID already used
                return record;
            }, undefined, false);

            if (write.committed) {
                recordSaved = true;
            } else {
                // ID already occupied (counter desync). Do NOT roll the counter
                // back — that number genuinely belongs to the existing record.
                // Just take the next number.
                reservedId = '';
            }
        }

        if (!recordSaved) throw new Error('ID collision — could not save pickup');

        const pickupId = reservedId;
        Swal.close();

        // Success modal
        Swal.fire({
            icon: 'success',
            title: '✅ Submitted for Approval',
            html: `
                <div style="text-align:left;">
                    <div style="background:linear-gradient(135deg,#faf5ff,#f3e8ff);border:2px solid #d8b4fe;border-radius:12px;padding:14px;text-align:center;margin-bottom:12px;">
                        <div style="font-size:10px;font-weight:800;color:#7c3aed;letter-spacing:1.5px;">PICKUP ID</div>
                        <div style="font-family:monospace;font-size:16px;font-weight:800;color:#4c1d95;margin-top:4px;word-break:break-all;">${escapeHtmlOP(pickupId)}</div>
                    </div>
                    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:10px;padding:12px;font-size:12px;color:#92400e;text-align:center;">
                        <strong>⏳ Status: Pending Approval</strong><br>
                        <span style="font-size:11px;">Admin will verify and approve this pickup. WhatsApp message will be sent by admin after approval.</span>
                    </div>
                </div>`,
            confirmButtonText: 'OK',
            confirmButtonColor: '#7c3aed',
            width: 'min(420px, 96vw)'
        });

        // Reset state and close
        outsidePickupImages = [];
        outsidePickupId = '';
        opSelectedRam = ''; opSelectedStorage = ''; opSelectedNetwork = '';
        hiddenImei2 = '';

        // Return to pickup tab (without the discard confirmation)
        document.getElementById('outsidePickupPage').style.display = 'none';
        document.getElementById('mainTabBar').style.display = 'flex';
        switchTab('pickup');

    } catch (e) {
        console.error('Outside pickup submit error:', e);
        Swal.close();
        if (!recordSaved && reservedId) await releaseOutsidePickupCounter(reservedId);
        // Keep the on-screen number in sync with the real counter after a failure.
        try {
            outsidePickupId = await peekOutsidePickupId();
            const idEl = document.getElementById('outsidePickupIdDisplay');
            if (idEl) idEl.textContent = outsidePickupId;
        } catch (_) {}
        showToast('❌ Submit failed. Please try again.', 'error');
    } finally {
        if (claimHeld) await releaseOutsidePickupClaim(imei);
        opSubmitInFlight = false;
    }
}

// ================================================================
// === SECTION 21: INITIALIZATION (DOMContentLoaded) =============
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
    setupBackNavigation();

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
        loadPendingOrders();
        const today = getLocalDate();
        document.getElementById('attendanceDateDisplay').textContent = today;
        switchTab('pickup');
    }
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loginUser();
    });
    document.getElementById('loginUsername').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginPassword').focus();
    });
});