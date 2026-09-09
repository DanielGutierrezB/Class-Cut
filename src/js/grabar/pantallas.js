'use strict';
/**
 * pantallas.js — Las dos mitades del paso "Grabar", y cuándo se puede volver.
 *
 * El paso entraba directo a la toma de notas, con la lista de lo ya grabado
 * colgando abajo, y las dos cosas se estorbaban. Arriba, la clase en curso pedía
 * la pantalla entera —es la que está pasando— y abajo la lista la pedía también,
 * porque es donde se busca una clase de anteayer. Con seis clases viejas
 * desplegadas, la toma que estaba grabando quedaba debajo del pliegue, y el
 * remedio de entonces fue plegar la lista sola al empezar a grabar: un mecanismo
 * que movía la pantalla sin que nadie lo pidiera, para tapar que las dos mitades
 * no cabían juntas.
 *
 * Ahora son dos pantallas y el paso entra por la lista, que es lo que hay antes
 * de que exista una clase: lo que está en la carpeta, y un botón para empezar
 * otra. **"Comenzar clase" no arranca ninguna toma**: entra a la interfaz de toma
 * de notas, con el micrófono abierto y el medidor sonando, y grabar sigue siendo
 * "Iniciar grabación" ahí adentro. Son dos decisiones distintas —entrar a
 * trabajar, y comprometer el archivo— y estaban en el mismo botón.
 *
 * Y no son dos pasos del cabezal, que era la otra forma de hacerlo. "Grabar" es
 * un paso, una sola cosa en la cabeza de quien lo usa; estas dos son dos momentos
 * suyos. Como pasos, volver a la lista se leería como retroceder en el trabajo, y
 * `marcarPaso` tendría que elegir a cuál de los dos señala.
 */

import { $ } from '../chrome.js';

export const LISTA = 'lista';
export const TOMA = 'toma';

const CAJAS = { [LISTA]: 'grabar-pantalla-lista', [TOMA]: 'grabar-pantalla-toma' };

let puesta = LISTA;

/** Cuál de las dos se está viendo. */
export function cual() {
    return puesta;
}

/**
 * Muestra una de las dos.
 *
 * Con el atributo `hidden` y no con una clase: las dos son hermanas dentro de la
 * misma `.view`, y `hidden` ya quiere decir exactamente esto. La hoja se encarga
 * de que gane sobre el `display: flex` de la caja (ver `grabar.css`).
 */
export function mostrar(quien) {
    puesta = quien === TOMA ? TOMA : LISTA;
    for (const [nombre, id] of Object.entries(CAJAS)) $(id).hidden = nombre !== puesta;
}

/**
 * Por qué no se puede volver a la lista todavía, o null si se puede.
 *
 * **Volver está cerrado mientras se graba, y el botón lo dice en vez de no hacer
 * nada.** No es una limitación técnica —el motor aguanta que la ventana cambie de
 * paso, y de hecho `abrirGrabar` reencuentra la sesión al volver—: es que la lista
 * de allá es la pantalla de GESTIONAR clases, y de la clase que se está grabando
 * no hay nada que gestionar. No aparece en ella (el motor la esconde para no
 * mostrarla dos veces, ver `listar`) y es la única que no se puede renombrar ni
 * borrar. O sea que volver mientras se graba sería salir a administrar justo lo
 * único que no se deja tocar, y encima dejando fuera de la vista la toma que
 * está corriendo.
 *
 * Terminar es lo que abre la puerta, y en el mismo gesto la clase pasa a la
 * lista: es lo que hace que volver signifique algo.
 *
 * Es una función y no un booleano en la vista porque el motivo se muestra: un
 * botón apagado sin explicación es la misma sorpresa que un botón que no
 * responde. Y es pura —recibe el estado y devuelve texto— para poder probarla sin
 * pantalla.
 *
 * @param {object|null} estado el resumen del motor
 * @param {boolean} [terminando] "Terminar" apretado y esperando al motor
 * @returns {string|null}
 */
export function porQueNoSeVuelve(estado, terminando) {
    if (terminando) {
        return 'Esperá: se están releyendo las últimas tomas con el modelo grande. ' +
            'Cuando el XML quede escrito, la clase aparece en la lista.';
    }
    if (estado && estado.grabando) {
        return 'Terminá la toma de notas para volver. Mientras se graba, esta clase no está ' +
            'en la lista y es la única que no se puede renombrar ni borrar: volver sería ' +
            'salir a gestionar lo único que no se deja tocar, y dejar la toma en curso ' +
            'fuera de la vista.';
    }
    return null;
}
