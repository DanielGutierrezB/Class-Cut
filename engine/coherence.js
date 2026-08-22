'use strict';
/**
 * coherence.js — La clase cortada, leída de corrido.
 *
 * Cada bloque puede estar bien cortado y la clase entera no tener sentido: una
 * idea que queda colgando porque su explicación se fue con lo eliminado, un
 * empalme donde el profesor arranca a mitad de razonamiento, lo mismo dicho dos
 * veces porque sobrevivieron dos intentos. Eso no lo ve ninguna regla, y es lo
 * único que importa cuando alguien mira la clase terminada.
 *
 * Así que se arma el GUION FINAL —solo las palabras que sobreviven, en el orden
 * en que van a verse— y se lee. Primero con reglas, que atrapan lo evidente y no
 * cuestan nada, y después con el modelo local, que es el que puede decir "acá se
 * está respondiendo algo que nadie preguntó".
 *
 * El modelo nombra NÚMEROS DE BLOQUE, nunca tiempos: cada hallazgo se valida
 * contra los bloques que existen y el que no cuadra se tira.
 */

const speech = require('./speech-edges');

const COHERENCE_VERSION = 1;

const DEFAULTS = {
    // Un guion de clase cortada ronda las 2.000 palabras y entra entero; si una
    // clase larga se pasa, se parte y se solapa un bloque para no perder el
    // empalme, que es justo lo que se está mirando.
    maxWordsPerCall: 2600,
    overlapBlocks: 1,
    numPredict: 1200
};

const TIPOS = {
    idea_colgando: 'Idea colgando',
    repetido: 'Se dice dos veces',
    empalme: 'Empalme raro',
    conector: 'Conector sin antecedente',
    orden: 'Orden que no fluye',
    otro: 'Otro'
};

const SYSTEM = 'Sos un editor de video que revisa el guion de una clase ya cortada. ' +
    'Buscás lo que al alumno no le va a cerrar. Respondés SIEMPRE solo JSON válido, en español.';

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/**
 * El guion final: lo que queda de la clase, bloque por bloque, en orden.
 * @returns {{blocks: Array, text: string, wordCount: number}}
 */
function buildScript(blocks, words) {
    const kept = (blocks || []).filter(b => b.enabled !== false);
    const out = [];
    let wordCount = 0;

    kept.forEach((block, position) => {
        const text = speech.textInside(words, block.startSec, block.endSec);
        const count = text ? text.split(/\s+/).length : 0;
        wordCount += count;
        out.push({
            n: position + 1,
            index: block.index,
            view: block.view,
            note: block.note || '',
            // Con qué dijo el CD que abre el bloque: sirve para no avisar de un
            // conector que él puso a propósito.
            cueIn: block.cueIn || '',
            startSec: block.startSec,
            endSec: block.endSec,
            durationSec: Math.round((block.endSec - block.startSec) * 100) / 100,
            wordCount: count,
            text
        });
    });

    return {
        blocks: out,
        wordCount,
        text: out.map(b => `[${b.n}] ${b.text}`).join('\n\n')
    };
}

/**
 * Lo que se puede ver sin modelo: bloques vacíos, arranques con un conector
 * huérfano y frases repetidas entre bloques vecinos.
 */
function localFindings(script) {
    const findings = [];
    const CONNECTOR = /^(y|entonces|pero|porque|además|luego|después|así|eso|esto|ahí|igual|o sea)\b/i;

    for (let i = 0; i < script.blocks.length; i++) {
        const block = script.blocks[i];

        if (!block.text) {
            findings.push({
                bloque: block.n,
                tipo: 'otro',
                gravedad: 'alta',
                detalle: 'El bloque no tiene nada hablado adentro.',
                fuente: 'regla'
            });
            continue;
        }

        // Un conector solo es huérfano si NO estaba en la nota. Medido en el
        // curso: de 25 bloques que abren con "Y", "Luego" o "Después", 24 los
        // escribió así el CD — es su forma de hablar, no un corte mal puesto.
        const opener = block.text.split(/\s+/)[0];
        const intentional = CONNECTOR.test(block.cueIn || '');
        if (i > 0 && CONNECTOR.test(block.text) && !intentional) {
            findings.push({
                bloque: block.n,
                tipo: 'conector',
                gravedad: 'baja',
                detalle: `Arranca con "${opener}", que se apoya en algo dicho antes, y la nota del CD no abría así.`,
                fuente: 'regla'
            });
        }

        const previous = script.blocks[i - 1];
        if (previous && previous.text) {
            const head = normalize(block.text).slice(0, 60);
            if (head.length > 25 && normalize(previous.text).includes(head)) {
                findings.push({
                    bloque: block.n,
                    tipo: 'repetido',
                    gravedad: 'alta',
                    detalle: 'Empieza repitiendo lo que el bloque anterior ya dijo.',
                    fuente: 'regla'
                });
            }
        }
    }
    return findings;
}

function normalize(text) {
    return String(text || '').toLowerCase().replace(/[^a-záéíóúñü0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Parte el guion en tandas que entren en una llamada, solapando un bloque. */
function chunk(script, options) {
    const limit = opt(options, 'maxWordsPerCall');
    const overlap = opt(options, 'overlapBlocks');
    const chunks = [];
    let current = [];
    let count = 0;

    for (const block of script.blocks) {
        if (current.length && count + block.wordCount > limit) {
            chunks.push(current);
            current = current.slice(-overlap);
            count = current.reduce((sum, b) => sum + b.wordCount, 0);
        }
        current.push(block);
        count += block.wordCount;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

function buildPrompt(blocks, script) {
    const body = blocks.map(b =>
        `[${b.n}]${b.note ? ` (nota del CD: ${b.note})` : ''} ${b.text}`).join('\n\n');

    return `Esta es una clase ya cortada. Cada bloque es un trozo que quedó; entre bloque y bloque se eliminó material (tomas falsas, indicaciones al editor, silencios).

Es el bloque ${blocks[0].n} al ${blocks[blocks.length - 1].n} de ${script.blocks.length}.

GUION:
${body}

Leelo como si fueras el alumno que va a ver la clase, de corrido. Marcá SOLO lo que de verdad se entiende mal:

- idea_colgando: se empieza a explicar algo y nunca se cierra, o se da por dicho algo que no se dijo.
- repetido: dos bloques dicen lo mismo (quedaron dos intentos de la misma toma).
- empalme: el salto entre dos bloques se nota porque la frase no engancha.
- conector: el bloque abre con "y", "entonces", "pero"... apoyándose en algo que se eliminó.
- orden: algo se explica antes de lo que hace falta para entenderlo.

Si el guion se entiende bien, devolvé la lista vacía. No inventes problemas ni comentes el estilo.

Responde solo JSON:
{"hallazgos": [{"bloque": <número>, "tipo": "<idea_colgando|repetido|empalme|conector|orden>", "gravedad": "<alta|media|baja>", "detalle": "<qué no cierra, en una frase>", "sugerencia": "<qué haría el editor, en una frase>"}]}`;
}

/** Solo sobrevive lo que apunta a un bloque que existe y dice algo. */
function validateFindings(raw, script) {
    const valid = [];
    const numbers = new Set(script.blocks.map(b => b.n));

    for (const item of (raw && raw.hallazgos) || []) {
        const bloque = parseInt(item.bloque, 10);
        if (!numbers.has(bloque)) continue;
        const detalle = String(item.detalle || '').trim();
        if (!detalle) continue;
        valid.push({
            bloque,
            tipo: TIPOS[item.tipo] ? item.tipo : 'otro',
            gravedad: ['alta', 'media', 'baja'].includes(item.gravedad) ? item.gravedad : 'media',
            detalle,
            sugerencia: String(item.sugerencia || '').trim() || null,
            fuente: 'ia'
        });
    }
    return valid;
}

/**
 * Revisa una clase entera.
 * @param {object} params { alignResult, words, ai, options, onProgress, signal }
 */
async function reviewClass(params) {
    const { alignResult, words, options } = params;
    const script = buildScript(alignResult.blocks, words);
    const findings = localFindings(script);
    const stats = { llamadas: 0, fallos: 0, hallazgosIa: 0, hallazgosRegla: findings.length };

    if (params.ai && script.blocks.length) {
        const chunks = chunk(script, options);
        for (let i = 0; i < chunks.length; i++) {
            if (params.onProgress) params.onProgress({ chunk: i + 1, total: chunks.length });
            stats.llamadas++;
            const response = await params.ai.ask({
                system: SYSTEM,
                prompt: buildPrompt(chunks[i], script),
                numPredict: opt(options, 'numPredict'),
                signal: params.signal
            });
            if (response && response.error) { stats.fallos++; continue; }
            const found = validateFindings(response, script);
            stats.hallazgosIa += found.length;
            findings.push(...found);
        }
    }

    // Un mismo problema puede salir por regla y por modelo: se deja uno.
    const seen = new Set();
    const unique = findings.filter(f => {
        const key = `${f.bloque}:${f.tipo}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => a.bloque - b.bloque);

    return {
        version: COHERENCE_VERSION,
        createdAt: new Date().toISOString(),
        wordCount: script.wordCount,
        blocks: script.blocks.map(b => ({
            n: b.n, index: b.index, view: b.view, note: b.note,
            startSec: b.startSec, endSec: b.endSec, durationSec: b.durationSec, text: b.text
        })),
        findings: unique,
        stats
    };
}

module.exports = {
    reviewClass,
    buildScript,
    localFindings,
    validateFindings,
    buildPrompt,
    chunk,
    TIPOS,
    COHERENCE_VERSION,
    DEFAULTS
};
