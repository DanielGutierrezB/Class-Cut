'use strict';
/** Paso 2: soltar o elegir carpetas. Se pueden sumar todas las que hagan falta. */

import { $, anotar, toast } from './chrome.js';
import { state, clases, ponerCarpeta } from './estado.js';
import { plural, rutaPlegada } from './formato.js';
import { renderScan } from './vista-clases.js';

/** Lo llama `app.js` para poder llevar a la tabla sin importarse los pasos. */
let alCargar = () => {};

export function wireCarpeta(params) {
    alCargar = (params && params.alCargar) || (() => {});
    wireDropzone();
}

export function dropError(message) {
    const el = $('drop-error');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
}

/** Lo que ya está cargado, para no tener que ir a la tabla a saberlo. */
export function renderCargadas() {
    const caja = $('drop-cargadas');
    if (!state.carpetas.length) { caja.hidden = true; return; }
    $('drop-cargadas-info').textContent =
        `Ya tenés ${plural(state.carpetas.length, 'carpeta', 'carpetas')} · ` +
        `${plural(clases().length, 'clase', 'clases')}: ${state.carpetas.map(c => c.rootName).join(', ')}`;
    caja.hidden = false;
}

/* ─── Las últimas carpetas ────────────────────────────────────────────────── */

/**
 * Las rutas que se ofrecen, en el orden que mandan los ajustes (la última
 * primero). Es una copia de lo que contestó el puente y no una lista propia:
 * quitar una guarda y vuelve a leer de la respuesta del que escribió, nunca de
 * esto.
 */
let recientes = [];

/**
 * Cuáles están en el disco AHORA. Sin entrada quiere decir "todavía no pregunté",
 * que se dibuja igual que "sí": la lista se pinta antes de que la respuesta
 * llegue y no puede empezar acusando de perdidas a seis carpetas que están.
 */
const enDisco = new Map();

/** El nombre del curso, que es el último tramo: lo único que no se pliega. */
function nombreDeRuta(ruta) {
    return String(ruta || '').split('/').filter(Boolean).pop() || ruta || '';
}

/** El nido donde vive, ya plegado. Vacío si la carpeta cuelga de la raíz. */
function dondeVive(ruta) {
    const partes = String(ruta || '').split('/').filter(Boolean);
    return partes.length > 1 ? rutaPlegada(`/${partes.slice(0, -1).join('/')}`) : '';
}

function filaReciente(ruta) {
    const fila = document.createElement('li');
    fila.className = 'reciente';
    fila.dataset.ruta = ruta;
    const falta = enDisco.get(ruta) === false;
    fila.classList.toggle('es-perdida', falta);

    const abrir = document.createElement('button');
    abrir.type = 'button';
    abrir.className = 'reciente-abrir';
    // La ruta entera en el globito: plegarla es para leerla de un vistazo, no
    // para esconderla de quien la necesita para saber cuál de dos es.
    abrir.title = ruta;

    const nombre = document.createElement('strong');
    nombre.className = 'reciente-nombre';
    nombre.textContent = nombreDeRuta(ruta);
    const donde = document.createElement('span');
    donde.className = 'reciente-donde mono';
    donde.textContent = dondeVive(ruta);
    abrir.append(nombre, donde);

    if (falta) {
        const marca = document.createElement('span');
        marca.className = 'reciente-marca';
        marca.textContent = 'no la encuentro';
        marca.title = 'Puede ser un disco que no está enchufado, o que la moviste. ' +
            'Sigue acá: nada se borró.';
        abrir.append(marca);
    }
    abrir.onclick = () => abrirReciente(ruta);

    // El mismo botón y el mismo texto que en la lista de Grabar
    // (`grabar/grabadas.js`): en las dos pantallas quiere decir lo mismo, y una
    // que dijera "Olvidar" haría dudar de si la otra borra.
    const quitar = document.createElement('button');
    quitar.type = 'button';
    quitar.className = 'btn btn-ghost btn-inline reciente-quitar';
    quitar.textContent = 'Quitar de la lista';
    quitar.title = 'Deja de mostrarla acá. No borra nada del disco.';
    quitar.onclick = () => quitarReciente(ruta);

    fila.append(abrir, quitar);
    return fila;
}

function pintarRecientes() {
    const caja = $('drop-recientes');
    caja.hidden = !recientes.length;
    const lista = $('drop-recientes-lista');
    lista.replaceChildren(...recientes.map(filaReciente));
}

/**
 * Relee la lista y pregunta por el disco después.
 *
 * En dos tiempos a propósito: primero se pinta lo que dicen los ajustes, que es
 * inmediato, y recién después se marcan las que no están. Al revés —esperar el
 * disco para pintar— la pantalla con la que abre la app quedaría en blanco todo
 * lo que tarde en contestar un volumen dormido, y eso es exactamente el "que la
 * pantalla se trabe" que esta lista no puede permitirse.
 */
export async function cargarRecientes() {
    recientes = await window.cc.carpetasRecientes();
    pintarRecientes();
    if (!recientes.length) return;
    const hay = await window.cc.carpetasEnDisco(recientes);
    for (const [ruta, esta] of Object.entries(hay || {})) enDisco.set(ruta, esta);
    pintarRecientes();
}

/**
 * Un clic en una carpeta reciente.
 *
 * Se vuelve a preguntar por el disco antes de escanear en vez de creerle a la
 * marca pintada: entre que la pantalla se abrió y el clic pudo pasar cualquiera
 * de las dos cosas —el disco se enchufó, el disco se fue— y la marca es de antes.
 * Así el que acaba de enchufar el disco no tiene que reabrir nada, y la que ya no
 * está lo dice antes de que el escáner lo diga peor.
 *
 * Y pase lo que pase el clic contesta algo. Una fila apagada que no hace nada
 * deja al editor golpeándola sin saber si el problema es la carpeta o la app.
 */
async function abrirReciente(ruta) {
    // Ni siquiera esta: un clic que se traga el gesto en silencio deja al editor
    // apretando de nuevo, que es la manera más rápida de escanear dos veces.
    if (state.scanning) { toast('Pará un segundo: todavía estoy leyendo la carpeta anterior.'); return; }
    dropError('');
    const hay = await window.cc.carpetasEnDisco([ruta]);
    const esta = Boolean(hay && hay[ruta]);
    enDisco.set(ruta, esta);
    pintarRecientes();
    if (esta) { addFolder(ruta); return; }
    anotar('reciente.no-esta', { carpeta: ruta });
    dropError(`No encuentro "${nombreDeRuta(ruta)}" en ${dondeVive(ruta) || 'esa ruta'}. ` +
        'Si vive en un disco que no está enchufado, enchufalo y volvé a tocarla. ' +
        'Si la moviste o la renombraste, traela con "Elegir carpeta…". ' +
        'La dejo en la lista por las dudas: para sacarla, "Quitar de la lista".');
}

/**
 * Sacar una ruta de la lista. No borra nada: la carpeta sigue donde está.
 *
 * La lista de después sale de lo que devolvió el que ESCRIBIÓ, no de filtrar la
 * copia local. Es la misma trampa que se comió la lista de Grabar: guardar sin
 * una carpeta y seguir mostrando un arreglo que ya no es el que quedó guardado
 * deja la pantalla y el archivo contando dos historias, y la que gana es la del
 * repintado siguiente — o sea que la carpeta vuelve sola.
 */
async function quitarReciente(ruta) {
    const r = await window.cc.ajustesGuardar({
        carpetasRecientes: recientes.filter(d => d !== ruta)
    });
    if (!r.ok) { toast(r.error); return; }
    anotar('reciente.quitada', { carpeta: ruta, quedan: r.ajustes.carpetasRecientes.length });
    recientes = r.ajustes.carpetasRecientes;
    enDisco.delete(ruta);
    pintarRecientes();
}

export async function addFolder(folder) {
    if (!folder || state.scanning) return;
    dropError('');
    state.scanning = true;
    $('dropzone').classList.remove('is-over');
    toast('Buscando clases…');

    try {
        const result = await window.cc.scan(folder);
        if (!result || !result.ok) {
            // Que ya esté cargada no es un error de la carpeta: es que no hay
            // nada que hacer. Se dice y se sigue mostrando lo que hay.
            const mensaje = (result && result.error) || 'No se pudo leer la carpeta.';
            if (result && result.yaCubierta) {
                toast(mensaje);
                if (state.carpetas.length) alCargar();
            } else {
                dropError(mensaje);
            }
            return;
        }
        if (!result.classCount) {
            dropError(`No encontré clases en "${result.rootName}". Busco carpetas que tengan un XML del Rodecaster con Audio y Video al lado.`);
            return;
        }

        ponerCarpeta(result, result.reemplaza);
        if (result.reemplaza && result.reemplaza.length) {
            toast(`"${result.rootName}" ya contenía lo que estaba cargado: se reemplazó.`);
        }
        renderCargadas();
        renderScan();
        alCargar();
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
            // Se resalta siempre, no solo con la tabla vacía: soltar una segunda
            // carpeta es tan normal como soltar la primera.
            zone.classList.add('is-over');
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
