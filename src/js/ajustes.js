'use strict';
/**
 * ajustes.js — La página de Ajustes: qué criterio usa la app.
 *
 * Tres proveedores, uno activo. La regla de la página es que nada se guarda
 * hasta tocar Guardar, y que Probar funciona ANTES de guardar: el editor pega
 * su clave o elige un modelo, ve que contesta, y recién ahí se lo queda. Si
 * guardara primero, una clave mal pegada dejaría la app sin criterio hasta
 * volver a entrar acá.
 */

import { $, openModal, toast } from './chrome.js';
import { esc } from './formato.js';
import { refrescar as refrescarModelo } from './modelo.js';

/** Lo que el editor tiene en pantalla, hasta que guarde. */
let borrador = null;

const PROVEEDORES = [
    {
        id: 'local',
        titulo: 'Modelo local',
        detalle: 'El que viene con la app. Sin internet, sin cuentas, y reprocesar da el corte idéntico.'
    },
    {
        id: 'cursor',
        titulo: 'Cursor CLI',
        detalle: 'Tu cuenta de Cursor, con el modelo que elijas. Ventana de un millón de tokens: el criterio ve la clase entera.'
    },
    {
        id: 'anthropic',
        titulo: 'API de Claude',
        detalle: 'Directo a Anthropic con tu clave. La clave queda en esta Mac y solo viaja a api.anthropic.com.'
    }
];

function cuerpo(local, cli) {
    const ia = borrador.ia;

    const tarjetas = PROVEEDORES.map(p => `
        <label class="aj-tarjeta ${ia.proveedor === p.id ? 'is-activa' : ''}" data-proveedor="${p.id}">
            <input type="radio" name="aj-proveedor" value="${p.id}" ${ia.proveedor === p.id ? 'checked' : ''}>
            <span class="aj-tarjeta-texto">
                <strong>${esc(p.titulo)}</strong>
                <span class="cell-dim">${esc(p.detalle)}</span>
            </span>
        </label>`).join('');

    const opcionesLocales = [`<option value="">El mejor disponible (automático)</option>`]
        .concat((local || []).map(m =>
            `<option value="${esc(m.model)}" ${ia.local.modelo === m.model ? 'selected' : ''}>${esc(m.model)}${m.own ? ' · viene con la app' : ''}</option>`))
        .join('');

    const datalist = (cli && cli.modelos ? cli.modelos : [])
        .map(m => `<option value="${esc(m.id)}">${esc(m.nombre)}</option>`).join('');

    return `
    <div class="aj">
        <p class="aj-intro">Con qué criterio se deciden los cortes dudosos y se lee el guion.
        Cambiarlo no toca lo ya procesado: vale a partir de la próxima corrida.</p>

        <div class="aj-tarjetas">${tarjetas}</div>

        <div class="aj-config" data-config="local" ${ia.proveedor === 'local' ? '' : 'hidden'}>
            <label class="aj-campo">
                <span>Modelo</span>
                <select id="aj-local-modelo">${opcionesLocales}</select>
            </label>
        </div>

        <div class="aj-config" data-config="cursor" ${ia.proveedor === 'cursor' ? '' : 'hidden'}>
            <label class="aj-campo">
                <span>Modelo</span>
                <input id="aj-cursor-modelo" list="aj-cursor-lista" value="${esc(ia.cursor.modelo)}"
                       placeholder="claude-sonnet-5-thinking-high" spellcheck="false">
                <datalist id="aj-cursor-lista">${datalist}</datalist>
            </label>
            ${cli && !cli.ok ? `<p class="aj-aviso">${esc(cli.reason || 'No se pudo hablar con el CLI.')}</p>` : ''}
        </div>

        <div class="aj-config" data-config="anthropic" ${ia.proveedor === 'anthropic' ? '' : 'hidden'}>
            <label class="aj-campo">
                <span>Clave</span>
                <input id="aj-anthropic-clave" type="password" value="${esc(ia.anthropic.apiKey)}"
                       placeholder="sk-ant-…" spellcheck="false" autocomplete="off">
            </label>
            <label class="aj-campo">
                <span>Modelo</span>
                <input id="aj-anthropic-modelo" value="${esc(ia.anthropic.modelo)}"
                       placeholder="claude-sonnet-4-5" spellcheck="false">
            </label>
        </div>

        <div class="aj-acciones">
            <button class="btn btn-ghost" id="aj-probar">Probar</button>
            <span class="aj-resultado" id="aj-resultado"></span>
            <span class="aj-espacio"></span>
            <button class="btn btn-primary" id="aj-guardar">Guardar</button>
        </div>
    </div>`;
}

/** Lee el formulario y lo deja en el borrador. */
function recogerFormulario() {
    const elegido = document.querySelector('input[name="aj-proveedor"]:checked');
    if (elegido) borrador.ia.proveedor = elegido.value;
    borrador.ia.local.modelo = $('aj-local-modelo').value || null;
    borrador.ia.cursor.modelo = $('aj-cursor-modelo').value.trim();
    borrador.ia.anthropic.apiKey = $('aj-anthropic-clave').value.trim();
    borrador.ia.anthropic.modelo = $('aj-anthropic-modelo').value.trim();
}

function configActiva() {
    const ia = borrador.ia;
    switch (ia.proveedor) {
        case 'local': return { proveedor: 'local', modelo: ia.local.modelo };
        case 'cursor': return { proveedor: 'cursor', modelo: ia.cursor.modelo };
        case 'anthropic': return { proveedor: 'anthropic', modelo: ia.anthropic.modelo, apiKey: ia.anthropic.apiKey };
        default: {
            const nunca = ia.proveedor;
            throw new Error(`Proveedor sin manejar: ${nunca}`);
        }
    }
}

function pintarResultado(texto, ok) {
    const caja = $('aj-resultado');
    caja.textContent = texto;
    caja.classList.toggle('is-ok', Boolean(ok));
    caja.classList.toggle('is-mal', ok === false);
}

async function probar() {
    recogerFormulario();
    const boton = $('aj-probar');
    boton.disabled = true;
    pintarResultado('Probando…', null);
    try {
        const res = await window.cc.iaProbar(configActiva());
        pintarResultado(res.reason || (res.ok ? 'Contesta.' : 'No contestó.'), res.ok);
    } finally {
        boton.disabled = false;
    }
}

async function guardar() {
    recogerFormulario();
    const res = await window.cc.ajustesGuardar(borrador);
    if (!res.ok) { toast(res.error); return; }
    borrador = res.ajustes;
    toast('Ajustes guardados. Valen desde la próxima corrida.');
    // El cabezal dice con qué se corta: tiene que enterarse ya, no al reabrir.
    refrescarModelo();
    $('modal').hidden = true;
}

function alCambiarProveedor() {
    recogerFormulario();
    for (const caja of document.querySelectorAll('.aj-config')) {
        caja.hidden = caja.dataset.config !== borrador.ia.proveedor;
    }
    for (const tarjeta of document.querySelectorAll('.aj-tarjeta')) {
        tarjeta.classList.toggle('is-activa', tarjeta.dataset.proveedor === borrador.ia.proveedor);
    }
    pintarResultado('', null);
}

export async function showAjustes() {
    // Los tres pedidos en paralelo: los ajustes mandan, y las listas de modelos
    // solo pueblan los selectores. Si el CLI tarda o no está, la página abre
    // igual y lo dice en su sección.
    const [guardados, local, cli] = await Promise.all([
        window.cc.ajustesLeer(),
        window.cc.modelos().catch(() => []),
        window.cc.cursorModelos().catch(() => ({ ok: false, modelos: [] }))
    ]);
    borrador = guardados;

    openModal('Ajustes', cuerpo(local, cli));

    for (const radio of document.querySelectorAll('input[name="aj-proveedor"]')) {
        radio.onchange = alCambiarProveedor;
    }
    $('aj-probar').onclick = probar;
    $('aj-guardar').onclick = guardar;
}
