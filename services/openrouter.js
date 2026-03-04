// services/openrouter.js — thin wrapper around the OpenRouter chat completion API
'use strict';

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL   = 'openai/gpt-4o-mini';
const URL     = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Calls OpenRouter and returns the assistant's reply text.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
async function chat(systemPrompt, userPrompt) {
  if (!API_KEY) throw new Error('OPENROUTER_API_KEY not set in environment.');

  const res = await fetch(URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'HTTP-Referer':  'https://absorbed.game',
      'X-Title':       'Absorbed',
    },
    body: JSON.stringify({
      model:    MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: 0.7,
      max_tokens:  420,
      stream:      false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

/**
 * Generates a council verdict letter.
 *
 * @param {'approved'|'denied'} verdict
 * @param {{ name:string, type:string, level:number }} planet   — planet being upgraded
 * @param {{ name:string, star_type:string, star_level:number,
 *            energy:number, matter:number, credits:number }} sys — solar system snapshot
 * @param {Array<{name:string,type:string,level:number}>} planets — all planets in system
 * @returns {Promise<string>} — the letter text
 */
async function councilLetter(verdict, planet, sys, planets) {
  const systemPrompt = `You are the scribe of the Ultimate Universe Council, an ancient and powerful interstellar governing body. Write formal decrees in a dramatic, pompous, slightly archaic tone — somewhere between a space emperor and a medieval magistrate. Keep letters under 180 words. Never start with "Dear". Use a formal proclamation opening like "By decree of the Council..." or "Let it be known...". Give exactly three numbered reasons specific to the state of the player's solar system. Write in plain, correct English sentences only. Do not scramble, shuffle, or distort any words.`;

  const systemContext = `
Solar System: "${sys.name}"
Star: ${sys.star_type} (Level ${sys.star_level})
Resources: ${Math.floor(sys.energy)} energy / ${Math.floor(sys.matter)} matter / ${Math.floor(sys.credits)} credits
Total Planets: ${planets.length}
Planet types present: ${[...new Set(planets.map(p => p.type))].join(', ')}
All planets: ${planets.map(p => `${p.name} (${p.type} lv${p.level})`).join(', ')}
`.trim();

  const userPrompt = `Write a council letter ${verdict === 'approved' ? 'APPROVING' : 'DENYING'} 
the upgrade of planet "${planet.name}" (${planet.type}, currently Level ${planet.level}) 
to Level ${planet.level + 1}. 

Context about the player's solar system:
${systemContext}

The three reasons must be directly inspired by the actual state of this specific solar system. 
${verdict === 'denied' ? 'For denial, the reasons should feel bureaucratic and somewhat unfair — the Council is capricious.' : 'For approval, the reasons should sound grand and slightly flattering.'}`;

  return chat(systemPrompt, userPrompt);
}

module.exports = { chat, councilLetter };
