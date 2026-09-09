'use strict';
/**
 * margen.js — Los comentarios de una toma, al margen y a pedido.
 *
 * Antes vivían en filas debajo del texto, dentro de la tarjeta, y la caja para
 * escribir uno nuevo aparecía ahí también. Eso inflaba la tarjeta: con dos
 * comentarios y una toma larga, la ficha medía media pantalla y la toma que
 * estaba pasando quedaba abajo. Y era una segunda forma de comentar en la misma
 * app, distinta de la que ya estaba aprobada en Revisar cortes.
 *
 * Así que es la misma: al margen, como en un documento compartido, con el mismo
 * lenguaje visual que `src/js/visor/guion.js` —la cita en itálica, el cuerpo, el
 * canto de color, "Borrar"— y el mismo acomodo cuando dos chocan
 * (`src/js/margen.js`, que las dos pantallas comparten).
 *
 * Lo que cambia acá es CUÁNDO se ven, y es lo que ordena todo el diseño: **el
 * comentario no vive permanentemente en pantalla, se pide.** El tramo va
 * subrayado siempre, se resalta al pasar el puntero y se abre al hacer clic. En
 * el guion del visor las tarjetas están todas puestas porque ahí se lee una clase
 * terminada de corrido; acá se está grabando, y una columna con seis tarjetas
 * abiertas al costado de la toma que está pasando es exactamente el ruido que
 * esta pantalla no puede tener.
 *
 * La columna del margen tampoco está siempre: aparece en la tarjeta que tiene un
 * comentario abierto y se va al cerrarlo. Reservarla vacía le sacaría doscientos
 * píxeles de ancho al texto de las veinte tomas para mostrar nada en diecinueve.
 */

import { acomodarMargen } from '../margen.js';
import { unirMarcadas } from './palabras.js';

/** La marca de que una tarjeta tiene el margen desplegado. */
const ABIERTA = 'es-comentando';

/**
 * Y la marca, aparte, de que lo que hay abierto es una caja de ESCRIBIR.
 *
 * Son dos situaciones que se ven parecidas y no lo son. `abrirCaja` abre el
 * campo donde alguien está redactando un comentario nuevo: eso es trabajo a
 * medio hacer, y un repintado que lo saque del documento se lleva el foco y lo
 * escrito. `abrirDe` solo MUESTRA comentarios que ya existen, y ahí no hay nada
 * que perder: la tarjeta se puede rehacer y el margen volver a abrirse encima
 * (`reabrir`).
 *
 * Estuvieron confundidas bajo la misma clase, y el precio fue el mismo defecto
 * que el del foco en el botón apretado (ver `tarjetasOcupadas` en `tomas.js`):
 * mientras un comentario viejo estuviera abierto, su tarjeta no se refrescaba
 * nunca y el cambio aparecía de golpe al cerrarlo.
 *
 * Va en un `dataset` y no en otra clase porque no se dibuja: la columna del
 * margen se abre igual en los dos casos, y una clase que no pinta nada invita a
 * colgarle estilo y volver a mezclarlas.
 */
const ESCRIBIENDO = 'comentando';

/** Si en esta tarjeta hay un comentario a medio escribir. */
export function escribiendoEn(tarjeta) {
    return Boolean(tarjeta && tarjeta.dataset && tarjeta.dataset[ESCRIBIENDO]);
}

/** Qué comentarios tiene abiertos al margen, por su índice en la toma. */
export function abiertosDe(tarjeta) {
    const crudo = tarjeta && tarjeta.dataset ? tarjeta.dataset.abiertos : '';
    return String(crudo || '').split(' ').filter(s => s !== '').map(Number);
}

function cajaDeMargen(tarjeta) {
    let margen = tarjeta.querySelector('.toma-margen');
    if (!margen) {
        margen = document.createElement('div');
        margen.className = 'toma-margen';
        const cuerpo = tarjeta.querySelector('.toma-cuerpo');
        if (!cuerpo) return null;
        cuerpo.append(margen);
    }
    return margen;
}

/**
 * Una tarjeta de comentario, igual que la del guion.
 *
 * @param {object} c { texto, comentario } del estado del motor
 * @param {number} indice el suyo en la toma, que es con lo que se lo borra
 * @param {object|null} acciones sin esto no lleva "Borrar": una clase leída de
 *   una carpeta ajena no tiene dónde escribir
 */
function tarjetaDe(c, indice, toma, acciones) {
    const caja = document.createElement('div');
    caja.className = 'toma-com';
    caja.dataset.com = String(indice);

    const cita = document.createElement('div');
    cita.className = 'toma-com-cita';
    cita.textContent = c.texto;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'toma-com-texto';
    cuerpo.textContent = c.comentario;

    caja.append(cita, cuerpo);

    if (acciones) {
        const fila = document.createElement('div');
        fila.className = 'toma-com-acciones';
        const borrar = document.createElement('button');
        borrar.className = 'btn btn-ghost btn-inline';
        borrar.type = 'button';
        borrar.textContent = 'Borrar';
        borrar.onclick = () => {
            cerrar(caja.closest('.toma'));
            acciones.alCambiar({ tipo: 'borrar-comentario', toma: toma.id, indice });
        };
        fila.append(borrar);
        caja.append(fila);
    }
    return caja;
}

/**
 * Deja al margen los comentarios que cubren una palabra, a su altura.
 *
 * Los que cubren y no el que cubre: dos comentarios se pueden pisar sobre las
 * mismas palabras, y en el tramo pisado se abren los dos. Elegir uno dejaría al
 * otro inalcanzable —no hay ninguna palabra donde esté solo— y esconder trabajo
 * es justamente lo que no puede hacer esta pantalla.
 *
 * @param {Element} span la palabra sobre la que se hizo clic
 */
export function abrirDe(span, toma, acciones) {
    const tarjeta = span.closest('.toma');
    const cuales = String(span.dataset.com || '').split(' ').filter(s => s !== '').map(Number);
    if (!tarjeta || !cuales.length) return;

    // Los mismos que ya estaban abiertos vuelven a cerrarse: el clic sobre un
    // tramo es un interruptor, que es lo que se espera de algo que se pide.
    if (tarjeta.dataset.abiertos === cuales.join(' ')) { cerrar(tarjeta); return; }

    abrir(tarjeta, cuales, toma, acciones);
}

/**
 * Vuelve a poner el margen sobre la tarjeta NUEVA, después de un repintado.
 *
 * Mostrar un comentario viejo no es trabajo a medio hacer, así que su tarjeta se
 * rehace como cualquier otra (ver `tarjetasOcupadas` en `tomas.js`) y el margen
 * se vuelve a abrir encima. Sin esto, la alternativa era la que había: congelar
 * la tarjeta mientras alguien mira un comentario, y que el cambio de vista que
 * hizo en el medio apareciera recién al cerrarlo.
 *
 * Los que ya no están se dejan afuera, y si no queda ninguno no se abre nada: un
 * margen con la columna puesta y sin tarjetas adentro es doscientos píxeles
 * quitados al texto para mostrar nada.
 */
export function reabrir(tarjeta, cuales, toma, acciones) {
    const comentarios = toma.comentarios || [];
    const siguen = cuales.filter(i => comentarios[i]);
    if (!siguen.length) return;
    abrir(tarjeta, siguen, toma, acciones);
}

/** Los comentarios `cuales` al margen de `tarjeta`, cada uno a su altura. */
function abrir(tarjeta, cuales, toma, acciones) {
    const margen = cajaDeMargen(tarjeta);
    if (!margen) return;
    margen.textContent = '';
    tarjeta.classList.add(ABIERTA);
    tarjeta.dataset.abiertos = cuales.join(' ');

    const comentarios = toma.comentarios || [];
    const puestas = [];
    for (const i of cuales) {
        if (!comentarios[i]) continue;
        const tarjetaCom = tarjetaDe(comentarios[i], i, toma, acciones);
        margen.append(tarjetaCom);
        puestas.push({ tarjeta: tarjetaCom, indice: i });
    }
    resaltar(tarjeta, cuales);
    acomodar(tarjeta, margen, puestas);
}

/**
 * Cada tarjeta a la altura de su primera palabra subrayada.
 *
 * Se mide con las tarjetas ya en el documento: una sin dibujar mide cero y todas
 * se apilarían en el mismo alto. Es lo mismo que hace el guion del visor.
 */
function acomodar(tarjeta, margen, puestas) {
    const base = margen.getBoundingClientRect().top;
    const pedidos = puestas.map(({ indice }) => {
        const primera = tarjeta.querySelector(`.toma-palabra[data-com~="${indice}"]`);
        return primera ? primera.getBoundingClientRect().top - base : 0;
    });
    const alturas = puestas.map(({ tarjeta: t }) => t.offsetHeight);
    acomodarMargen(alturas, pedidos).forEach((arriba, i) => {
        puestas[i].tarjeta.style.top = `${Math.max(0, arriba)}px`;
    });
}

/** Enciende el tramo que se está mirando, que es lo que lo liga a su tarjeta. */
function resaltar(tarjeta, cuales) {
    for (const s of tarjeta.querySelectorAll('.toma-palabra.es-abierta')) {
        s.classList.remove('es-abierta');
    }
    for (const i of cuales) {
        for (const s of tarjeta.querySelectorAll(`.toma-palabra[data-com~="${i}"]`)) {
            s.classList.add('es-abierta');
        }
    }
}

/** Cierra el margen de una tarjeta y le devuelve su ancho al texto. */
export function cerrar(tarjeta) {
    if (!tarjeta) return;
    tarjeta.classList.remove(ABIERTA);
    delete tarjeta.dataset.abiertos;
    delete tarjeta.dataset[ESCRIBIENDO];
    const margen = tarjeta.querySelector('.toma-margen');
    if (margen) margen.textContent = '';
    for (const s of tarjeta.querySelectorAll('.toma-palabra.es-abierta')) {
        s.classList.remove('es-abierta');
    }
    // Lo que se había subrayado para mostrar qué se estaba por comentar se va con
    // la caja: cancelar tiene que dejar el texto como estaba, y no hasta el
    // repintado siguiente —son tres segundos de un subrayado que no es de nadie—.
    for (const s of tarjeta.querySelectorAll('.toma-palabra[data-por-comentar]')) {
        s.classList.remove('es-comentada');
        delete s.dataset.porComentar;
    }
}

/** Cierra el margen de todas las tarjetas de la lista. */
export function cerrarTodos(donde) {
    for (const tarjeta of donde.querySelectorAll(`.toma.${ABIERTA}`)) cerrar(tarjeta);
}

/* ─── Escribir uno nuevo ─────────────────────────────────────────────────── */

/**
 * La caja para escribir, también al margen y a la altura de lo que se seleccionó.
 *
 * El tramo queda subrayado ANTES de escribir el comentario, y eso no es adorno:
 * al hacer clic en el campo la selección del navegador se pierde, y sin la marca
 * puesta no queda nada en pantalla que diga sobre qué se está por comentar. La
 * cita de arriba de la caja lo repite en palabras, como en el guion.
 *
 * @param {Element} tarjeta la de la toma
 * @param {object} ancla { desdeMs, hastaMs, texto } de `palabras.seleccion`
 */
export function abrirCaja(tarjeta, ancla, acciones, tomaId) {
    cerrar(tarjeta);
    const margen = cajaDeMargen(tarjeta);
    if (!margen) return;
    margen.textContent = '';
    tarjeta.classList.add(ABIERTA);
    // Y la marca de que acá hay algo a medio escribir, que es lo que le pide a la
    // lista que no rehaga esta tarjeta hasta que la suelten.
    tarjeta.dataset[ESCRIBIENDO] = '1';

    // El subrayado del tramo que se está por comentar, puesto a mano: el que sale
    // de `marcarComentados` es de los comentarios que YA existen, y este todavía
    // no es ninguno.
    marcarPorComentar(tarjeta, ancla);

    const caja = document.createElement('div');
    caja.className = 'toma-com es-nuevo';

    const cita = document.createElement('div');
    cita.className = 'toma-com-cita';
    cita.textContent = `«${ancla.texto}»`;

    const campo = document.createElement('textarea');
    campo.className = 'toma-com-campo';
    campo.rows = 3;
    campo.placeholder = 'Tu comentario para el editor…';

    const fila = document.createElement('div');
    fila.className = 'toma-com-acciones';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary btn-inline';
    ok.type = 'button';
    ok.textContent = 'Comentar';
    ok.onclick = () => {
        const texto = campo.value.trim();
        if (!texto) return;
        cerrar(tarjeta);
        window.getSelection().removeAllRanges();
        acciones.alCambiar({ tipo: 'comentar', toma: tomaId, ...ancla, comentario: texto });
    };
    const no = document.createElement('button');
    no.className = 'btn btn-ghost btn-inline';
    no.type = 'button';
    no.textContent = 'Cancelar';
    no.onclick = () => cerrar(tarjeta);
    fila.append(ok, no);

    caja.append(cita, campo, fila);
    margen.append(caja);
    campo.focus();
}

/**
 * Subraya lo que se acaba de seleccionar, antes de que exista el comentario.
 *
 * Por hora y no por la selección del navegador, igual que `marcarComentados`: es
 * la misma frontera, así que el tramo que se ve ahora es exactamente el que va a
 * quedar subrayado después de guardar.
 */
function marcarPorComentar(tarjeta, ancla) {
    for (const span of tarjeta.querySelectorAll('.toma-palabra:not(.es-orilla)')) {
        const t = Number(span.dataset.t);
        if (t < Number(ancla.desdeMs) || t > Number(ancla.hastaMs)) continue;
        // Quién puso la marca queda anotado: si se cancela hay que sacarla, y
        // sacarle el subrayado a una palabra que YA tenía un comentario sería
        // esconderlo hasta el repintado siguiente.
        if (!span.classList.contains('es-comentada')) span.dataset.porComentar = '1';
        span.classList.add('es-comentada', 'es-abierta');
    }
    const texto = tarjeta.querySelector('.toma-texto');
    if (texto) unirMarcadas(texto);
}

/**
 * El clic sobre un tramo subrayado abre su comentario; el clic en cualquier otra
 * parte del texto lo cierra.
 *
 * En `click` y no en `mouseup` para no pelearse con seleccionar: soltar una
 * selección termina en un clic, y ahí manda la caja de escribir. Se distingue
 * mirando si quedó algo seleccionado.
 */
export function cablearTramos(texto, toma, acciones) {
    texto.addEventListener('click', e => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const span = e.target.closest('.toma-palabra');
        if (!span) return;
        // La tarjeta se busca desde la palabra y no se recibe cableada: cuando
        // esto se cablea, el texto todavía no está colgado de ella.
        if (span.classList.contains('es-comentada')) abrirDe(span, toma, acciones);
        else cerrar(span.closest('.toma'));
    });
}
