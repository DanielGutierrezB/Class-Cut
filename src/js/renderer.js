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
    btn.textContent = selected.length === 1 ? 'Procesar 1 clase' : `Procesar ${selected.length} clases`;
    btn.disabled = selected.length === 0;
    btn.title = selected.length
        ? 'Transcribe el Live-Mix, alinea los marcadores y escribe el XML cortado.'
        : 'Marcá al menos una clase.';
}

function findClass(id) {
    return state.scan ? state.scan.classes.find(c => c.id === id) : null;
}

// ─── Paso 3: procesar ─────────────────────────────────────────────────

const STAGE_LABEL = {
    transcribir: 'Transcribiendo el Live-Mix',
    alinear: 'Alineando los marcadores',
    cortar: 'Calculando los cortes',
    exportar: 'Escribiendo el XML'
};

const run = { rows: new Map(), started: 0, total: 0, done: 0, cancelling: false };

async function startProcessing() {
    const selected = state.scan.classes.filter(c => c.selected);
    if (!selected.length) return;

    closeDrawer();
    run.rows = new Map(selected.map(c => [c.id, { cls: c, status: 'espera', stage: null, percent: null, result: null }]));
    run.total = selected.length;
    run.done = 0;
    run.started = Date.now();
    run.cancelling = false;

    showView('run');
    setStep(3);
    $('run-title').textContent = selected.length === 1 ? 'Procesando 1 clase' : `Procesando ${selected.length} clases`;
    $('run-sub').textContent = $('use-ai').checked
        ? 'Transcribe, alinea, afina los cortes dudosos y lee la clase entera.'
        : 'Solo reglas: la IA local está apagada.';
    $('btn-cancel').hidden = false;
    $('btn-open-output').hidden = true;
    $('btn-back').hidden = true;
    $('run-alerts').innerHTML = '';
    renderRunRows();
    renderRunFoot();

    const response = await window.cc.process({
        root: state.scan.root,
        ids: selected.map(c => c.id),
        useAi: $('use-ai').checked
    });

    finishProcessing(response);
}

function finishProcessing(response) {
    $('btn-cancel').hidden = true;
    $('btn-back').hidden = false;

    if (!response || !response.ok) {
        $('run-title').textContent = 'No se pudo procesar';
        $('run-alerts').innerHTML = `<div class="alert alert-err"><span>${esc((response && response.error) || 'Falló sin decir por qué.')}</span></div>`;
        return;
    }

    state.outputDir = response.outputDir;
    $('btn-open-output').hidden = false;

    const exported = response.results.filter(r => r.ok);
    if (exported.length) {
        // Se entra a revisar por la clase que más lo necesita, no por la primera.
        const worst = exported.slice().sort((a, b) => b.totals.needsReview - a.totals.needsReview)[0];
        state.reviewFirst = worst.id;
        $('btn-review').hidden = false;
        $('btn-review').textContent = worst.totals.needsReview
            ? `Revisar cortes (${exported.reduce((sum, r) => sum + r.totals.needsReview, 0)} pendientes)`
            : 'Revisar cortes';
    }

    const okCount = response.results.filter(r => r.ok).length;
    const seconds = Math.round((Date.now() - run.started) / 1000);
    $('run-title').textContent = response.cancelled
        ? `Cancelado · ${okCount} de ${run.total} listas`
        : `Listo · ${okCount} de ${run.total} ${okCount === 1 ? 'clase exportada' : 'clases exportadas'}`;
    $('run-sub').textContent = `En ${fmtDur(seconds)} · los XML están en "The Cutter"`;
    setStep(5);

    const alerts = [];
    const failed = response.results.filter(r => !r.ok && !r.cancelled);
    for (const fail of failed) {
        alerts.push({ level: 'err', message: `${fail.id}: ${fail.error}` });
    }
    const review = response.results.reduce((sum, r) => sum + (r.ok ? r.totals.needsReview : 0), 0);
    if (review) {
        alerts.push({
            level: 'warn',
            message: `${plural(review, 'bloque quedó', 'bloques quedaron')} para revisar: casi siempre es la misma frase grabada varias veces. Importá "alineada.xml" del Backup para verlos en el editor.`
        });
    }
    const seen = new Set();
    for (const result of response.results) {
        for (const w of (result.warnings || [])) {
            const key = `${result.id}:${w.code}`;
            if (seen.has(key)) continue;
            seen.add(key);
            alerts.push({ level: 'warn', message: `${shortName(result.id)}: ${w.message}` });
        }
    }
    $('run-alerts').innerHTML = alerts.slice(0, 12).map(a =>
        `<div class="alert alert-${a.level}"><span>${esc(a.message)}</span></div>`).join('');
}

function shortName(id) {
    const row = run.rows.get(id);
    return row && row.cls.classNumber != null ? `Clase ${row.cls.classNumber}` : id;
}

function renderRunRows() {
    const rows = [...run.rows.values()].map(entry => {
        const cls = entry.cls;
        const result = entry.result;
        let status;
        if (entry.status === 'espera') status = '<span class="cell-dim">en espera</span>';
        else if (entry.status === 'trabajando') {
            const label = STAGE_LABEL[entry.stage] || 'Trabajando';
            const bar = entry.percent != null
                ? `<span class="progress"><span style="width:${entry.percent}%"></span></span>`
                : '';
            status = `${esc(label)}${bar}`;
        } else if (result && result.ok) status = '<span class="badge badge-ok">exportada</span>';
        else if (result && result.cancelled) status = '<span class="badge badge-info">cancelada</span>';
        else status = `<span class="badge badge-err">falló</span>`;

        const conf = result && result.ok ? result.stats.confidence : null;
        return `
        <tr>
            <td class="col-num"><span class="class-no">${cls.classNumber == null ? '—' : cls.classNumber}</span></td>
            <td><span class="cell-seq">${esc(cls.sequenceName || cls.folderName)}</span></td>
            <td>${status}</td>
            <td class="num cell-num">${result && result.ok ? result.totals.kept : '—'}</td>
            <td class="num cell-num">${result && result.ok ? fmtDur(result.totals.keepSec) : '—'}</td>
            <td class="cell-dim">${result && result.ok ? `${result.offset.appliedSec.toFixed(2)}s <span class="cell-dim">(${esc(result.offset.source)})</span>` : '—'}</td>
            <td>${conf
                ? `<span class="badge badge-ok">${conf.alta}</span><span class="badge badge-warn">${conf.media}</span><span class="badge badge-err">${conf.baja}</span>`
                : '<span class="cell-dim">—</span>'}</td>
        </tr>`;
    }).join('');
    $('run-rows').innerHTML = rows;
}

function renderRunFoot() {
    const done = [...run.rows.values()].filter(r => r.status === 'listo').length;
    const kept = [...run.rows.values()].reduce((sum, r) => sum + (r.result && r.result.ok ? r.result.totals.keepSec : 0), 0);
    $('run-foot').innerHTML = `${done} de ${run.total} · ${fmtDur(kept)} de material cortado`;
}

// ─── Paso 4: revisar cortes ───────────────────────────────────────────

const rev = {
    data: null,
    id: null,
    segments: [],
    selected: 0,
    dirty: false,
    audio: null
};

const ZOOM_MARGIN_SEC = 4;

async function openReview(id) {
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
    // Se trabaja sobre una copia: hasta que no se guarda, el plan del disco es el
    // que vale y "Volver a lo calculado" tiene de dónde volver.
    rev.segments = data.cutplan.segments.map(s => ({ ...s, original: { ...s } }));
    rev.selected = Math.max(0, rev.segments.findIndex(s => s.confidence !== 'alta'));

    fillClassPicker();
    setReviewTab(rev.tab || 'cortes');
    renderReview();
}

function fillClassPicker() {
    const options = state.scan.classes
        .filter(c => c.processable)
        .map(c => `<option value="${esc(c.id)}" ${c.id === rev.id ? 'selected' : ''}>Clase ${c.classNumber} · ${esc(c.sequenceName)}</option>`)
        .join('');
    $('rev-class').innerHTML = options;
}

function renderReview() {
    const data = rev.data;
    const pending = rev.segments.filter(s => s.keep && s.confidence !== 'alta').length;

    $('rev-title').textContent = `Clase ${data.classNumber} · ${plural(rev.segments.filter(s => s.keep).length, 'bloque', 'bloques')}`;
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

    for (const item of document.querySelectorAll('.rev-item')) {
        item.addEventListener('click', () => {
            rev.selected = Number(item.dataset.idx);
            renderReview();
        });
    }
}

function canvasSize(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = Number(canvas.getAttribute('height')) || 100;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
}

function drawPeaks(ctx, peaks, from, to, width, height, color) {
    const total = peaks.length;
    const fromIdx = Math.max(0, Math.floor(from * total));
    const toIdx = Math.min(total, Math.ceil(to * total));
    const span = Math.max(1, toIdx - fromIdx);
    const mid = height / 2;

    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
        const start = fromIdx + Math.floor((x / width) * span);
        const end = fromIdx + Math.floor(((x + 1) / width) * span);
        let peak = 0;
        for (let i = start; i < Math.max(end, start + 1) && i < total; i++) {
            if (peaks[i] > peak) peak = peaks[i];
        }
        const h = Math.max(1, peak * (height - 6));
        ctx.fillRect(x, mid - h / 2, 1, h);
    }
}

function renderOverview() {
    const canvas = $('rev-overview');
    const wave = rev.data.waveform;
    const { ctx, width, height } = canvasSize(canvas);
    const duration = rev.data.durationSec || 1;

    ctx.clearRect(0, 0, width, height);

    // Primero las zonas que se quedan, para que la silueta se dibuje encima.
    for (const segment of rev.segments) {
        if (!segment.keep) continue;
        const x = (segment.sourceStartSec / duration) * width;
        const w = Math.max(1, ((segment.sourceEndSec - segment.sourceStartSec) / duration) * width);
        ctx.fillStyle = segment.confidence === 'alta' ? 'rgba(62,207,142,.20)' : 'rgba(245,181,68,.20)';
        ctx.fillRect(x, 0, w, height);
    }
    if (wave) drawPeaks(ctx, wave.peaks, 0, 1, width, height, 'rgba(162,169,184,.75)');

    const current = rev.segments[rev.selected];
    if (current) {
        const x = (current.sourceStartSec / duration) * width;
        const w = Math.max(2, ((current.sourceEndSec - current.sourceStartSec) / duration) * width);
        ctx.strokeStyle = '#4f9cf9';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, 1, w, height - 2);
    }

    canvas.onclick = event => {
        const rect = canvas.getBoundingClientRect();
        const seconds = ((event.clientX - rect.left) / rect.width) * duration;
        let best = 0;
        let bestDistance = Infinity;
        rev.segments.forEach((segment, index) => {
            const distance = Math.abs((segment.sourceStartSec + segment.sourceEndSec) / 2 - seconds);
            if (distance < bestDistance) { bestDistance = distance; best = index; }
        });
        rev.selected = best;
        renderReview();
    };
}

function zoomWindow() {
    const segment = rev.segments[rev.selected];
    if (!segment) return null;
    const from = Math.max(0, segment.sourceStartSec - ZOOM_MARGIN_SEC);
    const to = Math.min(rev.data.durationSec || segment.sourceEndSec + ZOOM_MARGIN_SEC,
        segment.sourceEndSec + ZOOM_MARGIN_SEC);
    return { from, to, span: Math.max(0.5, to - from) };
}

function renderZoom() {
    const canvas = $('rev-zoom');
    const segment = rev.segments[rev.selected];
    const window_ = zoomWindow();
    const { ctx, width, height } = canvasSize(canvas);
    ctx.clearRect(0, 0, width, height);
    if (!segment || !window_) return;

    const xOf = seconds => ((seconds - window_.from) / window_.span) * width;

    ctx.fillStyle = 'rgba(79,156,249,.13)';
    ctx.fillRect(xOf(segment.sourceStartSec), 0, xOf(segment.sourceEndSec) - xOf(segment.sourceStartSec), height);

    // El detalle del tramo se pide aparte: con los cubos del resumen, veinte
    // segundos son doce puntos y el borde del sonido no se ve.
    const detail = rev.zoomWave;
    if (detail && Math.abs(detail.fromSec - window_.from) < 0.01 && Math.abs(detail.toSec - window_.to) < 0.01) {
        drawPeaks(ctx, detail.peaks, 0, 1, width, height, 'rgba(200,207,222,.85)');
    } else {
        loadZoomWave(window_);
    }

    for (const [seconds, color] of [[segment.sourceStartSec, '#3ecf8e'], [segment.sourceEndSec, '#f2646b']]) {
        const x = xOf(seconds);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    $('rev-zoom-label').textContent =
        `${fmtClock(window_.from)} – ${fmtClock(window_.to)} · clic para mover la entrada, con Alt la salida`;

    canvas.onclick = event => {
        const rect = canvas.getBoundingClientRect();
        const seconds = window_.from + ((event.clientX - rect.left) / rect.width) * window_.span;
        setEdge(event.altKey ? 'out' : 'in', seconds);
    };
}

let zoomWaveToken = 0;
async function loadZoomWave(window_) {
    if (!rev.data.liveMixPath) return;
    const token = ++zoomWaveToken;
    const detail = await window.cc.waveformWindow({
        path: rev.data.liveMixPath,
        fromSec: window_.from,
        toSec: window_.to,
        buckets: 1400
    });
    // Mientras se leía el disco el editor pudo saltar a otro bloque.
    if (!detail || token !== zoomWaveToken) return;
    rev.zoomWave = detail;
    renderZoom();
}

function setEdge(edge, seconds) {
    const segment = rev.segments[rev.selected];
    if (!segment) return;
    const frame = 1 / (rev.data.fps || 30);
    const value = Math.max(0, Math.min(rev.data.durationSec || seconds, seconds));

    if (edge === 'in') {
        segment.sourceStartSec = Math.min(value, segment.sourceEndSec - frame);
    } else {
        segment.sourceEndSec = Math.max(value, segment.sourceStartSec + frame);
    }
    segment.sourceStartSec = Math.round(segment.sourceStartSec * 1000) / 1000;
    segment.sourceEndSec = Math.round(segment.sourceEndSec * 1000) / 1000;
    rev.dirty = true;
    renderReview();
}

function renderEdges() {
    const segment = rev.segments[rev.selected];
    if (!segment) return;
    $('in-time').textContent = fmtClock(segment.sourceStartSec);
    $('out-time').textContent = fmtClock(segment.sourceEndSec);
    $('rev-keep').checked = segment.keep !== false;

    const cameras = rev.data.cameras || [];
    const views = Object.keys(rev.data.cutplan.viewMap || { PV: 0, R: 1 });
    $('rev-views').innerHTML = views.map(view => {
        const camera = cameras[rev.data.cutplan.viewMap[view]];
        return `<button class="view-btn ${segment.view === view ? 'is-on' : ''}" data-view="${esc(view)}">
            ${esc(view)}${camera ? ` · ${esc(camera.name.replace(/\.[^.]+$/, ''))}` : ''}
        </button>`;
    }).join('');

    for (const button of document.querySelectorAll('.view-btn')) {
        button.onclick = () => {
            segment.view = button.dataset.view;
            rev.dirty = true;
            renderReview();
        };
    }
}

const DECIDED_LABEL = {
    nota: 'la nota del CD',
    regla: 'una regla',
    ia: 'la IA local'
};

function renderDecided() {
    const segment = rev.segments[rev.selected];
    const edges = (rev.data.edges || []).find(e => e.index === segment.blockIndex);
    if (!edges) {
        $('rev-decided').innerHTML = '<span class="cell-dim">Sin detalle del alineado.</span>';
        return;
    }

    const row = (label, edge) => {
        if (!edge) return '';
        const parts = [];
        if (edge.reason) parts.push(esc(edge.reason));
        if (edge.chatterRemoved && edge.chatterRemoved.length) {
            parts.push(`Se sacó del bloque: ${esc(edge.chatterRemoved.join(', '))}`);
        }
        if (edge.refine && edge.refine.reason) parts.push(esc(edge.refine.reason));
        return `
        <div class="decided-row">
            <span class="decided-kind">${label}</span>
            <span class="badge badge-by-${esc(edge.decidedBy)}">${esc(DECIDED_LABEL[edge.decidedBy] || edge.decidedBy)}</span>
            <span class="decided-text">${parts.join(' · ') || '—'}</span>
        </div>`;
    };

    $('rev-decided').innerHTML = row('Entrada', edges.in) + row('Salida', edges.out);
}

function renderScript() {
    const data = rev.data;
    const coherence = data.coherence;
    const host = $('rev-script');

    if (!coherence || !coherence.blocks || !coherence.blocks.length) {
        host.innerHTML = `<div class="script-head">
            <div class="script-title">Guion final</div>
            <p class="script-sub">Esta clase se procesó sin revisión del guion. Volvé a procesarla con la IA encendida para leerla de corrido.</p>
        </div>`;
        return;
    }

    const byBlock = new Map();
    for (const finding of coherence.findings || []) {
        if (!byBlock.has(finding.bloque)) byBlock.set(finding.bloque, []);
        byBlock.get(finding.bloque).push(finding);
    }

    const total = (coherence.findings || []).length;
    const minutes = Math.round(coherence.blocks.reduce((sum, b) => sum + b.durationSec, 0) / 60);

    const body = coherence.blocks.map(block => {
        const findings = byBlock.get(block.n) || [];
        const worstLevel = findings.some(f => f.gravedad === 'alta') ? 'alta'
            : findings.some(f => f.gravedad === 'media') ? 'media'
                : (findings.length ? 'baja' : '');

        const notes = findings.map(f => `
            <div class="finding ${esc(f.gravedad)}">
                <div class="finding-head">
                    <span class="finding-tipo">${esc(TIPO_LABEL[f.tipo] || f.tipo)}</span>
                    <span class="badge ${f.fuente === 'ia' ? 'badge-by-ia' : 'badge-by-regla'}">${f.fuente === 'ia' ? 'IA' : 'regla'}</span>
                </div>
                <div>${esc(f.detalle)}</div>
                ${f.sugerencia ? `<div class="finding-fix">${esc(f.sugerencia)}</div>` : ''}
            </div>`).join('');

        return `
        <div class="script-block ${worstLevel ? `has-${worstLevel}` : ''}" data-block="${block.index}">
            <div class="script-n">${block.n}</div>
            <div>
                ${block.note ? `<div class="script-note">${esc(block.note)}</div>` : ''}
                <div class="script-text">${esc(block.text) || '<span class="cell-dim">(sin habla)</span>'}</div>
                ${notes}
            </div>
        </div>`;
    }).join('');

    host.innerHTML = `
        <div class="script-head">
            <div class="script-title">La clase cortada, leída de corrido</div>
            <p class="script-sub">
                ${plural(coherence.blocks.length, 'bloque', 'bloques')} · ${minutes} min · ${coherence.wordCount} palabras ·
                ${total ? `${plural(total, 'cosa para mirar', 'cosas para mirar')}` : 'sin hallazgos'}
            </p>
        </div>
        <div class="script-body">${body}</div>`;

    for (const el of host.querySelectorAll('.script-block')) {
        el.addEventListener('click', () => {
            const index = Number(el.dataset.block);
            const position = rev.segments.findIndex(s => s.blockIndex === index);
            if (position === -1) return;
            rev.selected = position;
            setReviewTab('cortes');
            renderReview();
        });
    }
}

const TIPO_LABEL = {
    idea_colgando: 'Idea colgando',
    repetido: 'Se dice dos veces',
    empalme: 'Empalme raro',
    conector: 'Conector sin antecedente',
    orden: 'Orden que no fluye',
    otro: 'Para mirar'
};

function setReviewTab(tab) {
    rev.tab = tab;
    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.classList.toggle('is-on', button.dataset.tab === tab);
    }
    $('rev-cuts').style.display = tab === 'cortes' ? '' : 'none';
    $('rev-script').hidden = tab !== 'guion';
    if (tab === 'guion') renderScript();
}

function renderTranscript() {
    const segment = rev.segments[rev.selected];
    if (!segment) return;
    const margin = 10;
    const segments = (rev.data.segments || []).filter(s =>
        s.end >= segment.sourceStartSec - margin && s.start <= segment.sourceEndSec + margin);

    $('rev-transcript').innerHTML = segments.length
        ? segments.map(s => {
            const inside = s.start >= segment.sourceStartSec - 0.2 && s.end <= segment.sourceEndSec + 0.2;
            return `<div class="seg ${inside ? 'inside' : ''}">
                <span class="seg-time">${fmtClock(s.start)}</span>${esc(s.text)}
            </div>`;
        }).join('')
        : '<div class="cell-dim">No hay transcript para este tramo.</div>';
}

async function playEdge(edge) {
    const segment = rev.segments[rev.selected];
    if (!segment || !rev.data.liveMixPath) return;

    const at = edge === 'in' ? segment.sourceStartSec : segment.sourceEndSec;
    const startSec = Math.max(0, at - 1.5);
    const result = await window.cc.audition({
        path: rev.data.liveMixPath,
        startSec,
        durationSec: 3.5
    });
    if (!result.ok) { toast(result.error); return; }

    if (rev.audio) rev.audio.pause();
    rev.audio = new Audio(result.dataUrl);
    rev.audio.play().catch(err => toast(`No se pudo reproducir: ${err.message}`));
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

function wireReview() {
    for (const button of document.querySelectorAll('#rev-tabs .tab')) {
        button.onclick = () => setReviewTab(button.dataset.tab);
    }
    $('rev-back').onclick = () => {
        showView('run');
        setStep(5);
    };
    $('rev-save').onclick = saveReviewChanges;
    $('rev-class').onchange = event => openReview(event.target.value);
    $('rev-keep').onchange = event => {
        rev.segments[rev.selected].keep = event.target.checked;
        rev.dirty = true;
        renderReview();
    };
    $('rev-ok').onclick = () => {
        rev.segments[rev.selected].confidence = 'alta';
        rev.segments[rev.selected].reviewed = true;
        rev.dirty = true;
        if (rev.selected < rev.segments.length - 1) rev.selected++;
        renderReview();
    };
    $('rev-reset').onclick = () => {
        const segment = rev.segments[rev.selected];
        rev.segments[rev.selected] = { ...segment.original, original: segment.original };
        rev.dirty = true;
        renderReview();
    };

    for (const group of document.querySelectorAll('.nudges')) {
        for (const button of group.querySelectorAll('button')) {
            button.onclick = () => {
                const segment = rev.segments[rev.selected];
                const delta = Number(button.dataset.delta);
                const edge = group.dataset.edge;
                setEdge(edge, (edge === 'in' ? segment.sourceStartSec : segment.sourceEndSec) + delta);
            };
        }
    }
    for (const button of document.querySelectorAll('.btn-play')) {
        button.onclick = () => playEdge(button.dataset.play);
    }

    window.addEventListener('resize', () => {
        if (document.getElementById('view-review').classList.contains('is-visible')) {
            renderOverview();
            renderZoom();
        }
    });
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
    if (doc.ai) {
        rows.push([
            'IA local (Ollama)',
            doc.ai.ok && doc.ai.hasModel
                ? `<span class="badge badge-ok">lista</span> <span class="mono">${esc(doc.ai.model)}</span>`
                : `<span class="badge badge-warn">no disponible</span> <span class="cell-dim">${esc(doc.ai.reason)}</span>`
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
    wireReview();

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

    window.cc.onProcessStage(payload => {
        const entry = run.rows.get(payload.id);
        if (!entry) return;
        entry.status = 'trabajando';
        entry.stage = payload.stage;
        entry.percent = payload.percent != null ? payload.percent : null;
        renderRunRows();
    });

    window.cc.onProcessClass(payload => {
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

init().catch(err => {
    document.body.innerHTML = `<div class="empty">No se pudo iniciar la ventana: ${esc(err.message)}</div>`;
});
