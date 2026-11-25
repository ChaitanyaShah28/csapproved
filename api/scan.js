async function fetchExactNutrition(brand, productName) {
  const query = `${brand || ''} ${productName || ''}`.trim();
  if (!query) return null;

  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=3&fields=product_name,brands,serving_size,nutriments`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CSApproved/1.0 (https://csapproved.vercel.app)' },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const match = (data.products || []).find(
      (p) => p.nutriments && (p.nutriments.proteins_serving != null || p.nutriments.proteins_100g != null)
    );
    if (!match) return null;

    const n = match.nutriments;
    const useServing = n.proteins_serving != null || n.sugars_serving != null;
    const suffix = useServing ? '_serving' : '_100g';

    const sugar = Number(n[`sugars${suffix}`] ?? 0);
    const sodiumMg = Math.round(Number(n[`sodium${suffix}`] ?? 0) * 1000);
    const satFat = Number(n[`saturated-fat${suffix}`] ?? 0);
    const fiber = Number(n[`fiber${suffix}`] ?? 0);
    const protein = Number(n[`proteins${suffix}`] ?? 0);
    const calories = Math.round(Number(n[`energy-kcal${suffix}`] ?? 0));

    return {
      calories: calories || null,
      nutrients: {
        sugar: {
          value: Math.round(sugar * 10) / 10,
          unit: 'g',
          percentDaily: Math.round((sugar / 50) * 100),
          status: sugar <= 5 ? 'good' : sugar <= 15 ? 'moderate' : 'bad',
        },
        sodium: {
          value: sodiumMg,
          unit: 'mg',
          percentDaily: Math.round((sodiumMg / 2300) * 100),
          status: sodiumMg <= 140 ? 'good' : sodiumMg <= 400 ? 'moderate' : 'bad',
        },
        saturatedFat: {
          value: Math.round(satFat * 10) / 10,
          unit: 'g',
          percentDaily: Math.round((satFat / 20) * 100),
          status: satFat <= 1.5 ? 'good' : satFat <= 5 ? 'moderate' : 'bad',
        },
        fiber: {
          value: Math.round(fiber * 10) / 10,
          unit: 'g',
          percentDaily: Math.round((fiber / 28) * 100),
          status: fiber >= 4 ? 'good' : fiber >= 2 ? 'moderate' : 'bad',
        },
        protein: {
          value: Math.round(protein * 10) / 10,
          unit: 'g',
          percentDaily: Math.round((protein / 50) * 100),
          status: protein >= 10 ? 'good' : protein >= 5 ? 'moderate' : 'bad',
        },
      },
    };
  } catch (err) {
    console.error('Open Food Facts lookup skipped:', err.message);
    return null;
  }
}

async function enrichIfFrontOnly(parsed) {
  if (!parsed || parsed.isFoodProduct === false || parsed.hasNutritionTable === true) {
    return parsed;
  }

  const exact = await fetchExactNutrition(parsed.brand, parsed.productName);
  if (exact) {
    if (exact.calories) parsed.calories = exact.calories;
    parsed.nutrients = exact.nutrients;
  }
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const { base64Image, mimeType, prompt, responseSchema } = req.body;
  const imgMime = mimeType || 'image/jpeg';

  // Add hasNutritionTable + front-callout instruction without needing index.html edits
  const enhancedSchema = {
    ...responseSchema,
    properties: {
      ...responseSchema.properties,
      hasNutritionTable: { type: 'BOOLEAN' },
    },
  };

  const enhancedPrompt = `${prompt}
Set hasNutritionTable to true ONLY if a Nutrition Facts table is clearly visible in the image; set it to false for front-of-pack photos. Always read exact brand name, product variant, and any front/lid callouts (like "17g Protein" or "0% Fat") accurately.`;

  // 1. Try Gemini first
  if (geminiKey) {
    const models = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen'];
    const payload = JSON.stringify({
      contents: [
        {
          parts: [
            { text: enhancedPrompt },
            { inlineData: { mimeType: imgMime, data: base64Image } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: enhancedSchema,
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
          if (cleanText) {
            const enriched = await enrichIfFrontOnly(JSON.parse(cleanText));
            return res.status(200).json(enriched);
          }
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
    const groqPrompt = `${enhancedPrompt}\n\nKeep all text fields brief. Return ONLY valid JSON matching this exact schema (no markdown, no extra text):\n${JSON.stringify(enhancedSchema)}`;
    const groqBody = JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      max_completion_tokens: 750,
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
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: groqBody,
        });

        const groqData = await groqRes.json();
        if (groqRes.ok) {
          const text = groqData.choices?.[0]?.message?.content;
          if (text) {
            const enriched = await enrichIfFrontOnly(JSON.parse(text));
            return res.status(200).json(enriched);
          }
        }

        if (groqRes.status === 429 && attempt === 1) {
          const retryAfter = Math.min(Number(groqRes.headers.get('retry-after')) || 8, 10);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        console.error(`Groq failed (${groqRes.status}):`, JSON.stringify(groqData));
        break;
      } catch (err) {
        console.error('Groq error:', err.message);
        break;
      }
    }
  }

  return res.status(503).json({ error: 'Both Gemini and Groq are temporarily unavailable.' });
}
