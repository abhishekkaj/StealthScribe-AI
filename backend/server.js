import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// Init Supabase Service Role (bypasses RLS strictly for server updates after JWT check)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

wss.on('connection', async (ws, req) => {
    console.log('Client connected to WebSocket for audio stream.');

    // Extract token from URL (e.g., ws://localhost:8080/?token=JWT)
    const parameters = url.parse(req.url, true).query;
    const token = parameters.token;

    if (!token) {
        ws.close(4000, 'Missing authentication token');
        return;
    }

    // Authenticate user JWT before accepting audio
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
        ws.close(4001, 'Invalid authentication token');
        return;
    }

    // Retrieve the user's Freemium Time Pool
    const { data: userProfile, error: profileError } = await supabase
        .from('users')
        .select('subscription_tier, total_recorded_seconds')
        .eq('id', user.id)
        .single();

    if (profileError || !userProfile) {
        ws.close(4000, 'User profile not found');
        return;
    }

    const totalRecordedSeconds = userProfile.total_recorded_seconds || 0;
    const isFree = userProfile.subscription_tier === 'free';
    const MAX_FREE_SECONDS = 3600;

    // Immediately reject if they are free and out of time
    if (isFree && totalRecordedSeconds >= MAX_FREE_SECONDS) {
        ws.close(4001, 'Free Time Pool Exhausted');
        return;
    }

    // Calculate remaining limits (5 seconds per chunk)
    const remainingAllowedChunks = isFree ? Math.floor((MAX_FREE_SECONDS - totalRecordedSeconds) / 5) : Infinity;

    // Store state per client connection
    connections.set(ws, {
        userId: user.id,
        initialRecordedSeconds: totalRecordedSeconds,
        transcript: "",
        audioBuffer: Buffer.alloc(0),
        chunkCounter: 0,
        remainingChunks: remainingAllowedChunks,
        isFree: isFree,
        sessionSeconds: 0
    });

    ws.on('message', async (message) => {
        // We receive binary chunks (from offscreen WebM chunks)
        const state = connections.get(ws);
        if (!state) return;

        // Freemium chunk counter logic
        if (state.isFree) {
            state.chunkCounter++;
            state.sessionSeconds += 5;

            // Disconnect immediately when limit is reached
            if (state.chunkCounter >= state.remainingChunks) {
                console.log(`User ${state.userId} exhausted free time limit.`);
                ws.close(4001, 'Free Time Pool Exhausted');
                return;
            }
        }

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

    ws.on('close', async (code, reason) => {
        console.log(`Client disconnected with code ${code}. Reason: ${reason}`);

        const state = connections.get(ws);
        if (state) {
            // Update time pool in Supabase
            const newTotal = state.initialRecordedSeconds + state.sessionSeconds;
            await supabase
                .from('users')
                .update({ total_recorded_seconds: newTotal })
                .eq('id', state.userId);

            // Automatically trigger summary if a transcript was actively captured
            if (state.transcript.trim().length > 0) {
                await generateSummaryAndSave(state.transcript, state.userId, state.sessionSeconds);
            }

            connections.delete(ws);
        }
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

// Function to generate the Gemini Summary and save it securely via Supabase
async function generateSummaryAndSave(transcript, userId, duration) {
    try {
        console.log("Synthesizing summary through Google Gemini for DB save...");
        const prompt = `
        You are a highly capable AI assistant summarizing a business meeting.
        Analyze the following transcript and return a structured JSON response exactly matching this schema:
        { "summary": "A 2-3 sentence overview.", "action_items": ["Action 1"], "key_decisions": ["Decision 1"] }

        Transcript:
        ${transcript}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });

        const result = JSON.parse(response.text);

        // Save Meeting Results to Supabase Database
        const { error } = await supabase
            .from('meetings')
            .insert([{
                user_id: userId,
                transcript: transcript,
                summary: result,
                duration_seconds: duration
            }]);

        if (error) console.error("Error saving meeting to DB:", error);
    } catch (e) {
        console.error("Error generating/saving summary:", e);
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
