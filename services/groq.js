import Groq from 'groq-sdk';
import fetch from 'node-fetch';
import FormData from 'form-data';

let groq;

export function initGroq() {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log('✅ Groq initialized');
}

// ─── Speech-to-Text ──────────────────────────────────────────
export async function transcribeAudio(audioUrl) {
  try {
    // Download audio from Exotel (needs basic auth)
    const auth = Buffer.from(
      `${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`
    ).toString('base64');

    const audioResponse = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!audioResponse.ok) throw new Error(`Audio fetch failed: ${audioResponse.status}`);
    const audioBuffer = await audioResponse.buffer();

    // Send to Groq Whisper via multipart form
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');
    form.append('language', 'hi'); // Hindi + English mixed works great

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
      max_tokens: 150, // Short for voice — 2-3 sentences max
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
  const days = clinic.workingDays?.join(', ') || 'Monday to Saturday';
  const commands = (clinic.commands || [])
    .map(c => `- If asked about "${c.trigger}": ${c.response}`)
    .join('\n');

  return `You are ${clinic.aiName || 'Priya'}, the AI receptionist for ${clinic.clinicName}.

CLINIC INFO:
- Doctor: ${clinic.doctorName} (${clinic.qualification || ''})
- Specialty: ${clinic.specialty || 'General Physician'}
- Address: ${clinic.address}, ${clinic.city}
- Working Days: ${days}
- Hours: ${clinic.openTime || '10:00'} to ${clinic.closeTime || '20:00'}
${clinic.hasLunchBreak ? `- Lunch Break: ${clinic.lunchStart} to ${clinic.lunchEnd}` : ''}
- Consultation Fee: ₹${clinic.consultationFee || 'N/A'}
- Languages: ${(clinic.languages || ['Hindi', 'English']).join(', ')}
- Services: ${(clinic.services || []).join(', ')}
${clinic.insuranceAccepted ? `- Insurance: ${clinic.insuranceAccepted}` : ''}

CUSTOM KNOWLEDGE BASE:
${commands || '(none)'}

CURRENT TIME: ${now}

INSTRUCTIONS:
- Speak in ${clinic.aiLanguage || 'Hinglish'} (natural mix of Hindi & English)
- Keep ALL responses under 2-3 short sentences — this is a phone call
- To book appointment: collect patient name → preferred date → preferred time → confirm
- If clinic is currently closed, acknowledge and offer next available slot
- If patient insists on speaking to doctor, say you'll transfer
- Be warm, professional, and efficient
- Never reveal you are an AI unless directly asked
- When booking is confirmed, say "Appointment confirm ho gaya" and give details
- Output ONLY the spoken response, no extra formatting`;
}

// ─── Intent Detection ─────────────────────────────────────────
export async function detectIntent(text) {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant', // Fast model for intent
      messages: [
        {
          role: 'system',
          content: `Classify the user's intent into one of: BOOK_APPOINTMENT, CANCEL_APPOINTMENT, ASK_TIMINGS, ASK_FEE, ASK_LOCATION, ASK_DOCTOR, TRANSFER_TO_DOCTOR, GENERAL_QUERY, GOODBYE. Reply with ONLY the intent label.`,
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
