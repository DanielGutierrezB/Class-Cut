'use strict';
/**
 * app.js — La ventana. No sabe leer discos ni medir video: le pide todo al
 * proceso principal por `window.cc` (preload) y se ocupa de dibujar.
 *
 * Acá solo está el cableado: qué botón llama a qué. Cada paso vive en su
 * archivo.
 */

import { $, showView, anotar } from './chrome.js';
import { state, clases, findClass, quitarCarpeta } from './estado.js';
import { addFolder, dropError, wireCarpeta, renderCargadas } from './vista-carpeta.js';
import {
    renderScan, renderAlerts, renderRows, renderFoot, wireClases, openDrawer, closeDrawer,
    actualizarDuracion
} from './vista-clases.js';
import { run, startProcessing, alAvanzarEtapa, alCambiarClase } from './vista-corrida.js';
import { openReview, wireReview } from './visor/index.js';
import { cerrarReproductor } from './visor/reproductor.js';
import { rev } from './visor/estado.js';
import { marcarPaso, refrescarPasos, wirePasos, PASOS } from './pasos.js';
import { showDoctor } from './diagnostico.js';
import { showAjustes } from './ajustes.js';
import { init as initActualizar, buscar as buscarUpdate } from './actualizar.js';
import { refrescar as refrescarModelo } from './modelo.js';

/** ¿Hubo una corrida en esta sesión? Es lo que hace visitable el paso 3. */
const huboCorrida = () => run.total > 0;

/** Ir a un paso. Es lo único que sabe atar una vista con la de al lado. */
function irAPaso(n) {
    anotar('paso', { a: n, carpetas: state.carpetas.length, clases: clases().length });
    switch (n) {
        case PASOS.carpetas:
            closeDrawer();
            cerrarReproductor();
            dropError('');
            renderCargadas();
            showView('drop');
            marcarPaso(PASOS.carpetas, huboCorrida());
            return;
        case PASOS.clases:
            cerrarReproductor();
            renderScan();
            showView('classes');
            marcarPaso(PASOS.clases, huboCorrida());
            return;
        case PASOS.procesar:
            cerrarReproductor();
            showView('run');
            marcarPaso(PASOS.procesar, huboCorrida());
            return;
        case PASOS.revisar:
            // El visor decide con qué clase abre y marca su propio paso.
            openReview(null);
            return;
        default: {
            const desconocido = n;
            throw new Error(`Paso sin manejar: ${desconocido}`);
        }
    }
}

/**
 * Saca una carpeta de la lista. No borra nada del disco: lo que se hizo sigue
 * guardado en la carpeta de cada clase, y volver a agregarla lo recupera.
 */
async function sacarCarpeta(root) {
    closeDrawer();
    // El motor anota la suya; esta línea dice que salió de un clic en la tabla
    // y no de que una carpeta se cayera del disco.
    anotar('tabla.quitar-carpeta', { carpeta: root });
    await window.cc.quitarCarpeta(root);
    quitarCarpeta(root);
    if (!state.carpetas.length) { irAPaso(PASOS.carpetas); return; }
    renderScan();
    refrescarPasos(huboCorrida());
}

async function init() {
    const info = await window.cc.appInfo();

    wireCarpeta({ alCargar: () => irAPaso(PASOS.clases) });
    wireClases({ alQuitarCarpeta: sacarCarpeta });
    wireReview({ alVolver: () => irAPaso(PASOS.clases) });
    wirePasos({ irA: irAPaso, corrida: huboCorrida });

    $('btn-pick').onclick = async () => {
        const folder = await window.cc.pickFolder();
        if (folder) addFolder(folder);
    };
    $('btn-add-folder').onclick = () => irAPaso(PASOS.carpetas);
    $('btn-ver-clases').onclick = () => irAPaso(PASOS.clases);

    const marcarTodas = on => {
        for (const c of clases()) c.selected = on && c.processable;
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
        // Y ahora hay clases procesadas: el paso de Revisar se puede visitar.
        refrescarPasos(huboCorrida());
    };
    $('btn-process').onclick = () => procesar(false);
    // Tirar horas de transcripción no puede pasar por un clic distraído.
    $('btn-reprocess').onclick = async () => {
        const cuantas = clases().filter(c => c.selected).length;
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
        irAPaso(PASOS.clases);
        $('btn-cancel').disabled = false;
    };
    $('btn-open-output').onclick = () => {
        // Si la corrida mezcló carpetas, se abren todas: la mitad de los XML en
        // una carpeta que no se abre es peor que abrir dos ventanas del Finder.
        for (const salida of state.salidas) window.cc.openPath(salida.dir);
    };
    $('btn-review').onclick = () => openReview(state.reviewFirst);

    // Elegir modelo solo tiene sentido con el criterio encendido.
    $('use-ai').onchange = e => { $('ai-model').disabled = !e.target.checked; };
    $('ai-model').onchange = () => refrescarModelo();
    await llenarModelos();
    await refrescarModelo();

    $('drawer-close').onclick = closeDrawer;
    $('btn-doctor').onclick = showDoctor;
    $('btn-ajustes').onclick = showAjustes;
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
        // Se busca comparando y no con un selector: el id de una clase es la ruta
        // de su carpeta, y una ruta trae barras, espacios y cualquier cosa que el
        // editor haya escrito. Son trece celdas.
        actualizarDuracion(p.id, p.durationSec);

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
        if (p.done === p.total && state.carpetas.length) {
            renderAlerts();
            renderRows();
            renderFoot();
        }
    });

    window.cc.onProcessStage(alAvanzarEtapa);

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
        alCambiarClase(payload);
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
    visor: () => rev,
    // Lo mismo para la barra de la corrida: si avanza o no avanza es una
    // cuenta, y desde una captura de pantalla no se puede comprobar.
    corrida: () => run
};

init().catch(err => {
    // Antes de dibujar nada: si la ventana se cayó al arrancar, esta línea es
    // lo único que va a explicar por qué, y el registro sobrevive porque vive
    // del otro lado del puente.
    anotar('ventana.se-cayo', { mensaje: err && err.message });
    // Con clase y no con `style`: la política de seguridad descarta los atributos
    // de estilo, y esta es justo la pantalla que no puede salir ilegible.
    document.body.innerHTML = `<pre class="crash"></pre>`;
    document.querySelector('.crash').textContent = err.stack;
});
