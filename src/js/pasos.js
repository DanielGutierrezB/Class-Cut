'use strict';
/**
 * pasos.js — El cabezal como mapa, no como fila de un solo sentido.
 *
 * Los pasos eran cuatro carteles que solo se encendían al pasar por ellos: si
 * abrías una carpeta ya procesada, para llegar a Revisar había que procesarla de
 * nuevo, y de ahí no se podía volver a agregar otra. Cada paso se sentía
 * definitivo y ninguno lo es: agregar carpetas, mirar la tabla y revisar cortes
 * son sitios a los que se entra y se sale todo el tiempo.
 *
 * Ahora son botones. Cada uno pregunta si hay a dónde ir —una carpeta cargada,
 * una corrida hecha, una clase ya procesada— y si no hay, se apaga y lo dice en
 * el globito. Lo que decide eso vive acá; a dónde se va, lo cablea `app.js`,
 * porque este archivo no conoce ninguna vista.
 */

import { $ } from './chrome.js';
import { state, hayRevisable } from './estado.js';

export const PASOS = {
    carpetas: 1,
    clases: 2,
    procesar: 3,
    revisar: 4
};

let actual = PASOS.carpetas;
let irA = null;

/** Si se puede ir a un paso, y si no, por qué no. */
function alcance(n, corrida) {
    switch (n) {
        case PASOS.carpetas:
            return { puede: true, porque: 'Agregar otra carpeta o cambiar de curso' };
        case PASOS.clases:
            return state.carpetas.length
                ? { puede: true, porque: 'Las clases de las carpetas cargadas' }
                : { puede: false, porque: 'Todavía no agregaste ninguna carpeta' };
        case PASOS.procesar:
            return corrida
                ? { puede: true, porque: 'Cómo fue la última corrida' }
                : { puede: false, porque: 'Se llega procesando clases desde la tabla' };
        case PASOS.revisar:
            return hayRevisable()
                ? { puede: true, porque: 'Revisar los cortes de una clase ya procesada' }
                : { puede: false, porque: 'Ninguna clase está procesada todavía' };
        default: {
            const desconocido = n;
            throw new Error(`Paso sin definir: ${desconocido}`);
        }
    }
}

/**
 * Repinta el cabezal.
 *
 * @param {boolean} corrida si hubo un procesamiento en esta sesión
 */
export function refrescarPasos(corrida) {
    for (const boton of document.querySelectorAll('#steps .step')) {
        const n = Number(boton.dataset.step);
        const { puede, porque } = alcance(n, corrida);
        boton.classList.toggle('is-current', n === actual);
        boton.classList.toggle('is-done', n < actual && puede);
        boton.disabled = !puede || n === actual;
        boton.title = n === actual ? 'Estás acá' : porque;
    }
}

/** Deja marcado en qué paso estamos. Lo llaman las vistas al mostrarse. */
export function marcarPaso(n, corrida) {
    actual = n;
    refrescarPasos(Boolean(corrida));
}

export function pasoActual() {
    return actual;
}

/**
 * @param {object} params { irA: (n) => void, corrida: () => boolean }
 */
export function wirePasos(params) {
    irA = params.irA;
    for (const boton of document.querySelectorAll('#steps .step')) {
        boton.onclick = () => {
            const n = Number(boton.dataset.step);
            if (n !== actual && alcance(n, params.corrida()).puede) irA(n);
        };
    }
    refrescarPasos(params.corrida());
}
