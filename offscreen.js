let mediaRecorder;
let recordedChunks = [];
let ws; // WebSocket connection for real-time processing

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'start_recording') {
        // Ideally pass a Supabase JWT token here from background script
        const token = message.token || 'insert_jwt_token_here';
        connectWebSocket(token);
        startRecording(message.streamId);
    } else if (message.action === 'stop_recording') {
        stopRecording();
    }
});

function connectWebSocket(token) {
    ws = new WebSocket(`ws://localhost:8080/?token=${token}`);

    ws.onclose = (event) => {
        // Handle 4001 closure code securely defined from backend
        if (event.code === 4001) {
            console.log("Free time exhausted connection closure.");
            stopRecording();

            // Triggering native Chrome Notification immediately
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon.png', // Replace with valid extension icon path
                title: 'Time Limit Reached',
                message: '1-hour free time pool exhausted. Notes are generating. Upgrade for unlimited time!'
            });
        }
    };

    ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

async function startRecording(streamId) {
    try {
        // We use the streamId provided by the background script to request the tab's audio stream.
        // The "chromeMediaSourceId" strictly routes the active tab audio payload into userMedia.
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });

        // Create a MediaRecorder to capture the audio softly without blocking the main browser UI thread
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        // The start(ms) dictates how often the `ondataavailable` triggers. 
        // Small chunks enable real-time/lightweight processing without crushing the browser memory.
        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                await handleAudioChunk(event.data);
            }
        };

        // Error handling covering glitches like microphone dropout out or tab suspending
        mediaRecorder.onerror = (error) => {
            console.error('MediaRecorder glitch/error occurred:', error);
            stopRecording();
        };

        mediaRecorder.onstop = () => {
            console.log(`Recording ended gracefully. Total chunks: ${recordedChunks.length}`);
            // Clean up WebRTC tracks reliably.
            stream.getTracks().forEach(track => track.stop());
            recordedChunks = [];
        };

        // Instruct the stream tracks themselves to stop if something externally kills the tab layer
        stream.getVideoTracks().forEach(track => track.onended = stopRecording);
        stream.getAudioTracks().forEach(track => track.onended = stopRecording);

        // Fire capture chunks every 5000ms (5 seconds) continuously 
        mediaRecorder.start(5000);

    } catch (error) {
        console.error('Failed to capture audio via getUserMedia:', error);
    }
}

async function handleAudioChunk(blob) {
    console.log(`Intercepted chunk of size: ${blob.size} bytes. Ready to stream...`);

    // Stream chunks live to backend through WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(blob);
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}
