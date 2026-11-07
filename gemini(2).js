// Luminio AI - Gemini provider integration (multi-model mapping + vision)
const { GoogleGenAI } = require('@google/genai');
const db = require('./db');

const env = (k, d) => process.env[k] || d;
let ai = null;
function client() {
  if (!process.env.GEMINI_API_KEY) {
    const e = new Error('GEMINI_API_KEY is not configured on the server.');
    e.status = 500; throw e;
  }
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return ai;
}

const SYSTEM_INSTRUCTION = `You are Luminio AI, a premium, friendly and highly capable AI assistant created by Luminio.
Answer with clarity and depth appropriate to the question. Use Markdown formatting: headings, bullet
points, tables and fenced code blocks with the language tag when helpful. For math, use LaTeX
notation ($...$ inline, $$...$$ display) only when it aids readability. Be accurate, admit
uncertainty, and never invent facts. When shown an image, analyze the actual image content.`;

// Effective model configuration: env defaults + admin overrides from the
// config table. Never claim a model exists unless it is mapped here.
function modelConfig() {
  let overrides = {};
  try { overrides = JSON.parse(db.getConfig('limits') || '{}'); } catch (_) {}
  const m = (id, label, tagline, model) => ({
    id, label, tagline,
    model, // actual Gemini model name; verified per-request, errors surface honestly
    freeDaily: Number(overrides.free?.[id] ?? env('FREE_DAILY_' + id.replace(/-/g, '_').toUpperCase(), '20')),
    proDaily: Number(overrides.pro?.[id] ?? env('PRO_DAILY_' + id.replace(/-/g, '_').toUpperCase(), '200')),
  });
  return [
    m('luminio-2', 'Luminio 2', 'Fast & efficient everyday model', env('MODEL_LUMINIO_2', 'gemini-2.0-flash')),
    m('luminio-3', 'Luminio 3', 'Balanced reasoning & speed', env('MODEL_LUMINIO_3', 'gemini-2.5-flash')),
    m('luminio-5', 'Luminio 5', 'Deep reasoning flagship', env('MODEL_LUMINIO_5', 'gemini-2.5-pro')),
  ];
}

function visionModel() {
  return db.getConfig('visionModel') || env('VISION_MODEL', 'gemini-2.0-flash');
}

function friendlyError(e) {
  const msg = e?.message || String(e);
  if (e?.status === 429 || /quota|rate limit|resource exhausted/i.test(msg)) {
    return { status: 429, message: 'The AI provider quota is temporarily exhausted. Please try again shortly or switch to another Luminio model.' };
  }
  if (/not found|unsupported|does not exist|not supported for this model/i.test(msg)) {
    return { status: 502, message: 'The configured model is unavailable. An administrator should check the model mapping in the backend configuration.' };
  }
  if (/api key|permission|forbidden/i.test(msg)) {
    return { status: 502, message: 'AI provider authentication failed. Check GEMINI_API_KEY on the server.' };
  }
  return { status: 502, message: 'The AI service is temporarily unavailable. Please try again.' };
}

// Returns an async generator of text deltas. Throws normalized errors.
async function* generateStream({ modelId, history, message, image, imageMime }) {
  const conf = modelConfig().find((x) => x.id === modelId);
  if (!conf) { const e = new Error('Unknown model ' + modelId); e.status = 400; throw e; }
  const modelName = image ? visionModel() : conf.model;
  const contents = [];
  for (const h of (history || []).slice(-30)) {
    if (!h.content) continue;
    contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] });
  }
  const parts = [];
  if (image) parts.push({ inlineData: { data: image, mimeType: imageMime || 'image/png' } });
  parts.push({ text: message });
  contents.push({ role: 'user', parts });
  let res;
  try {
    res = await client().models.generateContentStream({
      model: modelName,
      contents,
      config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.7, maxOutputTokens: 4096 },
    });
  } catch (e) { const f = friendlyError(e); const err = new Error(f.message); err.status = f.status; throw err; }
  try {
    for await (const chunk of res) {
      const t = chunk.text;
      if (t) yield t;
    }
  } catch (e) { const f = friendlyError(e); const err = new Error(f.message); err.status = f.status; throw err; }
}

async function ping() {
  try {
    const r = await client().models.generateContent({
      model: env('MODEL_LUMINIO_2', 'gemini-2.0-flash'),
      contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
    });
    return { ok: true, reply: (r.text || '').slice(0, 40) };
  } catch (e) { return { ok: false, error: friendlyError(e).message }; }
}

module.exports = { modelConfig, visionModel, generateStream, ping };
