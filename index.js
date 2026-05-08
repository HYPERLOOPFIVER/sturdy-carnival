import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { initFirebase } from './services/firebase.js';
import { initGroq } from './services/groq.js';
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
                    input: { encoding: 'mulaw', sampleRate: 8000 },
                    output: { encoding: 'mulaw', sampleRate: 8000 }
                }
            }));
        });

        // 2. EXOTEL -> VAPI
        ws.on('message', (message, isBinary) => {
            if (isBinary) {
                // Pass raw audio directly
                if (vapiWs.readyState === WebSocket.OPEN) vapiWs.send(message);
                return;
            }
            
            try {
                const packet = JSON.parse(message.toString());
                if (packet.event === 'media' && vapiWs.readyState === WebSocket.OPEN) {
                    vapiWs.send(Buffer.from(packet.media.payload, 'base64'));
                }
            } catch (err) {
                // Optional text event handling
            }
        });

        // 3. VAPI -> EXOTEL
        vapiWs.on('message', (data, isBinary) => {
            if (isBinary) {
                // Pass binary audio directly to Exotel
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
                return;
            }

            try {
                const msg = JSON.parse(data.toString());
                console.log('[VAPI MESSAGE]', msg.type);
                
                // If Vapi sends audio as JSON (fallback)
                if (msg.type === 'audio' && ws.readyState === WebSocket.OPEN) {
                    ws.send(Buffer.from(msg.data, 'base64'));
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
