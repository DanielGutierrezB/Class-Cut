'use strict';
/**
 * Lo que el visor tiene entre manos, y la forma de avisar que cambió.
 *
 * Los submódulos (onda, bordes, guion) tocan `rev` y llaman a `cambio()` sin
 * saber quién dibuja. Así ninguno tiene que importar al que los coordina, que es
 * lo que los volvería un círculo.
 */

export const rev = {
    data: null,
    id: null,
    segments: [],
    selected: 0,
    dirty: false,
    audio: null,
    tab: 'cortes',
    zoomWave: null,
    // Lo que el editor escribió revisando. Va aparte de `segments` porque no se
    // recalcula al guardar: sobrevive a mover bordes y a reprocesar la clase.
    notas: null,
    // La clase montada como una sola línea de tiempo, que arma el reproductor y
    // lee el panel de transcript para saber qué palabra va en qué momento.
    pista: null
};

/** El bloque que se está mirando ahora. */
export function actual() {
    return rev.segments[rev.selected] || null;
}

let dibujar = () => {};

/** Lo registra `index.js`: es el único que sabe redibujar el visor entero. */
export function alRedibujar(fn) {
    dibujar = fn;
}

/** "Cambió algo, mostralo". */
export function cambio() {
    dibujar();
}
