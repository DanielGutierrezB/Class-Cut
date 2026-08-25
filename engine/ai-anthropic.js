'use strict';
/**
 * ai-anthropic.js — El criterio por la API de Claude, con la clave del editor.
 *
 * Mismo contrato que los demás proveedores: `ask` → JSON chico que quien llama
 * valida. La clave viaja solo en el encabezado de cada pedido a
 * `api.anthropic.com`; no se manda a ningún otro lado y se guarda donde el
 * resto de los ajustes, en el Application Support del usuario.
 *
 * `temperature: 0` porque acá no hay semilla que fijar: es lo más cerca de
 * "reprocesar da lo mismo" que ofrece la API.
 */

const ai = require('./ai-local');

const DEFAULTS = {
    url: 'https://api.anthropic.com/v1/messages',
    version: '2023-06-01',
    maxTokens: 1400,
    timeoutMs: 120000
};

/**
 * Una pregunta, una respuesta en JSON. Nunca lanza: contesta `{error}`.
 * @param {object} config { apiKey, model, system, prompt, numPredict, signal }
 */
async function preguntar(config) {
    let response;
    try {
        response = await fetch(DEFAULTS.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': DEFAULTS.version
            },
            body: JSON.stringify({
                model: config.model,
                max_tokens: config.numPredict || DEFAULTS.maxTokens,
                temperature: 0,
                system: config.system || '',
                messages: [{ role: 'user', content: config.prompt || '' }]
            }),
            signal: config.signal || AbortSignal.timeout(config.timeoutMs || DEFAULTS.timeoutMs)
        });
    } catch (err) {
        if (err.name === 'AbortError') return { error: 'cancelado' };
        if (err.name === 'TimeoutError') return { error: 'Claude no contestó a tiempo' };
        return { error: `no se pudo hablar con Claude: ${err.message}` };
    }

    if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        if (response.status === 401) return { error: 'La clave de Anthropic no es válida.' };
        if (response.status === 404) return { error: `Anthropic no conoce el modelo «${config.model}».` };
        if (response.status === 429) return { error: 'Anthropic está limitando los pedidos (429). Esperá un momento.' };
        return { error: `Claude contestó ${response.status}. ${detalle.slice(0, 200)}`.trim() };
    }

    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        return { error: 'Claude devolvió algo que no es JSON.' };
    }

    const texto = ((payload && payload.content) || [])
        .filter(parte => parte.type === 'text')
        .map(parte => parte.text)
        .join('');
    if (!texto) return { error: 'el modelo contestó vacío' };

    const parsed = ai.parseJson(texto);
    if (!parsed) return { error: `el modelo no contestó JSON: ${texto.slice(0, 160)}` };
    return parsed;
}

/** Un cliente atado a UNA clave y UN modelo. */
function cliente(config) {
    return {
        model: config.model,
        proveedor: 'anthropic',
        contextoGrande: true,
        // La API aguanta varias a la vez de sobra; cuatro es rápido sin
        // coquetear con el límite de pedidos por minuto.
        paralelo: 4,
        ask: params => {
            if (!config.apiKey) return Promise.resolve({ error: 'Falta la clave de Anthropic (Ajustes).' });
            return preguntar({
                apiKey: config.apiKey,
                model: config.model,
                system: params.system,
                prompt: params.prompt,
                numPredict: params.numPredict,
                signal: params.signal
            });
        }
    };
}

/** ¿La clave y el modelo sirven? Para el botón Probar. */
async function probar(config) {
    if (!config.apiKey) return { ok: false, reason: 'Falta la clave. Empieza con sk-ant-…' };
    const desde = Date.now();
    const res = await preguntar({
        apiKey: config.apiKey,
        model: config.model,
        system: 'Contestás SOLO JSON válido.',
        prompt: 'Contestá exactamente: {"ok": true}',
        numPredict: 30,
        timeoutMs: 30000
    });
    if (res.error) return { ok: false, reason: res.error };
    return { ok: true, ms: Date.now() - desde, reason: `Contestó en ${((Date.now() - desde) / 1000).toFixed(1)} s.` };
}

module.exports = { cliente, probar, DEFAULTS };
