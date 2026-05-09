import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { initFirebase } from './services/firebase.js';
import { initGroq } from './services/groq.js';
import { mulaw } from 'alawmulaw';
import callRoutes from './routes/call.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket Bridge: Exotel <-> Railway <-> Vapi
wss.on('connection', async (ws, req) => {
    console.log('[BRIDGE] Connection attempt detected...');
    
    try {
        const vapiKey = process.env.VAPI_PRIVATE_KEY || process.env.VAPI_PUBLIC_KEY;
        const assistantId = process.env.VAPI_ASSISTANT_ID;

        // 1. CREATE VAPI CALL
        console.log('[BRIDGE] Creating Vapi call...');
        const response = await fetch('https://api.vapi.ai/call', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${vapiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                assistantId: assistantId,
                transport: { provider: 'vapi.websocket' }
            })
        });

        const callData = await response.json();
        const websocketUrl = callData.transport?.websocketCallUrl;
        
        if (!websocketUrl) {
            console.error('[BRIDGE] Vapi failed to provide WebSocket URL:', callData);
            ws.close();
            return;
        }

        console.log(`[BRIDGE] Connecting to Vapi: ${websocketUrl}`);
        const vapiWs = new WebSocket(websocketUrl);

        vapiWs.on('open', () => {
            console.log('[BRIDGE] Connected to Vapi');
            vapiWs.send(JSON.stringify({
                type: 'start',
                assistantId: assistantId,
                audio: {
                    input: { encoding: 'linear16', sampleRate: 8000 },
                    output: { encoding: 'linear16', sampleRate: 8000 }
                }
            }));
        });

        // 2. EXOTEL -> VAPI
        let streamSid = null;
        let audioChunkCount = 0;

        ws.on('message', (message) => {
            try {
                const packet = JSON.parse(message.toString());
                
                if (packet.event === 'start') {
                    console.log('[EXOTEL START PACKET]', JSON.stringify(packet, null, 2));
                    streamSid = packet.start?.streamSid || packet.stream_sid || packet.start?.stream_sid;
                    console.log(`[EXOTEL] Identified StreamSid: ${streamSid}`);
                }
                
                if (packet.event === 'media' && vapiWs.readyState === WebSocket.OPEN) {
                    if (audioChunkCount % 50 === 0) console.log('[EXOTEL] Caller audio received');
                    vapiWs.send(JSON.stringify({
                        type: 'audio',
                        data: packet.media.payload
                    }));
                }

                if (packet.event === 'stop') {
                    console.log('[EXOTEL] Stream stopped');
                    if (vapiWs.readyState === WebSocket.OPEN) vapiWs.close();
                }
            } catch (err) {}
        });

        // 3. VAPI -> EXOTEL (WITH STREAMSID)
        vapiWs.on('message', (data, isBinary) => {
            // 1. Binary audio frame from Vapi
            if (isBinary) {
                audioChunkCount++;
                
                if (!streamSid) {
                    if (audioChunkCount % 50 === 0) console.log('[EXOTEL] No streamSid yet');
                    return;
                }

                // Convert 16-bit PCM (from Vapi) to Int16Array
                const pcm = new Int16Array(
                    data.buffer,
                    data.byteOffset,
                    data.length / 2
                );

                // Encode to μ-law (required by Exotel)
                const ulawPayload = Buffer.from(mulaw.encode(pcm)).toString('base64');

                ws.send(JSON.stringify({
                    event: 'media',
                    stream_sid: streamSid,
                    media: {
                        payload: ulawPayload
                    }
                }));

                if (audioChunkCount % 50 === 0) {
                    console.log(`[AUDIO] ${audioChunkCount} chunks transcoded and forwarded`);
                }

                return;
            }

            // 2. JSON control messages
            try {
                const msg = JSON.parse(data.toString());

                console.log('[VAPI MESSAGE]', msg.type);

                if (msg.type === 'hangup') {
                    console.log('[VAPI] Hangup');
                    ws.close();
                }
            } catch (err) {
                console.error('[VAPI JSON ERROR]', err.message);
            }
        });

        ws.on('close', () => {
            console.log('[BRIDGE] Exotel disconnected');
            if (vapiWs.readyState === WebSocket.OPEN) vapiWs.close();
        });

        vapiWs.on('close', () => {
            console.log('[BRIDGE] Vapi disconnected');
            ws.close();
        });

        vapiWs.on('error', (err) => console.error('[BRIDGE] Vapi Error:', err));

    } catch (err) {
        console.error('[BRIDGE] Error:', err.message);
        ws.close();
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Services
try { initFirebase(); } catch (err) {}
try { initGroq(); } catch (err) {}

// Routes
app.use('/call', callRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Zeyphra Call AI Backend running on port ${PORT}`);
});

export default app;
