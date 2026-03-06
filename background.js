// Keeps track of whether we are currently recording.
let isRecording = false;

chrome.action.onClicked.addListener(async (tab) => {
  // If we're already recording, stop it natively.
  if (isRecording) {
    chrome.runtime.sendMessage({ action: 'stop_recording' });
    isRecording = false;
    chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    return;
  }

  // STEP 1: Ensure an offscreen document is ready to receive the audio stream.
  // Service Workers cannot access WebRTC APIs directly in MVP3, so an offscreen doc is needed.
  await setupOffscreenDocument();

  // STEP 2: Use chrome.tabCapture to grab a streamId for the active tab without bot participation.
  chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      console.error("Failed to get tab Media Stream ID:", chrome.runtime.lastError?.message || "No stream ID");
      return;
    }

    // STEP 3: Route the streamId to the offscreen document.
    // The offscreen doc will use this ID cleanly in getUserMedia.
    chrome.runtime.sendMessage({
      action: 'start_recording',
      streamId: streamId
    });

    isRecording = true;
    chrome.action.setBadgeText({ tabId: tab.id, text: "REC" });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#FF0000" });
  });
});

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
