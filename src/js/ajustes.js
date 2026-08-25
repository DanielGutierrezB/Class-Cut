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
    const conectado = Boolean(borrador.secretos && borrador.secretos.anthropic);

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
            ${conectado ? `
            <div class="aj-sesion is-conectada">
                <span>Conectado: la clave está guardada en el Llavero de esta Mac.</span>
                <button class="btn btn-ghost btn-inline" id="aj-claude-salir">Salir</button>
            </div>` : `
            <div class="aj-sesion">
                <button class="btn btn-primary" id="aj-claude-login">Iniciar sesión con Claude</button>
                <span class="cell-dim">Se abre el navegador, autorizás, y la clave queda creada y guardada sola.</span>
            </div>
            <div class="aj-codigo" id="aj-claude-paso2" hidden>
                <label class="aj-campo">
                    <span>Código</span>
                    <input id="aj-claude-codigo" placeholder="pegá acá el código que te mostró el navegador"
                           spellcheck="false" autocomplete="off">
                </label>
                <button class="btn btn-primary btn-inline" id="aj-claude-conectar">Conectar</button>
            </div>
            <details class="aj-alternativa">
                <summary>O pegá una clave a mano</summary>
                <label class="aj-campo">
                    <span>Clave</span>
                    <input id="aj-anthropic-clave" type="password" value=""
                           placeholder="sk-ant-…" spellcheck="false" autocomplete="off">
                </label>
            </details>`}
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
    borrador.ia.anthropic.modelo = $('aj-anthropic-modelo').value.trim();
    // El campo de clave manual solo existe si NO hay sesión iniciada. Lo que se
    // pegue viaja una vez al guardar y termina en el Llavero, nunca en el JSON.
    const claveManual = $('aj-anthropic-clave');
    borrador.ia.anthropic.apiKey = claveManual ? claveManual.value.trim() : '';
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

async function empezarSesionClaude() {
    const res = await window.cc.claudeLoginEmpezar();
    if (!res.ok) { toast(res.error || 'No se pudo abrir el navegador.'); return; }
    // El navegador quedó abierto: acá aparece dónde pegar lo que devuelva.
    $('aj-claude-paso2').hidden = false;
    $('aj-claude-codigo').focus();
    pintarResultado('Autorizá en el navegador y pegá el código acá.', null);
}

async function conectarClaude() {
    const boton = $('aj-claude-conectar');
    boton.disabled = true;
    pintarResultado('Canjeando el código y creando tu clave…', null);
    try {
        const res = await window.cc.claudeLoginCodigo($('aj-claude-codigo').value);
        if (!res.ok) { pintarResultado(res.error, false); return; }
        borrador.secretos = res.ajustes.secretos;
        toast('Sesión iniciada. La clave quedó en el Llavero.');
        repintar();
    } finally {
        boton.disabled = false;
    }
}

async function salirDeClaude() {
    const res = await window.cc.claudeSalir();
    if (res.ok) {
        borrador.secretos = res.ajustes.secretos;
        toast('La clave se borró del Llavero.');
        repintar();
    }
}

/** Vuelve a armar el formulario con el borrador que ya está en memoria. */
function repintar() {
    recogerFormulario();
    showAjustes({ borradorVivo: borrador });
}

function atarFormulario() {
    for (const radio of document.querySelectorAll('input[name="aj-proveedor"]')) {
        radio.onchange = alCambiarProveedor;
    }
    $('aj-probar').onclick = probar;
    $('aj-guardar').onclick = guardar;

    const login = $('aj-claude-login');
    if (login) login.onclick = empezarSesionClaude;
    const conectar = $('aj-claude-conectar');
    if (conectar) conectar.onclick = conectarClaude;
    const codigo = $('aj-claude-codigo');
    if (codigo) {
        codigo.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); conectarClaude(); } };
    }
    const salir = $('aj-claude-salir');
    if (salir) salir.onclick = salirDeClaude;
}

export async function showAjustes(opciones) {
    // Los tres pedidos en paralelo: los ajustes mandan, y las listas de modelos
    // solo pueblan los selectores. Si el CLI tarda o no está, la página abre
    // igual y lo dice en su sección.
    const [guardados, local, cli] = await Promise.all([
        opciones && opciones.borradorVivo ? opciones.borradorVivo : window.cc.ajustesLeer(),
        window.cc.modelos().catch(() => []),
        window.cc.cursorModelos().catch(() => ({ ok: false, modelos: [] }))
    ]);
    borrador = guardados;

    openModal('Ajustes', cuerpo(local, cli));
    atarFormulario();
}
