export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
  }

  const { base64Image, mimeType, prompt, responseSchema } = req.body;
  const models = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-4-hydrogen',
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
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return res.status(200).json(JSON.parse(text));
      }

      lastStatus = response.status;
      lastData = data;

      // Only fall back to the next model on temporary overload or rate-limit errors
      if (response.status !== 503 && response.status !== 429) {
        break;
      }
    }

    return res.status(lastStatus).json(lastData);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
