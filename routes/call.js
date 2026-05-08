import express from 'express';
import { getClinicByForwardedNumber, getClinicByPin, getSession, setSession, logCall } from '../services/firebase.js';
import { transcribeAudio, generateAIResponse, detectIntent } from '../services/groq.js';
import { generateSpeechUrl } from '../services/tts.js';
import xml2js from 'xml2js';

const router = express.Router();
const builder = new xml2js.Builder({ rootName: 'Response', headless: true });

// Exotel webhook when a call comes in (Supports both GET and POST)
router.all('/incoming', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // Exotel can send data in Body (POST) or Query (URL/GET)
    const data = { ...req.query, ...req.body };
    const { CallSid, From, To, ForwardedFrom, CallTo, CallFrom, Digits } = data;
    
    // Normalize parameter names (Exotel uses both From/CallFrom)
    const callerNumber = From || CallFrom;
    const dialedNumber = To || CallTo;

    console.log('[DEBUG] Incoming Call:', { callerNumber, dialedNumber, ForwardedFrom, Digits });
    
    let clinic = null;

    // 1. PRIMARY: Look for the doctor's number in 'ForwardedFrom'
    if (ForwardedFrom) {
      const normalized = ForwardedFrom.replace(/\D/g, '').slice(-10);
      console.log(`[DEBUG] Searching Firestore for ForwardedFrom (Normalized): ${normalized}`);
      clinic = await getClinicByForwardedNumber(ForwardedFrom);
    }

    // 2. SECONDARY: Look for the doctor's number in 'dialedNumber' (if it's a direct VN)
    if (!clinic && dialedNumber) {
      const normalized = dialedNumber.replace(/\D/g, '').slice(-10);
      console.log(`[DEBUG] Searching Firestore for DialedNumber (Normalized): ${normalized}`);
      clinic = await getClinicByForwardedNumber(dialedNumber);
    }

    // 3. TERTIARY: Look for caller in case it's a known number
    if (!clinic && callerNumber) {
      clinic = await getClinicByForwardedNumber(callerNumber);
    }

    // 4. QUATERNARY: Fallback to PIN
    if (!clinic && Digits) {
      clinic = await getClinicByPin(Digits);
    }
    
    if (!clinic) {
      console.log(`[ERROR] Clinic not found for number ${dialedNumber} or caller ${callerNumber}`);
      return sendExoML(res, {
        Say: "Welcome to Zeyphra Health. We couldn't identify the clinic for this call. Please ensure your number is registered.",
        Hangup: ""
      });
    }

    console.log(`[SUCCESS] Clinic Identified: ${clinic.clinicName} (ID: ${clinic.id})`);

    // Initialize conversation history
    const initialHistory = [];
    setSession(CallSid, { clinic, history: initialHistory, caller: callerNumber });

    // Initial greeting
    const greeting = `Hello! Welcome to ${clinic.clinicName}. I am ${clinic.aiName || 'your virtual assistant'}. How can I help you today?`;
    console.log(`[DEBUG] Sending Greeting: ${greeting}`);
    
    // Log call start (Non-blocking to speed up response)
    logCall(clinic.id, {
      callSid: CallSid,
      caller: callerNumber,
      startTime: new Date().toISOString(),
      status: 'started'
    }).catch(err => console.error('[ERROR] logCall failed:', err.message));

    console.log('[DEBUG] Returning TEST ExoML response (Say Only)');
    return sendExoML(res, { Say: greeting });
    
  } catch (err) {
    console.error('Incoming call error:', err);
    res.status(500).send('Error');
  }
});

// Exotel webhook when user speaks (Record/Gather completes)
router.all('/gather', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = { ...req.query, ...req.body };
    const { CallSid, RecordingUrl } = data;
    
    const session = getSession(CallSid);
    if (!session) {
      return sendExoML(res, [{ Say: "Sorry, the session expired." }, { Hangup: "" }]);
    }
    
    const { clinic, history, caller } = session;

    if (!RecordingUrl) {
       return sendGather(res, "I'm sorry, I didn't catch that. Could you please repeat?", clinic);
    }

    // 1. STT (Whisper)
    const userText = await transcribeAudio(RecordingUrl);
    console.log(`[USER] ${userText}`);
    
    if (!userText || userText.length < 2) {
       return sendGather(res, "I couldn't hear you clearly. Could you say that again?", clinic);
    }

    history.push({ role: 'user', content: userText });

    // 2. Check Intent
    const intent = await detectIntent(userText);
    
    if (intent === 'TRANSFER_TO_DOCTOR' && clinic.doctorMobile) {
      const responseText = "Okay, transferring your call to the doctor now. Please wait.";
      return sendExoML(res, {
        Say: responseText,
        Dial: clinic.doctorMobile
      });
    }

    // 3. Generate AI Response
    const aiResponseText = await generateAIResponse(history, clinic);
    console.log(`[AI] ${aiResponseText}`);
    
    history.push({ role: 'assistant', content: aiResponseText });
    setSession(CallSid, session);

    if (intent === 'GOODBYE' || aiResponseText.toLowerCase().includes('goodbye')) {
        return sendExoML(res, {
            Say: aiResponseText,
            Hangup: ""
        });
    }

    return sendGather(res, aiResponseText, clinic);

  } catch (err) {
    console.error('Gather error:', err);
    return sendExoML(res, {
      Say: "Ek minute please, kuch technical issue aa raha hai.",
      Hangup: ""
    });
  }
});

// Helper to send Exotel ML (XML) for gathering input
async function sendGather(res, text, clinic) {
  let promptNode;
  
  if (process.env.USE_CUSTOM_TTS === 'true') {
    try {
      const audioUrl = await generateSpeechUrl(text, clinic.aiLanguage);
      promptNode = { Play: audioUrl };
    } catch (err) {
      promptNode = { Say: text };
    }
  } else {
      promptNode = { Say: text };
  }

  const baseUrl = process.env.BACKEND_URL.replace(/\/$/, '');
  
  // Exotel expects a clean object structure for XML
  const exoml = {
    ...promptNode,
    Record: {
      $: {
        action: `${baseUrl}/call/gather`,
        maxLength: 15,
        playBeep: true
      }
    }
  };
  
  return sendExoML(res, exoml);
}

function sendExoML(res, instructions) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Response>\n';
  
  if (instructions.Say) xml += `  <Say>${instructions.Say}</Say>\n`;
  if (instructions.Play) xml += `  <Play>${instructions.Play}</Play>\n`;
  if (instructions.Dial) xml += `  <Dial>${instructions.Dial}</Dial>\n`;
  if (instructions.Hangup !== undefined) xml += `  <Hangup></Hangup>\n`;
  
  if (instructions.Record) {
    const { action, maxLength, playBeep } = instructions.Record.$;
    xml += `  <Record action="${action}" maxLength="${maxLength}" playBeep="${playBeep}"></Record>\n`;
  }
  
  xml += '</Response>';
  
  console.log('[DEBUG] Sending Final ExoML:\n', xml);
  res.set('Content-Type', 'application/xml');
  return res.status(200).send(xml);
}

export default router;
