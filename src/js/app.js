'use strict';
/**
 * app.js — La ventana. No sabe leer discos ni medir video: le pide todo al
 * proceso principal por `window.cc` (preload) y se ocupa de dibujar.
 *
 * Acá solo está el cableado: qué botón llama a qué. Cada paso vive en su
 * archivo.
 */

import { $, setStep, showView } from './chrome.js';
import { fmtDur } from './formato.js';
import { state, findClass } from './estado.js';
import { addFolder, dropError, wireDropzone } from './vista-carpeta.js';
import {
    renderAlerts, renderRows, renderFoot, wireClases, openDrawer, closeDrawer
} from './vista-clases.js';
import { run, startProcessing, renderRunRows, renderRunFoot } from './vista-corrida.js';
import { openReview, wireReview } from './visor/index.js';
import { showDoctor } from './diagnostico.js';

async function init() {
    const info = await window.cc.appInfo();
    $('version').textContent = `v${info.version}`;

    wireDropzone();
    wireClases();
    wireReview();

    $('btn-pick').onclick = async () => {
        const folder = await window.cc.pickFolder();
        if (folder) addFolder(folder);
    };
    $('btn-change').onclick = () => {
        closeDrawer();
        state.scan = null;
        dropError('');
        showView('drop');
        setStep(1);
    };

    const marcarTodas = on => {
        for (const c of state.scan.classes) c.selected = on && c.processable;
        renderRows();
        renderFoot();
    };
    $('btn-select-all').onclick = () => marcarTodas(true);
    $('btn-select-none').onclick = () => marcarTodas(false);
    $('check-all').onclick = e => marcarTodas(e.target.checked);

    $('btn-process').onclick = startProcessing;
    $('btn-cancel').onclick = async () => {
        run.cancelling = true;
        $('btn-cancel').disabled = true;
        $('run-sub').textContent = 'Cancelando: se termina la clase que está en curso.';
        await window.cc.cancelProcess();
    };
    $('btn-back').onclick = () => {
        showView('classes');
        setStep(2);
        $('btn-cancel').disabled = false;
    };
    $('btn-open-output').onclick = () => {
        if (state.outputDir) window.cc.openPath(state.outputDir);
    };
    $('btn-review').onclick = () => openReview(state.reviewFirst);

    $('drawer-close').onclick = closeDrawer;
    $('btn-doctor').onclick = showDoctor;
    $('modal-close').onclick = () => { $('modal').hidden = true; };
    $('modal').onclick = e => { if (e.target.id === 'modal') $('modal').hidden = true; };

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!$('modal').hidden) $('modal').hidden = true;
        else if (!$('drawer').hidden) closeDrawer();
    });

    // Las duraciones llegan de a una mientras ffprobe mide: la tabla ya está en
    // pantalla y se va completando sola.
    window.cc.onScanProgress(p => {
        const cell = document.querySelector(`[data-dur="${p.id}"]`);
        if (cell) cell.textContent = fmtDur(p.durationSec);

        const cls = findClass(p.id);
        if (cls) {
            Object.assign(cls, {
                durationSec: p.durationSec,
                fps: p.fps,
                problems: p.problems,
                warnings: p.warnings,
                processable: p.processable
            });
        }
        if (p.done === p.total && state.scan) {
            renderAlerts();
            renderRows();
            renderFoot();
        }
    });

    window.cc.onProcessStage(payload => {
        const entry = run.rows.get(payload.id);
        if (!entry) return;
        entry.status = 'trabajando';
        entry.stage = payload.stage;
        entry.percent = payload.percent != null ? payload.percent : null;
        renderRunRows();
    });

    window.cc.onProcessClass(payload => {
        // 'modelo' es de la corrida entera y no de una clase; lo que haya que
        // decir al respecto ya viaja como aviso en la primera.
        if (payload.phase === 'modelo') {
            run.modelo = payload.modelo;
            return;
        }
        const entry = run.rows.get(payload.id);
        if (!entry) return;
        if (payload.phase === 'empieza') {
            entry.status = 'trabajando';
        } else {
            entry.status = 'listo';
            entry.result = payload.result;
            entry.stage = null;
            entry.percent = null;
        }
        renderRunRows();
        renderRunFoot();
    });
}

// La puerta que usa `main.js --js=…` para manejar la ventana desde afuera (las
// capturas de pantalla del README salen así). Con módulos, lo que no esté acá no
// se puede tocar desde la línea de comandos, y eso es a propósito: antes era
// pública toda función que existiera.
window.dev = { addFolder, abrirClase: openDrawer, abrirVisor: openReview };

init().catch(err => {
    document.body.innerHTML = `<pre style="padding:24px;color:#f2646b">${err.stack}</pre>`;
});
