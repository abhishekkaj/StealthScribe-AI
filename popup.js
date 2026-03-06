// Note: You would sync these to your backend Supabase instance.
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key-here';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const unauthView = document.getElementById('unauth-view');
    const authView = document.getElementById('auth-view');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const recordBtn = document.getElementById('record-btn');
    const recordBtnText = document.getElementById('record-btn-text');
    const recordingDot = document.getElementById('recording-dot');
    const upgradeBtn = document.getElementById('upgrade-btn');
    const upgradeBtnText = document.getElementById('upgrade-btn-text');

    // Auth Check on load
    await checkAuth();

    // Login Event (OAuth flow)
    loginBtn.addEventListener('click', async () => {
        // In Chrome Extensions, OAuth flows are typically triggered via identity API explicitly,
        // or using Supabase's redirect to 'chrome.identity.getRedirectURL()'.
        const redirectUrl = chrome.identity ? chrome.identity.getRedirectURL() : window.location.origin;
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: redirectUrl
            }
        });
        if (error) console.error("Login Error:", error);
        // Supabase OAuth handles redirect, on return we check session locally.
    });

    // Supabase auth change listener
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
            await chrome.storage.local.set({ sb_session: session });
            await checkAuth();
        }
        if (event === 'SIGNED_OUT') {
            await chrome.storage.local.remove('sb_session');
            unauthView.classList.remove('hidden');
            authView.classList.add('hidden');
        }
    });

    // Verify session
    async function checkAuth() {
        // Retrieve local session state manually via storage
        const { sb_session } = await chrome.storage.local.get('sb_session');
        if (sb_session && sb_session.access_token) {
            unauthView.classList.add('hidden');
            authView.classList.remove('hidden');
            document.getElementById('user-email').innerText = sb_session.user.email;

            // Render progress logic
            await updateTimePool(sb_session.user.id);
            syncButtonState();
        } else {
            unauthView.classList.remove('hidden');
            authView.classList.add('hidden');
        }
    }

    async function updateTimePool(userId) {
        // Here we request the latest DB pool constraints via Supabase
        const { data, error } = await supabase
            .from('users')
            .select('total_recorded_seconds')
            .eq('id', userId)
            .single();

        let totalSeconds = data ? data.total_recorded_seconds : 0;
        let left = 3600 - totalSeconds;
        let minsLeft = Math.max(0, Math.floor(left / 60));

        document.getElementById('time-left-text').innerText = `${minsLeft}m left of 60m`;
        document.getElementById('time-progress').style.width = `${Math.min(100, (totalSeconds / 3600) * 100)}%`;
    }

    // Connect to Background to relay tokens & trigger recordings
    recordBtn.addEventListener('click', async () => {
        const { isRecording } = await chrome.storage.local.get('isRecording');

        if (!isRecording) {
            chrome.runtime.sendMessage({ action: 'trigger_record_toggle', start: true });

            // Optimistic UI Setting
            setButtonRecordingState();
        } else {
            chrome.runtime.sendMessage({ action: 'trigger_record_toggle', start: false });
            resetButton();
        }
    });

    logoutBtn.addEventListener('click', async () => {
        await supabase.auth.signOut();
    });

    // Checkout Session Trigger
    upgradeBtn.addEventListener('click', async () => {
        const { sb_session } = await chrome.storage.local.get('sb_session');
        if (!sb_session) return;

        upgradeBtnText.innerText = "Loading checkout...";

        try {
            const response = await fetch('http://localhost:8080/create-checkout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: sb_session.user.id,
                    email: sb_session.user.email
                })
            });

            const data = await response.json();

            if (data.url) {
                // Instantly open the secure Stripe checkout url safely inside the browser
                chrome.tabs.create({ url: data.url });
            } else {
                upgradeBtnText.innerText = "Checkout failed";
                setTimeout(() => { upgradeBtnText.innerText = "Upgrade to Pro"; }, 2000);
            }
        } catch (e) {
            console.error("Checkout error", e);
            upgradeBtnText.innerText = "Network error";
            setTimeout(() => { upgradeBtnText.innerText = "Upgrade to Pro"; }, 2000);
        }
    });

    // Visual helpers
    async function syncButtonState() {
        const { isRecording } = await chrome.storage.local.get('isRecording');
        if (isRecording) {
            setButtonRecordingState();
        } else {
            resetButton();
        }
    }

    function setButtonRecordingState() {
        recordBtnText.innerText = 'Stop Recording';
        recordBtn.className = 'w-full bg-red-600 hover:bg-red-500 text-white py-3.5 rounded-xl font-extrabold text-sm shadow-[0_0_15px_rgba(220,38,38,0.5)] transition-all duration-300 flex items-center justify-center space-x-2 relative group mt-2';
        recordingDot.classList.remove('hidden');
    }

    function resetButton() {
        recordBtnText.innerText = 'Start Recording';
        recordBtn.className = 'w-full bg-blue-600 hover:bg-blue-500 text-white py-3.5 rounded-xl font-extrabold text-sm shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all duration-300 flex items-center justify-center space-x-2 relative group mt-2';
        recordingDot.classList.add('hidden');
    }
});
