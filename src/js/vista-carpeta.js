'use strict';
/** Paso 1: soltar o elegir la carpeta del curso. */

import { $, setStep, showView, toast } from './chrome.js';
import { state } from './estado.js';
import { renderScan } from './vista-clases.js';

export function dropError(message) {
    const el = $('drop-error');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
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
            volverAlPaso1((result && result.error) || 'No se pudo leer la carpeta.');
            return;
        }
        if (!result.classCount) {
            volverAlPaso1(`No encontré clases en "${result.rootName}". Busco carpetas que tengan un XML del Rodecaster con Audio y Video al lado.`);
            return;
        }
        state.scan = result;
        renderScan();
        showView('classes');
        setStep(2);
    } catch (err) {
        dropError(`Algo falló al escanear: ${err.message}`);
    } finally {
        state.scanning = false;
    }
}

function volverAlPaso1(message) {
    dropError(message);
    showView('drop');
    setStep(1);
}

export function wireDropzone() {
    const zone = $('dropzone');

    for (const evt of ['dragenter', 'dragover']) {
        document.addEventListener(evt, e => {
            e.preventDefault();
            if (!state.scan) zone.classList.add('is-over');
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
