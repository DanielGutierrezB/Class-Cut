'use strict';
/**
 * La clase cortada leída de corrido, con lo que la revisión encontró.
 *
 * Y se puede comentar encima, seleccionando: leer de corrido es cuando se ven
 * las cosas que bloque por bloque no se notan, así que es justo acá donde dan
 * ganas de anotar algo. Los comentarios son los MISMOS que los del panel de al
 * lado del video —mismo almacén, mismo ancla al tiempo de la grabación, mismo
 * marcador en el XML—, así que da igual desde dónde se escriban.
 *
 * Van al margen, como en un documento compartido, y no intercalados en el texto:
 * intercalados parten la lectura, que es lo único que esta pestaña hace bien.
 */

import { $, toast } from '../chrome.js';
import { esc, plural } from '../formato.js';
import { rev, cambio } from './estado.js';
import { notas, guardar, anclaDeSeleccion } from './comentarios.js';
import { comentariosEn } from './pista.js';

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

/**
 * El número con el que se conoce a un bloque en toda la app.
 *
 * El guion guardado numera los bloques entre los que QUEDARON, y la lista de
 * cortes los numera entre TODOS. Mientras no se apague ninguno da igual, pero en
 * el curso ya pasa en 4 de 13 clases: el mismo bloque es el 12 acá y el 13 allá,
 * y no hay manera de saberlo mirando. Manda el de la lista, que es el que no se
 * mueve: apagar un bloque no renumera a los demás.
 *
 * La numeración del guion no se toca por dentro —el motor y la IA la comparten
 * como clave y renumerarla obligaría a reprocesar—, así que se traduce al leer.
 */
function numeroDe(bloque) {
    return bloque.index + 1;
}

/** De la numeración del guion a la que se ve. Vacío si ya coinciden. */
function traduccion(bloques) {
    const mapa = new Map();
    for (const b of bloques || []) {
        if (b.n !== numeroDe(b)) mapa.set(b.n, numeroDe(b));
    }
    return mapa;
}

/**
 * Los números de bloque que la IA escribió adentro de su texto, traducidos.
 *
 * La mitad de los hallazgos del curso citan un bloque por su número —«repite el
 * cierre del bloque 13», «los bloques 8 y 9»—, así que cambiar el rótulo sin
 * tocar el texto haría que la explicación señale al bloque equivocado justo en
 * las clases donde las dos numeraciones no coinciden.
 */
export function traducirTexto(texto, mapa) {
    if (!mapa || !mapa.size) return String(texto || '');
    return String(texto || '').replace(
        /\bbloques?\s+\d+(?:\s*(?:y|,|-|a)\s*\d+)*/gi,
        tramo => tramo.replace(/\d+/g, n => String(mapa.get(Number(n)) || n)));
}

/**
 * Las palabras de un bloque, con sus tiempos de grabación.
 *
 * El guion guardado trae el texto ya armado, pero un texto no se puede anclar:
 * para que un comentario sobreviva a que se mueva un borde hace falta saber en
 * qué segundo de la grabación cae cada palabra. Son las mismas con las que se
 * armó ese texto (`speech.textInside` sobre el mismo tramo), así que lo que se
 * lee no cambia.
 */
function palabrasDe(bloque) {
    return (rev.data.words || [])
        .filter(p => p.start >= bloque.startSec && p.start < bloque.endSec);
}

/** Qué palabras de un bloque están abarcadas por un comentario, por su id. */
function comentadasDe(bloque, palabras) {
    const marcas = new Map();
    for (const c of comentariosEn(bloque.startSec, bloque.endSec, notas().comentarios)) {
        palabras.forEach((p, i) => {
            if (p.start >= c.sourceStartSec && p.start <= c.sourceEndSec) marcas.set(i, c.id);
        });
    }
    return marcas;
}

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

    const numeros = traduccion(coherence.blocks);
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
                <div>${esc(traducirTexto(f.corregido, numeros))}</div>
            </div>`
            : `
            <div class="finding ${esc(f.gravedad)}">
                <div class="finding-head">
                    <span class="finding-tipo">${esc(TIPO_LABEL[f.tipo] || f.tipo)}</span>
                    <span class="badge ${f.fuente === 'ia' ? 'badge-by-ia' : 'badge-by-regla'}">${f.fuente === 'ia' ? 'IA' : 'regla'}</span>
                </div>
                <div>${esc(traducirTexto(f.detalle, numeros))}</div>
                ${f.sugerencia ? `<div class="finding-fix">${esc(traducirTexto(f.sugerencia, numeros))}</div>` : ''}
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

        // Palabra por palabra para poder seleccionar y comentar. Un guion viejo,
        // servido sin tiempos por palabra, cae en el texto corrido: se lee igual,
        // solo que no se puede anclar nada encima.
        const palabras = palabrasDe(block);
        const comentadas = comentadasDe(block, palabras);
        const texto = palabras.length
            ? palabras.map((p, i) => {
                const id = comentadas.get(i);
                // Cuando la marca sigue en la palabra siguiente, el espacio va
                // ADENTRO: pintado palabra por palabra, el espacio queda sin
                // pintar y la frase marcada se lee como un código de barras. Se
                // resolvió así y no estirando las cajas con márgenes negativos
                // porque el fondo es translúcido y al superponerse se duplica el
                // color: quedaban costuras oscuras en cada junta.
                const sigue = id && comentadas.get(i + 1) === id;
                const hueco = i < palabras.length - 1 ? ' ' : '';
                return `<span class="script-palabra${id ? ' is-comentado' : ''}"` +
                    `${id ? ` data-com="${esc(id)}"` : ''} data-b="${block.index}" data-p="${i}"` +
                    `>${esc(p.text)}${sigue ? hueco : ''}</span>${sigue ? '' : hueco}`;
            }).join('')
            : (esc(block.text) || '<span class="cell-dim">(sin habla)</span>');

        // El rótulo es lo único que lleva al corte. Antes lo hacía el bloque
        // entero, y eso peleaba con seleccionar texto: soltar el mouse termina en
        // un clic y se cambiaba de pestaña con la selección hecha.
        return `
        <div class="script-block ${worstLevel ? `has-${worstLevel}` : ''}" data-block="${block.index}">
            <button class="script-n" data-ir="${block.index}"
                    title="Ir a este bloque en Cortes">Bloque ${numeroDe(block)}</button>
            <div>
                ${block.note ? `<div class="script-note">${esc(block.note)}</div>` : ''}
                <div class="script-text">${texto}</div>
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
        <div class="script-cols">
            <div class="script-body">${body}</div>
            <div class="script-margen" id="script-margen"></div>
        </div>`;

    pintarMargen();
}

/* ─── Los comentarios, al margen ────────────────────────────────────────── */

/** Cuánto se separan dos tarjetas que quieren el mismo alto. */
const AIRE_ENTRE_TARJETAS = 8;

function tarjetaDe(comentario) {
    const caja = document.createElement('div');
    caja.className = 'script-com';
    caja.dataset.com = comentario.id;

    const cita = document.createElement('div');
    cita.className = 'script-com-cita';
    cita.textContent = comentario.texto;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'script-com-texto';
    cuerpo.textContent = comentario.comentario;

    const acciones = document.createElement('div');
    acciones.className = 'script-com-acciones';
    const borrar = document.createElement('button');
    borrar.className = 'btn btn-ghost btn-inline';
    borrar.textContent = 'Borrar';
    borrar.dataset.borrar = comentario.id;
    acciones.append(borrar);

    caja.append(cita, cuerpo, acciones);
    return caja;
}

/**
 * Pone cada tarjeta a la altura de lo que comenta, y las que chocan más abajo.
 *
 * Sin el empujón, dos comentarios sobre frases vecinas se dibujan uno encima del
 * otro y el de arriba queda ilegible. Empujar hacia abajo y no repartir a los
 * dos lados mantiene el orden de lectura: la tarjeta nunca aparece antes que su
 * cita.
 */
export function acomodarMargen(alturas, pedidos) {
    const salida = [];
    let piso = 0;
    for (let i = 0; i < pedidos.length; i++) {
        const arriba = Math.max(pedidos[i], piso);
        salida.push(arriba);
        piso = arriba + alturas[i] + AIRE_ENTRE_TARJETAS;
    }
    return salida;
}

function pintarMargen() {
    const margen = $('script-margen');
    if (!margen) return;
    margen.textContent = '';

    // En el orden en que aparecen en la clase, que es el orden en que se leen.
    const conAncla = [];
    for (const comentario of notas().comentarios) {
        const cita = $('rev-script').querySelector(`.script-palabra[data-com="${comentario.id}"]`);
        if (cita) conAncla.push({ comentario, cita });
    }
    conAncla.sort((a, b) => a.cita.offsetTop - b.cita.offsetTop);

    const tarjetas = conAncla.map(({ comentario }) => {
        const tarjeta = tarjetaDe(comentario);
        margen.append(tarjeta);
        return tarjeta;
    });

    // Medir después de estar todas en el DOM: una tarjeta sin dibujar mide cero
    // y todas se apilarían en el mismo alto.
    const base = margen.getBoundingClientRect().top;
    const pedidos = conAncla.map(({ cita }) => cita.getBoundingClientRect().top - base);
    const alturas = tarjetas.map(t => t.offsetHeight);
    acomodarMargen(alturas, pedidos).forEach((arriba, i) => {
        tarjetas[i].style.top = `${Math.max(0, arriba)}px`;
    });
}

/** Enciende una cita y su tarjeta a la vez, que es lo que las relaciona. */
function resaltar(id) {
    const raiz = $('rev-script');
    for (const el of raiz.querySelectorAll('.is-activo')) el.classList.remove('is-activo');
    if (!id) return;
    for (const el of raiz.querySelectorAll(`[data-com="${id}"]`)) el.classList.add('is-activo');
}

/* ─── Comentar ──────────────────────────────────────────────────────────── */

let seleccionViva = null;

/** Qué palabras del guion abarca lo que quedó seleccionado. */
export function palabrasSeleccionadas(spans, bloqueDe) {
    if (!spans.length) return null;
    // Una selección que cruza bloques no tiene un ancla claro: se queda con la
    // del primero, que es lo que el editor estaba mirando.
    const bloque = spans[0].dataset.b;
    const delMismo = spans.filter(s => s.dataset.b === bloque);
    const palabras = bloqueDe(Number(bloque));
    if (!palabras) return null;
    return delMismo
        .map(s => palabras[Number(s.dataset.p)])
        .filter(Boolean);
}

function bloqueDe(indice) {
    const coherence = rev.data.coherence;
    const bloque = ((coherence && coherence.blocks) || []).find(b => b.index === indice);
    return bloque ? palabrasDe(bloque) : null;
}

function abrirCaja(ancla) {
    cerrarCaja();
    seleccionViva = ancla;

    const caja = document.createElement('div');
    caja.className = 'script-com is-nuevo';
    caja.id = 'script-com-nuevo';

    const cita = document.createElement('div');
    cita.className = 'script-com-cita';
    cita.textContent = ancla.texto;

    const campo = document.createElement('textarea');
    campo.className = 'script-com-campo';
    campo.rows = 3;
    campo.placeholder = 'Tu comentario para el editor…';

    const acciones = document.createElement('div');
    acciones.className = 'script-com-acciones';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary btn-inline';
    ok.textContent = 'Comentar';
    ok.onclick = () => confirmar(campo.value);
    const no = document.createElement('button');
    no.className = 'btn btn-ghost btn-inline';
    no.textContent = 'Cancelar';
    no.onclick = cerrarCaja;
    acciones.append(ok, no);

    caja.append(cita, campo, acciones);
    $('script-margen').append(caja);
    campo.focus();
}

function cerrarCaja() {
    const caja = document.getElementById('script-com-nuevo');
    if (caja) caja.remove();
    seleccionViva = null;
}

async function confirmar(texto) {
    const limpio = String(texto || '').trim();
    if (!limpio) { toast('El comentario está vacío.'); return; }
    if (!seleccionViva) return;

    // Sin id: lo acuña `engine/notas.js` al guardar, que es el único que los
    // reparte. La respuesta vuelve con todo asignado y de ahí se repinta.
    notas().comentarios.push({ ...seleccionViva, comentario: limpio });
    cerrarCaja();
    window.getSelection().removeAllRanges();
    if (await guardar()) {
        renderScript();
        toast('Comentario guardado. Va a salir como marcador en el XML.');
    }
}

async function borrar(id) {
    notas().comentarios = notas().comentarios.filter(c => c.id !== id);
    if (await guardar()) renderScript();
}

/**
 * Un clic en un bloque del guion salta a ese corte. El oyente va sobre el
 * contenedor y no sobre cada bloque: el guion se redibuja entero cada vez.
 *
 * @param {(tab:string) => void} irALaPestaña
 */
export function wireGuion(irALaPestaña) {
    const raiz = $('rev-script');

    raiz.addEventListener('click', e => {
        const borrarBtn = e.target.closest('[data-borrar]');
        if (borrarBtn) { borrar(borrarBtn.dataset.borrar); return; }

        // Pararse en un comentario, desde cualquiera de sus dos puntas.
        const marcado = e.target.closest('[data-com]');
        if (marcado) { resaltar(marcado.dataset.com); return; }

        // Solo el rótulo lleva al corte: el resto del bloque es texto para leer y
        // seleccionar, y saltar de pestaña en medio de una selección se la lleva
        // puesta justo cuando se iba a comentar.
        const ir = e.target.closest('[data-ir]');
        if (!ir) return;
        const position = rev.segments.findIndex(s => s.blockIndex === Number(ir.dataset.ir));
        if (position === -1) return;
        rev.selected = position;
        irALaPestaña('cortes');
        cambio();
    });

    // Pasar por encima de una cita enciende su tarjeta, y al revés: es lo que
    // dice cuál comenta a cuál sin tener que hacer clic.
    raiz.addEventListener('mouseover', e => {
        const marcado = e.target.closest('[data-com]');
        if (marcado) resaltar(marcado.dataset.com);
    });

    raiz.addEventListener('mouseup', () => {
        // En el siguiente turno: durante `mouseup` el navegador todavía no
        // terminó de fijar la selección.
        setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return;
            const rango = sel.getRangeAt(0);
            const spans = [...raiz.querySelectorAll('.script-palabra')]
                .filter(span => rango.intersectsNode(span));
            const ancla = anclaDeSeleccion(palabrasSeleccionadas(spans, bloqueDe));
            if (ancla) abrirCaja(ancla);
        }, 0);
    });
}
