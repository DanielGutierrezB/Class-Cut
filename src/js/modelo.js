'use strict';
/**
 * modelo.js — Con qué modelo local está corriendo la app, en el cabezal.
 *
 * A la vista siempre porque cambia el resultado: la misma clase cortada con el
 * modelo grande y con el chico no da lo mismo, y hasta ahora había que abrir
 * Diagnóstico para saber con cuál se hizo.
 *
 * Lo contesta el motor y no el selector de Ajustes: lo que el editor eligió es
 * una preferencia, y si ese modelo ya no está en el disco se corre con otro.
 */

import { $ } from './chrome.js';

const ESTADOS = ['is-corriendo', 'is-listo', 'is-falta'];

/**
 * Vuelve a preguntar con qué se está corriendo y lo deja escrito en el cabezal.
 *
 * Se llama en los momentos en que puede haber cambiado: al abrir la app, cuando
 * el modelo termina de levantar, cuando la corrida lo baja y cuando el editor
 * elige otro. No hay aviso que escuchar porque el modelo no cambia solo.
 */
export async function refrescar() {
    const chip = $('brand-model');
    let ai;
    try {
        // La preferencia vive en el selector de la vista de clases; el motor no
        // la conoce y sin ella contestaría el mejor del orden de preferencia.
        ai = await window.cc.modelo($('ai-model').value || null);
    } catch (e) {
        // Sin respuesta es mejor no decir nada que decir algo falso: el cabezal
        // queda como estaba.
        return;
    }

    chip.classList.remove(...ESTADOS);
    chip.classList.add(`is-${ai.estado}`);
    chip.textContent = ai.estado === 'falta' ? 'sin criterio' : etiqueta(ai);
    chip.title = detalle(ai);
    chip.hidden = false;
}

/** El modelo y, si no es el local, por dónde: cambia el resultado y se ve. */
function etiqueta(ai) {
    // Sin el prefijo del fabricante: "claude-" no distingue nada en un chip que
    // ya dice Cursor o Claude al lado, y esos píxeles empujaban al resto.
    const corto = String(ai.model || '').replace(/^claude-/, '');
    switch (ai.proveedor) {
        case 'cursor': return `${corto} · Cursor`;
        case 'anthropic': return `${corto} · Claude`;
        case 'local':
        default:
            // Los estados viejos venían sin proveedor: eran siempre el local.
            return ai.model;
    }
}

function detalle(ai) {
    switch (ai.estado) {
        // `reason` ya trae el modelo y de dónde salió —el que viene con la app o
        // el que el editor ya tenía—, así que acá solo falta el estado.
        case 'corriendo':
            return `Está corriendo. ${ai.reason}`;
        case 'listo':
            return ai.reason;
        case 'falta':
            return `${ai.reason} Los cortes salen con las reglas solas, sin criterio en los casos dudosos.`;
        default: {
            const desconocido = ai.estado;
            return `Estado desconocido: ${desconocido}.`;
        }
    }
}
