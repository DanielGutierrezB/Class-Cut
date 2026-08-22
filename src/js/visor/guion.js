'use strict';
/** La clase cortada leída de corrido, con lo que la revisión encontró. */

import { $ } from '../chrome.js';
import { esc, plural } from '../formato.js';
import { rev, cambio } from './estado.js';

const TIPO_LABEL = {
    idea_colgando: 'Idea colgando',
    repetido: 'Se dice dos veces',
    empalme: 'Empalme raro',
    conector: 'Conector sin antecedente',
    orden: 'Orden que no fluye',
    otro: 'Para mirar'
};

export function renderScript() {
    const coherence = rev.data.coherence;
    const host = $('rev-script');

    if (!coherence || !coherence.blocks || !coherence.blocks.length) {
        host.innerHTML = `<div class="script-head">
            <div class="script-title">Guion final</div>
            <p class="script-sub">Esta clase se procesó sin revisión del guion. Volvé a procesarla con la IA encendida para leerla de corrido.</p>
        </div>`;
        return;
    }

    const byBlock = new Map();
    for (const finding of coherence.findings || []) {
        if (!byBlock.has(finding.bloque)) byBlock.set(finding.bloque, []);
        byBlock.get(finding.bloque).push(finding);
    }

    const total = (coherence.findings || []).length;
    const minutes = Math.round(coherence.blocks.reduce((sum, b) => sum + b.durationSec, 0) / 60);

    const body = coherence.blocks.map(block => {
        const findings = byBlock.get(block.n) || [];
        const worstLevel = findings.some(f => f.gravedad === 'alta') ? 'alta'
            : findings.some(f => f.gravedad === 'media') ? 'media'
                : (findings.length ? 'baja' : '');

        const notes = findings.map(f => `
            <div class="finding ${esc(f.gravedad)}">
                <div class="finding-head">
                    <span class="finding-tipo">${esc(TIPO_LABEL[f.tipo] || f.tipo)}</span>
                    <span class="badge ${f.fuente === 'ia' ? 'badge-by-ia' : 'badge-by-regla'}">${f.fuente === 'ia' ? 'IA' : 'regla'}</span>
                </div>
                <div>${esc(f.detalle)}</div>
                ${f.sugerencia ? `<div class="finding-fix">${esc(f.sugerencia)}</div>` : ''}
            </div>`).join('');

        return `
        <div class="script-block ${worstLevel ? `has-${worstLevel}` : ''}" data-block="${block.index}">
            <div class="script-n">${block.n}</div>
            <div>
                ${block.note ? `<div class="script-note">${esc(block.note)}</div>` : ''}
                <div class="script-text">${esc(block.text) || '<span class="cell-dim">(sin habla)</span>'}</div>
                ${notes}
            </div>
        </div>`;
    }).join('');

    host.innerHTML = `
        <div class="script-head">
            <div class="script-title">La clase cortada, leída de corrido</div>
            <p class="script-sub">
                ${plural(coherence.blocks.length, 'bloque', 'bloques')} · ${minutes} min · ${coherence.wordCount} palabras ·
                ${total ? plural(total, 'cosa para mirar', 'cosas para mirar') : 'sin hallazgos'}
            </p>
        </div>
        <div class="script-body">${body}</div>`;
}

/**
 * Un clic en un bloque del guion salta a ese corte. El oyente va sobre el
 * contenedor y no sobre cada bloque: el guion se redibuja entero cada vez.
 *
 * @param {(tab:string) => void} irALaPestaña
 */
export function wireGuion(irALaPestaña) {
    $('rev-script').addEventListener('click', e => {
        const el = e.target.closest('.script-block');
        if (!el) return;
        const position = rev.segments.findIndex(s => s.blockIndex === Number(el.dataset.block));
        if (position === -1) return;
        rev.selected = position;
        irALaPestaña('cortes');
        cambio();
    });
}
