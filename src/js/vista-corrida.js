'use strict';
/** Paso 3: procesar las clases marcadas y contar cómo fue. */

import { $, showView, alertsHtml } from './chrome.js';
import { esc, fmtDur, plural } from './formato.js';
import { state, marcadas, ponerCarpeta } from './estado.js';
import { closeDrawer, renderScan } from './vista-clases.js';
import { marcarPaso, PASOS } from './pasos.js';

const STAGE_LABEL = {
    reusar: 'Recuperando el trabajo ya hecho',
    transcribir: 'Transcribiendo el Live-Mix',
    alinear: 'Alineando los marcadores',
    afinar: 'Afinando los cortes dudosos',
    despegar: 'Quitando lo que se dice dos veces',
    revisar: 'Leyendo la clase entera',
    repasar: 'Arreglando lo que no cierra',
    cortar: 'Calculando los cortes',
    exportar: 'Escribiendo el XML'
};

export const run = { rows: new Map(), started: 0, total: 0, done: 0, cancelling: false, modelo: null };

/**
 * @param {boolean} desdeCero ignora el trabajo guardado y lo rehace todo
 */
export async function startProcessing(desdeCero) {
    const selected = marcadas();
    if (!selected.length) return;

    closeDrawer();
    run.rows = new Map(selected.map(c => [c.id, { cls: c, status: 'espera', stage: null, percent: null, result: null }]));
    run.total = selected.length;
    run.done = 0;
    run.started = Date.now();
    run.cancelling = false;
    run.modelo = null;

    showView('run');
    marcarPaso(PASOS.procesar, true);
    const verbo = desdeCero ? 'Reprocesando' : 'Procesando';
    $('run-title').textContent = selected.length === 1
        ? `${verbo} 1 clase`
        : `${verbo} ${selected.length} clases`;
    $('run-sub').textContent = !$('use-ai').checked
        ? 'Solo reglas: la IA local está apagada.'
        : (desdeCero
            ? 'Desde cero: se ignora lo guardado y se vuelve a transcribir.'
            : 'Transcribe, alinea, afina los cortes dudosos y lee la clase entera.');
    $('btn-cancel').hidden = false;
    $('btn-open-output').hidden = true;
    $('btn-back').hidden = true;
    $('run-alerts').innerHTML = '';
    renderRunRows();
    renderRunFoot();

    finishProcessing(await window.cc.process({
        ids: selected.map(c => c.id),
        force: Boolean(desdeCero),
        useAi: $('use-ai').checked,
        // Vacío es "el mejor que haya": la elección a mano solo pisa el orden de
        // preferencia cuando el editor de verdad eligió algo.
        model: $('ai-model').value || null
    }));
}

function finishProcessing(response) {
    $('btn-cancel').hidden = true;
    $('btn-back').hidden = false;

    if (!response || !response.ok) {
        $('run-title').textContent = 'No se pudo procesar';
        $('run-alerts').innerHTML = alertsHtml([{
            level: 'err',
            message: (response && response.error) || 'Falló sin decir por qué.'
        }]);
        return;
    }

    // Las carpetas se releyeron al terminar: la tabla tiene que mostrar las
    // clases como procesadas, y el paso de Revisar tiene que quedar habilitado
    // sin salir y volver a entrar.
    for (const fresca of (response.carpetas || [])) ponerCarpeta(fresca, []);
    if (response.carpetas && response.carpetas.length) renderScan();

    state.salidas = response.salidas || [];
    const salida = $('btn-open-output');
    salida.hidden = false;
    salida.textContent = state.salidas.length > 1
        ? `Abrir ${state.salidas.length} carpetas de salida`
        : 'Abrir "The Cutter"';
    salida.title = state.salidas.map(s => s.dir).join('\n');

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

    const seconds = Math.round((Date.now() - run.started) / 1000);
    $('run-title').textContent = response.cancelled
        ? `Cancelado · ${exported.length} de ${run.total} listas`
        : `Listo · ${exported.length} de ${run.total} ${exported.length === 1 ? 'clase exportada' : 'clases exportadas'}`;
    $('run-sub').textContent = `En ${fmtDur(seconds)} · los XML están en "The Cutter"`;
    // Sigue siendo el paso 3: escribir los XML es en lo que termina procesar, no
    // un sitio aparte al que se va. Lo que cambia es que ahora Revisar quedó
    // habilitado en el cabezal.
    marcarPaso(PASOS.procesar, true);

    $('run-alerts').innerHTML = alertsHtml(avisosDeLaCorrida(response).slice(0, 12));
}

function avisosDeLaCorrida(response) {
    const alerts = response.results
        .filter(r => !r.ok && !r.cancelled)
        .map(fail => ({ level: 'err', message: `${fail.id}: ${fail.error}` }));

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
    return alerts;
}

function shortName(id) {
    const row = run.rows.get(id);
    return row && row.cls.classNumber != null ? `Clase ${row.cls.classNumber}` : id;
}

export function renderRunRows() {
    $('run-rows').innerHTML = [...run.rows.values()].map(entry => {
        const { cls, result } = entry;
        const conf = result && result.ok ? result.stats.confidence : null;
        return `
        <tr>
            <td class="col-num"><span class="class-no">${cls.classNumber == null ? '—' : cls.classNumber}</span></td>
            <td><span class="cell-seq">${esc(cls.sequenceName || cls.folderName)}</span></td>
            <td>${estadoDeFila(entry)}</td>
            <td class="num cell-num">${result && result.ok ? result.totals.kept : '—'}</td>
            <td class="num cell-num">${result && result.ok ? fmtDur(result.totals.keepSec) : '—'}</td>
            <td class="cell-dim">${result && result.ok ? `${result.offset.appliedSec.toFixed(2)}s <span class="cell-dim">(${esc(result.offset.source)})</span>` : '—'}</td>
            <td>${conf
                ? `<span class="badge badge-ok">${conf.alta}</span><span class="badge badge-warn">${conf.media}</span><span class="badge badge-err">${conf.baja}</span>`
                : '<span class="cell-dim">—</span>'}</td>
        </tr>`;
    }).join('');

    pintarProgreso();
}

/** Le da su ancho a cada barra de progreso recién puesta. */
function pintarProgreso() {
    for (const barra of $('run-rows').querySelectorAll('.progress [data-percent]')) {
        barra.style.width = `${barra.dataset.percent}%`;
    }
}

function estadoDeFila(entry) {
    if (entry.status === 'espera') return '<span class="cell-dim">en espera</span>';
    if (entry.status === 'trabajando') {
        // El ancho no puede ir como atributo `style`: la política de seguridad
        // de la ventana los descarta y la barra se queda siempre vacía. Viaja
        // como dato y lo aplica `pintarProgreso` cuando la fila ya está puesta.
        const bar = entry.percent != null
            ? `<span class="progress"><span data-percent="${entry.percent}"></span></span>`
            : '';
        return `${esc(STAGE_LABEL[entry.stage] || 'Trabajando')}${bar}`;
    }
    const result = entry.result;
    if (result && result.ok) return '<span class="badge badge-ok">exportada</span>';
    if (result && result.cancelled) return '<span class="badge badge-info">cancelada</span>';
    return '<span class="badge badge-err">falló</span>';
}

export function renderRunFoot() {
    const rows = [...run.rows.values()];
    const done = rows.filter(r => r.status === 'listo').length;
    const kept = rows.reduce((sum, r) => sum + (r.result && r.result.ok ? r.result.totals.keepSec : 0), 0);
    $('run-foot').innerHTML = `${done} de ${run.total} · ${fmtDur(kept)} de material cortado`;
}
