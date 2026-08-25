'use strict';
/**
 * clase-entera.js — La clase completa, escrita para que el modelo la lea entera.
 *
 * Al afinar un borde, el modelo ve una ventana de unas 60 palabras alrededor del
 * corte. Alcanza para "¿esta frase cierra?", pero no para "¿esto que estoy por
 * dejar afuera se rehace más adelante?": la clase se graba por intentos y el
 * intento bueno puede estar tres minutos después, muy lejos de cualquier ventana.
 *
 * Esto arma el texto de la clase entera con los bloques marcados, para poder
 * dárselo de fondo. Dos decisiones que importan:
 *
 * 1. Va lo que se DESCARTA, no solo lo que queda. Entre bloque y bloque están las
 *    tomas falsas y las órdenes al editor, que es exactamente lo que el modelo
 *    necesita ver para saber si mover un borde se las come.
 * 2. Se arma UNA vez por clase, antes de tocar ningún borde, y no se recalcula.
 *    Con un prefijo idéntico entre consultas, el servidor reusa lo ya procesado
 *    y la segunda consulta no vuelve a pagar la lectura completa.
 *
 * Historia: esto existió como la opción `contexto: 'clase'` de cut-refine, se
 * midió con el modelo local (qwen: 2 defectos de 174 de diferencia a 2.8× el
 * tiempo) y se borró. Volvió cuando aparecieron los proveedores con ventana de
 * un millón de tokens — hoy NO es una opción: se usa siempre que el cliente
 * declare `contextoGrande`, porque para un modelo así leer la clase cuesta
 * centavos y ver las retomas lejanas es justo lo que el chico no podía.
 */

const speech = require('./speech-edges');

/** Cuánto texto de descarte se muestra entre dos bloques, en palabras. */
const DESCARTE_MAX = 60;

function recorte(texto, palabras) {
    const partes = String(texto || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '';
    if (partes.length <= palabras) return partes.join(' ');
    const mitad = Math.floor(palabras / 2);
    return `${partes.slice(0, mitad).join(' ')} […] ${partes.slice(-mitad).join(' ')}`;
}

/**
 * El texto de la clase con los bloques marcados.
 *
 * @param {Array} blocks bloques del alineado, con startSec/endSec
 * @param {Array} words palabras del transcript
 * @returns {string} vacío si no hay con qué armarlo
 */
function texto(blocks, words) {
    if (!blocks || !blocks.length || !words || !words.length) return '';

    const partes = [];
    let anterior = null;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block.startSec == null || block.endSec == null) continue;

        // Lo que quedó entre el bloque anterior y este: tomas falsas, conteos,
        // "pausa", "va de nuevo". Sin esto el modelo no puede distinguir un borde
        // que cierra limpio de uno que se está comiendo el arranque de otra toma.
        if (anterior && block.startSec > anterior.endSec + 0.4) {
            const tirado = recorte(speech.textInside(words, anterior.endSec, block.startSec), DESCARTE_MAX);
            if (tirado) partes.push(`  (entre medio se descarta: «${tirado}»)`);
        }

        const nota = (block.note || block.cueIn || '').trim();
        partes.push(`⟦BLOQUE ${i + 1}${nota ? ` · nota del CD: «${nota}»` : ''}⟧`);
        partes.push(speech.textInside(words, block.startSec, block.endSec) || '(no se dice nada)');
        anterior = block;
    }

    if (!partes.length) return '';
    return partes.join('\n');
}

/**
 * El mensaje de sistema con la clase entera pegada detrás.
 *
 * Va en el sistema y no en el prompt del usuario a propósito: es lo único que se
 * repite igual en todas las consultas de la clase, y estando primero Ollama lo
 * reconoce como prefijo ya procesado. Puesto al final del prompt del usuario, el
 * texto cambiaría de posición en cada consulta y habría que releerlo entero.
 *
 * @returns {string} el sistema original si no hay clase que agregar
 */
function conLaClase(systemMsg, textoDeLaClase) {
    if (!textoDeLaClase) return systemMsg;
    return `${systemMsg}\n\n` +
        'Antes de nada, esta es la clase ENTERA tal como se grabó, con los bloques que el CD ' +
        'marcó. Lo que está entre bloques se descarta al montar.\n' +
        'Úsala para saber si algo se repite más adelante, si una idea queda a medias o si el ' +
        'material que estás por dejar fuera se rehace después.\n\n' +
        `${textoDeLaClase}\n\n` +
        'Fin de la clase. Ahora te van a preguntar por UN borde concreto.';
}

module.exports = { texto, conLaClase, DESCARTE_MAX };
