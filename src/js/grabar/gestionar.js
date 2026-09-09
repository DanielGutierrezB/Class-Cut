'use strict';
/**
 * gestionar.js — Cómo se llama una clase, y qué le pasa si se la renombra o se
 * la borra. Sin pantalla y sin motor.
 *
 * Todo lo de acá es lo que la lista tiene que decir EN PALABRAS antes de que
 * alguien apriete: en qué parte va a quedar la clase si le cambia el número, qué
 * archivos se van a ir del disco, por qué la hora de captura no se puede tocar.
 * Está afuera del dibujo justamente por eso —una promesa que el motor no cumple
 * es peor que no prometer nada—, y afuera del motor porque el motor no puede
 * contestar "¿qué pasaría si…?" sin hacerlo.
 *
 * O sea que estas reglas están escritas dos veces, acá y en
 * `engine/clases-grabadas.js`, y eso es a propósito y tiene su precio: la de allá
 * es la que manda —es la que escribe— y la de acá tiene que decir lo mismo.
 * `tests/renombrar-vista.test.js` corre las dos contra la misma carpeta y falla
 * si se separan, que es lo único que hace sostenible tenerlas separadas.
 */

import { fmtHora, plural } from '../formato.js';

/** El nombre de una carpeta, que es el del curso: una carpeta de notas por curso. */
export function nombreDeCarpeta(ruta) {
    return String(ruta || '').split('/').filter(Boolean).pop() || ruta || '';
}

/**
 * Cómo se lee una clase: "Clase 3", o "Clase 3 · parte 2" si se grabó en tandas.
 *
 * La parte solo aparece cuando la hay. La mayoría de las clases son una sola
 * grabación, y un "parte 1" en todas taparía justo el caso que importa ver.
 */
export function comoSeLlama(clase) {
    const n = clase.clase || '?';
    return `Clase ${n}${clase.parte > 1 ? ` · parte ${clase.parte}` : ''}`;
}

/**
 * El número a dos dígitos, que es como se escribe en todos lados empezando por
 * la carpeta del Rodecaster. El techo de 999 es el del motor: el número se relee
 * con `^(\d{1,3})` en las dos puntas de la app, y un cuarto dígito daría un
 * nombre que la app no sabe volver a leer (ver `numeroDeClase` allá).
 */
export function dosDigitos(n) {
    return String(Math.max(1, Math.min(999, Math.round(n)))).padStart(2, '0');
}

/** El número que se escribió en un campo, limpio. 1 si no se entiende nada. */
export function numeroLeido(valor) {
    return Number(String(valor == null ? '' : valor).replace(/\D/g, '')) || 1;
}

/**
 * En qué parte va a quedar la clase si se la renombra a `numero`.
 *
 * **Reusar un número la convierte en la parte siguiente, igual que grabar.** Es
 * la decisión del motor y la pantalla la muestra mientras se escribe, en vez de
 * dejar que aparezca después en el nombre del archivo: el editor renombra
 * justamente cuando quiere juntar esta clase con otra que ya está, así que "queda
 * como parte 2" es la respuesta que está buscando, no una sorpresa.
 *
 * Renombrar al número que ya tiene le deja su parte como estaba: cambiar solo el
 * curso no puede convertir una parte 1 en parte 2.
 *
 * @param {object} clase la que se está renombrando
 * @param {Array} enLaCarpeta todas las de su carpeta; esta se saca acá adentro,
 *   para que quien llama no pueda olvidarse y contarla dos veces
 * @param {number} numero el número que se escribió
 */
export function parteQueQueda(clase, enLaCarpeta, numero) {
    if (numero === Number(clase.clase)) return Number(clase.parte) || 1;
    const mio = clase.archivos ? clase.archivos.json : null;
    const otras = (enLaCarpeta || [])
        .filter(c => !mio || !c.archivos || c.archivos.json !== mio);
    return otras.filter(c => Number(c.clase) === numero).length + 1;
}

/**
 * Qué decir de la hora de captura, que es lo único que un renombrado no toca.
 *
 * Con la hora a la vista: es la que empareja esta clase con la carpeta del
 * Rodecaster —el Rodecaster escribe su propia hora local en el nombre de su
 * carpeta y post compara las dos— así que cambiarla no la renombraría, la
 * desemparejaría. Se muestra y no se edita, y el cartel dice por qué: un campo
 * apagado sin motivo se lee como algo que falta.
 *
 * Sin hora en el archivo, el motor todavía puede sacarla del nombre viejo, y por
 * eso esto avisa en vez de prohibir: adivinar acá que no se va a poder le negaría
 * el renombrado justo a las clases más viejas, que son las que más lo necesitan.
 * Si el motor se planta, su motivo se muestra tal cual en el formulario.
 *
 * @returns {{hora: string|null, aviso: string|null}}
 */
export function horaDeCaptura(clase) {
    if (clase && clase.ceroMs) return { hora: fmtHora(clase.ceroMs), aviso: null };
    return {
        hora: null,
        aviso: 'Esta clase no guardó su hora de captura. Voy a buscarla en su nombre; ' +
            'si tampoco está ahí, el renombrado se va a negar, porque una hora inventada ' +
            'la dejaría sin poder emparejarse con la carpeta del Rodecaster.'
    };
}

/**
 * El cartel de borrar: qué archivos se van del disco, y que no hay vuelta.
 *
 * **Dice los tres y los cuenta.** Acá no se descarta una toma ni se saca una
 * carpeta de una lista —eso es "Quitar de la lista", que no borra nada—: se
 * pierden cientos de megas de audio que no van a la papelera, y el aviso tiene
 * que nombrarlos para que la respuesta sea a esa pregunta y no a "¿seguro?".
 *
 * El número de audios sale del archivo de datos, o sea que es cuántos dice la
 * clase que tiene y no cuántos quedan en el disco: puede que alguien ya haya
 * movido uno a mano. Lo que se fue de verdad lo cuenta el motor y se dice después
 * (ver `borrar` allá), que es el único que puede saberlo.
 */
export function queSeBorra(clase) {
    const archivos = clase.archivos || {};
    const audios = new Set((clase.sesiones || []).map(s => s.archivo).filter(Boolean)).size;
    const lineas = [
        `· el XML que abre Premiere: ${nombreDeCarpeta(archivos.xml) || clase.secuencia}`,
        '· el archivo de datos, que es lo que la hace aparecer en esta lista',
        audios
            ? `· ${plural(audios, 'archivo de audio', 'archivos de audio')} de la grabación`
            : '· ningún audio: esta clase no dejó ninguno anotado'
    ];
    return {
        titulo: `Borrar ${comoSeLlama(clase)}${clase.curso ? ` · ${clase.curso}` : ''}`,
        mensaje: `Se borran del disco, y no van a la papelera:\n\n${lineas.join('\n')}\n\n` +
            `Están en ${clase.carpeta}. Esto no se puede deshacer: Cmd-Z no los devuelve.`,
        ok: 'Borrar'
    };
}
