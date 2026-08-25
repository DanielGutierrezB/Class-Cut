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
const tokens = require('./tokens');

const DEFAULTS = {
    url: 'https://api.anthropic.com/v1/messages',
    version: '2023-06-01',
    maxTokens: 1400,
    timeoutMs: 120000
};

/**
 * El uso de una respuesta de Claude, en la forma de `engine/tokens.js`.
 *
 * Las dos cubetas de caché existen en la API y llegan solo cuando se pide
 * caché explícito, que acá no se hace: se leen igual para que el día que se
 * active la cuenta no cambie de sitio.
 */
function usoDeClaude(payload) {
    const uso = payload && payload.usage;
    if (!uso || typeof uso !== 'object') return null;
    return {
        entrada: uso.input_tokens,
        salida: uso.output_tokens,
        cacheLectura: uso.cache_read_input_tokens,
        cacheEscritura: uso.cache_creation_input_tokens
    };
}

/**
 * Una pregunta, una respuesta en JSON. Nunca lanza: contesta `{respuesta:{error}}`.
 * @param {object} config { apiKey, model, system, prompt, numPredict, signal }
 * @returns {Promise<{respuesta: object, uso: object|null}>}
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
        if (err.name === 'AbortError') return { respuesta: { error: 'cancelado' }, uso: null };
        if (err.name === 'TimeoutError') return { respuesta: { error: 'Claude no contestó a tiempo' }, uso: null };
        return { respuesta: { error: `no se pudo hablar con Claude: ${err.message}` }, uso: null };
    }

    if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        const falla = mensaje => ({ respuesta: { error: mensaje }, uso: null });
        if (response.status === 401) return falla('La clave de Anthropic no es válida.');
        if (response.status === 404) return falla(`Anthropic no conoce el modelo «${config.model}».`);
        if (response.status === 429) return falla('Anthropic está limitando los pedidos (429). Esperá un momento.');
        return falla(`Claude contestó ${response.status}. ${detalle.slice(0, 200)}`.trim());
    }

    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        return { respuesta: { error: 'Claude devolvió algo que no es JSON.' }, uso: null };
    }

    // El uso viaja aunque la respuesta no sirva: los tokens se cobran igual.
    const uso = usoDeClaude(payload);

    const texto = ((payload && payload.content) || [])
        .filter(parte => parte.type === 'text')
        .map(parte => parte.text)
        .join('');
    if (!texto) return { respuesta: { error: 'el modelo contestó vacío' }, uso };

    const parsed = ai.parseJson(texto);
    if (!parsed) return { respuesta: { error: `el modelo no contestó JSON: ${texto.slice(0, 160)}` }, uso };
    return { respuesta: parsed, uso };
}

/** Un cliente atado a UNA clave y UN modelo. */
function cliente(config) {
    const uso = tokens.contador();
    return {
        model: config.model,
        proveedor: 'anthropic',
        contextoGrande: true,
        // La API aguanta varias a la vez de sobra; cuatro es rápido sin
        // coquetear con el límite de pedidos por minuto.
        paralelo: 4,
        uso,
        ask: async params => {
            if (!config.apiKey) return { error: 'Falta la clave de Anthropic (Ajustes).' };
            const res = await preguntar({
                apiKey: config.apiKey,
                model: config.model,
                system: params.system,
                prompt: params.prompt,
                numPredict: params.numPredict,
                signal: params.signal
            });
            tokens.sumar(uso, res.uso);
            return res.respuesta;
        }
    };
}

/** ¿La clave y el modelo sirven? Para el botón Probar. */
async function probar(config) {
    if (!config.apiKey) return { ok: false, reason: 'Falta la clave. Empieza con sk-ant-…' };
    const desde = Date.now();
    const { respuesta, uso } = await preguntar({
        apiKey: config.apiKey,
        model: config.model,
        system: 'Contestás SOLO JSON válido.',
        prompt: 'Contestá exactamente: {"ok": true}',
        numPredict: 30,
        timeoutMs: 30000
    });
    if (respuesta.error) return { ok: false, reason: respuesta.error };

    const ms = Date.now() - desde;
    const gasto = uso ? tokens.totales(tokens.sumar(tokens.contador(), uso)) : null;
    return {
        ok: true,
        ms,
        tokens: gasto,
        reason: `Contestó en ${(ms / 1000).toFixed(1)} s.` +
            (gasto ? ` Informa tokens (${gasto.total} en esta consulta).` : ' No informó tokens.')
    };
}

module.exports = { cliente, probar, usoDeClaude, DEFAULTS };
