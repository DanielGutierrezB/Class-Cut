'use strict';
/** Lo que rodea a las vistas: pasos, avisos, toast y modal. */

import { esc } from './formato.js';

export const $ = id => document.getElementById(id);

export function setStep(current) {
    for (const el of document.querySelectorAll('.step')) {
        const n = Number(el.dataset.step);
        el.classList.toggle('is-current', n === current);
        el.classList.toggle('is-done', n < current);
    }
}

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
