'use strict';
/** Qué encontró la app y qué le falta, para cuando algo no anda. */

import { $, openModal, toast, anotar } from './chrome.js';
import { esc } from './formato.js';
import { buscar } from './actualizar.js';

export async function showDoctor() {
    anotar('diagnostico.abierto', {});
    const [info, doc] = await Promise.all([window.cc.appInfo(), window.cc.doctor()]);
    const rows = [
        ['Versión', `${info.version} · Electron ${info.electron}`
            + ' <button class="btn btn-ghost btn-inline" id="doctor-update">Buscar actualización</button>'],
        ['Arquitectura', `${info.arch}${doc.appleSilicon ? ' (Apple Silicon)' : ' — Class Cut necesita Apple Silicon'}`],
        // El botón vive en Diagnóstico y no en la barra de arriba porque es
        // exactamente lo que se busca cuando algo no anda, que es cuando se
        // abre esta ventana. Ponerlo arriba sería un botón que nadie usa
        // ocupando el sitio de los que sí.
        ['Registro de la sesión',
            'Todo lo que hizo la app desde que se abrió: carpetas, corridas con sus etapas y tiempos, ' +
            'guardados y errores. No lleva claves ni rutas completas. ' +
            '<button class="btn btn-ghost btn-inline" id="doctor-log">Descargar Log</button>']
    ];

    for (const tool of doc.tools) {
        rows.push([tool.key, tool.found
            ? `<span class="badge badge-ok">ok</span> <span class="mono">${esc(tool.path)}</span> <span class="cell-dim">(${esc(tool.source)})</span>`
            : `<span class="badge ${tool.required ? 'badge-err' : 'badge-warn'}">${tool.required ? 'falta' : 'todavía no hace falta'}</span> <span class="cell-dim">buscado en: ${esc(tool.searched.join(', '))}</span>`
        ]);
    }
    if (doc.ai) rows.push([nombreDelCriterio(doc.ai), insigniaModelo(doc.ai)]);

    openModal('Diagnóstico', `<div class="kv">${rows.map(([k, v]) =>
        `<div class="kv-row"><div class="kv-key">${esc(k)}</div><div class="kv-val">${v}</div></div>`).join('')}</div>`);

    // A mano se contesta siempre, aunque la respuesta sea que no hay nada:
    // apretar un botón y que no pase nada se lee como que está roto.
    $('doctor-update').onclick = () => buscar(true);
    $('doctor-log').onclick = descargarLog;
}

/**
 * Escribe el diario en Descargas y lo muestra en el Finder.
 *
 * El botón se apaga mientras escribe y dice qué pasó al volver: escribir es
 * instantáneo, pero si falla —disco lleno, permisos— hay que enterarse, y un
 * botón que no contesta se aprieta tres veces.
 */
async function descargarLog() {
    const boton = $('doctor-log');
    boton.disabled = true;
    boton.textContent = 'Escribiendo…';
    const res = await window.cc.registroDescargar();
    boton.disabled = false;
    boton.textContent = 'Descargar Log';
    toast(res.ok
        ? `Registro en Descargas · ${res.lineas} líneas`
        : `No se pudo escribir el registro: ${res.error}`);
}

/** El renglón dice por dónde va el criterio, que ahora se elige en Ajustes. */
function nombreDelCriterio(ai) {
    switch (ai.proveedor) {
        case 'cursor': return 'Criterio (Cursor CLI)';
        case 'anthropic': return 'Criterio (API de Claude)';
        case 'local':
        default: return 'Criterio (modelo local)';
    }
}

/**
 * "Listo pero apagado" no es lo mismo que "no está": lo primero no pide nada del
 * editor y lo segundo sí. Cuando esto era un solo booleano, una máquina sana
 * mostraba "no disponible" al lado de un texto que decía "Listo".
 */
function insigniaModelo(ai) {
    switch (ai.estado) {
        case 'corriendo':
            return `<span class="badge badge-ok">corriendo</span> <span class="mono">${esc(ai.model)}</span> <span class="cell-dim">(${esc(ai.source)})</span>`;
        case 'listo':
            return `<span class="badge badge-ok">lista</span> <span class="mono">${esc(ai.model)}</span> <span class="cell-dim">(${esc(ai.source)})</span>`;
        case 'falta':
            return `<span class="badge badge-warn">no disponible</span> <span class="cell-dim">${esc(ai.reason)}</span>`;
        default: {
            const desconocido = ai.estado;
            return `<span class="badge badge-err">estado desconocido: ${esc(desconocido)}</span>`;
        }
    }
}
