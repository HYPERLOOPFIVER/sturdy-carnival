import express from 'express';
import xml2js from 'xml2js';
import { getClinicByForwardedNumber, getClinicByPin, logCall } from '../services/firebase.js';
import { getAIResponse, setSession, getSession } from '../services/groq.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const builder = new xml2js.Builder({ rootName: 'Response', headless: true });

// Middleware to handle both JSON and Form-Encoded data
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// VOICEBOT ROUTE: For Exotel's "Voicebot" Applet (Real-time AI)
router.all('/voicebot', async (req, res) => {
  try {
    const data = { ...req.query, ...req.body };
    
    if (data.message && data.message.type === 'assistant-request') {
      const callerNumber = data.message.call.customer.number;
      console.log(`[VAPI] Request for: ${callerNumber}`);
      
      let clinic = await getClinicByForwardedNumber(callerNumber);
      const clinicName = clinic ? clinic.clinicName : "Zeyphra Health";
      
      return res.json({
        assistant: {
          model: {
            messages: [{ role: "system", content: `You are Priya for ${clinicName}. Speak Hinglish.` }]
          }
        }
      });
    }

    const callerNumber = data.From || data.CallFrom;
    console.log(`[EXOTEL] Success! Fetching WSS for: ${callerNumber}`);

    const fullUrl = `wss://api.vapi.ai/api/v1/stream?vapi_public_key=${process.env.VAPI_PUBLIC_KEY}&vapi_assistant_id=${process.env.VAPI_ASSISTANT_ID}`;

    return res.json({
      url: fullUrl,
      websocket_url: fullUrl,
      wss_url: fullUrl,
      config: {
        vapi_public_key: process.env.VAPI_PUBLIC_KEY,
        vapi_assistant_id: process.env.VAPI_ASSISTANT_ID
      },
      params: {
        vapi_public_key: process.env.VAPI_PUBLIC_KEY,
        vapi_assistant_id: process.env.VAPI_ASSISTANT_ID
      }
    });
  } catch (err) {
    console.error('Voicebot error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// MAIN INCOMING ROUTE: For Exotel's "Passthru" or "Connect" Applets
router.all('/incoming', async (req, res) => {
  try {
    const data = { ...req.query, ...req.body };
    const { CallSid, From, To, CallFrom, CallTo, ForwardedFrom, Digits } = data;

    const callerNumber = From || CallFrom;
    const dialedNumber = To || CallTo;

    console.log('[DEBUG] Incoming Call:', { callerNumber, dialedNumber, ForwardedFrom });

    let clinic = null;
    if (ForwardedFrom) {
      console.log(`[DEBUG] Searching by ForwardedFrom: ${ForwardedFrom}`);
      clinic = await getClinicByForwardedNumber(ForwardedFrom);
    }
    
    if (!clinic && dialedNumber) {
      const normalized = dialedNumber.replace(/\D/g, '').slice(-10);
      console.log(`[DEBUG] Searching by DialedNumber: ${normalized}`);
      clinic = await getClinicByForwardedNumber(dialedNumber);
    }

    if (!clinic) {
      console.log(`[ERROR] Clinic not found for number ${dialedNumber}`);
      return sendExoML(res, {
        Say: "Welcome to Zeyphra Health. We couldn't identify the clinic. Please register your number."
      });
    }

    console.log(`[SUCCESS] Clinic Identified: ${clinic.clinicName}`);
    
    // Store clinic info in session so AI remembers it
    const session = { 
      messages: [], 
      clinicId: clinic.id, 
      clinicName: clinic.clinicName,
      doctorName: clinic.doctorName 
    };
    setSession(CallSid, session);

    const greeting = `Hello! Welcome to ${clinic.clinicName}. I am Priya, your AI assistant. How can I help you today?`;

    // Non-blocking log
    logCall(CallSid, {
      clinicId: clinic.id,
      callerNumber,
      status: 'started'
    }).catch(err => console.error('[ERROR] logCall failed:', err.message));

    return sendGather(res, greeting, clinic);
    
  } catch (err) {
    console.error('Incoming call error:', err);
    return sendExoML(res, { Say: "Sorry, a technical error occurred." });
  }
});

// GATHER ROUTE: Handles AI conversation
router.all('/gather', async (req, res) => {
  try {
    const data = { ...req.query, ...req.body };
    const { CallSid, RecordingUrl, From, CallFrom } = data;
    const callerNumber = From || CallFrom;

    console.log(`[DEBUG] Gather Event. Caller: ${callerNumber}`);

    let session = getSession(CallSid) || { messages: [] };
    const aiResponseText = await getAIResponse(RecordingUrl, session, callerNumber);
    
    setSession(CallSid, session);

    return sendGather(res, aiResponseText);
  } catch (err) {
    console.error('Gather error:', err);
    return sendExoML(res, { Say: "Ek minute please, kuch technical issue aa raha hai." });
  }
});

function sendGather(res, text, clinic = null) {
  const baseUrl = process.env.BACKEND_URL.replace(/\/$/, '');
  
  const exoml = {
    Say: {
      $: { voice: 'Polly.Aditi' },
      _: text
    },
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
  
  if (instructions.Say) {
    if (typeof instructions.Say === 'object') {
      const voice = instructions.Say.$.voice;
      const text = instructions.Say._;
      xml += `  <Say voice="${voice}">${text}</Say>\n`;
    } else {
      xml += `  <Say>${instructions.Say}</Say>\n`;
    }
  }
  
  if (instructions.Play) xml += `  <Play>${instructions.Play}</Play>\n`;
  if (instructions.Dial) xml += `  <Dial>${instructions.Dial}</Dial>\n`;
  if (instructions.Hangup !== undefined) xml += `  <Hangup></Hangup>\n`;
  
  if (instructions.Record) {
    const { action, maxLength, playBeep } = instructions.Record.$;
    xml += `  <Record action="${action}" maxLength="${maxLength}" playBeep="${playBeep}"></Record>\n`;
  }
  
  xml += '</Response>';
  
  console.log('[DEBUG] Sending ExoML:\n', xml);
  res.set('Content-Type', 'application/xml');
  return res.status(200).send(xml);
}

export default router;
