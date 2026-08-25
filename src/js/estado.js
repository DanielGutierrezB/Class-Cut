'use strict';
/**
 * Lo que la ventana sabe entre vistas: qué carpetas se cargaron, qué clase está
 * abierta y a dónde fue a parar lo exportado.
 *
 * Vive aparte para que las vistas no tengan que importarse entre ellas solo para
 * leer el escaneo.
 *
 * Son VARIAS carpetas, no una: el editor puede tener cargado el curso de un
 * cliente y el día que grabó de otro, y una tabla sola con todo mezclado no le
 * sirve — por eso la tabla agrupa y cada clase sabe de qué carpeta es. Que no se
 * solapen lo garantiza el motor (`engine/carpetas.js`).
 */

export const state = {
    /** Escaneos cargados, en el orden en que se agregaron. */
    carpetas: [],
    openId: null,
    scanning: false,
    salidas: [],
    reviewFirst: null
};

/** Todas las clases de todas las carpetas, en el orden en que se cargaron. */
export function clases() {
    return state.carpetas.flatMap(c => c.classes);
}

export function findClass(id) {
    return clases().find(c => c.id === id) || null;
}

/** La carpeta de la que salió una clase. */
export function carpetaDe(cls) {
    return state.carpetas.find(c => c.root === (cls && cls.root)) || null;
}

/** Las clases marcadas para procesar. */
export function marcadas() {
    return clases().filter(c => c.selected);
}

/** ¿Hay algo ya procesado que se pueda ir a revisar? */
export function hayRevisable() {
    return clases().some(c => c.alreadyProcessed || (c.trabajoGuardado && c.trabajoGuardado.sirve));
}

/**
 * Suma o reemplaza una carpeta, respetando lo que decidió el motor.
 *
 * `reemplaza` son las raíces que la nueva deja sin sentido por contenerlas: se
 * quitan acá para que la ventana muestre exactamente lo que quedó cargado allá.
 */
export function ponerCarpeta(scan, reemplaza) {
    const fuera = new Set([...(reemplaza || []), scan.root]);
    state.carpetas = state.carpetas.filter(c => !fuera.has(c.root));
    state.carpetas.push(scan);
}

export function quitarCarpeta(root) {
    state.carpetas = state.carpetas.filter(c => c.root !== root);
}
