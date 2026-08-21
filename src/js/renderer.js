'use strict';
/**
 * renderer.js — La ventana. No sabe leer discos ni medir video: le pide todo al
 * proceso principal por `window.cc` (preload) y se ocupa de dibujar.
 */

const state = {
    scan: null,
    openId: null,
    scanning: false
};

const $ = id => document.getElementById(id);

// ─── Formato ──────────────────────────────────────────────────────────

function fmtDur(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(seconds) {
    if (seconds == null) return '—';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return h ? `${h}:${base}` : base;
}

function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

// ─── Chrome: pasos, toast, modal ──────────────────────────────────────

function setStep(current) {
    for (const el of document.querySelectorAll('.step')) {
        const n = Number(el.dataset.step);
        el.classList.toggle('is-current', n === current);
        el.classList.toggle('is-done', n < current);
    }
}

function showView(name) {
    for (const el of document.querySelectorAll('.view')) {
        el.classList.toggle('is-visible', el.id === `view-${name}`);
    }
}

let toastTimer = null;
function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function openModal(title, html) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    $('modal').hidden = false;
}

// ─── Paso 1: agregar carpeta ──────────────────────────────────────────

function dropError(message) {
    const el = $('drop-error');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
}

async function addFolder(folder) {
    if (!folder || state.scanning) return;
    dropError('');
    state.scanning = true;
    $('dropzone').classList.remove('is-over');
    toast('Buscando clases…');

    try {
        const result = await window.cc.scan(folder);
        if (!result || !result.ok) {
            dropError((result && result.error) || 'No se pudo leer la carpeta.');
            showView('drop');
            setStep(1);
            return;
        }
        if (!result.classCount) {
            dropError(`No encontré clases en "${result.rootName}". Busco carpetas que tengan un XML del Rodecaster con Audio y Video al lado.`);
            showView('drop');
            setStep(1);
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

function wireDropzone() {
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

// ─── Paso 2: tabla de clases ──────────────────────────────────────────

const KIND_LABEL = {
    course: 'Curso',
    day: 'Día',
    class: 'Clase suelta',
    empty: 'Sin clases'
};

function renderScan() {
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

function renderAlerts() {
    const scan = state.scan;
    const host = $('scan-alerts');
    const alerts = [];

    for (const w of scan.warnings || []) {
        alerts.push({ level: 'warn', message: w.message });
    }

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

    host.innerHTML = alerts.map(a =>
        `<div class="alert alert-${a.level}"><span>${esc(a.message)}</span></div>`
    ).join('');
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
    if (!cls.processable) {
        out.push(`<span class="badge badge-err">no procesable</span>`);
    } else if (cls.alreadyProcessed) {
        out.push(`<span class="badge badge-ok">ya procesada</span>`);
    } else {
        out.push(`<span class="badge badge-info">lista</span>`);
    }
    if (cls.duplicate) out.push(`<span class="badge badge-warn">duplicada</span>`);
    if (cls.warnings && cls.warnings.length) {
        out.push(`<span class="badge badge-warn">${cls.warnings.length} aviso${cls.warnings.length === 1 ? '' : 's'}</span>`);
    }
    return out.join('');
}

function renderRows() {
    const scan = state.scan;
    const rows = scan.classes.map(cls => {
        const disabled = cls.processable ? '' : 'disabled';
        const checked = cls.selected ? 'checked' : '';
        return `
        <tr data-id="${esc(cls.id)}" class="${cls.processable ? '' : 'is-blocked'} ${state.openId === cls.id ? 'is-open' : ''}">
            <td class="col-check">
                <input type="checkbox" data-check="${esc(cls.id)}" ${checked} ${disabled}
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
        </tr>`;
    }).join('');

    $('class-rows').innerHTML = rows;

    for (const box of document.querySelectorAll('[data-check]')) {
        box.addEventListener('click', e => e.stopPropagation());
        box.addEventListener('change', e => {
            const cls = findClass(e.target.dataset.check);
            if (cls) cls.selected = e.target.checked;
            renderFoot();
            syncCheckAll();
        });
    }
    for (const row of document.querySelectorAll('#class-rows tr')) {
        row.addEventListener('click', () => openDrawer(row.dataset.id));
    }
    syncCheckAll();
}

function syncCheckAll() {
    const usable = state.scan.classes.filter(c => c.processable);
    const selected = usable.filter(c => c.selected);
    const box = $('check-all');
    box.checked = usable.length > 0 && selected.length === usable.length;
    box.indeterminate = selected.length > 0 && selected.length < usable.length;
}

function renderFoot() {
    const scan = state.scan;
    const selected = scan.classes.filter(c => c.selected);
    const totalSec = selected.reduce((sum, c) => sum + (c.durationSec || 0), 0);
    const blocks = selected.reduce((sum, c) => sum + (c.blockCount || 0), 0);

    $('foot-info').innerHTML = selected.length
        ? `<strong>${plural(selected.length, 'clase marcada', 'clases marcadas')}</strong> · ${fmtDur(totalSec)} de material · ${plural(blocks, 'bloque', 'bloques')} por cortar`
        : 'Ninguna clase marcada.';

    const btn = $('btn-process');
    btn.textContent = selected.length ? `Procesar ${selected.length}` : 'Procesar';
    btn.disabled = true;
    btn.title = 'La transcripción y el alineado llegan en el paso siguiente del desarrollo.';
}

function findClass(id) {
    return state.scan ? state.scan.classes.find(c => c.id === id) : null;
}

// ─── Detalle de una clase ─────────────────────────────────────────────

function openDrawer(id) {
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

function closeDrawer() {
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

    const problems = (cls.problems || []).map(p =>
        `<div class="alert alert-err"><span>${esc(p.message)}</span></div>`).join('');
    const warnings = (cls.warnings || []).map(w =>
        `<div class="alert alert-warn"><span>${esc(w.message)}</span></div>`).join('');

    const nominal = cls.nominalDurationSec && cls.durationSec
        ? `<div class="alert alert-info"><span>El XML declara ${fmtDur(cls.nominalDurationSec)} (valor fijo del Rodecaster); el material dura ${fmtDur(cls.durationSec)}, y ése es el que se usa.</span></div>`
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

// ─── Diagnóstico ──────────────────────────────────────────────────────

async function showDoctor() {
    const [info, doc] = await Promise.all([window.cc.appInfo(), window.cc.doctor()]);
    const rows = [
        ['Versión', `${info.version} · Electron ${info.electron}`],
        ['Arquitectura', `${info.arch}${doc.appleSilicon ? ' (Apple Silicon)' : ' — Class Cut necesita Apple Silicon'}`]
    ];
    for (const tool of doc.tools) {
        rows.push([
            tool.key,
            tool.found
                ? `<span class="badge badge-ok">ok</span> <span class="mono">${esc(tool.path)}</span> <span class="cell-dim">(${esc(tool.source)})</span>`
                : `<span class="badge ${tool.required ? 'badge-err' : 'badge-warn'}">${tool.required ? 'falta' : 'todavía no hace falta'}</span> <span class="cell-dim">buscado en: ${esc(tool.searched.join(', '))}</span>`
        ]);
    }
    openModal('Diagnóstico', `<div class="kv">${rows.map(([k, v]) =>
        `<div class="kv-row"><div class="kv-key">${esc(k)}</div><div class="kv-val">${v}</div></div>`).join('')}</div>`);
}

// ─── Arranque ─────────────────────────────────────────────────────────

async function init() {
    const info = await window.cc.appInfo();
    $('version').textContent = `v${info.version}`;

    wireDropzone();

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
    $('btn-select-all').onclick = () => {
        for (const c of state.scan.classes) if (c.processable) c.selected = true;
        renderRows();
        renderFoot();
    };
    $('btn-select-none').onclick = () => {
        for (const c of state.scan.classes) c.selected = false;
        renderRows();
        renderFoot();
    };
    $('check-all').onclick = e => {
        const on = e.target.checked;
        for (const c of state.scan.classes) if (c.processable) c.selected = on;
        renderRows();
        renderFoot();
    };
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
        if (state.scan) {
            const cls = findClass(p.id);
            if (cls) {
                cls.durationSec = p.durationSec;
                cls.fps = p.fps;
                cls.problems = p.problems;
                cls.warnings = p.warnings;
                cls.processable = p.processable;
            }
        }
        if (p.done === p.total) {
            if (state.scan) { renderAlerts(); renderRows(); }
            renderFoot();
        }
    });
}

init().catch(err => {
    document.body.innerHTML = `<div class="empty">No se pudo iniciar la ventana: ${esc(err.message)}</div>`;
});
