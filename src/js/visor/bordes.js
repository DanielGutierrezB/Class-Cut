'use strict';
/** Los bordes del bloque: moverlos, ver por qué quedaron ahí y escucharlos. */

import { $, toast } from '../chrome.js';
import { esc, fmtClock } from '../formato.js';
import { rev, actual, cambio } from './estado.js';

const DECIDED_LABEL = {
    nota: 'la nota del CD',
    regla: 'una regla',
    ia: 'la IA local'
};

/** Mueve un borde a un momento, sin dejar que se cruce con el otro. */
export function setEdge(edge, seconds) {
    const segment = actual();
    if (!segment) return;
    const frame = 1 / (rev.data.fps || 30);
    const value = Math.max(0, Math.min(rev.data.durationSec || seconds, seconds));

    if (edge === 'in') {
        segment.sourceStartSec = Math.min(value, segment.sourceEndSec - frame);
    } else {
        segment.sourceEndSec = Math.max(value, segment.sourceStartSec + frame);
    }
    segment.sourceStartSec = Math.round(segment.sourceStartSec * 1000) / 1000;
    segment.sourceEndSec = Math.round(segment.sourceEndSec * 1000) / 1000;
    rev.dirty = true;
    cambio();
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

export function renderTranscript() {
    const segment = actual();
    if (!segment) return;
    const margin = 10;
    const segments = (rev.data.segments || []).filter(s =>
        s.end >= segment.sourceStartSec - margin && s.start <= segment.sourceEndSec + margin);

    $('rev-transcript').innerHTML = segments.length
        ? segments.map(s => {
            const inside = s.start >= segment.sourceStartSec - 0.2 && s.end <= segment.sourceEndSec + 0.2;
            return `<div class="seg ${inside ? 'inside' : ''}">
                <span class="seg-time">${fmtClock(s.start)}</span>${esc(s.text)}
            </div>`;
        }).join('')
        : '<div class="cell-dim">No hay transcript para este tramo.</div>';
}

/** Escucha segundo y medio antes del borde: alcanza para saber si corta bien. */
export async function playEdge(edge) {
    const segment = actual();
    if (!segment || !rev.data.liveMixPath) return;

    const at = edge === 'in' ? segment.sourceStartSec : segment.sourceEndSec;
    const result = await window.cc.audition({
        path: rev.data.liveMixPath,
        startSec: Math.max(0, at - 1.5),
        durationSec: 3.5
    });
    if (!result.ok) { toast(result.error); return; }

    if (rev.audio) rev.audio.pause();
    rev.audio = new Audio(result.dataUrl);
    rev.audio.play().catch(err => toast(`No se pudo reproducir: ${err.message}`));
}
