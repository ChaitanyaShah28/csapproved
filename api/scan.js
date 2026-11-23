export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY env var');
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
  }

  const { base64Image, mimeType, prompt, responseSchema } = req.body;
const models = [
    'gemini-2.5-flash-lite',
    'gemini-4-hydrogen',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
  ];

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: base64Image,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  try {
    let lastStatus = 500;
    let lastData = { error: 'All models unavailable' };

    for (const model of models) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: payload,
      });

      const data = await response.json();

      if (response.ok) {
        const parts = data.candidates?.[0]?.content?.parts || [];
        const answerPart = parts.find((p) => !p.thought && p.text) || parts[parts.length - 1];
        const cleanText = answerPart?.text?.replace(/^```json\s*|\s*```$/g, '').trim();

        if (cleanText) {
          return res.status(200).json(JSON.parse(cleanText));
        }
        console.error(`Model ${model} returned empty text:`, JSON.stringify(data));
      } else {
        console.error(`Model ${model} failed (${response.status}):`, JSON.stringify(data));
      }

      lastStatus = response.status;
      lastData = data;

      // Fall back to the next model on overload, rate limit, or unavailable model
      if (![404, 429, 500, 503].includes(response.status)) {
        break;
      }
    }

    return res.status(lastStatus).json(lastData);
  } catch (error) {
    console.error('Handler crash:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
