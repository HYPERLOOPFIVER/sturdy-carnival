import Groq from 'groq-sdk';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { getClinicByForwardedNumber } from './firebase.js';

let groq;
const sessions = new Map();

export function initGroq() {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log('✅ Groq initialized');
}

// ─── Session Management ───────────────────────────────────────
export const getSession = (id) => sessions.get(id);
export const setSession = (id, data) => sessions.set(id, data);

// ─── Speech-to-Text ──────────────────────────────────────────
export async function transcribeAudio(audioUrl) {
  try {
    const auth = Buffer.from(
      `${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`
    ).toString('base64');

    const audioResponse = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!audioResponse.ok) throw new Error(`Audio fetch failed: ${audioResponse.status}`);
    const audioBuffer = await audioResponse.buffer();

    const transcription = await groq.audio.transcriptions.create({
      file: audioBuffer,
      model: 'whisper-large-v3',
      response_format: 'text',
    });

    return typeof transcription === 'string' ? transcription : transcription.text;
  } catch (err) {
    console.error('Transcription error:', err.message);
    return null;
  }
}

// ─── Main AI Handler ──────────────────────────────────────────
export async function getAIResponse(audioUrl, session, callerNumber) {
  try {
    // 1. Transcribe audio
    const transcription = await transcribeAudio(audioUrl);
    if (!transcription) return "Sorry, I couldn't hear you. Can you repeat that?";
    console.log(`[USER]: ${transcription}`);

    // 2. Add to history
    session.messages.push({ role: 'user', content: transcription });

    // 3. Get clinic info (from session or database)
    let clinic = session.clinic;
    if (!clinic && session.clinicId) {
       // In a real app, you'd fetch the full clinic object here
       // For now, let's assume session already has enough info or we fetch it once
       // clinic = await getClinicById(session.clinicId); 
    }
    
    // Fallback if clinic data isn't in session yet
    const clinicContext = {
      clinicName: session.clinicName || "Zeyphra Health",
      doctorName: session.doctorName || "the Doctor",
      aiName: session.aiName || "Priya"
    };

    // 4. Generate AI response
    const aiText = await generateAIResponse(session.messages, clinicContext);
    session.messages.push({ role: 'assistant', content: aiText });

    return aiText;
  } catch (err) {
    console.error('AI Processing Error:', err);
    return "Ek minute please, technical issue.";
  }
}

// ─── Chat Completion ─────────────────────────────────────────
export async function generateAIResponse(conversationHistory, clinic) {
  try {
    const systemPrompt = buildSystemPrompt(clinic);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
      ],
      temperature: 0.6,
      max_tokens: 150,
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('AI response error:', err.message);
    return 'Ek minute please, kuch technical issue aa raha hai.';
  }
}

// ─── System Prompt Builder ────────────────────────────────────
function buildSystemPrompt(clinic) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const clinicName = clinic.clinicName || "Zeyphra Health";
  const doctorName = clinic.doctorName || "the Doctor";

  return `You are ${clinic.aiName || 'Priya'}, the AI receptionist for ${clinicName}.
Doctor is ${doctorName}.
Speak in Hinglish (mix of Hindi and English).
Keep responses under 2 sentences.
Be professional and warm.`;
}

// ─── Intent Detection ─────────────────────────────────────────
export async function detectIntent(text) {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `Classify the user's intent into one of: BOOK_APPOINTMENT, GENERAL_QUERY, GOODBYE. Reply with ONLY the label.`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 10,
      temperature: 0,
    });
    return res.choices[0].message.content.trim();
  } catch {
    return 'GENERAL_QUERY';
  }
}
