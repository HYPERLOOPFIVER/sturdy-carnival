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
  if (req.url.includes('/call/ws-bridge')) {
    console.log('[BRIDGE] Exotel connected');
    
    // Connect to Vapi securely
    const vapiWs = new WebSocket(`wss://api.vapi.ai/api/v1/stream?vapi_public_key=${process.env.VAPI_PUBLIC_KEY}&vapi_assistant_id=${process.env.VAPI_ASSISTANT_ID}`);

    vapiWs.on('open', () => console.log('[BRIDGE] Connected to Vapi'));
    
    // Pipe data: Exotel -> Vapi
    ws.on('message', (data) => {
      if (vapiWs.readyState === WebSocket.OPEN) vapiWs.send(data);
    });

    // Pipe data: Vapi -> Exotel
    vapiWs.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on('close', () => {
      console.log('[BRIDGE] Exotel disconnected');
      vapiWs.close();
    });

    vapiWs.on('close', () => ws.close());
    vapiWs.on('error', (err) => console.error('[BRIDGE] Vapi Error:', err));
  }
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
