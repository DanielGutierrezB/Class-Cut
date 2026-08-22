'use strict';
/** Paso 2: la tabla de clases y el detalle de una. */

import { $, alertsHtml } from './chrome.js';
import { esc, fmtDur, fmtClock, plural } from './formato.js';
import { state, findClass } from './estado.js';

const KIND_LABEL = {
    course: 'Curso',
    day: 'Día',
    class: 'Clase suelta',
    empty: 'Sin clases'
};

export function renderScan() {
    const scan = state.scan;
    if (!scan) return;

    const parts = [KIND_LABEL[scan.kind] || 'Carpeta'];
    if (scan.dayCount) parts.push(plural(scan.dayCount, 'día', 'días'));
    parts.push(plural(scan.classCount, 'clase', 'clases'));
    $('scan-title').textContent = parts.join(' · ');

    const pathBtn = $('scan-path');
    pathBtn.textContent = scan.root;
    pathBtn.onclick = () => window.cc.reveal(scan.root);

    renderAlerts();
    renderRows();
    renderFoot();
}

export function renderAlerts() {
    const scan = state.scan;
    const alerts = (scan.warnings || []).map(w => ({ level: 'warn', message: w.message }));

    const blocked = scan.classes.filter(c => !c.processable);
    if (blocked.length) {
        alerts.push({
            level: 'err',
            message: `${plural(blocked.length, 'clase', 'clases')} no se puede procesar todavía: mirá el detalle de las filas atenuadas.`
        });
    }

    const done = scan.classes.filter(c => c.alreadyProcessed);
    if (done.length) {
        alerts.push({
            level: 'info',
            message: `${plural(done.length, 'clase ya tiene', 'clases ya tienen')} XML en "The Cutter": procesarlas otra vez lo reemplaza.`
        });
    }

    $('scan-alerts').innerHTML = alertsHtml(alerts);
}

function viewBadges(views) {
    const entries = Object.entries(views || {});
    if (!entries.length) return '<span class="cell-dim">—</span>';
    return entries.map(([name, count]) => {
        const cls = name === 'PV' ? 'badge-pv' : (name === 'R' ? 'badge-r' : 'badge-info');
        return `<span class="badge ${cls}">${esc(name)} ${count}</span>`;
    }).join('');
}

function statusBadges(cls) {
    const out = [];
    if (!cls.processable) out.push('<span class="badge badge-err">no procesable</span>');
    else if (cls.alreadyProcessed) out.push('<span class="badge badge-ok">ya procesada</span>');
    else out.push('<span class="badge badge-info">lista</span>');

    if (cls.duplicate) out.push('<span class="badge badge-warn">duplicada</span>');
    if (cls.warnings && cls.warnings.length) {
        out.push(`<span class="badge badge-warn">${plural(cls.warnings.length, 'aviso', 'avisos')}</span>`);
    }
    return out.join('');
}

export function renderRows() {
    const scan = state.scan;
    $('class-rows').innerHTML = scan.classes.map(cls => `
        <tr data-id="${esc(cls.id)}" class="${cls.processable ? '' : 'is-blocked'} ${state.openId === cls.id ? 'is-open' : ''}">
            <td class="col-check">
                <input type="checkbox" data-check="${esc(cls.id)}" ${cls.selected ? 'checked' : ''} ${cls.processable ? '' : 'disabled'}
                       aria-label="Procesar esta clase">
            </td>
            <td class="col-num"><span class="class-no">${cls.classNumber == null ? '—' : cls.classNumber}</span></td>
            <td>
                <span class="cell-seq">${esc(cls.sequenceName || cls.folderName)}</span>
                <span class="cell-folder">${esc(cls.folderName)}</span>
            </td>
            <td class="cell-dim">${esc(cls.dayName || '—')}</td>
            <td class="num cell-num">${cls.videos.length}</td>
            <td class="num cell-num">${cls.audios.length}${cls.liveMixPath ? '' : ' ⚠'}</td>
            <td class="num cell-num" data-dur="${esc(cls.id)}">${fmtDur(cls.durationSec)}</td>
            <td class="num cell-num">${cls.blockCount || '—'}</td>
            <td>${viewBadges(cls.views)}</td>
            <td>${statusBadges(cls)}</td>
        </tr>`).join('');
    syncCheckAll();
}

export function syncCheckAll() {
    const usable = state.scan.classes.filter(c => c.processable);
    const selected = usable.filter(c => c.selected);
    const box = $('check-all');
    box.checked = usable.length > 0 && selected.length === usable.length;
    box.indeterminate = selected.length > 0 && selected.length < usable.length;
}

export function renderFoot() {
    const selected = state.scan.classes.filter(c => c.selected);
    const totalSec = selected.reduce((sum, c) => sum + (c.durationSec || 0), 0);
    const blocks = selected.reduce((sum, c) => sum + (c.blockCount || 0), 0);

    $('foot-info').innerHTML = selected.length
        ? `<strong>${plural(selected.length, 'clase marcada', 'clases marcadas')}</strong> · ${fmtDur(totalSec)} de material · ${plural(blocks, 'bloque', 'bloques')} por cortar`
        : 'Ninguna clase marcada.';

    const btn = $('btn-process');
    btn.textContent = selected.length === 1 ? 'Procesar 1 clase' : `Procesar ${selected.length} clases`;
    btn.disabled = selected.length === 0;
    btn.title = selected.length
        ? 'Transcribe el Live-Mix, alinea los marcadores y escribe el XML cortado.'
        : 'Marcá al menos una clase.';
}

/**
 * Los oyentes de la tabla se ponen UNA vez sobre el contenedor, no una por fila
 * cada vez que se dibuja: las filas se rehacen enteras en cada render y volver a
 * atarlas es trabajo que crece con la cantidad de clases.
 */
export function wireClases() {
    const host = $('class-rows');

    host.addEventListener('change', e => {
        const id = e.target.dataset.check;
        if (!id) return;
        const cls = findClass(id);
        if (cls) cls.selected = e.target.checked;
        renderFoot();
        syncCheckAll();
    });

    host.addEventListener('click', e => {
        // El clic en la casilla marca, no abre el detalle.
        if (e.target.dataset.check != null) return;
        const row = e.target.closest('tr');
        if (row) openDrawer(row.dataset.id);
    });
}

// ─── Detalle de una clase ─────────────────────────────────────────────

export function openDrawer(id) {
    const cls = findClass(id);
    if (!cls) return;
    state.openId = id;

    $('drawer-title').textContent = cls.sequenceName || cls.folderName;
    $('drawer-sub').textContent = cls.folder;
    $('drawer-body').innerHTML = drawerHtml(cls);
    $('drawer').hidden = false;

    for (const row of document.querySelectorAll('#class-rows tr')) {
        row.classList.toggle('is-open', row.dataset.id === id);
    }
    const revealBtn = $('drawer-reveal');
    if (revealBtn) revealBtn.onclick = () => window.cc.reveal(cls.xmlPath || cls.folder);
}

export function closeDrawer() {
    state.openId = null;
    $('drawer').hidden = true;
    for (const row of document.querySelectorAll('#class-rows tr')) row.classList.remove('is-open');
}

function drawerHtml(cls) {
    const facts = [
        ['Clase', cls.classNumber == null ? '—' : cls.classNumber],
        ['Duración real', fmtDur(cls.durationSec)],
        ['Frame rate', cls.fps ? `${cls.fps} fps` : '—'],
        ['Resolución', cls.width ? `${cls.width}×${cls.height}` : '—'],
        ['Bloques', cls.blockCount || 0],
        ['Claqueta', cls.clapSec == null ? 'sin marcador' : fmtClock(cls.clapSec)]
    ].map(([k, v]) => `
        <div class="fact"><div class="fact-label">${esc(k)}</div><div class="fact-value">${esc(v)}</div></div>
    `).join('');

    const problems = alertsHtml((cls.problems || []).map(p => ({ level: 'err', message: p.message })));
    const warnings = alertsHtml((cls.warnings || []).map(w => ({ level: 'warn', message: w.message })));

    const nominal = cls.nominalDurationSec && cls.durationSec
        ? alertsHtml([{
            level: 'info',
            message: `El XML declara ${fmtDur(cls.nominalDurationSec)} (valor fijo del Rodecaster); el material dura ${fmtDur(cls.durationSec)}, y ése es el que se usa.`
        }])
        : '';

    const blocks = (cls.blocks || []).map(b => `
        <div class="block view-${esc(b.view)}">
            <div class="block-head">
                <span class="block-idx">${b.index + 1}.</span>
                <span class="block-time">${fmtClock(b.startSec)} → ${fmtClock(b.endSec)}</span>
                <span class="block-dur">${b.durationSec.toFixed(1)} s</span>
                <span class="badge ${b.view === 'PV' ? 'badge-pv' : (b.view === 'R' ? 'badge-r' : 'badge-info')}">${esc(b.view || '?')}</span>
                ${b.complete ? '' : '<span class="badge badge-err">sin OUT</span>'}
                ${b.hasCount ? '' : '<span class="badge badge-warn">sin conteo</span>'}
            </div>
            ${b.note ? `<div class="block-note">${esc(b.note)}</div>` : ''}
            <div class="block-cue"><b>entra:</b> ${esc(b.cueIn || '—')}</div>
            <div class="block-cue"><b>sale:</b> ${esc(b.cueOut || '—')}</div>
        </div>
    `).join('');

    const files = list => (list || []).map(f => `
        <div>
            <span class="${f.isLiveMix ? 'is-live' : ''}">${esc(f.name)}${f.isLiveMix ? ' · se transcribe' : ''}</span>
            <span class="muted">${fmtDur(f.durationSec)}</span>
        </div>`).join('');

    return `
        <div class="facts">${facts}</div>
        ${problems}${warnings}${nominal}

        <div class="section-title">Material</div>
        <div class="file-list">${files(cls.videos)}${files(cls.audios)}</div>

        <div class="section-title">
            Bloques del director de contenido
            <button class="btn btn-ghost" id="drawer-reveal" style="float:right;margin-top:-4px">Ver el XML</button>
        </div>
        ${blocks ? `<div class="blocks">${blocks}</div>` : '<div class="empty">Sin bloques en el XML.</div>'}
    `;
}
