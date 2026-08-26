'use strict';
/** Lo que rodea a las vistas: pasos, avisos, toast y modal. */

import { esc } from './formato.js';

export const $ = id => document.getElementById(id);

/**
 * Anota algo en el diario de la sesión (`engine/registro.js`).
 *
 * Pasa por acá y no por `window.cc.anotar` directo para que un módulo de la
 * ventana se pueda importar desde `tests/run.js`, donde no hay puente: sin este
 * envoltorio, cargar `vista-clases.js` en una prueba se cae al primer clic
 * simulado. Anotar es lo último que puede tumbar nada.
 */
export function anotar(evento, datos) {
    if (window.cc && window.cc.anotar) window.cc.anotar(evento, datos || {});
}

// Quién está en cada paso del cabezal y a cuál se puede ir vive en `pasos.js`:
// dejó de ser "pintar el número que toca" cuando los pasos se volvieron
// navegables en las dos direcciones.

export function showView(name) {
    for (const el of document.querySelectorAll('.view')) {
        el.classList.toggle('is-visible', el.id === `view-${name}`);
    }
}

/**
 * ¿El editor está escribiendo?
 *
 * Los atajos de teclado del visor viven en el documento (para eso están: el foco
 * lo tiene lo último que se tocó, no el reproductor), así que cada uno tiene que
 * apartarse cuando el foco está en un campo de texto — la nota de un marcador y
 * la caja de comentarios son campos donde la barra espaciadora es un espacio.
 *
 * Vive acá y no en el reproductor porque ahora hay dos pestañas que atienden la
 * barra —"Ver la clase" y los cortes— y la regla tiene que ser una sola: con dos
 * copias, arreglar una deja la otra comiéndose los espacios del editor.
 */
export function estaEscribiendo(donde) {
    return Boolean(donde)
        && (donde.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(donde.tagName));
}

let toastTimer = null;
export function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function openModal(title, html) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    // El dueño anterior deja de valer: quien necesite reconocer "su" modal
    // abierto (p. ej. actualizar, para repintarlo) se marca después de abrir.
    delete $('modal').dataset.dueno;
    $('modal').hidden = false;
}

/**
 * Un aviso se ve igual venga de donde venga, así que lo dibuja un solo sitio.
 * El motor y el visor hablan la misma forma: `{level, message}`.
 */
export function alertsHtml(list) {
    return (list || [])
        .map(a => `<div class="alert alert-${a.level}"><span>${esc(a.message)}</span></div>`)
        .join('');
}
