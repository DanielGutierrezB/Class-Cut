'use strict';
/** Paso 2: la tabla de clases, agrupada por carpeta, y el detalle de una. */

import { $, alertsHtml, anotar } from './chrome.js';
import { esc, fmtDur, fmtClock, fmtMs, fmtTokens, plural } from './formato.js';
import { state, clases, findClass, marcadas, estaColapsada, alternarCarpeta } from './estado.js';

const KIND_LABEL = {
    course: 'Curso',
    day: 'Día',
    class: 'Clase suelta',
    empty: 'Sin clases'
};

/** Cómo se lee una carpeta en su encabezado: "Curso · 3 días · 13 clases". */
function comoSeLee(scan) {
    const partes = [KIND_LABEL[scan.kind] || 'Carpeta'];
    if (scan.dayCount) partes.push(plural(scan.dayCount, 'día', 'días'));
    partes.push(plural(scan.classCount, 'clase', 'clases'));
    return partes.join(' · ');
}

export function renderScan() {
    if (!state.carpetas.length) return;

    const todas = clases();
    const dura = todas.reduce((suma, c) => suma + (c.durationSec || 0), 0);
    // La barra de arriba cuenta el total; de cada carpeta habla su encabezado en
    // la tabla. Antes acá vivía el nombre y la ruta de LA carpeta, en singular.
    $('scan-title').textContent =
        `${plural(state.carpetas.length, 'carpeta', 'carpetas')} · ${plural(todas.length, 'clase', 'clases')}`;
    // Y cuánto de eso ya está cortado, si hay algo cortado: es la diferencia
    // entre lo que se grabó y lo que se entrega.
    const cortado = todas.reduce((suma, c) => suma + duracionFinalDe(c), 0);
    $('scan-sub').textContent = cortado
        ? `${fmtDur(dura)} de material · ${fmtDur(cortado)} ya cortados`
        : `${fmtDur(dura)} de material`;

    renderAlerts();
    renderRows();
    renderFoot();
}

/**
 * Los avisos de todas las carpetas juntos.
 *
 * Se cuentan sobre el total y no por carpeta: al editor le importa cuántas
 * clases le faltan, no en cuál de las dos carpetas están. El detalle de cada
 * una vive en su fila.
 */
export function renderAlerts() {
    const todas = clases();
    const alerts = state.carpetas.flatMap(scan =>
        (scan.warnings || []).map(w => ({
            level: 'warn',
            message: state.carpetas.length > 1 ? `${scan.rootName}: ${w.message}` : w.message
        })));

    const blocked = todas.filter(c => !c.processable);
    if (blocked.length) {
        alerts.push({
            level: 'err',
            message: `${plural(blocked.length, 'clase', 'clases')} no se puede procesar todavía: mirá el detalle de las filas atenuadas.`
        });
    }

    const guardadas = todas.filter(c => c.trabajoGuardado && c.trabajoGuardado.sirve);
    const soloXml = todas.filter(c => c.alreadyProcessed && !c.trabajoGuardado);
    // Las dos noticias buenas van juntas y en una línea: son la mayoría de las
    // filas y antes ocupaban tres renglones de aviso arriba de la tabla, todos
    // los días, diciendo algo que las insignias de cada fila ya dicen.
    if (guardadas.length || soloXml.length) {
        const partes = [];
        if (guardadas.length) {
            partes.push(`${plural(guardadas.length, 'clase trae', 'clases traen')} su trabajo guardado: procesarlas escribe el XML en segundos`);
        }
        if (soloXml.length) partes.push(`${soloXml.length} ya tiene XML en "The Cutter"`);
        alerts.push({
            level: 'info',
            message: `${partes.join(' · ')}. Para rehacer todo desde cero está "Reprocesar".`
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

/** "hace 2 días", "el 18 de agosto". Para una fecha que solo sitúa, no precisa. */
function cuando(iso) {
    const fecha = new Date(iso);
    if (isNaN(fecha)) return '';
    const dias = Math.floor((Date.now() - fecha.getTime()) / 86400000);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    if (dias < 30) return `hace ${dias} días`;
    return fecha.toLocaleDateString('es', { day: 'numeric', month: 'long' });
}

/**
 * Lo que costó procesarla: cuánto tardó y, si el proveedor lo informa, cuántos
 * tokens gastó.
 *
 * Va al lado de "ya procesada" y no en una columna propia: es un dato que solo
 * existe para las filas hechas, y una columna con doce guiones y un número no
 * paga el ancho que ocupa. Las clases procesadas por versiones anteriores no
 * lo tienen guardado y no muestran nada, que es distinto de mostrar un cero.
 */
function costoBadge(guardado) {
    if (!guardado || !guardado.msProceso) return '';
    const gasto = guardado.tokens;
    const detalle = gasto && gasto.informa
        ? `${gasto.total.toLocaleString('es')} tokens en ${gasto.consultas} consultas al modelo`
        : 'Este proveedor no informa tokens';
    return `<span class="badge badge-info" title="${esc(detalle)}">tardó ${esc(fmtMs(guardado.msProceso))}` +
        `${gasto && gasto.informa ? ` · ${esc(fmtTokens(gasto.total))} tok` : ''}</span>`;
}

function statusBadges(cls) {
    const out = [];
    const guardado = cls.trabajoGuardado;

    if (!cls.processable) out.push('<span class="badge badge-err">no procesable</span>');
    else if (guardado && guardado.sirve) {
        out.push(`<span class="badge badge-ok" title="El trabajo está guardado en la carpeta de la clase: procesarla no vuelve a transcribir.">ya procesada · ${esc(cuando(guardado.procesadaEn))}</span>`);
        out.push(costoBadge(guardado));
    } else if (guardado) {
        out.push(`<span class="badge badge-warn" title="${esc(guardado.porque)}">hay que rehacerla</span>`);
    } else if (cls.alreadyProcessed) out.push('<span class="badge badge-ok">ya procesada</span>');
    else out.push('<span class="badge badge-info">lista</span>');

    if (cls.duplicate) out.push('<span class="badge badge-warn">duplicada</span>');
    if (cls.warnings && cls.warnings.length) {
        out.push(`<span class="badge badge-warn">${plural(cls.warnings.length, 'aviso', 'avisos')}</span>`);
    }
    return out.join('');
}

/**
 * El encabezado de una carpeta.
 *
 * Existe para poder tener varias cargadas sin perderse: dice de dónde salen las
 * filas que siguen, y lleva lo que antes vivía en la barra de arriba y valía
 * para una sola carpeta —verla en el Finder, quitarla, marcarla entera—.
 */
function grupoHtml(scan, conDia) {
    const suyas = scan.classes;
    const usables = suyas.filter(c => c.processable);
    const marcadasAca = usables.filter(c => c.selected).length;
    const dura = suyas.reduce((suma, c) => suma + (c.durationSec || 0), 0);
    const plegada = estaColapsada(scan.root);

    // Cuánto queda del curso ya cortado, si hay algo cortado. Es el número que
    // el editor le pasa al cliente, y hasta ahora había que sumar trece filas a
    // ojo para tenerlo.
    const cortado = suyas.reduce((suma, c) => suma + duracionFinalDe(c), 0);
    const resumen = cortado
        ? `${esc(comoSeLee(scan))} · ${fmtDur(dura)} → ${fmtDur(cortado)} cortado`
        : `${esc(comoSeLee(scan))} · ${fmtDur(dura)}`;

    return `
        <tr class="grupo ${plegada ? 'is-plegada' : ''}" data-root="${esc(scan.root)}">
            <td class="col-check">
                <input type="checkbox" data-grupo="${esc(scan.root)}"
                       ${usables.length && marcadasAca === usables.length ? 'checked' : ''}
                       ${usables.length ? '' : 'disabled'}
                       aria-label="Marcar las clases de esta carpeta">
            </td>
            <td colspan="${conDia ? 7 : 6}" data-plegar="${esc(scan.root)}">
                <button class="grupo-plegar" data-plegar="${esc(scan.root)}"
                        aria-expanded="${plegada ? 'false' : 'true'}"
                        title="${plegada ? 'Mostrar sus clases' : 'Esconder sus clases'}">${plegada ? '▸' : '▾'}</button>
                <button class="grupo-nombre" data-reveal="${esc(scan.root)}" title="Ver en el Finder">${esc(scan.rootName)}</button>
                <span class="grupo-meta">${resumen}</span>
            </td>
            <td colspan="2" class="grupo-acciones">
                <button class="btn btn-ghost btn-inline" data-quitar="${esc(scan.root)}"
                        title="Saca esta carpeta de la lista. No borra nada del disco.">Quitar</button>
            </td>
        </tr>`;
}

/** Cuánto dura esta clase ya cortada, o 0 si todavía no se cortó. */
function duracionFinalDe(cls) {
    const guardado = cls.trabajoGuardado;
    return guardado && guardado.sirve && guardado.duracionFinalSec ? guardado.duracionFinalSec : 0;
}

/**
 * La celda de duración.
 *
 * Para una clase sin procesar, el dato es cuánto material hay. Para una ya
 * procesada, ese número dejó de importar: lo que se quiere saber es cuánto dura
 * la clase que va a salir. Así que la ya procesada muestra el corte arriba y de
 * qué material salió abajo, en chico — que es la forma de decir las dos cosas
 * sin agregar una columna que estaría vacía en la mitad de las filas.
 */
function duracionCelda(cls) {
    const final = duracionFinalDe(cls);
    if (!final) return `<span data-dur="${esc(cls.id)}">${fmtDur(cls.durationSec)}</span>`;
    const material = cls.durationSec || 0;
    const fuera = material > final ? ` · se van ${fmtDur(material - final)}` : '';
    return `<span class="dur-final" title="La clase cortada dura ${esc(fmtDur(final))}${esc(fuera)}.">${fmtDur(final)}</span>` +
        `<span class="dur-crudo" data-dur="${esc(cls.id)}">de ${fmtDur(material)}</span>`;
}

function filaHtml(cls, conDia) {
    return `
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
            ${conDia ? `<td class="cell-dim cell-dia" title="${esc(cls.dayName || '')}">${esc(cls.dayName || '—')}</td>` : ''}
            <td class="num cell-num">${cls.videos.length}</td>
            <td class="num cell-num">${cls.audios.length}${cls.liveMixPath ? '' : ' ⚠'}</td>
            <td class="num cell-num col-dur">${duracionCelda(cls)}</td>
            <td class="num cell-num">${cls.blockCount || '—'}</td>
            <td>${viewBadges(cls.views)}</td>
            <td>${statusBadges(cls)}</td>
        </tr>`;
}

export function renderRows() {
    // El encabezado va siempre, aunque haya una sola carpeta: es donde vive
    // "Quitar", y con una sola no había forma de sacarla. Y así la tabla se lee
    // igual con una carpeta o con cinco, en vez de tener dos diseños.
    //
    // La columna del día, en cambio, solo existe si alguna clase está dentro de
    // uno: cuando la carpeta ES el día, esa columna eran trece guiones seguidos.
    const conDia = clases().some(c => c.dayName);
    $('th-dia').hidden = !conDia;

    // Una carpeta plegada no dibuja sus filas en vez de esconderlas con CSS: con
    // varios cursos cargados son cientos de `<tr>` que el navegador tiene que
    // medir igual aunque no se vean, y el único motivo para tenerlas ahí sería
    // no volver a armarlas — que es justo lo que este archivo ya hace en cada
    // render.
    $('class-rows').innerHTML = state.carpetas.map(scan =>
        grupoHtml(scan, conDia) +
        (estaColapsada(scan.root) ? '' : scan.classes.map(cls => filaHtml(cls, conDia)).join(''))
    ).join('');
    syncCheckAll();
}

/**
 * Rellena la duración de una fila cuando ffprobe termina de medirla.
 *
 * Lo hace este archivo y no quien recibe el aviso porque la celda tiene dos
 * formas —una línea si la clase está sin procesar, dos si ya se cortó— y quien
 * escucha el progreso no tiene por qué saber cuál le tocó.
 */
export function actualizarDuracion(id, durationSec) {
    for (const cell of document.querySelectorAll('#class-rows [data-dur]')) {
        if (cell.dataset.dur !== id) continue;
        cell.textContent = cell.classList.contains('dur-crudo')
            ? `de ${fmtDur(durationSec)}`
            : fmtDur(durationSec);
        return;
    }
}

export function syncCheckAll() {
    const usable = clases().filter(c => c.processable);
    const selected = usable.filter(c => c.selected);
    const box = $('check-all');
    box.checked = usable.length > 0 && selected.length === usable.length;
    box.indeterminate = selected.length > 0 && selected.length < usable.length;
}

export function renderFoot() {
    const selected = marcadas();
    const totalSec = selected.reduce((sum, c) => sum + (c.durationSec || 0), 0);
    const blocks = selected.reduce((sum, c) => sum + (c.blockCount || 0), 0);
    // Las que traen su trabajo son las que van a tardar segundos; el resto son
    // las que van a pasar por Whisper. Es la diferencia entre esperar un minuto
    // y esperar una hora, así que se dice antes de apretar.
    const reusan = selected.filter(c => c.trabajoGuardado && c.trabajoGuardado.sirve).length;
    const desdeCero = selected.length - reusan;

    const partes = [];
    if (selected.length) {
        partes.push(`<strong>${plural(selected.length, 'clase marcada', 'clases marcadas')}</strong>`);
        // De cuántas carpetas salen: procesar mezclando dos deja los XML en dos
        // "The Cutter" distintos, y eso se dice antes y no después.
        const deCuantas = new Set(selected.map(c => c.root)).size;
        if (deCuantas > 1) partes.push(`de ${deCuantas} carpetas`);
        partes.push(`${fmtDur(totalSec)} de material`);
        partes.push(plural(blocks, 'bloque', 'bloques'));
        if (reusan && desdeCero) partes.push(`${reusan} ya hechas · ${desdeCero} desde cero`);
        else if (reusan) partes.push('todas ya hechas');
    }
    $('foot-info').innerHTML = partes.length ? partes.join(' · ') : 'Ninguna clase marcada.';

    const btn = $('btn-process');
    btn.textContent = selected.length === 1 ? 'Procesar 1 clase' : `Procesar ${selected.length} clases`;
    btn.disabled = selected.length === 0;
    btn.title = selected.length
        ? (reusan
            ? 'Reusa lo que cada clase tenga guardado y escribe el XML. Lo que falte se calcula.'
            : 'Transcribe el Live-Mix, alinea los marcadores y escribe el XML cortado.')
        : 'Marcá al menos una clase.';

    // Solo tiene sentido ofrecerlo cuando hay algo hecho que tirar.
    const rehacer = $('btn-reprocess');
    rehacer.hidden = reusan === 0;
    rehacer.disabled = selected.length === 0;
    rehacer.textContent = reusan === selected.length && selected.length > 1
        ? 'Reprocesar todo'
        : 'Reprocesar';
    rehacer.title = 'Ignora el trabajo guardado y lo hace todo de nuevo: vuelve a transcribir y a leer la clase.';
}

/**
 * Los oyentes de la tabla se ponen UNA vez sobre el contenedor, no una por fila
 * cada vez que se dibuja: las filas se rehacen enteras en cada render y volver a
 * atarlas es trabajo que crece con la cantidad de clases.
 */
export function wireClases(callbacks) {
    const host = $('class-rows');
    const alQuitar = (callbacks && callbacks.alQuitarCarpeta) || (() => {});

    host.addEventListener('change', e => {
        const id = e.target.dataset.check;
        if (id) {
            const cls = findClass(id);
            if (cls) cls.selected = e.target.checked;
            renderFoot();
            syncCheckAll();
            return;
        }

        // La casilla del encabezado marca la carpeta entera: con dos cursos
        // cargados, "marcar todas" es demasiado y una por una es demasiado poco.
        const root = e.target.dataset.grupo;
        if (!root) return;
        const scan = state.carpetas.find(c => c.root === root);
        if (!scan) return;
        for (const cls of scan.classes) {
            if (cls.processable) cls.selected = e.target.checked;
        }
        renderRows();
        renderFoot();
    });

    host.addEventListener('click', async e => {
        // El clic en una casilla marca, no abre el detalle.
        if (e.target.dataset.check != null || e.target.dataset.grupo != null) return;

        const ver = e.target.closest('[data-reveal]');
        if (ver) { window.cc.reveal(ver.dataset.reveal); return; }

        const quitar = e.target.closest('[data-quitar]');
        if (quitar) { await alQuitar(quitar.dataset.quitar); return; }

        // Va después de los dos botones que viven adentro del encabezado y antes
        // de abrir el detalle: el `data-plegar` está en la celda entera, así que
        // sin este orden un clic en "Ver en el Finder" también plegaría.
        const plegar = e.target.closest('[data-plegar]');
        if (plegar) {
            const root = plegar.dataset.plegar;
            anotar('tabla.carpeta-plegada', { carpeta: root, plegada: alternarCarpeta(root) });
            renderRows();
            return;
        }

        const row = e.target.closest('tr');
        if (row && row.dataset.id) openDrawer(row.dataset.id);
    });
}

// ─── Detalle de una clase ─────────────────────────────────────────────

export function openDrawer(id) {
    const cls = findClass(id);
    if (!cls) return;
    state.openId = id;
    anotar('tabla.detalle-abierto', { clase: id, procesable: cls.processable });

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
    const guardadoAca = cls.trabajoGuardado;
    const final = duracionFinalDe(cls);
    const facts = [
        ['Clase', cls.classNumber == null ? '—' : cls.classNumber],
        ['Duración real', fmtDur(cls.durationSec)],
        // Las dos de la corrida solo aparecen si hay corrida: en una clase sin
        // procesar serían dos renglones diciendo "—".
        ...(final ? [['Duración del corte', fmtDur(final)]] : []),
        ...(guardadoAca && guardadoAca.msProceso
            ? [['Tardó en procesarse', fmtMs(guardadoAca.msProceso)]]
            : []),
        ...(guardadoAca && guardadoAca.tokens && guardadoAca.tokens.informa
            ? [['Tokens del modelo',
                `${guardadoAca.tokens.total.toLocaleString('es')} en ${plural(guardadoAca.tokens.consultas, 'consulta', 'consultas')}`]]
            : []),
        ['Frame rate', cls.fps ? `${cls.fps} fps` : '—'],
        ['Resolución', cls.width ? `${cls.width}×${cls.height}` : '—'],
        ['Bloques', cls.blockCount || 0],
        ['Claqueta', cls.clapSec == null ? 'sin marcador' : fmtClock(cls.clapSec)]
    ].map(([k, v]) => `
        <div class="fact"><div class="fact-label">${esc(k)}</div><div class="fact-value">${esc(v)}</div></div>
    `).join('');

    // Qué trae hecho de antes. Va arriba porque es lo que decide si esta clase
    // va a tardar segundos o media hora.
    const guardado = cls.trabajoGuardado;
    const hecho = !guardado ? '' : alertsHtml([guardado.sirve
        ? {
            level: 'info',
            message: `Procesada ${cuando(guardado.procesadaEn)}${guardado.modelo ? ` con ${guardado.modelo}` : ''}. ` +
                'El trabajo está guardado en esta carpeta y viaja con ella: procesarla otra vez no vuelve a transcribir.'
        }
        : { level: 'warn', message: `${guardado.porque} Lo guardado no se va a usar.` }
    ]);

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
        ${hecho}${problems}${warnings}${nominal}

        <div class="section-title">Material</div>
        <div class="file-list">${files(cls.videos)}${files(cls.audios)}</div>

        <div class="section-title">
            Bloques del director de contenido
            <button class="btn btn-ghost btn-corner" id="drawer-reveal">Ver el XML</button>
        </div>
        ${blocks ? `<div class="blocks">${blocks}</div>` : '<div class="empty">Sin bloques en el XML.</div>'}
    `;
}
