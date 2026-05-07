import express from 'express';
import { getClinicByForwardedNumber, getSession, setSession, logCall } from '../services/firebase.js';
import { transcribeAudio, generateAIResponse, detectIntent } from '../services/groq.js';
import { generateSpeechUrl } from '../services/tts.js';
import xml2js from 'xml2js';

const router = express.Router();
const builder = new xml2js.Builder({ rootName: 'Response', headless: true });

// Exotel webhook when a call comes in
router.post('/incoming', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { CallSid, From, To, ForwardedFrom } = req.body;
    
    console.log(`[CALL INCOMING] From: ${From}, To: ${To}, Forwarded: ${ForwardedFrom}`);
    
    // Fallback if ForwardedFrom is missing but we know the To number
    const lookupNumber = ForwardedFrom || To;
    
    const clinic = await getClinicByForwardedNumber(lookupNumber);
    
    if (!clinic) {
      console.log(`Unregistered number: ${lookupNumber}`);
      return sendExoML(res, [
        { Say: "Sorry, this number is not registered. Please check the number and try again." },
        { Hangup: "" }
      ]);
    }

    // Initialize conversation history
    const initialHistory = [];
    setSession(CallSid, { clinic, history: initialHistory, caller: From });

    // Initial greeting
    const greeting = `Hello! Welcome to ${clinic.clinicName}. I am ${clinic.aiName || 'your virtual assistant'}. How can I help you today?`;
    
    // Log call start
    await logCall(clinic.id, {
      callSid: CallSid,
      caller: From,
      startTime: new Date().toISOString(),
      status: 'started'
    });

    return sendGather(res, greeting, clinic);
    
  } catch (err) {
    console.error('Incoming call error:', err);
    res.status(500).send('Error');
  }
});

// Exotel webhook when user speaks (Record/Gather completes)
router.post('/gather', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { CallSid, RecordingUrl } = req.body;
    
    const session = getSession(CallSid);
    if (!session) {
      // Session lost, gracefully hangup or restart
      return sendExoML(res, [{ Say: "Sorry, the session expired." }, { Hangup: "" }]);
    }
    
    const { clinic, history, caller } = session;

    if (!RecordingUrl) {
       // If no audio was recorded
       return sendGather(res, "I'm sorry, I didn't catch that. Could you please repeat?", clinic);
    }

    // 1. STT (Whisper)
    const userText = await transcribeAudio(RecordingUrl);
    console.log(`[USER] ${userText}`);
    
    if (!userText || userText.length < 2) {
       return sendGather(res, "I couldn't hear you clearly. Could you say that again?", clinic);
    }

    // Add user message to history
    history.push({ role: 'user', content: userText });

    // 2. Check Intent (optional early exit for specific tasks)
    const intent = await detectIntent(userText);
    
    if (intent === 'TRANSFER_TO_DOCTOR' && clinic.doctorMobile) {
      const responseText = "Okay, transferring your call to the doctor now. Please wait.";
      return sendExoML(res, [
        { Say: responseText },
        { Dial: clinic.doctorMobile } // Blind transfer
      ]);
    }

    // 3. Generate AI Response (LLaMA)
    const aiResponseText = await generateAIResponse(history, clinic);
    console.log(`[AI] ${aiResponseText}`);
    
    // Add AI message to history
    history.push({ role: 'assistant', content: aiResponseText });
    
    // Update session
    setSession(CallSid, session);

    // Check if the AI ended the conversation or if it was a goodbye
    if (intent === 'GOODBYE' || aiResponseText.toLowerCase().includes('goodbye')) {
        return sendExoML(res, [
            { Say: aiResponseText },
            { Hangup: "" }
        ]);
    }

    // 4. Send back to Exotel to play and record next input
    return sendGather(res, aiResponseText, clinic);

  } catch (err) {
    console.error('Gather error:', err);
    return sendExoML(res, [
      { Say: "Sorry, there was a technical error." },
      { Hangup: "" }
    ]);
  }
});

// Helper to send Exotel ML (XML) for gathering input
async function sendGather(res, text, clinic) {
  // Option A: Use Exotel's built-in TTS (Say)
  // Option B: Generate custom TTS and use <Play> (Better voice quality)
  
  // Using custom TTS (Sarvam/ElevenLabs) if available, fallback to Say
  let promptNode;
  
  if (process.env.USE_CUSTOM_TTS === 'true') {
      const audioUrl = await generateSpeechUrl(text, clinic.aiLanguage);
      promptNode = { Play: audioUrl };
  } else {
      promptNode = { Say: text };
  }

  const exoml = [
    promptNode,
    {
      Record: {
        $: {
          action: `${process.env.BACKEND_URL}/call/gather`,
          maxLength: 15,
          playBeep: false
        }
      }
    }
  ];
  
  return sendExoML(res, exoml);
}

function sendExoML(res, instructions) {
  const xml = builder.buildObject(instructions);
  res.header('Content-Type', 'text/xml');
  res.send(xml);
}

export default router;
