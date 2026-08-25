'use strict';
/**
 * orden-del-cd.js — Cuando el director de contenido ya dijo dónde cortar.
 *
 * Los marcadores IN traen, además del cue, una nota escrita para el editor. La
 * mayoría son de post ("POST: highlight en…"), pero un puñado son órdenes de
 * corte con nombre y apellido:
 *
 *     OUT ANTES DE: "En Spec-Driven Development, la"
 *     IN DESPUÉS DE: "3, 2, 1. Vamos a ver qué hallazgos generó"
 *
 * Fijarse en dos cosas, porque las dos importan:
 *
 * 1. La orden viaja en el marcador de ENTRADA pero casi siempre habla de la
 *    SALIDA. Mostrársela al modelo mientras afina el IN es ruido; lo que hay que
 *    hacer es llevarla al borde del que habla.
 * 2. No es una sugerencia, es la persona que armó la clase diciendo dónde va el
 *    corte. Si la frase se ubica sin ambigüedad, se aplica y no se vota: medido
 *    sobre el curso, de 24 órdenes explícitas solo 2 se estaban respetando, y
 *    varias se pasaban de largo por 13, 19 y hasta 23 segundos.
 *
 * Ubicar la frase es difuso a propósito: el CD la escribe de memoria y Whisper la
 * transcribe a su manera —"Spec-Driven Development" contra "Spectriven
 * Development"—, así que compararlas letra a letra no encuentra nada.
 */

const anchor = require('./vendor/marker-anchor');

// «OUT ANTES DE: "…"», «IN DESPUÉS DE: "…"», con o sin dos puntos y con
// cualquiera de las comillas que salen de un teclado.
const ORDEN = /(^|\n)\s*(OUT|IN)\s+(ANTES|DESPU[ÉE]S)\s+DE\s*:?\s*["“”«]?\s*(.+?)\s*["“”»]?\s*(\n|$)/i;

// Con menos que esto la frase no se reconoció, se encontró otra cosa parecida.
const SCORE_MINIMO = 0.7;
// Con menos que esto no se aplica sola, salvo que sea la única del tramo: ahí no
// hay con qué confundirla.
const SCORE_SEGURO = 0.8;
// Un bloque no puede durar cero: la frase tiene que caer con aire respecto del
// otro borde.
const MARGEN_SEC = 1.5;

// Para dar por CLARA la aparición que gana el desempate, la segunda tiene que
// quedar bastante más lejos del marcador: la mitad más lejos y además al menos
// un segundo. Lo segundo importa con retomas pegadas — a 2 y 3 segundos del
// marcador, cualquier factor solo casi empata y eso sigue siendo una moneda al
// aire.
const VENTAJA_DE_LEJANIA = 1.5;
const VENTAJA_MINIMA_SEC = 1;

/**
 * La orden que la nota le da a UN borde, o null.
 *
 * @param {object} block bloque del alineado, con su `note`
 * @param {'IN'|'OUT'} kind el borde que se está afinando
 */
function para(block, kind) {
    if (!block || !block.note) return null;
    const m = ORDEN.exec(String(block.note));
    if (!m) return null;

    const borde = m[2].toUpperCase();
    if (borde !== kind) return null;

    // Una nota cortada a la mitad ("OUT ANTES DE:") no pide nada: sin algo que
    // buscar en el transcript, no hay orden.
    const frase = m[4].replace(/^[\s:"“”«»]+|[\s:"“”«»]+$/g, '');
    if (!/[\p{L}\p{N}]/u.test(frase)) return null;
    return {
        borde,
        relacion: /ANTES/i.test(m[3]) ? 'antes' : 'después',
        frase
    };
}

/**
 * Hasta dónde puede moverse este borde sin invadir el bloque de al lado.
 *
 * Sin esto, una frase que el profesor repite en toda la clase —"vamos a ver",
 * "en este caso"— se ubica en cualquier lado: 34 apariciones para una sola orden
 * en la clase 1. Dentro del territorio del bloque casi siempre queda una.
 */
function territorio(blocks, index, kind) {
    const propio = blocks[index] || {};
    if (kind === 'IN') {
        const previo = blocks[index - 1];
        return {
            desde: previo && previo.endSec != null ? previo.endSec : 0,
            hasta: propio.endSec != null ? propio.endSec : Infinity
        };
    }
    const siguiente = blocks[index + 1];
    return {
        desde: propio.startSec != null ? propio.startSec : 0,
        hasta: siguiente && siguiente.startSec != null ? siguiente.startSec : Infinity
    };
}

/**
 * Dónde cae la frase de la orden, en segundos.
 *
 * En los dos casos la frase queda FUERA del bloque, y por eso el punto que se
 * busca no es el mismo: "OUT antes de X" corta donde X empieza a decirse y "IN
 * después de X" corta donde X termina. Confundirlos deja la clase 11 abriendo
 * con el "3, 2, 1" del conteo, que es exactamente lo que la nota pedía sacar.
 *
 * @returns {{timeSec:number, score:number, seguro:boolean, apariciones:number}|null}
 */
function ubicar(words, orden, blocks, index, options) {
    if (!orden || !words || !words.length) return null;

    const kind = orden.borde;
    const zona = territorio(blocks || [], index, kind);
    // 'IN' devuelve el arranque de la coincidencia y 'OUT' el final: acá no dice
    // qué borde se está moviendo, dice qué punta de la frase interesa.
    const punta = orden.relacion === 'antes' ? 'IN' : 'OUT';
    const hits = anchor.findMatches(words, orden.frase, punta, {
        truncatedLen: 1,
        minScore: SCORE_MINIMO,
        fps: (options && options.fps) || 30
    });
    if (!hits.length) return null;

    const propio = blocks[index] || {};
    const tope = kind === 'IN'
        ? (propio.endSec != null ? propio.endSec - MARGEN_SEC : Infinity)
        : Infinity;
    const piso = kind === 'OUT'
        ? (propio.startSec != null ? propio.startSec + MARGEN_SEC : -Infinity)
        : -Infinity;

    const dentro = hits.filter(h =>
        h.time >= zona.desde && h.time <= zona.hasta && h.time >= piso && h.time <= tope);
    if (!dentro.length) return null;

    // El desempate que funciona: mejor puntaje primero y, a igual puntaje, la
    // aparición más cercana al marcador que ya existe.
    //
    // Lo segundo no es un detalle. Estas clases se graban con retomas: el
    // profesor arranca la frase, se traba y la repite dos o tres veces, así que
    // la misma frase aparece cuatro veces en un mismo bloque con puntaje
    // perfecto. Quedarse con la primera lleva el corte a la toma equivocada; el
    // marcador en vivo, aunque esté corrido diez o veinte segundos, dice cuál de
    // las tomas estaba mirando el CD cuando escribió la nota.
    const referencia = (options && options.referencia != null)
        ? options.referencia
        : (kind === 'IN' ? propio.startSec : propio.endSec);

    const lejania = h => (referencia == null ? 0 : Math.abs(h.time - referencia));
    const ordenadas = dentro.slice().sort((a, b) => b.score - a.score || lejania(a) - lejania(b));
    const mejor = ordenadas[0];
    const segunda = ordenadas.find(h => h.score === mejor.score && h !== mejor);

    // Dos tomas casi equidistantes son una moneda al aire: ahí se ofrece la
    // frase como candidata y decide el resto de la maquinaria, que para eso
    // está.
    const clara = !segunda
        || lejania(segunda) >= lejania(mejor) * VENTAJA_DE_LEJANIA + VENTAJA_MINIMA_SEC;

    // Y por debajo del listón no se encontró la frase, se encontró otra que se
    // le parece. Un 0.75 en la clase 1 enganchó "y nos entregó el cambio en la
    // aplicación" cuando la nota pedía "¡Ya nos entregó la aplicación": llevar
    // el corte ahí lo dejaba partiendo una oración por la mitad.
    const reconocida = mejor.score >= SCORE_SEGURO;

    return {
        timeSec: mejor.time,
        score: mejor.score,
        apariciones: dentro.length,
        reconocida,
        seguro: reconocida && clara
    };
}

/** Cómo se lee la orden en el resumen del borde. */
function comoSeLee(orden, ubicada) {
    const frase = orden.frase.length > 42 ? `${orden.frase.slice(0, 42)}…` : orden.frase;
    const base = `el CD pidió ${orden.borde} ${orden.relacion} de «${frase}»`;
    if (!ubicada) return `${base}, pero esa frase no aparece en este tramo`;
    return `${base} (${ubicada.timeSec.toFixed(1)}s)`;
}

module.exports = { para, ubicar, territorio, comoSeLee, ORDEN, SCORE_MINIMO, SCORE_SEGURO };
