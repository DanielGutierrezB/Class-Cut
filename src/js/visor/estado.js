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

/* ─── Deshacer y rehacer ────────────────────────────────────────────────── */

/**
 * Las fotos de los cortes, antes y después de cada cambio.
 *
 * Se guarda el estado ENTERO y no qué se tocó, porque acá el estado es chico —los
 * bloques de una clase, veinticinco en la más larga del curso— y un historial de
 * acciones que se deshacen una por una es la clase de código donde una acción mal
 * invertida deja los cortes en algo que nunca existió, sin que nada lo diga.
 * Copiando, deshacer no puede inventar un estado: solo puede volver a uno que ya
 * estuvo en pantalla.
 *
 * Se guarda también cuál bloque estaba elegido: deshacer sin volver a lo que se
 * estaba mirando obliga a buscar dónde pasó lo que se acaba de deshacer.
 */
const historia = { atras: [], adelante: [] };

/** Cuántos pasos atrás se pueden dar. Cada foto pesa lo que pesa un cutplan. */
const TOPE = 60;

function foto() {
    return {
        segments: rev.segments.map(s => ({ ...s })),
        selected: rev.selected,
        dirty: rev.dirty
    };
}

function poner(f) {
    rev.segments = f.segments.map(s => ({ ...s }));
    rev.selected = Math.max(0, Math.min(f.selected, rev.segments.length - 1));
    rev.dirty = f.dirty;
}

/**
 * Hace un cambio sobre los cortes dejándolo anotado para poder volver.
 *
 * Todo lo que toca el corte pasa por acá: mover un borde, sacar un bloque,
 * cambiar la vista, marcar revisado, volver a lo calculado. Los cambios que solo
 * mueven la selección NO pasan —elegir otro bloque no es una edición y llenaría
 * el historial de pasos que no cambian nada—.
 *
 * @param {string} que qué se hizo, para poder decirlo al deshacerlo
 * @param {Function} hacer la edición, sobre `rev.segments`
 */
export function editar(que, hacer) {
    const antes = foto();
    hacer();
    antes.que = que;
    historia.atras.push(antes);
    if (historia.atras.length > TOPE) historia.atras.shift();
    // Rehacer solo tiene sentido sobre lo que se deshizo: si después de deshacer
    // se edita otra cosa, ese futuro dejó de existir.
    historia.adelante.length = 0;
    rev.dirty = true;
    cambio();
}

/** @returns {string|null} qué se deshizo, o null si no había nada */
export function deshacer() {
    const paso = historia.atras.pop();
    if (!paso) return null;
    historia.adelante.push({ ...foto(), que: paso.que });
    poner(paso);
    cambio();
    return paso.que;
}

/** @returns {string|null} qué se rehizo, o null si no había nada */
export function rehacer() {
    const paso = historia.adelante.pop();
    if (!paso) return null;
    historia.atras.push({ ...foto(), que: paso.que });
    poner(paso);
    cambio();
    return paso.que;
}

/**
 * Arranca de cero el historial.
 *
 * Lo llama quien abre una clase, y no es opcional: las fotos son de LOS BLOQUES
 * DE ESA CLASE, así que deshacer con el historial de la anterior metería los
 * cortes de una clase adentro de otra.
 */
export function olvidarHistoria() {
    historia.atras.length = 0;
    historia.adelante.length = 0;
}

/** Para saber si hay algo que deshacer o rehacer, sin tocar el historial. */
export function pasos() {
    return { atras: historia.atras.length, adelante: historia.adelante.length };
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
