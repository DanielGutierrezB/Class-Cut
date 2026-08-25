'use strict';
/**
 * Paso 4: revisar los cortes antes de dar la clase por buena.
 *
 * Este archivo coordina; lo que dibuja está en `onda`, `bordes` y `guion`.
 */

import { $, setStep, showView, toast } from '../chrome.js';
import { esc, fmtClock, fmtDur, plural } from '../formato.js';
import { state } from '../estado.js';
import { rev, actual, alRedibujar, cambio } from './estado.js';
import { renderOverview, renderZoom } from './onda.js';
import { setEdge, renderEdges, renderDecided, renderTranscript, playEdge } from './bordes.js';
import { renderScript, wireGuion } from './guion.js';
import { abrirReproductor, cerrarReproductor, refrescarBloques, wireReproductor } from './reproductor.js';
import { ajustarDivision, wireDivision } from './division.js';
import { wireLetra } from './panel-letra.js';

export async function openReview(id) {
    const target = id || (state.scan.classes.find(c => c.selected && c.alreadyProcessed) || {}).id;
    if (!target) return;

    // Cambiar de clase con el reproductor abierto: lo de la clase anterior se
    // suelta antes de cargar nada, o queda un video de 15 GB sonando sin dueño.
    cerrarReproductor();

    showView('review');
    setStep(4);
    $('rev-title').textContent = 'Cargando…';

    const data = await window.cc.loadReview({ id: target, buckets: 2400 });
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
    rev.zoomWave = null;
    rev.notas = data.notas || { bloques: {}, comentarios: [] };
    rev.pista = null;
    // Se trabaja sobre una copia: hasta que no se guarda, el plan del disco es el
    // que vale y "Volver a lo calculado" tiene de dónde volver.
    rev.segments = data.cutplan.segments.map(s => ({ ...s, original: { ...s } }));
    rev.selected = Math.max(0, rev.segments.findIndex(s => s.confidence !== 'alta'));

    fillClassPicker();
    setReviewTab(rev.tab || 'cortes');
    renderReview();
}

function fillClassPicker() {
    $('rev-class').innerHTML = state.scan.classes
        .filter(c => c.processable)
        .map(c => `<option value="${esc(c.id)}" ${c.id === rev.id ? 'selected' : ''}>Clase ${c.classNumber} · ${esc(c.sequenceName)}</option>`)
        .join('');
}

function renderReview() {
    const pending = rev.segments.filter(s => s.keep && s.confidence !== 'alta').length;

    $('rev-title').textContent = `Clase ${rev.data.classNumber} · ${plural(rev.segments.filter(s => s.keep).length, 'bloque', 'bloques')}`;
    $('rev-sub').textContent = pending
        ? `${plural(pending, 'bloque para revisar', 'bloques para revisar')}${rev.dirty ? ' · hay cambios sin guardar' : ''}`
        : (rev.dirty ? 'Hay cambios sin guardar' : 'Todo revisado');

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
    const dentro = rev.data.silencios.tramos.reduce((suma, t) => {
        const desde = Math.max(t.desdeSec, segment.sourceStartSec);
        const hasta = Math.min(t.hastaSec, segment.sourceEndSec);
        return suma + Math.max(0, hasta - desde);
    }, 0);
    // Menos de dos segundos sumados es respirar entre frases.
    return dentro >= 2 ? dentro : 0;
}

/** Cuántos comentarios escribió el editor dentro de un bloque. */
function comentariosDe(segment) {
    const comentarios = (rev.notas && rev.notas.comentarios) || [];
    return comentarios.filter(c =>
        c.sourceStartSec >= segment.sourceStartSec && c.sourceStartSec <= segment.sourceEndSec).length;
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
            <span class="rev-item-note">${esc(segment.note || segment.cueIn || '')}</span>
        </button>`;
    }).join('');
}

function setReviewTab(tab) {
    // Salir de la pestaña no puede dejar una clase sonando por detrás.
    if (rev.tab === 'clase' && tab !== 'clase') cerrarReproductor();

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
}

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
    button.textContent = 'Guardar y regenerar';

    if (!result.ok) { toast(result.error); return; }
    rev.dirty = false;
    rev.data.cutplan = result.cutplan;
    rev.segments = result.cutplan.segments.map(s => ({ ...s, original: { ...s } }));
    toast(`XML regenerado · ${result.exported.segments} bloques · ${fmtDur(result.exported.keepSec)}`);
    renderReview();
    // Guardar reescribe los bloques: el reproductor tiene que pasar a mostrar
    // el corte que acaba de quedar y no el de antes de guardar.
    if (rev.tab === 'clase') abrirReproductor();
}

/**
 * Todo se ata UNA vez, al arrancar. Las listas y los botones de vista se
 * redibujan enteros en cada cambio, así que sus oyentes van sobre el contenedor
 * y no sobre cada elemento: si no, mover un borde con el teclado vuelve a atar
 * un oyente por bloque cada vez.
 */
export function wireReview() {
    alRedibujar(renderReview);

    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.onclick = () => setReviewTab(button.dataset.tab);
    }
    $('rev-back').onclick = () => { cerrarReproductor(); showView('run'); setStep(5); };
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
