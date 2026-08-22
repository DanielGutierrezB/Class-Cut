'use strict';
/**
 * ai-local.js — Hablar con el modelo local (Ollama), sin creerle nada.
 *
 * Acá el modelo no decide tiempos ni escribe archivos: contesta un JSON chico que
 * quien llama valida contra estructuras que ya existen —un número de punto de
 * corte, un número de bloque—. Si contesta cualquier otra cosa, se descarta y el
 * corte se queda como estaba. Esa es toda la relación de confianza.
 *
 * Todo es local: no sale nada a internet y no hay tokens que gastar. Si Ollama no
 * está corriendo, la app funciona igual con las reglas; solo se pierde el criterio
 * en los casos dudosos, y se dice.
 */

const DEFAULTS = {
    url: 'http://localhost:11434',
    model: 'qwen3.8:27b',
    temperature: 0.2,
    numPredict: 400,
    timeoutMs: 120000,
    // El modelo grande tarda en cargarse en memoria; mantenerlo vivo entre
    // llamadas es la diferencia entre 3 s y 30 s por bloque.
    keepAlive: '10m'
};

let settings = { ...DEFAULTS };

function configure(options) {
    settings = { ...settings, ...(options || {}) };
    return settings;
}

function current() {
    return { ...settings };
}

/** ¿Hay un Ollama escuchando y tiene el modelo que vamos a pedir? */
async function probe(options) {
    const config = { ...settings, ...(options || {}) };
    try {
        const response = await fetch(`${config.url}/api/tags`, {
            signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) {
            return { ok: false, reason: `Ollama contestó ${response.status}.` };
        }
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        const has = models.includes(config.model);
        return {
            ok: true,
            models,
            model: config.model,
            hasModel: has,
            reason: has
                ? `Ollama listo con ${config.model}.`
                : `Ollama está corriendo pero no tiene ${config.model}. Modelos: ${models.join(', ') || 'ninguno'}.`
        };
    } catch (err) {
        return {
            ok: false,
            reason: err.name === 'TimeoutError'
                ? 'Ollama no contestó a tiempo.'
                : `No hay un Ollama escuchando en ${config.url}.`
        };
    }
}

/**
 * Una pregunta, una respuesta en JSON.
 * @param {object} params { system, prompt, numPredict, signal, model }
 * @returns {Promise<object>} el JSON del modelo, o `{error}` — nunca lanza.
 */
async function ask(params) {
    const config = { ...settings, ...(params || {}) };
    const body = {
        model: config.model,
        messages: [
            { role: 'system', content: params.system || '' },
            { role: 'user', content: params.prompt || '' }
        ],
        stream: false,
        format: 'json',
        keep_alive: config.keepAlive,
        // Razonar en voz alta acá no aporta: la respuesta es un número dentro de
        // un JSON, y el texto extra solo alarga la espera.
        think: false,
        options: {
            temperature: config.temperature,
            num_predict: params.numPredict || config.numPredict
        }
    };

    let response;
    try {
        response = await fetch(`${config.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: params.signal || AbortSignal.timeout(config.timeoutMs)
        });
    } catch (err) {
        if (err.name === 'AbortError') return { error: 'cancelado' };
        if (err.name === 'TimeoutError') return { error: `el modelo no contestó en ${Math.round(config.timeoutMs / 1000)} s` };
        return { error: `no se pudo hablar con Ollama: ${err.message}` };
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { error: `Ollama contestó ${response.status}. ${detail.slice(0, 200)}`.trim() };
    }

    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        return { error: 'Ollama devolvió algo que no es JSON.' };
    }

    const content = payload && payload.message ? payload.message.content : '';
    if (!content) return { error: 'el modelo contestó vacío' };

    const parsed = parseJson(content);
    if (!parsed) return { error: `el modelo no contestó JSON: ${String(content).slice(0, 160)}` };
    return parsed;
}

/**
 * El JSON de la respuesta. Con `format: "json"` Ollama ya devuelve JSON limpio,
 * pero algunos modelos igual lo envuelven en ```json o le cuelgan una frase, así
 * que se rescata el primer objeto bien formado en vez de rendirse.
 */
function parseJson(text) {
    const raw = String(text).trim();
    try {
        return JSON.parse(raw);
    } catch (e) { /* se sigue intentando */ }

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]); } catch (e) { /* se sigue */ }
    }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { /* nada */ }
    }
    return null;
}

module.exports = { ask, probe, configure, current, parseJson, DEFAULTS };
