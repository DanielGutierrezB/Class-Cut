'use strict';
/** Lo que rodea a las vistas: pasos, avisos, toast y modal. */

import { esc } from './formato.js';

export const $ = id => document.getElementById(id);

// Quién está en cada paso del cabezal y a cuál se puede ir vive en `pasos.js`:
// dejó de ser "pintar el número que toca" cuando los pasos se volvieron
// navegables en las dos direcciones.

export function showView(name) {
    for (const el of document.querySelectorAll('.view')) {
        el.classList.toggle('is-visible', el.id === `view-${name}`);
    }
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
