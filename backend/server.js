import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Ensure temp directory exists for writing chunked Blobs
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// API Clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Middleware
app.use(express.json());

// Maintain transcript per connection (simplified for a single instance)
const connections = new Map();

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket for audio stream.');

    // Store state per client connection
    connections.set(ws, {
        transcript: "",
        audioBuffer: Buffer.alloc(0), // Build chunked Audio Blob bytes here
        chunkCounter: 0
    });

    ws.on('message', async (message) => {
        // We receive binary chunks (from offscreen WebM chunks)
        const state = connections.get(ws);
        if (!state) return;

        try {
            // Append incoming buffer bytes to the running pool
            state.audioBuffer = Buffer.concat([state.audioBuffer, message]);

            // Assuming audio chunks are ~5s, process them every ~30 seconds of audio.
            // A simple implementation writes buffer sizes over roughly ~500kb-1MB blocks.
            // For stability, we transcribe when our buffer hits ~1MB
            if (state.audioBuffer.length > 1024 * 1024) {
                console.log(`Processing an audio block of size ${state.audioBuffer.length} bytes...`);
                // Offload to Whisper API
                const chunkId = Date.now();
                const tempFilePath = path.join(tempDir, `chunk_${chunkId}.webm`);

                // Save the current chunk block to disk explicitly for Whisper's 'File' requirement.
                fs.writeFileSync(tempFilePath, state.audioBuffer);

                // Reset the active stream buffer immediately
                state.audioBuffer = Buffer.alloc(0);

                const transcriptText = await processWithWhisper(tempFilePath);
                if (transcriptText) {
                    state.transcript += " " + transcriptText;
                    console.log("[Whisper Chunk Result]:", transcriptText);
                }
            }
        } catch (error) {
            console.error("Error processing stream message:", error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        connections.delete(ws);
    });
});

async function processWithWhisper(filePath) {
    try {
        const fileStream = fs.createReadStream(filePath);
        // Uses the official Whisper-1 module to decode the WebM payload synchronously.
        const response = await openai.audio.transcriptions.create({
            file: fileStream,
            model: "whisper-1",
            response_format: "text"
        });

        // Cleanup temp
        fs.unlinkSync(filePath);
        return response;

    } catch (error) {
        console.error("Whisper API Error:", error.message || error);
        // Ensure cleanup if network request dies halfway
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return null;
    }
}

// REST route to trigger Meeting End Summarization.
// In practice, this could be triggered via API call or a specific WS message.
app.post('/api/summarize', async (req, res) => {
    const { transcript } = req.body; // or fetch from Map via ID/tokens

    if (!transcript || transcript.trim().length === 0) {
        return res.status(400).json({ error: "Empty or invalid transcript." });
    }

    try {
        console.log("Synthesizing summary through Google Gemini...");
        const prompt = `
        You are a highly capable AI assistant summarizing a business meeting.
        Analyze the following transcript and return a structured JSON response exactly matching this schema:
        {
          "summary": "A 2-3 sentence overview of the meeting.",
          "action_items": ["Action 1", "Action 2"],
          "key_decisions": ["Decision 1", "Decision 2"]
        }

        Transcript:
        ${transcript}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
            }
        });

        const rawText = response.text;
        const result = JSON.parse(rawText);

        res.json(result);

    } catch (error) {
        console.error("Gemini API Error:", error.message || error);
        res.status(500).json({ error: "Failed to generate summary.", details: error.message });
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Backend Server listening on port ${PORT}...`);
});
