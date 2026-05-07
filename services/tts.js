import fetch from 'node-fetch';
import admin from 'firebase-admin';

/**
 * Generates a speech URL using Sarvam AI (optimized for Indian context)
 * and uploads it to Firebase Storage so Exotel can <Play> it.
 */
export async function generateSpeechUrl(text, language = 'hi-IN') {
  try {
    if (!process.env.SARVAM_API_KEY) {
      console.warn('SARVAM_API_KEY not set, falling back to Exotel <Say>');
      return null;
    }

    // 1. Generate Speech using Sarvam AI
    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': process.env.SARVAM_API_KEY
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: language === 'hinglish' ? 'hi-IN' : language,
        speaker: 'meera', // Natural Indian female voice
        pitch: 0,
        pace: 1.1,
        loudness: 1.5,
        speech_sample_rate: 8000 // Optimized for phone lines
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Sarvam AI Error:', error);
      return null;
    }

    const { audios } = await response.json();
    const audioBuffer = Buffer.from(audios[0], 'base64');

    // 2. Upload to Firebase Storage for public access
    const bucket = admin.storage().bucket();
    const fileName = `tts/${Date.now()}.wav`;
    const file = bucket.file(fileName);

    await file.save(audioBuffer, {
      metadata: { contentType: 'audio/wav' },
      public: true
    });

    // 3. Return the public URL
    // Note: Make sure your bucket's public access is configured or use a Signed URL
    return `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  } catch (err) {
    console.error('TTS Generation failed:', err.message);
    return null;
  }
}
