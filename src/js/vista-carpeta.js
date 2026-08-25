'use strict';
/** Paso 1: soltar o elegir carpetas. Se pueden sumar todas las que hagan falta. */

import { $, toast } from './chrome.js';
import { state, clases, ponerCarpeta } from './estado.js';
import { plural } from './formato.js';
import { renderScan } from './vista-clases.js';

/** Lo llama `app.js` para poder llevar a la tabla sin importarse los pasos. */
let alCargar = () => {};

export function wireCarpeta(params) {
    alCargar = (params && params.alCargar) || (() => {});
    wireDropzone();
}

export function dropError(message) {
    const el = $('drop-error');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
}

/** Lo que ya está cargado, para no tener que ir a la tabla a saberlo. */
export function renderCargadas() {
    const caja = $('drop-cargadas');
    if (!state.carpetas.length) { caja.hidden = true; return; }
    $('drop-cargadas-info').textContent =
        `Ya tenés ${plural(state.carpetas.length, 'carpeta', 'carpetas')} · ` +
        `${plural(clases().length, 'clase', 'clases')}: ${state.carpetas.map(c => c.rootName).join(', ')}`;
    caja.hidden = false;
}

export async function addFolder(folder) {
    if (!folder || state.scanning) return;
    dropError('');
    state.scanning = true;
    $('dropzone').classList.remove('is-over');
    toast('Buscando clases…');

    try {
        const result = await window.cc.scan(folder);
        if (!result || !result.ok) {
            // Que ya esté cargada no es un error de la carpeta: es que no hay
            // nada que hacer. Se dice y se sigue mostrando lo que hay.
            const mensaje = (result && result.error) || 'No se pudo leer la carpeta.';
            if (result && result.yaCubierta) {
                toast(mensaje);
                if (state.carpetas.length) alCargar();
            } else {
                dropError(mensaje);
            }
            return;
        }
        if (!result.classCount) {
            dropError(`No encontré clases en "${result.rootName}". Busco carpetas que tengan un XML del Rodecaster con Audio y Video al lado.`);
            return;
        }

        ponerCarpeta(result, result.reemplaza);
        if (result.reemplaza && result.reemplaza.length) {
            toast(`"${result.rootName}" ya contenía lo que estaba cargado: se reemplazó.`);
        }
        renderCargadas();
        renderScan();
        alCargar();
    } catch (err) {
        dropError(`Algo falló al escanear: ${err.message}`);
    } finally {
        state.scanning = false;
    }
}

function wireDropzone() {
    const zone = $('dropzone');

    for (const evt of ['dragenter', 'dragover']) {
        document.addEventListener(evt, e => {
            e.preventDefault();
            // Se resalta siempre, no solo con la tabla vacía: soltar una segunda
            // carpeta es tan normal como soltar la primera.
            zone.classList.add('is-over');
        });
    }
    for (const evt of ['dragleave', 'dragend']) {
        document.addEventListener(evt, e => {
            e.preventDefault();
            if (e.relatedTarget === null) zone.classList.remove('is-over');
        });
    }

    document.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('is-over');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        const folder = window.cc.pathForFile(file);
        if (!folder) {
            dropError('No pude leer la ruta de lo que soltaste. Probá con el botón "Elegir carpeta…".');
            return;
        }
        addFolder(folder);
    });
}
