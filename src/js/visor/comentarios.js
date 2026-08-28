'use strict';
/**
 * comentarios.js — Lo que el editor escribe sobre el transcript, en un solo sitio.
 *
 * Se puede comentar desde dos lados —el panel de al lado del video y el guion
 * leído de corrido— y los dos escriben en el mismo lugar, porque son comentarios
 * sobre la misma clase: uno hecho leyendo tiene que aparecer al mirar el video, y
 * los dos terminan igual en el XML como marcador.
 *
 * Van anclados al **tiempo de la grabación** y nunca a la posición en el corte:
 * la grabación no cambia y el corte sí, cada vez que se mueve un borde.
 */

import { toast } from '../chrome.js';
import { rev, cambio } from './estado.js';

/** Las notas de la clase, siempre con la forma que espera el resto. */
export function notas() {
    if (!rev.notas) rev.notas = { bloques: {}, comentarios: [] };
    if (!rev.notas.bloques) rev.notas.bloques = {};
    if (!rev.notas.comentarios) rev.notas.comentarios = [];
    return rev.notas;
}

/**
 * Manda las notas al disco y se queda con lo que volvió.
 *
 * Vuelve con los `id` puestos: los acuña `engine/notas.js`, que es el único que
 * los reparte, así que un comentario recién hecho no tiene id hasta este momento.
 */
export async function guardar() {
    const respuesta = await window.cc.saveNotas({
        id: rev.id,
        bloques: notas().bloques,
        comentarios: notas().comentarios
    });
    if (!respuesta.ok) { toast(respuesta.error); return false; }
    rev.notas = respuesta.notas;
    // La tira del reproductor y la lista de bloques marcan cuáles tienen
    // comentario: sin avisar, el aviso recién aparecería al volver a entrar.
    cambio();
    return true;
}

/**
 * El ancla de un comentario a partir de las palabras que se seleccionaron.
 *
 * El final es el ARRANQUE de la última palabra y no su final, que es lo que
 * hacía el panel del reproductor desde el principio: el `end` de una palabra en
 * el reloj del DTW es el arranque de la siguiente, así que tomarlo estiraría el
 * marcador hasta la palabra que no se seleccionó.
 *
 * @param {Array} palabras las de la selección, en orden, con `start` y `text`
 */
export function anclaDeSeleccion(palabras) {
    const lista = palabras || [];
    if (!lista.length) return null;
    return {
        sourceStartSec: lista[0].start,
        sourceEndSec: lista[lista.length - 1].start,
        texto: lista.map(p => p.text).join(' ').trim()
    };
}
