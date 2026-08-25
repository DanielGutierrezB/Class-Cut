'use strict';
/**
 * division.js — El reparto entre la imagen y el texto.
 *
 * Cuánto espacio quiere cada uno depende de qué se esté haciendo: para validar
 * cortes mirando la imagen sobra el panel de texto, y para revisar la letra y
 * dejar comentarios sobra el video. En vez de elegir por el editor, se arrastra.
 *
 * El ancho se guarda entre sesiones porque es una preferencia, no una decisión
 * que se toma cada vez que se abre una clase.
 */

import { $ } from '../chrome.js';

const RECORDADO = 'cc.ancho-del-texto';
const POR_DEFECTO = 380;
// Ninguno de los dos puede quedar en nada: el video se vuelve ilegible y el
// texto, con menos de esto, parte cada línea en dos palabras.
const MINIMO_TEXTO = 260;
const MINIMO_IMAGEN = 320;
const PASO_CON_TECLADO = 24;

let arrastrando = null;

/** El ancho que cabe de verdad, dado lo que mide la ventana ahora. */
function acotar(px) {
    const caja = $('rev-player').querySelector('.player-top');
    const disponible = caja ? caja.clientWidth - $('player-split').offsetWidth : 0;
    const techo = Math.max(MINIMO_TEXTO, disponible - MINIMO_IMAGEN);
    // Si la ventana es tan angosta que ni los mínimos entran, el texto cede: la
    // imagen sin ancho no se puede ni mirar.
    return Math.min(techo, Math.max(MINIMO_TEXTO, Math.round(px)));
}

function aplicar(px, recordar) {
    const ancho = acotar(px);
    $('rev-letra').style.width = `${ancho}px`;
    $('player-split').setAttribute('aria-valuenow', String(ancho));
    if (recordar) {
        try { localStorage.setItem(RECORDADO, String(ancho)); } catch { /* modo privado */ }
    }
    return ancho;
}

/** El ancho guardado, o el de fábrica si no hay o quedó ilegible. */
function recordado() {
    let px = POR_DEFECTO;
    try {
        const guardado = Number(localStorage.getItem(RECORDADO));
        if (Number.isFinite(guardado) && guardado > 0) px = guardado;
    } catch { /* modo privado */ }
    return px;
}

function mover(evento) {
    if (!arrastrando) return;
    // Se mide desde el borde derecho: el panel crece cuando el puntero va a la
    // izquierda, que es lo que la mano espera al empujar el divisor.
    aplicar(arrastrando.derecha - evento.clientX, false);
}

function soltar() {
    if (!arrastrando) return;
    arrastrando = null;
    document.body.classList.remove('esta-repartiendo');
    $('player-split').classList.remove('is-arrastrando');
    document.removeEventListener('pointermove', mover);
    document.removeEventListener('pointerup', soltar);
    aplicar($('rev-letra').getBoundingClientRect().width, true);
}

function agarrar(evento) {
    const caja = $('rev-letra').getBoundingClientRect();
    arrastrando = { derecha: caja.right };
    document.body.classList.add('esta-repartiendo');
    $('player-split').classList.add('is-arrastrando');
    document.addEventListener('pointermove', mover);
    document.addEventListener('pointerup', soltar);
    evento.preventDefault();
}

function conTeclado(evento) {
    const paso = { ArrowLeft: PASO_CON_TECLADO, ArrowRight: -PASO_CON_TECLADO }[evento.key];
    if (paso == null) return;
    evento.preventDefault();
    // Se para el evento acá: con el foco en el divisor, las flechas reparten el
    // espacio en vez de mover la aguja del reproductor.
    evento.stopPropagation();
    aplicar($('rev-letra').getBoundingClientRect().width + paso, true);
}

export function wireDivision() {
    const tirador = $('player-split');
    tirador.addEventListener('pointerdown', agarrar);
    tirador.addEventListener('keydown', conTeclado);
    // Doble clic para volver al reparto de fábrica, que es lo que uno busca
    // después de haberlo llevado a un extremo.
    tirador.addEventListener('dblclick', () => aplicar(POR_DEFECTO, true));

    tirador.setAttribute('aria-valuemin', String(MINIMO_TEXTO));

    // Al achicar la ventana, un panel ancho dejaría la imagen sin lugar. Se
    // reacomoda sin pisar lo guardado: al volver a agrandarla se recupera.
    window.addEventListener('resize', () => {
        if (!$('rev-player').hidden) aplicar(recordado(), false);
    });

    aplicar(recordado(), false);
}

/** Se llama al mostrar el reproductor: recién ahí el contenedor tiene ancho. */
export function ajustarDivision() {
    aplicar(recordado(), false);
}
