'use strict';
/** Paso 3: procesar las clases marcadas y contar cómo fue. */

import { $, showView, alertsHtml } from './chrome.js';
import { esc, fmtDur, fmtMs, fmtTokens, fmtFalta, plural } from './formato.js';
import { state, marcadas, ponerCarpeta } from './estado.js';
import { closeDrawer, renderScan } from './vista-clases.js';
import { marcarPaso, PASOS } from './pasos.js';
import { faltaDeEtapa, faltaDeClase, faltaDeCorrida, ritmo } from './estimar.js';
import { fraccionDeClase, fraccionDeCorrida, costoDeClase, esperadoDeClase, medir, TECHO } from './progreso.js';

// El orden es el del pipeline (`engine/pipeline.js`, STAGES). Está repetido acá
// a propósito: la ventana no puede importar del motor, y lo que necesita no es
// la lista sino cómo se lee cada etapa en español.
const STAGE_LABEL = {
    reusar: 'Recuperando el trabajo ya hecho',
    transcribir: 'Transcribiendo el Live-Mix',
    alinear: 'Alineando los marcadores',
    releer: 'Volviendo a oír los arranques sin texto',
    afinar: 'Afinando los cortes dudosos',
    despegar: 'Quitando lo que se dice dos veces',
    revisar: 'Leyendo la clase entera',
    repasar: 'Arreglando lo que no cierra',
    cortar: 'Calculando los cortes',
    exportar: 'Escribiendo el XML'
};

export const run = {
    rows: new Map(),
    started: 0,
    total: 0,
    done: 0,
    cancelling: false,
    modelo: null,
    /**
     * Las clases ya terminadas, para estimar las que faltan. Ver `estimar.js`:
     * lo que se guarda es material y tiempo medidos, no un promedio ya hecho,
     * porque el promedio depende de con cuál bolsa se pregunte.
     */
    muestras: [],
    tic: null,
    /** Con qué se arrancó esta corrida, para no repetirlo en cada repintado. */
    contexto: '',
    /**
     * Dónde quedó la barra, de 0 a 1.
     *
     * Se guarda en vez de calcularse y listo porque la barra NO PUEDE
     * retroceder: los pesos se recalculan con cada clase que termina, y una
     * medición nueva puede dar una cuenta un poco menor que la de hace un
     * segundo. Verla ir para atrás rompe lo único que la barra tiene que
     * transmitir.
     */
    barra: 0,
    /** Si se pidió rehacer todo, que cambia qué clases van a transcribir. */
    desdeCero: false
};

/**
 * @param {boolean} desdeCero ignora el trabajo guardado y lo rehace todo
 */
export async function startProcessing(desdeCero) {
    const selected = marcadas();
    if (!selected.length) return;

    closeDrawer();
    run.rows = new Map(selected.map(c => [c.id, {
        cls: c, status: 'espera', stage: null, percent: null,
        msClase: 0, msEtapa: 0, hechas: [], result: null
    }]));
    run.total = selected.length;
    run.done = 0;
    run.started = Date.now();
    run.cancelling = false;
    run.modelo = null;
    run.muestras = [];
    run.barra = 0;
    run.desdeCero = Boolean(desdeCero);

    showView('run');
    marcarPaso(PASOS.procesar, true);
    const verbo = desdeCero ? 'Reprocesando' : 'Procesando';
    $('run-title').textContent = selected.length === 1
        ? `${verbo} 1 clase`
        : `${verbo} ${selected.length} clases`;
    run.contexto = !$('use-ai').checked
        ? 'Solo reglas: el criterio está apagado'
        : (desdeCero ? 'Desde cero: se vuelve a transcribir' : '');
    $('btn-cancel').hidden = false;
    $('btn-open-output').hidden = true;
    $('btn-back').hidden = true;
    $('run-alerts').innerHTML = '';
    $('run-progreso').hidden = false;
    $('run-progreso').classList.remove('is-listo');
    $('run-ahora').textContent = 'Empezando…';
    $('run-cifra').textContent = '';
    renderRunRows();
    renderRunHead();
    renderBarra();
    renderRunFoot();
    // El reloj: sin esto, el transcurrido y el estimado solo se mueven cuando
    // llega un aviso del motor, y hay etapas que no avisan durante minutos —la
    // pantalla parecía colgada justo cuando más importa que no lo parezca.
    empezarElReloj();

    const respuesta = await window.cc.process({
        ids: selected.map(c => c.id),
        force: Boolean(desdeCero),
        useAi: $('use-ai').checked,
        // Vacío es "el mejor que haya": la elección a mano solo pisa el orden de
        // preferencia cuando el editor de verdad eligió algo.
        model: $('ai-model').value || null
    });
    pararElReloj();
    finishProcessing(respuesta);
}

function empezarElReloj() {
    pararElReloj();
    run.tic = setInterval(() => {
        // Las filas NO se rehacen cada segundo: repintarlas cierra el globito
        // que se esté leyendo —que es donde vive cuánto tardó cada etapa— y
        // pierde el scroll. Solo se toca el texto de la celda del tiempo.
        renderRunHead();
        renderBarra();
        refrescarTiempos();
        renderRunFoot();
    }, 1000);
}

function pararElReloj() {
    if (run.tic) clearInterval(run.tic);
    run.tic = null;
}

/** La fila que está corriendo ahora, si hay. */
function enCurso() {
    return [...run.rows.values()].find(r => r.status === 'trabajando') || null;
}

/** Lo que lleva la etapa en curso, contando desde el último aviso. */
function msEtapaVivo(entry) {
    if (!entry || entry.status !== 'trabajando') return 0;
    return entry.msEtapa + (Date.now() - (entry.recibidoEn || Date.now()));
}

/** Cuánto material tienen las clases que ni empezaron, separado por bolsa. */
function pendientes() {
    return [...run.rows.values()]
        .filter(r => r.status === 'espera')
        .map(r => ({
            materialSec: r.cls.durationSec || 0,
            transcribira: transcribira(r.cls)
        }));
}

/** Lo que falta de toda la corrida, o null si todavía no hay con qué decirlo. */
function faltaDeTodo() {
    const fila = enCurso();
    const desdeCero = ritmo(run.muestras, true);
    const reusando = ritmo(run.muestras, false);

    let faltaClase = null;
    if (fila) {
        const transcribe = transcribira(fila.cls);
        faltaClase = faltaDeClase({
            ritmoMs: transcribe ? desdeCero : reusando,
            materialSec: fila.cls.durationSec || 0,
            // Los dos al día y no como llegaron en el último aviso: si no, el
            // estimado se congela y el "faltan ~4 min" sigue diciendo cuatro
            // cinco minutos después.
            msTranscurridos: msDeFila(fila),
            faltaEtapaMs: faltaDeEtapa(msEtapaVivo(fila), fila.percent)
        });
    }

    return faltaDeCorrida({
        faltaClaseMs: faltaClase,
        pendientes: pendientes(),
        ritmoDesdeCero: desdeCero,
        ritmoReusando: reusando
    });
}

/** Los tokens de toda la corrida, y si el proveedor los informa. */
function tokensDeLaCorrida() {
    const resultados = [...run.rows.values()].map(r => r.result).filter(r => r && r.ok && r.tokens);
    if (!resultados.length) return null;
    const informa = resultados.some(r => r.tokens.informa);
    return {
        informa,
        total: resultados.reduce((s, r) => s + (r.tokens.informa ? r.tokens.total : 0), 0),
        consultas: resultados.reduce((s, r) => s + r.tokens.consultas, 0)
    };
}

/**
 * El renglón de abajo del título: con qué se arrancó y cuántas van.
 *
 * Deliberadamente quieto. Lo que se mueve —etapa, porcentaje, transcurrido,
 * estimado— vive en la barra, quince píxeles más abajo; tenerlo en los dos
 * lados hacía que compitieran y que ninguno se leyera.
 */
function renderRunHead() {
    if (run.done >= run.total && !enCurso()) return;
    const partes = run.contexto ? [run.contexto] : [];
    partes.push(`${run.done} de ${run.total} ${run.total === 1 ? 'lista' : 'listas'}`);
    $('run-sub').textContent = partes.join(' · ');
}

/**
 * Si esta clase va a pasar por Whisper o va a reusar lo que ya tiene.
 *
 * Mirar sólo el trabajo guardado no alcanza: en una corrida desde cero TODAS
 * transcriben, tengan lo que tengan guardado. Sin esta parte, reprocesar una
 * clase ya hecha le daba peso cero a transcribir y la barra se quedaba clavada
 * los cuarenta segundos de Whisper — el defecto original, servido de nuevo.
 */
function transcribira(cls) {
    return run.desdeCero || !(cls.trabajoGuardado && cls.trabajoGuardado.sirve);
}

/**
 * Lo que midió esta corrida por etapa, de las clases del mismo tipo de trabajo.
 *
 * Separado por bolsa porque una clase que reusó el transcript no dice nada
 * sobre cuánto pesa transcribir, y mezclarlas correría el peso de la etapa más
 * cara justo cuando la barra empieza a tener con qué guiarse.
 */
function medidosDe(transcribe) {
    const propias = run.muestras.filter(m => Boolean(m.transcribio) === Boolean(transcribe));
    return { suma: medir(propias.map(m => m.etapas)), clases: propias.length };
}

/** Cuánto va de una clase, de 0 a 1. */
function fraccionDeFila(entry) {
    if (entry.status === 'listo') return 1;
    if (entry.status !== 'trabajando' || !entry.stage) return 0;
    const transcribe = transcribira(entry.cls);
    const medidos = medidosDe(transcribe);
    return fraccionDeClase({
        etapa: entry.stage,
        percent: entry.percent,
        // Desde el ÚLTIMO aviso y no desde que empezó la etapa: el aviso ya
        // puso la barra donde va, y lo que hay que medir es el silencio que
        // vino después.
        msDesdeAviso: entry.recibidoEn ? Date.now() - entry.recibidoEn : 0,
        esperadoClaseMs: esperadoDeClase(entry.cls.durationSec, transcribe, ritmo(run.muestras, transcribe)),
        transcribe,
        medidos: medidos.suma,
        clasesMedidas: medidos.clases
    });
}

/**
 * La barra y el renglón de qué está pasando.
 *
 * La barra es de la CORRIDA ENTERA. Con trece clases marcadas, lo que el editor
 * necesita saber es cuánto falta en total; el avance de la clase en curso ya
 * está en su fila, en chico, donde no compite.
 */
function renderBarra() {
    const fila = enCurso();
    const filas = [...run.rows.values()].map(entry => {
        const transcribe = transcribira(entry.cls);
        return {
            estado: entry.status,
            costo: costoDeClase(entry.cls.durationSec, transcribe, ritmo(run.muestras, transcribe)),
            fraccion: fraccionDeFila(entry)
        };
    });

    // El techo también acá y no sólo por clase: con la última clase al 99% y
    // las demás terminadas, la corrida da 0,997 y se redondea a 100. Se vio en
    // una corrida de verdad —la barra llena y "Arreglando lo que no cierra"
    // abajo, dos minutos y medio— y es lo peor que puede hacer una barra.
    run.barra = Math.min(TECHO, Math.max(run.barra, fraccionDeCorrida(filas)));
    $('run-barra').style.width = `${(run.barra * 100).toFixed(1)}%`;

    // El nombre largo y en castellano llano, que para eso se escribió. Sin
    // clase en curso el texto igual dice algo: entre clase y clase hay unos
    // segundos de lectura de carpetas en los que la pantalla no puede quedar
    // muda.
    $('run-ahora').textContent = fila
        ? `${STAGE_LABEL[fila.stage] || 'Trabajando'} · ${nombreCorto(fila.cls)}`
        : (run.cancelling ? 'Cancelando…' : 'Preparando la próxima clase…');

    const falta = fmtFalta(faltaDeTodo());
    const cifra = [
        // Truncado y no redondeado: 99,6% no puede leerse "100%" mientras algo
        // sigue andando.
        `${Math.floor(run.barra * 100)}% de la corrida`,
        `lleva ${fmtMs(Date.now() - run.started)}`
    ];
    // El estimado solo aparece cuando `estimar.js` pudo derivarlo de algo
    // medido acá. La barra sí se apoya en la semilla de `progreso.js` para
    // moverse, pero un "faltan ~7 min" sacado de la máquina de otro sería un
    // número inventado con cara de dato.
    if (falta) cifra.push(`faltan ${falta}`);
    $('run-cifra').textContent = cifra.join(' · ');
}

function nombreCorto(cls) {
    return cls.classNumber == null ? cls.folderName : `Clase ${cls.classNumber}`;
}

function finishProcessing(response) {
    $('btn-cancel').hidden = true;
    $('btn-back').hidden = false;

    // La barra se completa pase lo que pase: terminó, bien o mal. Dejarla en el
    // 94% porque una clase falló haría creer que todavía está trabajando.
    run.barra = 1;
    $('run-barra').style.width = '100%';
    $('run-progreso').classList.add('is-listo');

    if (!response || !response.ok) {
        $('run-ahora').textContent = 'No se pudo procesar';
        $('run-cifra').textContent = '';
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

    const transcurrido = Date.now() - run.started;
    $('run-title').textContent = response.cancelled
        ? `Cancelado · ${exported.length} de ${run.total} listas`
        : `Listo · ${exported.length} de ${run.total} ${exported.length === 1 ? 'clase exportada' : 'clases exportadas'}`;

    // Al terminar, el renglón deja de decir cuánto falta y pasa a decir cuánto
    // tomó, que es el número que sirve para la próxima vez. Va en el mismo
    // lugar donde estuvo latiendo la etapa en curso: es adonde se estuvo
    // mirando toda la corrida.
    const gasto = tokensDeLaCorrida();
    $('run-ahora').textContent = response.cancelled
        ? 'Cancelado. Lo que llegó a exportarse está en "The Cutter"'
        : 'Listo. Los XML están en "The Cutter"';

    const cerrado = [`Tomó ${fmtMs(transcurrido)}`];
    if (gasto && gasto.informa) {
        cerrado.push(`${gasto.total.toLocaleString('es')} tokens en ${plural(gasto.consultas, 'consulta', 'consultas')}`);
    } else if (gasto) {
        cerrado.push('el proveedor no informa tokens');
    }
    $('run-cifra').textContent = cerrado.join(' · ');
    $('run-sub').textContent = `${exported.length} de ${run.total} ${exported.length === 1 ? 'lista' : 'listas'}`;

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
    return row ? nombreCorto(row.cls) : id;
}

export function renderRunRows() {
    $('run-rows').innerHTML = [...run.rows.values()].map(entry => {
        const { cls, result } = entry;
        const conf = result && result.ok ? result.stats.confidence : null;
        const gasto = result && result.ok ? result.tokens : null;
        return `
        <tr>
            <td class="col-num"><span class="class-no">${cls.classNumber == null ? '—' : cls.classNumber}</span></td>
            <td><span class="cell-seq">${esc(cls.sequenceName || cls.folderName)}</span></td>
            <td>${estadoDeFila(entry)}</td>
            <td class="num cell-num">${result && result.ok ? result.totals.kept : '—'}</td>
            <td class="num cell-num">${result && result.ok ? fmtDur(result.totals.keepSec) : '—'}</td>
            <td class="num cell-num">${tiempoDeFila(entry)}</td>
            <td class="num cell-num">${tokensDeFila(gasto)}</td>
            <td class="cell-dim">${result && result.ok ? `${result.offset.appliedSec.toFixed(2)}s <span class="cell-dim">(${esc(result.offset.source)})</span>` : '—'}</td>
            <td>${conf
                ? `<span class="badge badge-ok">${conf.alta}</span><span class="badge badge-warn">${conf.media}</span><span class="badge badge-err">${conf.baja}</span>`
                : '<span class="cell-dim">—</span>'}</td>
        </tr>`;
    }).join('');

    pintarProgreso();
}

/**
 * En qué se fue el tiempo de esta clase, etapa por etapa.
 *
 * Esto era una tira de nueve pastillas en la pantalla principal y no servía:
 * `Rp` no le dice a nadie que es "arreglando lo que no cierra". Pero el dato sí
 * sirve —cuando una clase tarda el triple que la anterior, lo primero que hay
 * que saber es en qué tramo se fue— así que se queda, en el globito del tiempo,
 * que es donde se lo busca cuando hace falta. Las que no aparecen es porque no
 * corrieron: sin transcript no hay nada que afinar ni que leer.
 */
function desgloseDeEtapas(etapas) {
    const hechas = (etapas || []).filter(e => e && e.ms > 0);
    if (!hechas.length) return '';
    return hechas.map(e => `${STAGE_LABEL[e.etapa] || e.etapa}: ${fmtMs(e.ms)}`).join('\n');
}

/**
 * Cuánto lleva —o cuánto tardó— esta clase.
 *
 * Para la que corre no se usa el `msClase` del último aviso tal cual: hay
 * etapas que no avisan durante minutos (leer la clase entera con el modelo son
 * un minuto y medio de silencio), y la celda se quedaba clavada en el número
 * de hace rato mientras el cabezal decía otro. Se le suma lo que pasó desde
 * que llegó ese aviso, que es la misma cuenta que hace el motor.
 */
function msDeFila(entry) {
    if (entry.status === 'listo') return (entry.result && entry.result.msProceso) || null;
    if (entry.status !== 'trabajando') return null;
    return entry.msClase + (Date.now() - (entry.recibidoEn || Date.now()));
}

function tiempoDeFila(entry) {
    const ms = msDeFila(entry);
    if (ms == null) return '<span class="cell-dim">—</span>';
    const clase = entry.status === 'listo' ? '' : ' class="cell-dim"';
    const etapas = entry.status === 'listo' && entry.result
        ? entry.result.etapas
        : entry.hechas;
    const desglose = desgloseDeEtapas(etapas);
    const globito = desglose ? ` title="${esc(desglose)}"` : '';
    return `<span${clase} data-tiempo="${esc(entry.cls.id)}"${globito}>${esc(fmtMs(ms))}</span>`;
}

/** El reloj de la celda del tiempo, sin rehacer la fila. */
function refrescarTiempos() {
    for (const celda of $('run-rows').querySelectorAll('[data-tiempo]')) {
        const entry = run.rows.get(celda.dataset.tiempo);
        if (!entry || entry.status !== 'trabajando') continue;
        celda.textContent = fmtMs(msDeFila(entry));
    }
}

function tokensDeFila(gasto) {
    if (!gasto) return '<span class="cell-dim">—</span>';
    if (!gasto.informa) {
        return '<span class="cell-dim" title="El proveedor de criterio que está configurado no devuelve cuántos tokens gastó cada consulta.">no informa</span>';
    }
    const detalle = `${gasto.total.toLocaleString('es')} tokens · ` +
        `${gasto.entrada.toLocaleString('es')} de entrada (incluye caché) y ${gasto.salida.toLocaleString('es')} de salida · ` +
        `${gasto.consultas} consultas`;
    return `<span title="${esc(detalle)}">${esc(fmtTokens(gasto.total))}</span>`;
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
        // Lo que le falta a ESTA etapa, cuando informa porcentaje. Es el único
        // estimado que no necesita haber terminado ninguna clase antes.
        const falta = fmtFalta(faltaDeEtapa(msEtapaVivo(entry), entry.percent));
        const cola = falta ? ` <span class="cell-dim">${esc(falta)}</span>` : '';
        return `${esc(STAGE_LABEL[entry.stage] || 'Trabajando')}${entry.percent != null ? ` ${entry.percent}%` : ''}${bar}${cola}`;
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
    const gasto = tokensDeLaCorrida();

    const partes = [`${done} de ${run.total}`, `${fmtDur(kept)} de material cortado`];
    if (gasto && gasto.informa) partes.push(`${fmtTokens(gasto.total)} tokens`);
    else if (gasto) partes.push('tokens: el proveedor no los informa');
    $('run-foot').innerHTML = esc(partes.join(' · '));
}

/**
 * Un aviso de progreso del motor. Lo llama `app.js`, que es quien escucha el
 * puente; acá vive qué hacer con él porque es esta pantalla la que lo dibuja.
 */
export function alAvanzarEtapa(payload) {
    const entry = run.rows.get(payload.id);
    if (!entry) return;
    entry.status = 'trabajando';
    entry.stage = payload.stage;
    entry.percent = payload.percent != null ? payload.percent : null;
    // Los tres los mide el motor (`engine/pipeline.js`): la ventana no puede
    // cronometrar lo que no ve empezar.
    entry.msClase = payload.msClase || 0;
    entry.msEtapa = payload.msEtapa || 0;
    entry.hechas = payload.hechas || [];
    // Cuándo llegó este aviso, para poder seguir contando desde acá mientras la
    // etapa esté callada.
    entry.recibidoEn = Date.now();
    renderRunRows();
    renderRunHead();
    renderBarra();
}

/** Una clase empezó o terminó. */
export function alCambiarClase(payload) {
    const entry = run.rows.get(payload.id);
    if (!entry) return;
    if (payload.phase === 'empieza') {
        entry.status = 'trabajando';
    } else {
        entry.status = 'listo';
        entry.result = payload.result;
        entry.stage = null;
        entry.percent = null;
        run.done++;
        // La muestra para estimar las que faltan. Solo de las que salieron bien:
        // una clase que falló a los diez segundos diría que el ritmo es diez
        // veces mejor de lo que es.
        if (payload.result && payload.result.ok && payload.result.msProceso) {
            run.muestras.push({
                materialSec: payload.result.materialSec || entry.cls.durationSec || 0,
                ms: payload.result.msProceso,
                transcribio: Boolean(payload.result.transcribio),
                // El desglose por etapa va en la muestra para que la barra deje
                // de repartirse con la tabla de `progreso.js` y pase a hacerlo
                // con lo que tardó de verdad en ESTA máquina.
                etapas: payload.result.etapas || []
            });
        }
    }
    renderRunRows();
    renderRunHead();
    renderBarra();
    renderRunFoot();
}
