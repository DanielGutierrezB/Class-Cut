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

export async function openReview(id) {
    const target = id || (state.scan.classes.find(c => c.selected && c.alreadyProcessed) || {}).id;
    if (!target) return;

    showView('review');
    setStep(4);
    $('rev-title').textContent = 'Cargando…';

    const data = await window.cc.loadReview({ id: target, buckets: 2400 });
    if (!data.ok) {
        $('rev-title').textContent = 'No se pudo abrir';
        $('rev-sub').textContent = data.error;
        return;
    }

    rev.data = data;
    rev.id = target;
    rev.dirty = false;
    rev.zoomWave = null;
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
}

function renderReviewList() {
    $('rev-list').innerHTML = rev.segments.map((segment, index) => `
        <button class="rev-item conf-${esc(segment.confidence)} ${index === rev.selected ? 'is-active' : ''} ${segment.keep ? '' : 'is-out'}"
                data-idx="${index}">
            <span class="rev-item-head">
                <span>${index + 1}.</span>
                <span class="rev-item-time">${fmtClock(segment.sourceStartSec)}</span>
                <span class="cell-dim">${(segment.sourceEndSec - segment.sourceStartSec).toFixed(1)}s</span>
                <span class="badge ${segment.view === 'PV' ? 'badge-pv' : 'badge-r'}">${esc(segment.view)}</span>
                ${segment.keep ? '' : '<span class="badge badge-err">fuera</span>'}
            </span>
            <span class="rev-item-note">${esc(segment.note || segment.cueIn || '')}</span>
        </button>
    `).join('');
}

function setReviewTab(tab) {
    rev.tab = tab;
    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.classList.toggle('is-on', button.dataset.tab === tab);
    }
    $('rev-cuts').style.display = tab === 'cortes' ? '' : 'none';
    $('rev-script').hidden = tab !== 'guion';
    if (tab === 'guion') renderScript();
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
    $('rev-back').onclick = () => { showView('run'); setStep(5); };
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

    // Las ondas se dibujan sobre canvas, que no se reacomodan solos.
    window.addEventListener('resize', () => {
        if ($('view-review').classList.contains('is-visible')) {
            renderOverview();
            renderZoom();
        }
    });
}
