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

// En pasado, porque lo que se está contando ya pasó: "Se dice dos veces, ya
// arreglado" hace dudar de si sigue pasando o no.
const TIPO_ARREGLADO = {
    idea_colgando: 'Idea colgando',
    repetido: 'Se decía dos veces',
    empalme: 'Empalme raro',
    conector: 'Conector sin antecedente',
    orden: 'Orden que no fluye',
    otro: 'Para mirar'
};

/** Lo que se quitó por decir dos veces lo mismo, indexado por bloque. */
function arreglosPorBloque() {
    const mapa = new Map();
    const datos = rev.data.repeticiones;
    for (const h of (datos && datos.hallazgos) || []) {
        if (!h.aplicado) continue;
        mapa.set(h.bloque, h);
    }
    return mapa;
}

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

    const arreglos = arreglosPorBloque();
    // Lo ya corregido no se cuenta como pendiente: el sentido de arreglarlo era
    // justamente que dejara de ser una tarea del editor.
    const total = (coherence.findings || []).filter(f => !f.corregido).length;
    const minutes = Math.round(coherence.blocks.reduce((sum, b) => sum + b.durationSec, 0) / 60);

    const body = coherence.blocks.map(block => {
        const findings = byBlock.get(block.n) || [];
        const pendientes = findings.filter(f => !f.corregido);
        const worstLevel = pendientes.some(f => f.gravedad === 'alta') ? 'alta'
            : pendientes.some(f => f.gravedad === 'media') ? 'media'
                : (pendientes.length ? 'baja' : '');

        const notes = findings.map(f => f.corregido
            ? `
            <div class="finding arreglado">
                <div class="finding-head">
                    <span class="finding-tipo">${esc(TIPO_ARREGLADO[f.tipo] || f.tipo)}, ya arreglado</span>
                </div>
                <div>${esc(f.corregido)}</div>
            </div>`
            : `
            <div class="finding ${esc(f.gravedad)}">
                <div class="finding-head">
                    <span class="finding-tipo">${esc(TIPO_LABEL[f.tipo] || f.tipo)}</span>
                    <span class="badge ${f.fuente === 'ia' ? 'badge-by-ia' : 'badge-by-regla'}">${f.fuente === 'ia' ? 'IA' : 'regla'}</span>
                </div>
                <div>${esc(f.detalle)}</div>
                ${f.sugerencia ? `<div class="finding-fix">${esc(f.sugerencia)}</div>` : ''}
            </div>`).join('');

        const arreglo = arreglos.get(block.index);
        const quitado = arreglo ? `
            <div class="finding arreglado">
                <div class="finding-head">
                    <span class="finding-tipo">Se decía dos veces, ya arreglado</span>
                </div>
                <div>Se quitaron ${arreglo.recorteSec}s del final: el bloque seguía hasta donde
                     el profesor rehizo la frase, y lo que sigue ya lo dice.</div>
                <div class="finding-fix">${esc(arreglo.texto.slice(0, 160))}…</div>
            </div>` : '';

        return `
        <div class="script-block ${worstLevel ? `has-${worstLevel}` : ''}" data-block="${block.index}">
            <div class="script-n">${block.n}</div>
            <div>
                ${block.note ? `<div class="script-note">${esc(block.note)}</div>` : ''}
                <div class="script-text">${esc(block.text) || '<span class="cell-dim">(sin habla)</span>'}</div>
                ${quitado}
                ${notes}
            </div>
        </div>`;
    }).join('');

    const stats = rev.data.repeticiones && rev.data.repeticiones.stats;
    const quitadas = stats ? stats.recortadas + stats.descartadas : 0;
    const arreglados = (coherence.findings || []).filter(f => f.corregido).length;

    // Lo arreglado va primero y lo pendiente después, en ese orden a propósito:
    // lo que el editor necesita saber al abrir esto es cuánto le queda por
    // hacer, y para eso tiene que ver antes cuánto ya no.
    const cuenta = [];
    if (arreglados) cuenta.push(`<b>${plural(arreglados, 'cosa arreglada sola', 'cosas arregladas solas')}</b>`);
    cuenta.push(total ? plural(total, 'cosa para mirar', 'cosas para mirar') : 'nada pendiente');

    host.innerHTML = `
        <div class="script-head">
            <div class="script-title">La clase cortada, leída de corrido</div>
            <p class="script-sub">
                ${plural(coherence.blocks.length, 'bloque', 'bloques')} · ${minutes} min · ${coherence.wordCount} palabras ·
                ${cuenta.join(' · ')}
                ${quitadas ? ` · ${plural(quitadas, 'repetición quitada', 'repeticiones quitadas')} (${stats.segundos}s)` : ''}
            </p>
            ${rev.data.repaso && rev.data.repaso.relectura ? `
            <p class="script-sub">Después de arreglar se volvió a leer la clase entera: lo que figura como
               pendiente es lo que sigue sin cerrar en el corte que quedó.</p>` : ''}
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
