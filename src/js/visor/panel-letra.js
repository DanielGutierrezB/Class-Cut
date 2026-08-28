'use strict';
/**
 * panel-letra.js — El transcript al lado del video: se alumbra lo que suena y
 * se puede comentar un pedazo.
 *
 * Leer va mucho más rápido que escuchar. Con el texto al lado, validar un corte
 * es mirar dónde arranca y dónde termina cada bloque en vez de esperar a que la
 * clase entera pase en tiempo real.
 *
 * Lo que el editor escribe acá es lo único de la revisión que no se puede volver
 * a calcular, así que se guarda apenas se escribe —sin esperar a "Guardar y
 * regenerar"— y termina en el XML como marcador, que es lo que va a leer quien
 * monte la clase.
 */

import { $, toast } from '../chrome.js';
import { rev } from './estado.js';
import { notas, guardar } from './comentarios.js';
import { repartir, palabraEn, anclaDe } from './letra.js';
import { COLORES_DE_CAMARA, comentariosEn } from './pista.js';

const estado = {
    bloques: [],
    // Dónde está prendido ahora, para no repintar sesenta veces por segundo.
    bloqueActivo: -1,
    palabraActiva: -1,
    // La selección viva, hasta que se comente o se cancele.
    seleccion: null,
    // Qué comentario se está editando, si es que alguno.
    editando: null,
    alSaltar: null,
    notaPendiente: null
};

function tramoDe(bloque) {
    return (rev.pista ? rev.pista.tramos : []).find(x => x.indice === bloque.indice) || null;
}

/**
 * La nota que se va a exportar de un bloque. La efectiva ya viene resuelta en
 * el tramo (`pista.construir` la calcula una vez para todas las vistas); acá
 * solo se dice si está corregida, que es lo que el campo marca en verde.
 */
function notaDe(bloque) {
    const tramo = tramoDe(bloque);
    if (!tramo) return { texto: '', editada: false };
    return { texto: tramo.nota || '', editada: tramo.nota !== tramo.notaOriginal };
}

/** Los comentarios que caen dentro de un bloque, por tiempo de grabación. */
function comentariosDe(bloque) {
    const tramo = tramoDe(bloque);
    if (!tramo) return [];
    return comentariosEn(tramo.origenDesdeSec, tramo.origenHastaSec, notas().comentarios);
}

/* ─── Dibujo ────────────────────────────────────────────────────────────── */

function pintarBloque(bloque) {
    const caja = document.createElement('section');
    caja.className = `letra-bloque cam-${(bloque.camara || 0) % COLORES_DE_CAMARA}`;
    caja.dataset.bloque = String(bloque.indice);

    const cabeza = document.createElement('header');
    cabeza.className = 'letra-bloque-head';

    const titulo = document.createElement('span');
    titulo.className = 'letra-bloque-num';
    titulo.textContent = `Bloque ${bloque.blockIndex + 1}`;

    const vista = document.createElement('span');
    vista.className = 'letra-bloque-vista';
    vista.textContent = bloque.view;

    cabeza.append(titulo, vista);

    // La nota del marcador, editable en el sitio: es lo que va a leer el editor.
    const nota = notaDe(bloque);
    const campo = document.createElement('div');
    campo.className = 'letra-nota' + (nota.editada ? ' is-editada' : '');
    campo.contentEditable = 'true';
    campo.spellcheck = false;
    campo.dataset.bloqueIndex = String(bloque.blockIndex);
    // Una palabra y en el gris más apagado que hay: el bloque sin nota es lo
    // normal —dos de cada tres en el curso— así que la invitación aparece en casi
    // todos los bloques y tiene que dejar leer el texto, no competir con él. Lo
    // que el campo es se explica en el `title`, que no ocupa lugar.
    campo.dataset.vacio = 'Comentar';
    campo.textContent = nota.texto;
    campo.title = 'La nota que va a leer el editor en Premiere';

    const parrafo = document.createElement('p');
    parrafo.className = 'letra-texto';
    // Las pausas se dibujan entre las palabras, no al final: leído corrido, un
    // silencio de diez segundos no se ve, y el video parece ir atrasado
    // respecto del texto cuando en realidad los dos están en su lugar.
    const pausasPorPalabra = new Map();
    for (const pausa of bloque.pausas || []) {
        const lista = pausasPorPalabra.get(pausa.trasPalabra) || [];
        lista.push(pausa);
        pausasPorPalabra.set(pausa.trasPalabra, lista);
    }
    const soltarPausas = i => {
        for (const pausa of pausasPorPalabra.get(i) || []) parrafo.append(pintarPausa(pausa, bloque));
    };

    soltarPausas(-1);
    bloque.palabras.forEach((palabra, i) => {
        const span = document.createElement('span');
        span.className = 'letra-palabra';
        span.dataset.bloque = String(bloque.indice);
        span.dataset.palabra = String(i);
        span.textContent = palabra.texto;
        parrafo.append(span, document.createTextNode(' '));
        soltarPausas(i);
    });
    if (!bloque.palabras.length) {
        parrafo.classList.add('is-vacio');
        parrafo.textContent = 'Sin transcripción para este bloque.';
    }

    caja.append(cabeza, campo, parrafo);
    for (const comentario of comentariosDe(bloque)) caja.append(pintarComentario(comentario));
    return caja;
}

/** El aviso de que acá no se dice nada, clicable para escucharlo. */
function pintarPausa(pausa, bloque) {
    const chip = document.createElement('span');
    chip.className = 'letra-pausa';
    chip.dataset.bloque = String(bloque.indice);
    chip.dataset.desde = String(pausa.desdeSec);
    chip.textContent = `⏸ ${pausa.duracionSec.toFixed(1).replace('.0', '')} s en silencio`;
    chip.title = 'No se dice nada acá. Hacé clic para escucharlo.';
    return chip;
}

function pintarComentario(comentario) {
    const caja = document.createElement('div');
    caja.className = 'letra-comentario';
    caja.dataset.id = comentario.id;

    const cita = document.createElement('div');
    cita.className = 'letra-comentario-cita';
    cita.textContent = comentario.texto;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'letra-comentario-texto';
    cuerpo.textContent = comentario.comentario;

    const acciones = document.createElement('div');
    acciones.className = 'letra-comentario-acciones';
    const editar = document.createElement('button');
    editar.className = 'btn btn-ghost btn-inline';
    editar.textContent = 'Editar';
    editar.dataset.editar = comentario.id;
    const borrar = document.createElement('button');
    borrar.className = 'btn btn-ghost btn-inline';
    borrar.textContent = 'Borrar';
    borrar.dataset.borrar = comentario.id;
    acciones.append(editar, borrar);

    caja.append(cita, cuerpo, acciones);
    return caja;
}

export function pintarLetra() {
    const cuerpo = $('letra-body');
    cuerpo.textContent = '';
    estado.bloqueActivo = -1;
    estado.palabraActiva = -1;

    if (!estado.bloques.length) {
        const vacio = document.createElement('p');
        vacio.className = 'letra-vacio';
        vacio.textContent = 'No hay transcripción para esta clase.';
        cuerpo.append(vacio);
        return;
    }
    for (const bloque of estado.bloques) cuerpo.append(pintarBloque(bloque));
}

/* ─── Karaoke ───────────────────────────────────────────────────────────── */

/**
 * Alumbra la palabra que suena.
 *
 * Se llama una vez por cuadro, así que solo toca el DOM cuando la palabra
 * cambió de verdad: repintar sesenta veces por segundo con la clase entera en
 * pantalla se ve como un tirón cada vez que alguien habla rápido.
 */
export function seguir(segundo) {
    const donde = palabraEn(estado.bloques, segundo);
    const bloque = donde ? donde.bloque : -1;
    const palabra = donde ? donde.palabra : -1;
    if (bloque === estado.bloqueActivo && palabra === estado.palabraActiva) return;

    const anterior = $('letra-body').querySelector('.letra-palabra.is-on');
    if (anterior) anterior.classList.remove('is-on');

    if (bloque !== estado.bloqueActivo) {
        for (const caja of $('letra-body').querySelectorAll('.letra-bloque.is-on')) {
            caja.classList.remove('is-on');
        }
        const caja = $('letra-body').querySelector(`.letra-bloque[data-bloque="${bloque}"]`);
        if (caja) {
            caja.classList.add('is-on');
            caja.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    if (donde) {
        const span = $('letra-body')
            .querySelector(`.letra-palabra[data-bloque="${bloque}"][data-palabra="${palabra}"]`);
        if (span) {
            span.classList.add('is-on');
            // Solo cuando se fue de cuadro: hacerlo siempre pelea con quien está
            // leyendo más adelante o seleccionando para comentar.
            if (fueraDeVista(span)) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    estado.bloqueActivo = bloque;
    estado.palabraActiva = palabra;
}

function fueraDeVista(elemento) {
    const caja = $('letra-body').getBoundingClientRect();
    const suya = elemento.getBoundingClientRect();
    return suya.top < caja.top || suya.bottom > caja.bottom;
}

/* ─── Comentarios ───────────────────────────────────────────────────────── */

/** Qué palabras abarca lo que el editor dejó seleccionado. */
function seleccionDePalabras() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

    const rango = sel.getRangeAt(0);
    const palabras = [...$('letra-body').querySelectorAll('.letra-palabra')]
        .filter(span => rango.intersectsNode(span));
    if (!palabras.length) return null;

    const bloqueIndice = Number(palabras[0].dataset.bloque);
    // Una selección que cruza bloques no tiene un ancla claro: se queda con la
    // parte del primero, que es lo que el editor estaba mirando.
    const delMismo = palabras.filter(p => Number(p.dataset.bloque) === bloqueIndice);
    const bloque = estado.bloques.find(b => b.indice === bloqueIndice);
    if (!bloque) return null;

    const ancla = anclaDe(
        bloque,
        Number(delMismo[0].dataset.palabra),
        Number(delMismo[delMismo.length - 1].dataset.palabra)
    );
    return ancla ? { ...ancla, bloque: bloqueIndice } : null;
}

function abrirCajaDeComentario(ancla, existente) {
    cerrarCajaDeComentario();
    estado.seleccion = ancla;
    estado.editando = existente || null;

    const caja = document.createElement('div');
    caja.className = 'letra-nuevo';
    caja.id = 'letra-nuevo';

    const cita = document.createElement('div');
    cita.className = 'letra-comentario-cita';
    cita.textContent = ancla.texto;

    const campo = document.createElement('textarea');
    campo.className = 'letra-nuevo-campo';
    campo.rows = 3;
    campo.placeholder = 'Tu comentario para el editor…';
    campo.value = existente ? existente.comentario : '';

    const acciones = document.createElement('div');
    acciones.className = 'letra-comentario-acciones';
    const guardarBtn = document.createElement('button');
    guardarBtn.className = 'btn btn-primary btn-inline';
    guardarBtn.textContent = existente ? 'Guardar' : 'Comentar';
    guardarBtn.onclick = () => confirmarComentario(campo.value);
    const cancelar = document.createElement('button');
    cancelar.className = 'btn btn-ghost btn-inline';
    cancelar.textContent = 'Cancelar';
    cancelar.onclick = cerrarCajaDeComentario;
    acciones.append(guardarBtn, cancelar);

    campo.onkeydown = evento => {
        if (evento.key === 'Escape') { evento.preventDefault(); cerrarCajaDeComentario(); }
        // Enter suelto hace salto de línea; con el modificador, guarda.
        if (evento.key === 'Enter' && (evento.metaKey || evento.ctrlKey)) {
            evento.preventDefault();
            confirmarComentario(campo.value);
        }
    };

    caja.append(cita, campo, acciones);

    const destino = $('letra-body').querySelector(`.letra-bloque[data-bloque="${ancla.bloque}"]`);
    (destino || $('letra-body')).append(caja);
    campo.focus();
}

function cerrarCajaDeComentario() {
    const caja = document.getElementById('letra-nuevo');
    if (caja) caja.remove();
    estado.seleccion = null;
    estado.editando = null;
}

async function confirmarComentario(texto) {
    const limpio = String(texto || '').trim();
    if (!limpio) { toast('El comentario está vacío.'); return; }

    const ancla = estado.seleccion;
    if (estado.editando) {
        const previo = notas().comentarios.find(c => c.id === estado.editando.id);
        if (previo) previo.comentario = limpio;
    } else {
        // Sin id: lo acuña `engine/notas.js` al guardar, que es el único que
        // los reparte. La respuesta vuelve con todo asignado y se repinta de ahí.
        notas().comentarios.push({
            sourceStartSec: ancla.sourceStartSec,
            sourceEndSec: ancla.sourceEndSec,
            texto: ancla.texto,
            comentario: limpio
        });
    }

    cerrarCajaDeComentario();
    window.getSelection().removeAllRanges();
    if (await guardar()) {
        pintarLetra();
        toast('Comentario guardado. Va a salir como marcador en el XML.');
    }
}

async function borrarComentario(id) {
    notas().comentarios = notas().comentarios.filter(c => c.id !== id);
    if (await guardar()) pintarLetra();
}

/**
 * La nota del marcador, mientras se escribe.
 *
 * No alcanza con guardar al salir del campo: quien escribe una nota y cierra la
 * app, o se va a otra clase sin sacar el cursor de ahí, la perdería. Y es lo
 * único de la revisión que no se puede recalcular. Se espera a que pare de
 * escribir para no mandar una escritura por tecla.
 */
function guardarNotaMasTarde(campo) {
    if (estado.notaPendiente) clearTimeout(estado.notaPendiente.timer);
    estado.notaPendiente = {
        campo,
        timer: setTimeout(() => guardarNotaDeBloque(campo), 600)
    };
}

/** Escribe ya lo que estaba esperando, antes de que el panel desaparezca. */
function soltarNotaPendiente() {
    if (!estado.notaPendiente) return;
    const { campo } = estado.notaPendiente;
    guardarNotaDeBloque(campo);
}

/** La nota del marcador, cuando el editor terminó de escribirla. */
async function guardarNotaDeBloque(campo) {
    if (estado.notaPendiente) clearTimeout(estado.notaPendiente.timer);
    estado.notaPendiente = null;
    const indice = Number(campo.dataset.bloqueIndex);
    const texto = campo.textContent.trim();
    const tramo = (rev.pista ? rev.pista.tramos : []).find(t => t.blockIndex === indice);
    const original = (tramo && tramo.notaOriginal) || '';

    // Volver a dejarla como vino no es una corrección: se borra el override para
    // que la clase siga la nota del marcador si mañana se reprocesa.
    if (texto === original.trim()) delete notas().bloques[indice];
    else notas().bloques[indice] = { note: texto };

    // La pista viva lleva la nota efectiva: sin esto, el overlay del reproductor
    // y la tira seguirían mostrando la de antes hasta reabrir la pestaña.
    if (tramo) tramo.nota = texto || original;

    if (await guardar()) {
        campo.classList.toggle('is-editada', Boolean(notas().bloques[indice]));
    }
}

/* ─── Ciclo de vida ─────────────────────────────────────────────────────── */

export function abrirLetra(pista, alSaltar) {
    estado.alSaltar = alSaltar;
    const silencios = rev.data && rev.data.silencios ? rev.data.silencios.tramos : [];
    estado.bloques = repartir(pista ? pista.tramos : [], rev.data ? rev.data.words : [], silencios);
    $('letra-hint').hidden = !estado.bloques.length;
    pintarLetra();
}

export function cerrarLetra() {
    // Salir de la pestaña no puede tragarse una nota a medio escribir.
    soltarNotaPendiente();
    cerrarCajaDeComentario();
    estado.bloques = [];
    estado.bloqueActivo = -1;
    estado.palabraActiva = -1;
    $('letra-body').textContent = '';
}

export function wireLetra() {
    const cuerpo = $('letra-body');

    cuerpo.onclick = evento => {
        const editar = evento.target.closest('[data-editar]');
        if (editar) {
            const comentario = notas().comentarios.find(c => c.id === editar.dataset.editar);
            if (comentario) {
                abrirCajaDeComentario({
                    sourceStartSec: comentario.sourceStartSec,
                    sourceEndSec: comentario.sourceEndSec,
                    texto: comentario.texto,
                    bloque: Number(editar.closest('.letra-bloque').dataset.bloque)
                }, comentario);
            }
            return;
        }

        const borrar = evento.target.closest('[data-borrar]');
        if (borrar) { borrarComentario(borrar.dataset.borrar); return; }

        // Clic en una pausa: pararse un poco antes, que es donde se oye si
        // sobra o si el silencio está haciendo algo.
        const pausa = evento.target.closest('.letra-pausa');
        if (pausa && estado.alSaltar) {
            estado.alSaltar(Math.max(0, Number(pausa.dataset.desde) - 1));
            return;
        }

        // Clic en una palabra: llevar el video ahí. Solo cuando no se estaba
        // seleccionando, para no saltar en medio de un arrastre.
        const palabra = evento.target.closest('.letra-palabra');
        if (palabra && window.getSelection().isCollapsed && estado.alSaltar) {
            const bloque = estado.bloques.find(b => b.indice === Number(palabra.dataset.bloque));
            const dato = bloque && bloque.palabras[Number(palabra.dataset.palabra)];
            if (dato) estado.alSaltar(dato.desdeSec);
        }
    };

    // Al soltar el mouse se ve si quedó algo seleccionado para comentar.
    cuerpo.onmouseup = () => {
        setTimeout(() => {
            const ancla = seleccionDePalabras();
            if (ancla) abrirCajaDeComentario(ancla, null);
        }, 0);
    };

    cuerpo.addEventListener('input', evento => {
        const campo = evento.target.closest('.letra-nota');
        if (campo) guardarNotaMasTarde(campo);
    });

    cuerpo.addEventListener('focusout', evento => {
        const campo = evento.target.closest('.letra-nota');
        if (campo) guardarNotaDeBloque(campo);
    });

    // Enter en la nota del marcador la cierra: es de una línea, y el XML no
    // guarda saltos de todos modos.
    cuerpo.addEventListener('keydown', evento => {
        const campo = evento.target.closest('.letra-nota');
        if (campo && evento.key === 'Enter') { evento.preventDefault(); campo.blur(); }
    });
}
