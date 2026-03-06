// Keeps track of whether we are currently recording.
let isRecording = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'trigger_record_toggle') {
    if (request.start) {
      handleStartRecording();
    } else {
      handleStopRecording();
    }
  }
});

async function handleStartRecording() {
  if (isRecording) return;

  // Retrieve JWT from Chrome Storage securely
  const { sb_session } = await chrome.storage.local.get('sb_session');
  if (!sb_session || !sb_session.access_token) {
    console.error("Missing valid JWT token. User must authenticate in popup.");
    return;
  }
  const token = sb_session.access_token;

  // Query the active tab to anchor the capture API
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (tabs.length === 0) return;
    const activeTab = tabs[0];

    // Ensure an offscreen document is ready to receive the audio stream.
    await setupOffscreenDocument();

    // Use chrome.tabCapture to grab a streamId for the active tab
    chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        console.error("Failed to get tab Media Stream ID:", chrome.runtime.lastError?.message || "No stream ID");
        return;
      }

      // Route the streamId and secure JWT token to the offscreen document
      chrome.runtime.sendMessage({
        action: 'start_recording',
        streamId: streamId,
        token: token
      });

      isRecording = true;
      // Synchronize UI state across extension
      chrome.storage.local.set({ isRecording: true });
      chrome.action.setBadgeText({ tabId: activeTab.id, text: "REC" });
      chrome.action.setBadgeBackgroundColor({ tabId: activeTab.id, color: "#FF0000" });
    });
  });
}

function handleStopRecording() {
  if (!isRecording) return;
  chrome.runtime.sendMessage({ action: 'stop_recording' });
  isRecording = false;
  chrome.storage.local.set({ isRecording: false });

  // Clean up tab badges
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => chrome.action.setBadgeText({ tabId: tab.id, text: "" }));
  });
}

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) return;

  // We explicitly declare USER_MEDIA to justify why the extension needs to record.
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Silently recording tab audio for automated analysis.'
    });
  } catch (error) {
    console.error('Failed to create offscreen document:', error);
  }
}
