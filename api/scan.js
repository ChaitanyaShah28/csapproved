export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const { base64Image, mimeType, prompt, responseSchema } = req.body;
  const imgMime = mimeType || 'image/jpeg';

  // 1. Try Gemini first
  if (geminiKey) {
    const models = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen'];
    const payload = JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inlineData: { mimeType: imgMime, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
      },
    });

    for (const model of models) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiKey,
            },
            body: payload,
          }
        );

        const data = await response.json();
        if (response.ok) {
          const parts = data.candidates?.[0]?.content?.parts || [];
          const answerPart = parts.find((p) => !p.thought && p.text) || parts[parts.length - 1];
          const cleanText = answerPart?.text?.replace(/^```json\s*|\s*```$/g, '').trim();
          if (cleanText) return res.status(200).json(JSON.parse(cleanText));
        } else {
          console.error(`Gemini ${model} failed (${response.status}): ${data?.error?.message || ''}`);
        }
      } catch (err) {
        console.error(`Gemini ${model} error:`, err.message);
      }
    }
  }

  // 2. Automatic Fallback: Groq Vision (qwen/qwen3.8-27b)
  if (groqKey) {
    try {
      const groqPrompt = `${prompt}\n\nReturn ONLY valid JSON matching this exact schema (no markdown, no extra text):\n${JSON.stringify(responseSchema)}`;
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.8-27b',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: groqPrompt },
                {
                  type: 'image_url',
                  image_url: { url: `data:${imgMime};base64,${base64Image}` },
                },
              ],
            },
          ],
        }),
      });

      const groqData = await groqRes.json();
      if (groqRes.ok) {
        const text = groqData.choices?.[0]?.message?.content;
        if (text) return res.status(200).json(JSON.parse(text));
      } else {
        console.error(`Groq failed (${groqRes.status}):`, JSON.stringify(groqData));
      }
    } catch (err) {
      console.error('Groq error:', err.message);
    }
  }

  return res.status(503).json({ error: 'Both Gemini and Groq are temporarily unavailable.' });
}
