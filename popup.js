// Ensure Supabase configuration aligns with your backend securely.
// In a true production Chrome Extension, you would not expose keys here directly; 
// but for MVP/V3 standards, Anon Keys with strictly enforced RLS are generally secure.
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key-here';

// Initialize Supabase Client globally so it can be utilized in the DOMContentLoaded scope.
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

document.addEventListener('DOMContentLoaded', async () => {
    // DOM Element Mapping 
    const authView = document.getElementById('auth-view');           // Unauthenticated login wrapper
    const dashboardView = document.getElementById('dashboard-view'); // Authenticated active workspace
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const recordBtn = document.getElementById('record-btn');
    const recordBtnText = document.getElementById('record-btn-text');
    const recordingDot = document.getElementById('recording-dot');
    const upgradeBtn = document.getElementById('upgrade-btn');
    const upgradeBtnText = document.getElementById('upgrade-btn-text');
    const userEmailDisplay = document.getElementById('user-email');
    const timeLeftDisplay = document.getElementById('time-left');
    // Using querySelector to target the progress bar by its class instead of ID
    const progressFill = document.querySelector('.progress-fill');

    // 1. Check and establish session on exact load
    await updateUI();

    // 2. Supabase Auth State Change Listener
    // Automatically invoked by Supabase when signInWithOAuth finishes tracking the auth hash on the redirect
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
            // Save the JWT context natively to chrome.storage
            await chrome.storage.local.set({ sb_session: session });
            await updateUI();
        }
        if (event === 'SIGNED_OUT') {
            await chrome.storage.local.remove('sb_session');
            await updateUI();
        }
    });

    // 3. Login Flow via Google OAuth
    loginBtn.addEventListener('click', async () => {
        // Critical: Guard against missing configurations
        if (SUPABASE_URL === 'https://your-project.supabase.co' || SUPABASE_ANON_KEY === 'your-anon-key-here') {
            alert("Development Setup Required: Please insert your actual SUPABASE_URL and SUPABASE_ANON_KEY at the very top of popup.js!");
            return;
        }

        loginBtn.disabled = true;
        const originalText = loginBtn.innerHTML;
        loginBtn.innerHTML = '<span>Opening secure login...</span>';

        const redirectUrl = chrome.identity.getRedirectURL(); // Auto-generates your extension's chromiumapp URL

        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: redirectUrl,
                skipBrowserRedirect: true // In Chrome Extensions, we MUST skip native redirects!
            }
        });

        if (error) {
            console.error("OAuth Provider Error:", error);
            loginBtn.innerHTML = originalText;
            loginBtn.disabled = false;
            return;
        }

        if (data?.url) {
            // Launch the native Chrome Identity popup for a secure OAuth flow
            chrome.identity.launchWebAuthFlow({
                url: data.url,
                interactive: true
            }, async (callbackUrl) => {
                loginBtn.innerHTML = originalText;
                loginBtn.disabled = false;

                if (chrome.runtime.lastError) {
                    console.error("Auth aborted or failed:", chrome.runtime.lastError);
                    return;
                }

                if (callbackUrl) {
                    // Extract Supabase JWT tokens from the returning redirect hash
                    const url = new URL(callbackUrl);
                    const hashParams = new URLSearchParams(url.hash.substring(1));
                    const accessToken = hashParams.get('access_token');
                    const refreshToken = hashParams.get('refresh_token');

                    if (accessToken && refreshToken) {
                        // Manually hydrate the Supabase Client session!
                        const { error: sessionError } = await supabase.auth.setSession({
                            access_token: accessToken,
                            refresh_token: refreshToken
                        });

                        if (sessionError) console.error("Session Set Error:", sessionError);
                        // Successful assignment triggers the global onAuthStateChange() listener above!
                    }
                }
            });
        }
    });

    // 4. Logout Session
    logoutBtn.addEventListener('click', async () => {
        await supabase.auth.signOut();
    });

    // 5. Upgrade Pro Button Logic via Stripe checkout route generated previously
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', async () => {
            const { sb_session } = await chrome.storage.local.get('sb_session');
            if (!sb_session) return;

            upgradeBtnText.innerText = "Loading checkout...";
            try {
                const response = await fetch('http://localhost:8080/create-ls-checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: sb_session.user.id,
                        email: sb_session.user.email
                    })
                });

                const data = await response.json();
                if (data.url) {
                    chrome.tabs.create({ url: data.url }); // Native chrome API to break out of popup view
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
    }

    // 6. Record Trigger (Token Relay Flow)
    recordBtn.addEventListener('click', async () => {
        const { isRecording } = await chrome.storage.local.get('isRecording');

        if (!isRecording) {
            // Initiate recording. Background.js will independently grab the local 'sb_session' and send it via Chrome.runtime message
            chrome.runtime.sendMessage({ action: 'trigger_record_toggle', start: true });
            setButtonRecordingState();
        } else {
            // Stop recording
            chrome.runtime.sendMessage({ action: 'trigger_record_toggle', start: false });
            resetButton();
        }
    });

    // ============================================
    // Core Display Functions
    // ============================================

    /**
     * Toggles the popup view between the auth login page and the active dashboard
     * utilizing CSS classes styling mapped structurally into the HTML
     */
    async function updateUI() {
        const { sb_session } = await chrome.storage.local.get('sb_session');

        // Unauthenticated State Handling
        if (!sb_session || !sb_session.user || !sb_session.access_token) {
            dashboardView.classList.remove('active');
            dashboardView.style.display = 'none';

            authView.classList.add('active');
            authView.style.display = 'block';
            return;
        }

        // Authenticated State Handling
        authView.classList.remove('active');
        authView.style.display = 'none';

        dashboardView.classList.add('active');
        dashboardView.style.display = 'block';

        // Populate Email
        if (userEmailDisplay) userEmailDisplay.innerText = sb_session.user.email;

        // Populate Remaining Pool Limit & Active Rec Button State
        await fetchUserTime(sb_session.user.id);
        syncButtonState();
    }

    /**
     * Reaches to Supabase to fetch exactly how much free time is remaining for this specific user UUID.
     * Computes the remaining limits and dynamically adjusts the progress bar width based on max capacity.
     */
    async function fetchUserTime(userId) {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('total_recorded_seconds')
                .eq('id', userId)
                .single();

            if (error) throw error;

            let totalSeconds = data ? data.total_recorded_seconds : 0;
            const MAX_SECONDS = 3600; // 60 minutes
            let secondsLeft = Math.max(0, MAX_SECONDS - totalSeconds);

            // Format to minutes (e.g. 45 / 60 min)
            let minsLeft = Math.floor(secondsLeft / 60);

            if (timeLeftDisplay) {
                timeLeftDisplay.innerText = `${minsLeft} / 60 min`;
            }

            // Calculate percentage used and set CSS width representation
            if (progressFill) {
                const percentUsed = Math.min(100, (totalSeconds / MAX_SECONDS) * 100);
                progressFill.style.width = `${percentUsed}%`;
            }
        } catch (e) {
            console.error("Failed to sync free time progress bar:", e);
        }
    }

    // Helper functions for updating specific DOM Nodes safely based on cached runtime status
    async function syncButtonState() {
        const { isRecording } = await chrome.storage.local.get('isRecording');
        if (isRecording) {
            setButtonRecordingState();
        } else {
            resetButton();
        }
    }

    function setButtonRecordingState() {
        if (recordBtnText) recordBtnText.innerText = 'Stop Recording';
        if (recordBtn) recordBtn.className = 'w-full bg-alert-red hover:opacity-90 text-cloud-white py-3.5 rounded-xl font-extrabold text-sm shadow-xl border border-alert-red transition-all duration-300 flex items-center justify-center space-x-2 relative group mt-2';
        if (recordingDot) recordingDot.classList.remove('hidden');
    }

    function resetButton() {
        if (recordBtnText) recordBtnText.innerText = 'Start Recording';
        if (recordBtn) recordBtn.className = 'w-full bg-cobalt-ai hover:opacity-90 text-cloud-white py-3.5 rounded-xl font-extrabold text-sm shadow-lg transition-all duration-300 flex items-center justify-center space-x-2 relative group mt-2 custom-glow';
        if (recordingDot) recordingDot.classList.add('hidden');
    }
});
