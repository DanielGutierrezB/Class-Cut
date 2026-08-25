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
import { rev } from './visor/estado.js';
import { showDoctor } from './diagnostico.js';
import { init as initActualizar, buscar as buscarUpdate } from './actualizar.js';
import { refrescar as refrescarModelo } from './modelo.js';

async function init() {
    const info = await window.cc.appInfo();

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

    const procesar = async desdeCero => {
        await startProcessing(desdeCero);
        // La corrida baja el modelo al terminar (ver `engine/pipeline.js`), así
        // que el cabezal no puede seguir diciendo que está corriendo.
        refrescarModelo();
    };
    $('btn-process').onclick = () => procesar(false);
    // Tirar horas de transcripción no puede pasar por un clic distraído.
    $('btn-reprocess').onclick = async () => {
        const cuantas = state.scan.classes.filter(c => c.selected).length;
        const ok = await window.cc.confirmar({
            titulo: cuantas === 1 ? 'Reprocesar la clase marcada' : `Reprocesar ${cuantas} clases`,
            mensaje: 'Se ignora el trabajo guardado y se vuelve a hacer todo: transcribir el audio ' +
                'y leer la clase con el modelo. Puede tardar bastante.',
            ok: 'Reprocesar'
        });
        if (ok) await procesar(true);
    };
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

    // Elegir modelo solo tiene sentido con el criterio encendido.
    $('use-ai').onchange = e => { $('ai-model').disabled = !e.target.checked; };
    $('ai-model').onchange = () => refrescarModelo();
    await llenarModelos();
    await refrescarModelo();

    $('drawer-close').onclick = closeDrawer;
    $('btn-doctor').onclick = showDoctor;
    initActualizar(info.version);
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
            // Recién acá se sabe si el modelo levantó de verdad: el cabezal
            // venía mostrando con cuál se iba a correr.
            refrescarModelo();
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

/**
 * Los modelos que hay para elegir.
 *
 * La opción vacía queda primera y es la de siempre: el orden de preferencia ya
 * elige bien solo, y esto es para el editor que quiere imponer el suyo. Si no
 * hay ninguno, el selector se apaga en vez de mostrar una lista vacía.
 */
async function llenarModelos() {
    const select = $('ai-model');
    let lista = [];
    try {
        lista = await window.cc.modelos();
    } catch (e) {
        // Sin lista se sigue con "el mejor que haya", que es lo que ya hacía.
    }
    if (!lista.length) {
        select.disabled = true;
        select.title = 'No hay ningún modelo local instalado.';
        return;
    }
    for (const { model, own } of lista) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = own ? `${model} (de la app)` : model;
        select.append(option);
    }
}

// La puerta que usa `main.js --js=…` para manejar la ventana desde afuera (las
// capturas de pantalla del README salen así). Con módulos, lo que no esté acá no
// se puede tocar desde la línea de comandos, y eso es a propósito: antes era
// pública toda función que existiera.
window.dev = {
    addFolder, abrirClase: openDrawer, abrirVisor: openReview, buscarUpdate,
    // Para poder comparar desde afuera lo que se ve contra lo que dicen los
    // datos: sin esto, verificar el reproductor es mirar la pantalla y opinar.
    visor: () => rev
};

init().catch(err => {
    // Con clase y no con `style`: la política de seguridad descarta los atributos
    // de estilo, y esta es justo la pantalla que no puede salir ilegible.
    document.body.innerHTML = `<pre class="crash"></pre>`;
    document.querySelector('.crash').textContent = err.stack;
});
