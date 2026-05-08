import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initFirebase } from './services/firebase.js';
import { initGroq } from './services/groq.js';
import callRoutes from './routes/call.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json()); // For standard JSON payloads
// Note: callRoutes uses express.urlencoded internally because Exotel sends x-www-form-urlencoded

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

// Start server (Only for local dev/Railway, not for Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Zeyphra Call AI Backend running on port ${PORT}`);
  });
}

// Export for Vercel
export default app;
