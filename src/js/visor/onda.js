'use strict';
/** Las dos ondas del visor: la clase entera arriba y el tramo ampliado abajo. */

import { $ } from '../chrome.js';
import { fmtClock } from '../formato.js';
import { rev, actual, cambio } from './estado.js';
import { setEdge } from './bordes.js';

const ZOOM_MARGIN_SEC = 4;

function canvasSize(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = Number(canvas.getAttribute('height')) || 100;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
}

function drawPeaks(ctx, peaks, from, to, width, height, color) {
    const total = peaks.length;
    const fromIdx = Math.max(0, Math.floor(from * total));
    const toIdx = Math.min(total, Math.ceil(to * total));
    const span = Math.max(1, toIdx - fromIdx);
    const mid = height / 2;

    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
        const start = fromIdx + Math.floor((x / width) * span);
        const end = fromIdx + Math.floor(((x + 1) / width) * span);
        let peak = 0;
        for (let i = start; i < Math.max(end, start + 1) && i < total; i++) {
            if (peaks[i] > peak) peak = peaks[i];
        }
        const h = Math.max(1, peak * (height - 6));
        ctx.fillRect(x, mid - h / 2, 1, h);
    }
}

export function renderOverview() {
    const canvas = $('rev-overview');
    const wave = rev.data.waveform;
    const { ctx, width, height } = canvasSize(canvas);
    const duration = rev.data.durationSec || 1;

    ctx.clearRect(0, 0, width, height);

    // Primero las zonas que se quedan, para que la silueta se dibuje encima.
    for (const segment of rev.segments) {
        if (!segment.keep) continue;
        const x = (segment.sourceStartSec / duration) * width;
        const w = Math.max(1, ((segment.sourceEndSec - segment.sourceStartSec) / duration) * width);
        ctx.fillStyle = segment.confidence === 'alta' ? 'rgba(62,207,142,.20)' : 'rgba(245,181,68,.20)';
        ctx.fillRect(x, 0, w, height);
    }
    if (wave) drawPeaks(ctx, wave.peaks, 0, 1, width, height, 'rgba(162,169,184,.75)');

    const current = actual();
    if (current) {
        const x = (current.sourceStartSec / duration) * width;
        const w = Math.max(2, ((current.sourceEndSec - current.sourceStartSec) / duration) * width);
        ctx.strokeStyle = '#4f9cf9';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, 1, w, height - 2);
    }

    canvas.onclick = event => {
        const rect = canvas.getBoundingClientRect();
        const seconds = ((event.clientX - rect.left) / rect.width) * duration;
        let best = 0;
        let bestDistance = Infinity;
        rev.segments.forEach((segment, index) => {
            const distance = Math.abs((segment.sourceStartSec + segment.sourceEndSec) / 2 - seconds);
            if (distance < bestDistance) { bestDistance = distance; best = index; }
        });
        rev.selected = best;
        cambio();
    };
}

function zoomWindow() {
    const segment = actual();
    if (!segment) return null;
    const from = Math.max(0, segment.sourceStartSec - ZOOM_MARGIN_SEC);
    const to = Math.min(rev.data.durationSec || segment.sourceEndSec + ZOOM_MARGIN_SEC,
        segment.sourceEndSec + ZOOM_MARGIN_SEC);
    return { from, to, span: Math.max(0.5, to - from) };
}

export function renderZoom() {
    const canvas = $('rev-zoom');
    const segment = actual();
    const ventana = zoomWindow();
    const { ctx, width, height } = canvasSize(canvas);
    ctx.clearRect(0, 0, width, height);
    if (!segment || !ventana) return;

    const xOf = seconds => ((seconds - ventana.from) / ventana.span) * width;

    ctx.fillStyle = 'rgba(79,156,249,.13)';
    ctx.fillRect(xOf(segment.sourceStartSec), 0, xOf(segment.sourceEndSec) - xOf(segment.sourceStartSec), height);

    // El detalle del tramo se pide aparte: con los cubos del resumen, veinte
    // segundos son doce puntos y el borde del sonido no se ve.
    const detail = rev.zoomWave;
    if (detail && Math.abs(detail.fromSec - ventana.from) < 0.01 && Math.abs(detail.toSec - ventana.to) < 0.01) {
        drawPeaks(ctx, detail.peaks, 0, 1, width, height, 'rgba(200,207,222,.85)');
    } else {
        loadZoomWave(ventana);
    }

    for (const [seconds, color] of [[segment.sourceStartSec, '#3ecf8e'], [segment.sourceEndSec, '#f2646b']]) {
        const x = xOf(seconds);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    $('rev-zoom-label').textContent =
        `${fmtClock(ventana.from)} – ${fmtClock(ventana.to)} · clic para mover la entrada, con Alt la salida`;

    canvas.onclick = event => {
        const rect = canvas.getBoundingClientRect();
        const seconds = ventana.from + ((event.clientX - rect.left) / rect.width) * ventana.span;
        setEdge(event.altKey ? 'out' : 'in', seconds);
    };
}

let zoomWaveToken = 0;
async function loadZoomWave(ventana) {
    if (!rev.data.liveMixPath) return;
    const token = ++zoomWaveToken;
    const detail = await window.cc.waveformWindow({
        path: rev.data.liveMixPath,
        fromSec: ventana.from,
        toSec: ventana.to,
        buckets: 1400
    });
    // Mientras se leía el disco el editor pudo saltar a otro bloque.
    if (!detail || token !== zoomWaveToken) return;
    rev.zoomWave = detail;
    renderZoom();
}
