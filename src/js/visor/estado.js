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
    /**
     * En qué pestaña se entra.
     *
     * Arranca en el reproductor y no en la lista de cortes porque validar una
     * clase es MIRARLA: la lista dice qué decidió la máquina, y eso recién
     * importa cuando ya viste que la clase se entiende de corrido. Entrar por
     * los cortes obligaba a apretar "Ver la clase" cada vez, trece veces por
     * curso.
     *
     * Vive acá, en el estado del visor, y no se reinicia al cambiar de clase: en
     * cuanto el editor elige otra pestaña —a mano o saltando desde el guion—,
     * `setReviewTab` deja su elección acá y abrir la clase siguiente respeta lo
     * que estaba mirando. Es "el default es el reproductor", no "siempre el
     * reproductor".
     */
    tab: 'clase',
    zoomWave: null,
    // Lo que el editor escribió revisando. Va aparte de `segments` porque no se
    // recalcula al guardar: sobrevive a mover bordes y a reprocesar la clase.
    notas: null,
    // La clase montada como una sola línea de tiempo, que arma el reproductor y
    // lee el panel de transcript para saber qué palabra va en qué momento.
    pista: null,
    // Las clases cuyo XML quedó atrasado respecto de lo que se escribió, medido
    // por el motor. Está acá para que el botón de guardar pueda decir a cuántas
    // va a tocar ANTES de apretarlo.
    atrasadas: null
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
