'use strict';
/**
 * ai-local.js — Hablar con el modelo local (Ollama), sin creerle nada.
 *
 * Acá el modelo no decide tiempos ni escribe archivos: contesta un JSON chico que
 * quien llama valida contra estructuras que ya existen —un número de punto de
 * corte, un número de bloque—. Si contesta cualquier otra cosa, se descarta y el
 * corte se queda como estaba. Esa es toda la relación de confianza.
 *
 * Todo es local: no sale nada a internet y no hay tokens que pagar. Contarlos
 * igual sirve: es la medida de cuánto prompt se le está mandando, y comparar el
 * mismo curso contra un proveedor remoto solo tiene sentido si los dos números
 * salen de la misma cuenta. Ollama los devuelve en cada respuesta
 * (`prompt_eval_count`, `eval_count`) y hasta ahora se descartaban.
 *
 * Si Ollama no está corriendo, la app funciona igual con las reglas; solo se
 * pierde el criterio en los casos dudosos, y se dice.
 */

const tokens = require('./tokens');

const DEFAULTS = {
    temperature: 0.2,
    // La misma clase tiene que dar el mismo corte. Sin semilla no lo daba: dos
    // corridas seguidas sobre los mismos archivos leían la clase 13 y una
    // encontraba seis cosas y la otra nueve, con el mismo modelo y el mismo
    // transcript. Para quien edita eso es peor que un fallo —reprocesar deja de
    // ser repetir y pasa a ser tirar otra vez el dado—, y además hace imposible
    // medir si un cambio mejoró algo o le tocó una corrida buena.
    //
    // El número da igual; que sea siempre el mismo, no.
    seed: 7,
    numPredict: 400,
    timeoutMs: 120000,
    // El modelo grande tarda en cargarse en memoria; mantenerlo vivo entre
    // llamadas es la diferencia entre 3 s y 30 s por bloque.
    keepAlive: '10m'
};

// Cuánta ventana pedirle a Ollama, en tokens.
//
// Esto no se fija en un número: se calcula de lo que mide el prompt. Ollama, si
// el prompt no le entra, no falla —tira el principio y contesta igual—, así que
// un prompt que se cayó a la mitad se ve idéntico a uno que entró entero. Y
// pedir un número fijo tampoco sirve: medido con `tools/medir-contexto.js`, el
// default de Ollama aguanta ~20k tokens, o sea que fijar 16384 BAJA el techo en
// vez de subirlo. Los dos modelos que usamos declaran 262144 de arquitectura, así
// que el límite real lo pone la memoria, no el modelo: se pide lo que hace falta.
const VENTANA = {
    // Whisper en español da alrededor de 3.5 caracteres por token. Se divide por
    // 3 a propósito: pasarse de ventana cuesta un poco de memoria, quedarse corto
    // cuesta que el modelo lea medio prompt sin que nadie se entere.
    charsPorToken: 3,
    minima: 4096,
    maxima: 65536,
    // Lo que ocupan las plantillas de chat y el margen del cálculo de arriba.
    holgura: 512
};

function ventanaPara(system, prompt, numPredict) {
    const chars = String(system || '').length + String(prompt || '').length;
    const necesita = Math.ceil(chars / VENTANA.charsPorToken) + (numPredict || 0) + VENTANA.holgura;
    // A múltiplos de 2048: pedir 9973 y 9974 hace que Ollama reserve dos caches
    // distintos y recargue el modelo entre una consulta y la siguiente.
    const redondo = Math.ceil(necesita / 2048) * 2048;
    return Math.min(VENTANA.maxima, Math.max(VENTANA.minima, redondo));
}

/**
 * Un cliente atado a UN servidor y UN modelo.
 *
 * No hay configuración global a propósito. Con un singleton, `refineClass` decía
 * "usá la IA" y a qué servidor le hablaba dependía de quién lo hubiera
 * configurado antes: el banco de pruebas terminaba midiendo contra el Ollama del
 * editor en vez del que trae la app, que es justo lo que este código promete no
 * tocar. Si el cliente se pasa como parámetro, eso no se puede escribir.
 *
 * @param {{url:string, model:string}} config
 */
function cliente(config) {
    const settings = { ...DEFAULTS, ...config };
    const uso = tokens.contador();
    return {
        url: settings.url,
        model: settings.model,
        proveedor: 'local',
        uso,
        // `ask` suelto sigue existiendo y sigue sin contar nada: lo usan las
        // herramientas de medición, que hacen su propia cuenta. El contador es
        // del cliente, que es lo que dura una corrida.
        ask: params => ask({ ...settings, ...params, onUso: u => tokens.sumar(uso, u) }),
        probe: () => probe(settings)
    };
}

/** ¿Hay un Ollama escuchando y tiene el modelo que vamos a pedir? */
async function probe(config) {
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
 * @param {object} config { url, model, system, prompt, numPredict, signal }
 * @returns {Promise<object>} el JSON del modelo, o `{error}` — nunca lanza.
 */
async function ask(config) {
    const params = config;
    // Cada salida de esta función pasa por acá. Una consulta que falló también
    // se cuenta —y sin uso—, que es lo que después distingue "no gastó" de "el
    // proveedor no informa".
    const anotar = (respuesta, uso) => {
        if (params.onUso) params.onUso(uso || null);
        return respuesta;
    };
    const numPredict = params.numPredict || config.numPredict;
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
            seed: config.seed,
            num_predict: numPredict,
            num_ctx: params.numCtx || ventanaPara(params.system, params.prompt, numPredict)
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
        if (err.name === 'AbortError') return anotar({ error: 'cancelado' });
        if (err.name === 'TimeoutError') return anotar({ error: `el modelo no contestó en ${Math.round(config.timeoutMs / 1000)} s` });
        return anotar({ error: `no se pudo hablar con Ollama: ${err.message}` });
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return anotar({ error: `Ollama contestó ${response.status}. ${detail.slice(0, 200)}`.trim() });
    }

    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        return anotar({ error: 'Ollama devolvió algo que no es JSON.' });
    }

    // Ollama no tiene caché de prompt que informar: las dos cubetas van en cero
    // y `tokens.totales` las suma igual, así que la cuenta se lee igual que la
    // de los proveedores que sí la tienen.
    const uso = usoDeOllama(payload);

    const content = payload && payload.message ? payload.message.content : '';
    if (!content) return anotar({ error: 'el modelo contestó vacío' }, uso);

    const parsed = parseJson(content);
    if (!parsed) return anotar({ error: `el modelo no contestó JSON: ${String(content).slice(0, 160)}` }, uso);
    return anotar(parsed, uso);
}

/**
 * El uso de una respuesta de Ollama, en la forma de `engine/tokens.js`.
 *
 * Null si no vinieron los dos contadores: un modelo que no los informe tiene
 * que verse como "no informa" y no como una consulta gratis.
 */
function usoDeOllama(payload) {
    if (!payload) return null;
    const entrada = payload.prompt_eval_count;
    const salida = payload.eval_count;
    if (!Number.isFinite(entrada) && !Number.isFinite(salida)) return null;
    return { entrada: entrada || 0, salida: salida || 0, cacheLectura: 0, cacheEscritura: 0 };
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

module.exports = { cliente, ask, probe, parseJson, ventanaPara, usoDeOllama, DEFAULTS, VENTANA };
