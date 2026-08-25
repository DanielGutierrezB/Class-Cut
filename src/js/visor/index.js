'use strict';
/**
 * Paso 4: revisar los cortes antes de dar la clase por buena.
 *
 * Este archivo coordina; lo que dibuja está en `onda`, `bordes` y `guion`.
 */

import { $, showView, toast, anotar } from '../chrome.js';
import { esc, fmtClock, fmtDur, plural } from '../formato.js';
import { state, clases } from '../estado.js';
import { marcarPaso, PASOS } from '../pasos.js';
import { rev, actual, alRedibujar, cambio } from './estado.js';
import { renderOverview, renderZoom } from './onda.js';
import { setEdge, renderEdges, renderDecided, renderTranscript, playEdge } from './bordes.js';
import { renderScript, wireGuion } from './guion.js';
import { abrirReproductor, cerrarReproductor, refrescarBloques, wireReproductor } from './reproductor.js';
import { ajustarDivision, wireDivision } from './division.js';
import { wireLetra } from './panel-letra.js';
import { aireEn } from './letra.js';
import { comentariosEn } from './pista.js';

/** Las que se pueden abrir: las que tienen algo hecho, de cualquier carpeta. */
function revisables() {
    return clases().filter(c => c.alreadyProcessed || (c.trabajoGuardado && c.trabajoGuardado.sirve));
}

/**
 * Abre el visor.
 *
 * Sin id se elige sola: la marcada que esté procesada, y si no, cualquiera que
 * lo esté. Antes hacía falta pasar por una corrida para llegar acá, así que
 * abrir una carpeta ya procesada obligaba a procesarla de nuevo para poder
 * mirarla.
 */
export async function openReview(id) {
    const listas = revisables();
    const target = id
        || (listas.find(c => c.selected) || listas[0] || {}).id;
    if (!target) {
        toast('Ninguna clase está procesada todavía.');
        return;
    }

    // Los bordes movidos y sin guardar viven solo acá: abrir otra clase reemplaza
    // `rev.segments` con su plan y se van sin dejar rastro. Se pregunta acá y no
    // en el selector porque a otra clase se llega también desde la tabla, y por
    // esa puerta se perdían igual.
    if (rev.dirty && rev.id && target !== rev.id && !(await resolverBordesSinGuardar())) return;

    // Cambiar de clase con el reproductor abierto: lo de la clase anterior se
    // suelta antes de cargar nada, o queda un video de 15 GB sonando sin dueño.
    cerrarReproductor();

    showView('review');
    marcarPaso(PASOS.revisar, true);
    $('rev-title').textContent = 'Cargando…';

    // Los cubos de la onda: uno por píxel del canvas y no más. Eran 2400 para
    // una silueta que se dibuja en unos 860 px, así que dos tercios se leían del
    // disco, viajaban por el puente y se descartaban al juntarlos por columna.
    const data = await window.cc.loadReview({ id: target, buckets: 1200 });
    if (!data.ok) {
        // Sin esto quedan los datos de la clase anterior y el resto del visor
        // sigue mostrándolos bajo un título que dice que no se pudo abrir: el
        // reproductor llegaría a poner el video de otra clase.
        rev.data = null;
        rev.segments = [];
        rev.id = null;
        rev.notas = null;
        rev.pista = null;
        $('rev-title').textContent = 'No se pudo abrir';
        $('rev-sub').textContent = data.error;
        return;
    }

    rev.data = data;
    rev.id = target;
    rev.dirty = false;
    // De la clase anterior, y hasta que el motor contesta por esta.
    rev.atrasadas = null;
    rev.zoomWave = null;
    rev.notas = data.notas || { bloques: {}, comentarios: [] };
    rev.pista = null;
    // Se trabaja sobre una copia: hasta que no se guarda, el plan del disco es el
    // que vale y "Volver a lo calculado" tiene de dónde volver.
    rev.segments = data.cutplan.segments.map(s => ({ ...s, original: { ...s } }));
    rev.selected = Math.max(0, rev.segments.findIndex(s => s.confidence !== 'alta'));

    fillClassPicker();
    // Sin `|| 'cortes'`: el default vive en `rev.tab` (ver `visor/estado.js`) y
    // acá lo único que corresponde es respetar lo que haya, que la primera vez
    // es el reproductor y después es lo que el editor eligió.
    setReviewTab(rev.tab);
    renderReview();
    refrescarAtrasadas();
}

/**
 * Qué hacer con los bordes sin guardar cuando el editor se va a otra clase.
 *
 * Lo que escribió ya está en disco —las notas y los comentarios se guardan al
 * escribirlos—, pero los bordes no: son los únicos cambios que existen solo en
 * memoria. Guardar solo escribiría un XML que nadie pidió, y seguir de largo es
 * la pérdida silenciosa que estamos sacando de la app, así que decide el editor.
 *
 * @returns {Promise<boolean>} si se puede seguir y cambiar de clase
 */
async function resolverBordesSinGuardar() {
    const elegida = await window.cc.preguntar({
        titulo: `La clase ${rev.data.classNumber} tiene bordes sin guardar`,
        mensaje: 'Lo que escribiste ya está guardado. Los bordes que movés, no: viven en esta pantalla hasta que guardás. Si cambiás de clase ahora, esos ajustes se van.',
        opciones: ['Guardar y cambiar', 'Cambiar sin guardar']
    });
    if (elegida === 0) return saveReviewChanges();
    if (elegida === 1) return true;
    // Canceló: el selector ya se movió a la otra clase y hay que devolverlo.
    fillClassPicker();
    return false;
}

/**
 * Cuántas clases más va a dejar al día el botón de guardar.
 *
 * Se le pregunta al motor en vez de deducirlo acá: la señal es la fecha de lo
 * que se escribió contra la del XML exportado, y eso está en el disco, que la
 * ventana no ve. Se pide al abrir una clase y después de guardar, que son los
 * dos momentos en que el número puede haber cambiado.
 */
async function refrescarAtrasadas() {
    if (!rev.id) return;
    const pedida = rev.id;
    const atrasadas = await window.cc.pendientes(pedida);
    // Cambiar de clase mientras esto viajaba deja una respuesta que ya no es de
    // la clase abierta: contarla sería anunciar el trabajo de otra.
    if (rev.id !== pedida) return;
    rev.atrasadas = atrasadas;
    renderReviewHead();
}

/**
 * El selector de clase, agrupado por carpeta.
 *
 * Con varias cargadas, una lista plana de "Clase 1, Clase 1, Clase 2…" no dice
 * de dónde es cada una; los grupos del `<select>` lo resuelven sin ocupar sitio.
 */
function fillClassPicker() {
    const opcion = c => `<option value="${esc(c.id)}" ${c.id === rev.id ? 'selected' : ''}>` +
        `Clase ${c.classNumber} · ${esc(c.sequenceName)}</option>`;

    const porCarpeta = state.carpetas
        .map(scan => ({ scan, suyas: scan.classes.filter(c => c.processable) }))
        .filter(g => g.suyas.length);

    $('rev-class').innerHTML = porCarpeta.length > 1
        ? porCarpeta.map(g =>
            `<optgroup label="${esc(g.scan.rootName)}">${g.suyas.map(opcion).join('')}</optgroup>`).join('')
        : porCarpeta.map(g => g.suyas.map(opcion).join('')).join('');
}

/**
 * Qué clase es, qué queda por revisar y qué va a hacer Guardar.
 *
 * Va aparte del resto porque se repinta solo: cuando llega la cuenta de clases
 * atrasadas no hay por qué volver a dibujar las ondas de la clase entera.
 */
function renderReviewHead() {
    const pending = rev.segments.filter(s => s.keep && s.confidence !== 'alta').length;

    $('rev-title').textContent = `Clase ${rev.data.classNumber} · ${plural(rev.segments.filter(s => s.keep).length, 'bloque', 'bloques')}`;
    $('rev-sub').textContent = (pending
        ? `${plural(pending, 'bloque para revisar', 'bloques para revisar')}${rev.dirty ? ' · hay cambios sin guardar' : ''}`
        : (rev.dirty ? 'Hay cambios sin guardar' : 'Todo revisado')) + textoDeAtrasadas();

    pintarBotonDeGuardar();
}

function renderReview() {
    renderReviewHead();
    renderReviewList();
    renderOverview();
    renderZoom();
    renderEdges();
    renderDecided();
    renderTranscript();
    if (rev.tab === 'guion') renderScript();
    // La tira del reproductor marca qué bloques tienen comentario, así que un
    // comentario nuevo tiene que verse ahí sin salir y volver a entrar.
    if (rev.tab === 'clase') refrescarBloques();
}

/** Cuánto aire muerto tiene un bloque, para avisarlo en la lista. */
function aireDe(segment) {
    if (!segment.keep || !rev.data || !rev.data.silencios) return 0;
    // El mínimo viene de la medición: por debajo de eso es respirar entre frases.
    return aireEn(rev.data.silencios.tramos, segment.sourceStartSec, segment.sourceEndSec,
        rev.data.silencios.minimoSec);
}

/** Cuántos comentarios escribió el editor dentro de un bloque. */
function comentariosDe(segment) {
    const comentarios = (rev.notas && rev.notas.comentarios) || [];
    return comentariosEn(segment.sourceStartSec, segment.sourceEndSec, comentarios).length;
}

function renderReviewList() {
    $('rev-list').innerHTML = rev.segments.map((segment, index) => {
        const aire = aireDe(segment);
        const notas = comentariosDe(segment);
        return `
        <button class="rev-item conf-${esc(segment.confidence)} ${index === rev.selected ? 'is-active' : ''} ${segment.keep ? '' : 'is-out'}"
                data-idx="${index}">
            <span class="rev-item-head">
                <span>${index + 1}.</span>
                <span class="rev-item-time">${fmtClock(segment.sourceStartSec)}</span>
                <span class="cell-dim">${(segment.sourceEndSec - segment.sourceStartSec).toFixed(1)}s</span>
                <span class="badge ${segment.view === 'PV' ? 'badge-pv' : 'badge-r'}">${esc(segment.view)}</span>
                ${segment.keep ? '' : `<span class="badge badge-err" title="${esc(segment.disabledReason || 'Lo sacaste de la clase')}">fuera</span>`}
                ${aire ? `<span class="badge badge-warn" title="No se dice nada durante esos segundos">⏸ ${Math.round(aire)}s</span>` : ''}
                ${notas ? `<span class="badge badge-nota" title="Va a salir como marcador en el XML">✎ ${notas}</span>` : ''}
            </span>
            ${segment.note ? `<span class="rev-item-note">${esc(segment.note)}</span>` : ''}
        </button>`;
    }).join('');
}

function setReviewTab(tab) {
    // Salir de la pestaña no puede dejar una clase sonando por detrás.
    if (rev.tab === 'clase' && tab !== 'clase') cerrarReproductor();

    if (rev.tab !== tab) anotar('visor.pestaña', { de: rev.tab, a: tab });
    rev.tab = tab;
    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.classList.toggle('is-on', button.dataset.tab === tab);
    }
    $('rev-cuts').style.display = tab === 'cortes' ? '' : 'none';
    $('rev-script').hidden = tab !== 'guion';
    $('rev-player').hidden = tab !== 'clase';

    if (tab === 'guion') renderScript();
    if (tab === 'clase') {
        // El reparto se recalcula acá y no al arrancar: mientras el reproductor
        // está oculto, el contenedor mide cero y todo ancho se recorta al mínimo.
        ajustarDivision();
        abrirReproductor();
    }
    if (tab === 'cortes') {
        // Y las ondas se repintan al volver, por lo mismo: si se dibujaron
        // mientras esta pestaña estaba oculta —pasa al mover la selección desde
        // el reproductor— salieron con la medida de respaldo y quedan estiradas.
        renderOverview();
        renderZoom();
    }
}

/** Las otras clases de la carpeta que este botón va a dejar al día. */
function otrasAtrasadas() {
    return (rev.atrasadas && rev.atrasadas.otras) || [];
}

/** Lo que se le suma al subtítulo para que el número no viva solo en el botón. */
function textoDeAtrasadas() {
    const otras = otrasAtrasadas();
    if (!otras.length) return '';
    return ` · ${plural(otras.length, 'clase más para regenerar', 'clases más para regenerar')}`;
}

/**
 * El botón dice a cuántas clases va a tocar, y el tooltip dice a cuáles y por
 * qué. Regenerar escribe en la carpeta del cliente: enterarse después de cuántos
 * XML se rehicieron es justo la sorpresa que no queremos.
 */
function pintarBotonDeGuardar() {
    const button = $('rev-save');
    // Mientras guarda, el botón está contando eso.
    if (button.disabled) return;

    const otras = otrasAtrasadas();
    const afuera = (rev.atrasadas && rev.atrasadas.afuera) || [];
    const carpeta = rev.atrasadas && rev.atrasadas.carpeta ? rev.atrasadas.carpeta.nombre : '';

    button.textContent = otras.length
        ? `Guardar y regenerar · ${otras.length + 1} clases`
        : 'Guardar y regenerar';

    const lineas = otras.length
        ? [`Rehace el XML de esta clase y de ${plural(otras.length, 'clase más', 'clases más')} de «${carpeta}»:`]
            .concat(otras.map(p => `· Clase ${p.classNumber} — ${p.motivo}`))
        : ['Rehace el XML de esta clase con lo que escribiste.',
            'Las demás de esta carpeta ya están al día.'];
    if (afuera.length) {
        // No se tocan: el alcance es esta carpeta. Pero callarlo dejaría clases
        // atrasadas sin que nadie se enterara, que es el problema de origen.
        lineas.push(`Hay ${plural(afuera.length, 'clase atrasada', 'clases atrasadas')} en otras carpetas cargadas: abrí una de ahí para regenerarlas.`);
    }
    button.title = lineas.join('\n');
}

/** @returns {Promise<boolean>} si quedó guardado */
async function saveReviewChanges() {
    const button = $('rev-save');
    button.disabled = true;
    button.textContent = 'Guardando…';

    const result = await window.cc.saveReview({
        id: rev.id,
        segments: rev.segments.map(s => ({
            blockIndex: s.blockIndex,
            sourceStartSec: s.sourceStartSec,
            sourceEndSec: s.sourceEndSec,
            view: s.view,
            keep: s.keep,
            disabledReason: s.disabledReason || '',
            reviewed: s.reviewed
        })),
        viewMap: rev.data.cutplan.viewMap
    });

    button.disabled = false;

    if (!result.ok) { pintarBotonDeGuardar(); toast(result.error); return false; }
    rev.dirty = false;
    rev.data.cutplan = result.cutplan;
    rev.segments = result.cutplan.segments.map(s => ({ ...s, original: { ...s } }));
    toast(`XML regenerado · ${result.exported.segments} bloques · ${fmtDur(result.exported.keepSec)}` +
        textoDeLasOtras(result));
    // Volver a medir: las que se acaban de regenerar tienen que dejar de contarse.
    refrescarAtrasadas();
    renderReview();
    // Guardar reescribe los bloques: el reproductor tiene que pasar a mostrar
    // el corte que acaba de quedar y no el de antes de guardar.
    if (rev.tab === 'clase') abrirReproductor();
    return true;
}

/** Qué otras clases quedaron al día, dicho después de hacerlo. */
function textoDeLasOtras(result) {
    const hechas = result.tambien || [];
    const fallas = result.fallas || [];
    let texto = '';
    if (hechas.length) {
        texto += ` · y ${plural(hechas.length, 'clase más', 'clases más')} (${hechas.map(h => h.classNumber).join(', ')})`;
    }
    // Un XML que no se pudo escribir no puede pasar como regenerado: es
    // exactamente el caso en que el editor va a Premiere a buscar algo que no está.
    if (fallas.length) {
        texto += ` · NO se pudo con ${fallas.map(f => `la ${f.classNumber}`).join(', ')}: ${fallas[0].error}`;
    }
    return texto;
}

/**
 * Todo se ata UNA vez, al arrancar. Las listas y los botones de vista se
 * redibujan enteros en cada cambio, así que sus oyentes van sobre el contenedor
 * y no sobre cada elemento: si no, mover un borde con el teclado vuelve a atar
 * un oyente por bloque cada vez.
 */
export function wireReview(callbacks) {
    alRedibujar(renderReview);

    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.onclick = () => setReviewTab(button.dataset.tab);
    }
    // Volver es volver a la tabla, que es el centro de todo: antes iba a la
    // pantalla de la última corrida, que después de revisar ya no dice nada.
    $('rev-back').onclick = () => {
        cerrarReproductor();
        if (callbacks && callbacks.alVolver) callbacks.alVolver();
    };
    $('rev-save').onclick = saveReviewChanges;
    $('rev-class').onchange = event => openReview(event.target.value);

    $('rev-list').addEventListener('click', e => {
        const item = e.target.closest('.rev-item');
        if (!item) return;
        rev.selected = Number(item.dataset.idx);
        cambio();
    });

    $('rev-views').addEventListener('click', e => {
        const button = e.target.closest('.view-btn');
        const segment = actual();
        if (!button || !segment) return;
        segment.view = button.dataset.view;
        rev.dirty = true;
        cambio();
    });

    $('rev-keep').onchange = event => {
        actual().keep = event.target.checked;
        rev.dirty = true;
        cambio();
    };
    $('rev-ok').onclick = () => {
        const segment = actual();
        segment.confidence = 'alta';
        segment.reviewed = true;
        rev.dirty = true;
        if (rev.selected < rev.segments.length - 1) rev.selected++;
        cambio();
    };
    $('rev-reset').onclick = () => {
        const segment = actual();
        rev.segments[rev.selected] = { ...segment.original, original: segment.original };
        rev.dirty = true;
        cambio();
    };

    for (const group of document.querySelectorAll('.nudges')) {
        group.addEventListener('click', e => {
            const button = e.target.closest('button[data-delta]');
            const segment = actual();
            if (!button || !segment) return;
            const edge = group.dataset.edge;
            setEdge(edge, (edge === 'in' ? segment.sourceStartSec : segment.sourceEndSec) + Number(button.dataset.delta));
        });
    }
    for (const button of document.querySelectorAll('.btn-play')) {
        button.onclick = () => playEdge(button.dataset.play);
    }

    wireGuion(setReviewTab);
    wireReproductor();
    wireLetra();
    wireDivision();

    // Las ondas se dibujan sobre canvas, que no se reacomodan solos.
    window.addEventListener('resize', () => {
        if ($('view-review').classList.contains('is-visible')) {
            renderOverview();
            renderZoom();
        }
    });
}
