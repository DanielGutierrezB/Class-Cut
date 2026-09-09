'use strict';
/**
 * oir-toma.js — Oír un tramo del reloj de pared, y oír una toma con sus orillas.
 *
 * Es la única pieza de la grabación que no sabe nada de la sesión: recibe la
 * lista de archivos de captura donde buscar, y nada más. Está aparte justamente
 * por eso — la usan los dos lados que necesitan volver a escuchar el audio, y
 * son lados que no se conocen entre sí: el ciclo de una clase en curso
 * (`grabacion.js`, `relecturas.js`) y una clase que terminó hace meses y se
 * manda a regenerar (`clases-grabadas.js`). Con esto adentro de la sesión,
 * regenerar tenía que entrar por una puerta que pedía una sesión que no existía.
 */

const fs = require('fs');

const captura = require('./captura');
const oir = require('./oir');
const vivo = require('./notas-vivo');

/**
 * Cuánto se guarda de lo que se dijo justo antes y justo después de una toma.
 *
 * Es lo que deja mover un borde MIRANDO. Con el texto recortado exactamente en el
 * IN y en el OUT, correr un borde es adivinar: no se ve la frase que quedó
 * afuera, que es justo la que dice si el corte está bien puesto. Doce segundos
 * son unas treinta palabras a la velocidad del curso —más de lo que un borde se
 * corre nunca, porque el error típico es de una frase— y para Whisper siguen
 * siendo el mismo recorte corto (`oir.js`: el largo casi no cambia lo que tarda).
 */
const ORILLA_MS = 12000;

/**
 * Un tramo del reloj de pared, transcripto.
 *
 * Se busca en qué archivo está: el que se está escribiendo o alguno ya cerrado
 * (`estado.sesiones`). Lo segundo es lo que permite releer la última toma de una
 * clase después de cerrar el audio, en `terminar`.
 */
function tramo(archivos, desdeMs, hastaMs, liviano) {
    const donde = captura.laQueContiene(archivos, desdeMs);
    if (!donde) return Promise.resolve(null);
    return oir.escuchar({ sesion: donde, desdeMs, hastaMs, liviano });
}

/**
 * El texto de una toma, con un poco de lo que se dijo antes y después.
 *
 * **Una sola pasada de Whisper, no tres.** Partir el audio en la raya del IN le
 * quita el contexto de la frase justo en el único sitio donde importa: el borde
 * mal puesto. Se pide el tramo entero con orillas y se reparte después, así que
 * la frase que cruza el corte se transcribe una vez y entera.
 *
 * El tramo se recorta a lo que el archivo tiene. La primera toma de una clase
 * empieza a pocos segundos del principio del WAV, y `captura.recorte` no sirve
 * tramos que no existen: sin recortar, pedir doce segundos antes devolvía null y
 * la toma se quedaba con el texto del ciclo liviano, que es el descartable.
 *
 * @param {Array} archivos las sesiones de captura donde buscar (`captura.laQueContiene`)
 * @returns {Promise<{antes, palabras, despues, colapsadas}|null>}
 */
async function leer(archivos, toma) {
    const donde = captura.laQueContiene(archivos, toma.inMs);
    if (!donde || !fs.existsSync(donde.archivo)) return null;

    const finDelArchivo = donde.desdeMs + (donde.segundos || 0) * 1000;
    const oido = await oir.escuchar({
        sesion: donde,
        desdeMs: Math.max(donde.desdeMs, toma.inMs - ORILLA_MS),
        hastaMs: Math.min(finDelArchivo, toma.outMs + ORILLA_MS),
        liviano: false
    });
    if (!oido) return null;
    return { ...vivo.repartir(oido.palabras, toma), colapsadas: oido.colapsadas || 0 };
}

module.exports = { ORILLA_MS, tramo, leer };
