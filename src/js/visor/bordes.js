'use strict';
/**
 * Los bordes del bloque: moverlos y ver por qué quedaron ahí.
 *
 * Escucharlos es de `escucha.js`: el «▶ Escuchar» de cada borde ya no extrae un
 * pedacito con ffmpeg, lleva el transporte del tramo hasta ese borde.
 */

import { $ } from '../chrome.js';
import { esc, fmtClock } from '../formato.js';
import { rev, actual, editar } from './estado.js';

const DECIDED_LABEL = {
    nota: 'la nota del CD',
    // "nota" es dónde quedó el marcador; "orden" es el CD escribiendo qué hacer
    // con él ("OUT ANTES DE: …"), que manda sobre todo lo demás.
    orden: 'la orden del CD',
    regla: 'una regla',
    ia: 'la IA local',
    // El bloque seguía hasta donde el profesor rehizo la frase; el corte se
    // adelantó hasta donde arranca la retoma.
    repetido: 'lo que se decía dos veces',
    // La lectura de la clase entera vio que el bloque abría o cerraba a mitad de
    // idea, y el borde se movió hasta donde la frase empieza o termina.
    repaso: 'el repaso del guion'
};

/** Mueve un borde a un momento, sin dejar que se cruce con el otro. */
export function setEdge(edge, seconds) {
    const segment = actual();
    if (!segment) return;
    const frame = 1 / (rev.data.fps || 30);
    const value = Math.max(0, Math.min(rev.data.durationSec || seconds, seconds));

    editar(`mover ${edge === 'in' ? 'la entrada' : 'la salida'} del bloque ${segment.blockIndex + 1}`, () => {
        aplicarBorde(segment, edge, value, frame);
    });
}

function aplicarBorde(segment, edge, value, frame) {
    if (edge === 'in') {
        segment.sourceStartSec = Math.min(value, segment.sourceEndSec - frame);
    } else {
        segment.sourceEndSec = Math.max(value, segment.sourceStartSec + frame);
    }
    segment.sourceStartSec = Math.round(segment.sourceStartSec * 1000) / 1000;
    segment.sourceEndSec = Math.round(segment.sourceEndSec * 1000) / 1000;
}

export function renderEdges() {
    const segment = actual();
    if (!segment) return;
    $('in-time').textContent = fmtClock(segment.sourceStartSec);
    $('out-time').textContent = fmtClock(segment.sourceEndSec);
    $('rev-keep').checked = segment.keep !== false;

    const cameras = rev.data.cameras || [];
    const viewMap = rev.data.cutplan.viewMap || { PV: 0, R: 1 };
    $('rev-views').innerHTML = Object.keys(viewMap).map(view => {
        const camera = cameras[viewMap[view]];
        return `<button class="view-btn ${segment.view === view ? 'is-on' : ''}" data-view="${esc(view)}">
            ${esc(view)}${camera ? ` · ${esc(camera.name.replace(/\.[^.]+$/, ''))}` : ''}
        </button>`;
    }).join('');
}

export function renderDecided() {
    const segment = actual();
    const edges = (rev.data.edges || []).find(e => segment && e.index === segment.blockIndex);
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

/**
 * Las palabras que hay dibujadas ahora, para poder alumbrarlas mientras suena.
 *
 * Es una lista plana con el índice que lleva cada `<span>`: quien sigue al audio
 * no tiene que volver a mirar el DOM para saber qué palabra toca.
 */
const dichas = [];

/** Cuál está alumbrada, para no repintar sesenta veces por segundo. */
let alumbrada = -1;

/**
 * Hasta cuándo se le sigue dando la palabra a la última que arrancó.
 *
 * Sin esto, en la pausa entre dos frases queda alumbrada la última palabra dicha
 * —a veces medio minuto, si el bloque termina en silencio—, que es justo lo que
 * hace dudar de si el texto va sincronizado. El final de la FRASE es el corte
 * bueno para esto: el `end` de cada palabra no sirve porque en el reloj del DTW
 * es el arranque de la que sigue, así que una palabra antes de una pausa larga
 * "dura" toda la pausa.
 */
const COLA_SEC = 0.35;

/** Las palabras de una frase, que son las que caen adentro de sus tiempos. */
function palabrasDe(frase) {
    return (rev.data.words || []).filter(p => p.start >= frase.start && p.start < frase.end);
}

export function renderTranscript() {
    const segment = actual();
    if (!segment) return;
    const margin = 10;
    const segments = (rev.data.segments || []).filter(s =>
        s.end >= segment.sourceStartSec - margin && s.start <= segment.sourceEndSec + margin);

    dichas.length = 0;
    alumbrada = -1;

    $('rev-transcript').innerHTML = segments.length
        ? segments.map(s => {
            const inside = s.start >= segment.sourceStartSec - 0.2 && s.end <= segment.sourceEndSec + 0.2;
            // Palabra por palabra para poder alumbrarlas, y si no hay tiempos por
            // palabra —un transcript viejo— cae en la frase entera, que es lo que
            // este panel mostraba siempre.
            const palabras = palabrasDe(s);
            const cuerpo = palabras.length
                ? palabras.map(p => {
                    const i = dichas.push({ desdeSec: p.start, hastaSec: s.end }) - 1;
                    return `<span class="seg-palabra" data-dicha="${i}">${esc(p.text)}</span>`;
                }).join(' ')
                : esc(s.text);
            return `<div class="seg ${inside ? 'inside' : ''}">
                <span class="seg-time">${fmtClock(s.start)}</span>${cuerpo}
            </div>`;
        }).join('')
        : '<div class="cell-dim">No hay transcript para este tramo.</div>';
}

/** Cuál de las palabras dibujadas suena en un momento, o −1 si ninguna. */
export function dichaEn(palabras, segundo) {
    let elegida = -1;
    for (let i = 0; i < palabras.length; i++) {
        if (palabras[i].desdeSec > segundo) break;
        elegida = i;
    }
    // Antes de la primera no hay ninguna sonando, y después de que su frase
    // terminó tampoco: alumbrar ahí sería señalar algo que ya no se está
    // diciendo.
    if (elegida < 0) return -1;
    return segundo <= palabras[elegida].hastaSec + COLA_SEC ? elegida : -1;
}

/**
 * Alumbra la palabra que suena, como en el panel del reproductor.
 *
 * La llama el transporte una vez por cuadro, así que solo toca el DOM cuando la
 * palabra cambió: repintar sesenta veces por segundo se ve como un tirón cuando
 * el profesor habla rápido.
 */
export function seguirTranscript(segundo) {
    const cual = segundo == null ? -1 : dichaEn(dichas, segundo);
    if (cual === alumbrada) return;
    alumbrada = cual;

    const caja = $('rev-transcript');
    const antes = caja.querySelector('.seg-palabra.is-on');
    if (antes) antes.classList.remove('is-on');
    if (cual < 0) return;

    const span = caja.querySelector(`.seg-palabra[data-dicha="${cual}"]`);
    if (span) span.classList.add('is-on');
}