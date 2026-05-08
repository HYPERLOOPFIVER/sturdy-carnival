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
wss.on('connection', (ws, req) => {
    console.log('[BRIDGE] Connection attempt detected...');
    
    // The absolute correct Vapi WebSocket URL
    const vapiWs = new WebSocket(`wss://api.vapi.ai/api/v1/stream?vapi_public_key=${process.env.VAPI_PUBLIC_KEY}`, {
        headers: { Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY || process.env.VAPI_PUBLIC_KEY}` }
    });

    vapiWs.on('open', () => {
        console.log('[BRIDGE] Connected to Vapi');
        vapiWs.send(JSON.stringify({
            type: 'start-conversation',
            assistantId: process.env.VAPI_ASSISTANT_ID
        }));
    });

    // Pipe data: Exotel -> Vapi
    ws.on('message', (data) => {
        if (vapiWs.readyState === WebSocket.OPEN) {
            vapiWs.send(JSON.stringify({
                type: 'add-audio',
                audio: data.toString('base64')
            }));
        }
    });

    // Pipe data: Vapi -> Exotel
    vapiWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'audio-output' && ws.readyState === WebSocket.OPEN) {
                ws.send(Buffer.from(msg.audio, 'base64'));
            }
        } catch (err) { /* Ignore non-JSON messages */ }
    });

    ws.on('close', () => {
        console.log('[BRIDGE] Exotel disconnected');
        vapiWs.close();
    });

    vapiWs.on('close', () => ws.close());
    vapiWs.on('error', (err) => console.error('[BRIDGE] Vapi Error:', err));
});

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Services
console.log('🔄 Starting service initialization...');
try {
    initFirebase();
    console.log('✅ Firebase Admin: Initialized successfully');
} catch (err) {
    console.error('❌ Firebase Admin: Initialization failed:', err.message);
}

try {
    initGroq();
    console.log('✅ Groq SDK: Initialized successfully');
} catch (err) {
    console.error('❌ Groq SDK: Initialization failed:', err.message);
}

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
