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
    escribirChip(chip, ai);
    chip.title = detalle(ai);
    chip.hidden = false;

    // El ✂ también toma el estado, porque el chip no está siempre: por debajo de
    // 1010px de ventana no entra en la barra, y "sin criterio" —el único estado
    // que pide hacer algo— es justo el que no se puede perder. La marca ya está
    // ahí y no ocupa un píxel más. Desde qué ancho se pone ámbar lo decide el
    // CSS: mientras el chip se vea, el aviso es del chip y el ✂ sigue azul.
    //
    // El globito solo cuando avisa: encima de una zona de arrastre no aparece
    // (la barra entera arrastra la ventana), así que mostrarlo cuesta quitarle
    // al arrastre el ancho del ✂, y hacer eso para no decir nada no va.
    const marca = document.querySelector('.brand-mark');
    const falta = ai.estado === 'falta';
    marca.classList.toggle('is-falta', falta);
    marca.title = falta ? detalle(ai) : '';
}

/**
 * El chip, en dos piezas: el modelo por un lado y de dónde sale por el otro.
 *
 * Separados porque cuando la barra se angosta el sufijo se esconde solo, con una
 * consulta de ancho y sin recalcular nada acá. Antes era un texto entero y lo
 * único que la barra podía hacer con él era recortarlo por la derecha, o sea
 * comerse el final del nombre del modelo —"thinking-high", que es justo lo que
 * distingue una corrida de otra— para conservar un "· Cursor" que también está
 * en el globito, en Ajustes y en Diagnóstico.
 */
function escribirChip(chip, ai) {
    if (ai.estado === 'falta') {
        chip.replaceChildren('sin criterio');
        return;
    }
    const { modelo, proveedor } = etiqueta(ai);
    if (!proveedor) {
        chip.replaceChildren(modelo);
        return;
    }
    const sufijo = document.createElement('span');
    sufijo.className = 'brand-model-prov';
    sufijo.textContent = ` · ${proveedor}`;
    chip.replaceChildren(modelo, sufijo);
}

/** El modelo y, si no es el local, por dónde: cambia el resultado y se ve. */
function etiqueta(ai) {
    // Sin el prefijo del fabricante: "claude-" no distingue nada en un chip que
    // ya dice Cursor o Claude al lado, y esos píxeles empujaban al resto.
    const corto = String(ai.model || '').replace(/^claude-/, '');
    switch (ai.proveedor) {
        case 'cursor': return { modelo: corto, proveedor: 'Cursor' };
        case 'anthropic': return { modelo: corto, proveedor: 'Claude' };
        case 'local':
        default:
            // Los estados viejos venían sin proveedor: eran siempre el local.
            return { modelo: String(ai.model || ''), proveedor: null };
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
