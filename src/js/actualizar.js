'use strict';
/**
 * actualizar.js — La versión, que además es el botón de actualizar.
 *
 * Antes había dos cosas: un número apagado en la esquina y un botón verde que
 * aparecía solo cuando había novedades. El problema de esconder el botón es que
 * cuando no está no hay dónde preguntar: si la consulta del arranque falló
 * porque no había internet, el editor no tiene forma de volver a intentarlo, y
 * tampoco de saber en qué versión está sin abrir Diagnóstico.
 *
 * Ahora es una sola cosa. El número siempre está y siempre se puede tocar: dice
 * en qué versión estás, y cuando hay una nueva se enciende y lo cuenta.
 *
 * El último paso lo da el editor a mano, abriendo el PKG. No es pereza: sin
 * Developer ID de Apple no se puede instalar por debajo (ver `engine/updates.js`),
 * y es preferible un instalador de Mac normal a un botón que falla en silencio.
 */

import { $, openModal, toast } from './chrome.js';
import { esc } from './formato.js';

// Al arrancar hay escaneos y ventanas dibujándose; la consulta puede esperar.
const ESPERA_INICIAL_MS = 4000;

// Y una cada tanto, porque esta app se queda abierta días entre curso y curso.
// Es un GET a GitHub: si falla, no pasa nada y se vuelve a intentar mañana.
const CADA_MS = 6 * 60 * 60 * 1000;

let versionActual = '';
let disponible = null;
let descargado = null;
let buscando = false;
let ultimaConsulta = null;

function pesoLegible(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function haceCuanto(fecha) {
    if (!fecha) return '';
    const min = Math.round((Date.now() - fecha) / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const horas = Math.round(min / 60);
    return horas < 24 ? `hace ${horas} h` : `hace ${Math.round(horas / 24)} días`;
}

/** Las notas del release vienen en Markdown; acá alcanza con las viñetas. */
function notasHtml(notas) {
    const lineas = String(notas || '')
        .split('\n')
        .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
    if (!lineas.length) return '';
    return `<ul class="update-notes">${lineas.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

/** El botón: el número siempre, y el aviso encima cuando hay algo. */
function pintarBoton() {
    const boton = $('version');
    if (!boton) return;
    const nueva = descargado || disponible;
    boton.classList.toggle('is-new', Boolean(nueva));
    boton.innerHTML = `v${esc(versionActual)}${nueva ? '<span class="version-dot"></span>' : ''}`;
    boton.title = descargado ? `La ${disponible.version} está descargada, lista para instalar`
        : disponible ? `Hay una versión nueva: ${disponible.version}`
            : `Class Cut ${versionActual} · tocá para buscar novedades`;
}

function cuerpoAlDia() {
    return `
        <p class="update-lead">Estás en la versión <strong>${esc(versionActual)}</strong>.</p>
        <p class="update-note">
            ${ultimaConsulta ? `Se consultó ${haceCuanto(ultimaConsulta)} y no había nada más nuevo.`
        : 'Todavía no se pudo consultar si hay novedades.'}
        </p>
        <div class="update-actions">
            <button class="btn" id="update-recheck"${buscando ? ' disabled' : ''}>
                ${buscando ? 'Buscando…' : 'Buscar de nuevo'}
            </button>
        </div>`;
}

function cuerpoDisponible() {
    const peso = pesoLegible(disponible.tamañoBytes);
    return `
        <p class="update-lead">
            Tenés la <strong>${esc(versionActual)}</strong> y está la
            <strong>${esc(disponible.version)}</strong>.
            ${peso ? `La descarga pesa ${peso}.` : ''}
        </p>
        ${notasHtml(disponible.notas)}
        <p class="update-note">
            Se baja solo la app. Tus modelos no se vuelven a descargar: viven fuera de ella
            y quedan donde están.
        </p>
        <div class="update-actions">
            <button class="btn btn-primary" id="update-go">Descargar</button>
        </div>
        <div class="update-progress" id="update-progress" hidden>
            <div class="update-bar"><span id="update-bar-fill"></span></div>
            <span class="update-pct" id="update-pct">0%</span>
            <button class="btn btn-ghost" id="update-stop">Cancelar</button>
        </div>`;
}

function cuerpoDescargado() {
    return `
        <p class="update-lead">La versión <strong>${esc(disponible.version)}</strong> está descargada.</p>
        <p class="update-note">
            Class Cut se cierra y se abre el instalador: hacés clic en Continuar y volvés a abrirla.
            El instalador quedó en tu carpeta de Descargas por si lo necesitás después.
        </p>
        <div class="update-actions">
            <button class="btn btn-primary" id="update-open">Cerrar e instalar</button>
        </div>`;
}

function pintarProgreso({ percent }) {
    const caja = $('update-progress');
    if (!caja) return;
    caja.hidden = false;
    const go = $('update-go');
    if (go) go.disabled = true;
    $('update-bar-fill').style.width = `${percent}%`;
    $('update-pct').textContent = `${percent}%`;
}

async function abrirInstalador() {
    const res = await window.cc.updateInstall(descargado);
    if (!res.ok) toast(res.error);
}

async function descargar() {
    const res = await window.cc.updateDownload({
        url: disponible.url,
        nombre: disponible.nombre
    });
    if (!res.ok) {
        const caja = $('update-progress');
        if (caja) caja.hidden = true;
        const go = $('update-go');
        if (go) go.disabled = false;
        toast(res.error);
        return;
    }
    descargado = res.path;
    pintarBoton();
    abrirVentana();
}

/**
 * La ventana muestra en qué punto está la cosa, y solo hay tres.
 *
 * Se vuelve a dibujar entera en cada cambio en vez de retocar el nodo: son tres
 * estados y ninguno comparte controles con otro, así que retocar sería más
 * código para que quede igual.
 */
function abrirVentana() {
    if (descargado && disponible) {
        openModal('Actualizar Class Cut', cuerpoDescargado());
        $('update-open').onclick = abrirInstalador;
        return;
    }
    if (disponible) {
        openModal('Actualizar Class Cut', cuerpoDisponible());
        $('update-go').onclick = descargar;
        $('update-stop').onclick = () => window.cc.updateCancel();
        return;
    }
    openModal('Class Cut', cuerpoAlDia());
    $('update-recheck').onclick = () => buscar(true);
    if (!ultimaConsulta && !buscando) buscar(true);
}

/** ¿La ventana abierta es esta? Para no repintar encima de otra cosa. */
function ventanaAbierta() {
    return !$('modal').hidden && $('modal-body').querySelector('.update-lead');
}

/**
 * Consulta si hay novedades.
 *
 * @param {boolean} aMano si lo pidió el editor, la ventana se actualiza sola con
 *   lo que haya salido; en la consulta del arranque el silencio es la respuesta
 *   correcta y lo único que cambia es el botón.
 */
export async function buscar(aMano) {
    if (buscando) return;
    buscando = true;
    if (aMano && ventanaAbierta()) abrirVentana();

    let res;
    try {
        res = await window.cc.updateCheck();
    } catch (e) {
        res = { hay: false, motivo: 'No se pudo consultar si hay novedades.' };
    }
    buscando = false;
    ultimaConsulta = Date.now();

    if (res.hay) disponible = res;
    pintarBoton();

    if (!aMano) return;
    if (res.hay) { abrirVentana(); return; }
    if (ventanaAbierta()) abrirVentana();
    toast(res.motivo || 'Ya estás en la última versión.');
}

export function init(version) {
    versionActual = version || '';
    pintarBoton();
    $('version').onclick = abrirVentana;
    window.cc.onUpdateProgress(pintarProgreso);
    window.cc.onUpdateReady(({ path }) => { descargado = path; pintarBoton(); });
    setTimeout(() => buscar(false), ESPERA_INICIAL_MS);
    setInterval(() => buscar(false), CADA_MS);
}
