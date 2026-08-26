'use strict';
/**
 * escucha.js — Recorrer con el oído el tramo que se está editando.
 *
 * El gesto del editor en la pestaña de cortes es mover un borde, escuchar cómo
 * quedó y corregir. Para eso hay que poder recorrer el tramo: dos botones que
 * sueltan un pedacito sirven para oír un instante, no para juzgar por dónde pasa
 * un corte.
 *
 * De dónde sale el sonido: del Live-Mix ENTERO, servido por `clase://`
 * (`engine/media-server.js`), que es la misma puerta por la que el reproductor
 * pide los MP4 de 15 GB. Antes cada escucha era un ffmpeg que extraía un WAV
 * temporal y lo mandaba como data URL: un proceso y un archivo por clic, y nada
 * para moverse adentro de lo extraído. Medido con el arnés sobre el Live-Mix de
 * la clase 1 del curso real (724 MB, 41:56): la ventana tiene la duración a los
 * 34 ms de pedir el archivo y saltar al minuto 30 tarda 152 ms, porque el
 * protocolo contesta por rangos y solo se lee del disco el pedazo que suena.
 *
 * La aguja se mueve con `requestAnimationFrame` y no con `timeupdate`: ese avisa
 * unas cuatro veces por segundo, y una aguja que salta cuatro veces por segundo
 * no sirve para ver contra qué parte de la onda está sonando.
 */

import { $, toast, estaEscribiendo } from '../chrome.js';
import { fmtClock } from '../formato.js';
import { rev, actual } from './estado.js';
import { zoomWindow } from './onda.js';

/**
 * Cuánto antes del borde arranca el "Escuchar" de cada lado.
 *
 * Es lo que ya venía haciendo el botón con ffmpeg y la razón sigue siendo la
 * misma: para saber si un corte entra bien hay que oír el silencio (o la
 * palabra) que quedó justo antes.
 */
const ANTES_DEL_BORDE_SEC = 1.5;

const estado = {
    reproduciendo: false,
    rafId: null,
    /**
     * Qué bloque tenía la ventana la última vez que se dibujó.
     *
     * Cambiar de bloque es navegar, no escuchar: si no se mirara esto, hacer
     * clic en la lista dejaría sonando el tramo anterior mientras en pantalla ya
     * está otro, con la aguja fuera de la ventana que se está viendo.
     */
    bloque: null,
    // La intención de dónde está la aguja. El `<audio>` es la verdad cuando ya
    // tiene el archivo abierto; hasta entonces `currentTime` es 0 y esto es lo
    // único que sabe adónde se quiso ir.
    posicionSec: 0
};

// ─── Las cuentas, sin DOM ─────────────────────────────────────────────
// Aparte y exportadas para poder probarlas (`tests/escucha.test.js`): son las
// que deciden si la aguja se dibuja donde suena y si darle play suena.

/** Dónde cae un momento dentro de la ventana, de 0 a 1. */
export function fraccionEn(segundo, ventana) {
    if (!ventana || !ventana.span) return 0;
    return Math.max(0, Math.min(1, (segundo - ventana.from) / ventana.span));
}

/** Y al revés: qué momento es un punto de la tira. */
export function segundoEn(fraccion, ventana) {
    if (!ventana) return 0;
    return ventana.from + Math.max(0, Math.min(1, fraccion)) * ventana.span;
}

/**
 * Desde dónde arranca una escucha.
 *
 * Fuera de la ventana no hay nada que oír de este tramo, y pegado al final
 * darle play no haría nada: en los dos casos se vuelve al principio, que es lo
 * que hace que la barra espaciadora siempre suene.
 */
export function arranqueDe(posicion, ventana) {
    if (!ventana) return 0;
    if (posicion == null || posicion < ventana.from || posicion >= ventana.to - 0.05) return ventana.from;
    return posicion;
}

/**
 * El reloj de la aguja, con décimas.
 *
 * `fmtClock` corta en el segundo, que alcanza para ubicar un bloque en una clase
 * de cuarenta minutos. Acá la ventana entera son veinte segundos y lo que se
 * está midiendo son cuadros: sin la décima, la aguja se mueve y el número no.
 */
export function reloj(segundos) {
    if (segundos == null || !Number.isFinite(segundos)) return '—';
    const decima = Math.floor(Math.abs(segundos) * 10) % 10;
    return `${fmtClock(segundos)},${decima}`;
}

// ─── El transporte ────────────────────────────────────────────────────

function audio() {
    return $('rev-audio');
}

/** El tramo que se escucha es el que se ve: la misma ventana que dibuja el zoom. */
function ventana() {
    return zoomWindow();
}

/** Si hay un archivo abierto y un tramo al que apuntar. */
function servible() {
    const el = audio();
    return Boolean(el && el.getAttribute('src') && ventana());
}

function posicion() {
    const el = audio();
    // `readyState` en 0 es "todavía no sabe nada del archivo": ahí `currentTime`
    // contesta 0 aunque se le haya pedido ir al minuto 30.
    return el && el.readyState > 0 ? el.currentTime : estado.posicionSec;
}

/** Pone la aguja en un momento, sin salirse del tramo que se está viendo. */
function irA(segundo, v) {
    const marco = v || ventana();
    if (!marco) return;
    const destino = Math.max(marco.from, Math.min(marco.to, segundo));
    estado.posicionSec = destino;
    const el = audio();
    if (el && el.getAttribute('src')) el.currentTime = destino;
    pintar();
}

function reproducir() {
    if (!servible()) {
        toast('Esta clase no tiene Live-Mix: no hay audio para escuchar.');
        return;
    }
    const marco = ventana();
    irA(arranqueDe(posicion(), marco), marco);
    estado.reproduciendo = true;
    audio().play().catch(err => {
        // `AbortError` es lo que contesta Chromium cuando el pedido de
        // reproducir quedó atrás de una pausa —pasa al saltar de borde— y no es
        // algo que el editor tenga que leer en un aviso.
        if (err.name === 'AbortError') return;
        pausar();
        toast(`No se pudo reproducir: ${err.message}`);
    });
    pintar();
    if (!estado.rafId) estado.rafId = requestAnimationFrame(latir);
}

export function pausar() {
    estado.reproduciendo = false;
    const el = audio();
    if (el) el.pause();
    if (estado.rafId) { cancelAnimationFrame(estado.rafId); estado.rafId = null; }
    pintar();
}

function alternar() {
    if (estado.reproduciendo) pausar(); else reproducir();
}

/** El latido: mueve la aguja y vigila el final del tramo. */
function latir() {
    estado.rafId = null;
    if (!estado.reproduciendo) return;

    const el = audio();
    const marco = ventana();
    if (el && marco) {
        estado.posicionSec = el.currentTime;
        // Mover un borde corre la ventana entera —empieza cuatro segundos antes
        // de la entrada—, así que la aguja puede quedar afuera sin que nadie
        // haya tocado el audio. Se la vuelve a meter en vez de dibujarla pegada
        // a un costado mostrando un momento que no está en pantalla.
        if (el.currentTime < marco.from) {
            irA(marco.from, marco);
        } else if (el.currentTime >= marco.to) {
            if ($('rev-loop').checked) {
                irA(marco.from, marco);
            } else {
                // La aguja se queda donde terminó, para ver hasta dónde llegó;
                // el próximo play rebobina solo (`arranqueDe`).
                pausar();
                return;
            }
        }
    }

    pintar();
    estado.rafId = requestAnimationFrame(latir);
}

/**
 * Escuchar un borde: la aguja segundo y medio antes y a reproducir.
 *
 * El botón «▶ Escuchar» de cada borde se queda, pero ahora es esto: llevar el
 * transporte al borde que se está mirando. Se queda porque sigue ahorrando el
 * gesto que más se repite —apuntar a mano en la tira y después darle play, para
 * volver a hacerlo tras cada ajuste— y porque el borde tiene su tiempo escrito
 * al lado, así que el botón está donde está la mano. Ya no extrae nada: suena en
 * el acto.
 *
 * Y no se corta a los tres segundos y medio como el pedacito de antes: sigue de
 * largo hasta el final del tramo. Para juzgar una salida hay que oír lo que
 * quedó afuera, y un audio que se apaga solo, habiendo transporte de verdad, se
 * lee como que algo falló.
 */
export function escucharBorde(borde) {
    const segmento = actual();
    const marco = ventana();
    if (!segmento || !marco) return;
    const donde = borde === 'in' ? segmento.sourceStartSec : segmento.sourceEndSec;
    irA(donde - ANTES_DEL_BORDE_SEC, marco);
    if (!estado.reproduciendo) reproducir();
}

// ─── Dibujo ───────────────────────────────────────────────────────────

function pintar() {
    const marco = ventana();
    const segmento = actual();
    const listo = servible();

    $('rev-play').disabled = !listo;
    $('rev-play').textContent = estado.reproduciendo ? 'Pausa' : 'Escuchar el tramo';
    $('rev-zoom-head').hidden = !listo;
    for (const boton of document.querySelectorAll('.btn-play')) boton.disabled = !listo;

    if (!listo || !segmento) {
        $('rev-audio-time').textContent = '—';
        return;
    }

    $('rev-zoom-head').style.left = `${fraccionEn(posicion(), marco) * 100}%`;
    $('rev-audio-time').textContent = reloj(posicion());

    // El bloque marcado sobre la tira: sin esto la tira es una barra gris y no
    // se ve qué parte de lo que suena es el margen que quedó afuera.
    const desde = fraccionEn(segmento.sourceStartSec, marco);
    const hasta = fraccionEn(segmento.sourceEndSec, marco);
    $('rev-zoom-bloque').style.left = `${desde * 100}%`;
    $('rev-zoom-bloque').style.width = `${Math.max(0, hasta - desde) * 100}%`;
}

/**
 * Repintar el transporte con lo que hay en pantalla ahora.
 *
 * Lo llama el mismo repintado que dibuja las ondas: mover un borde cambia la
 * ventana y la aguja tiene que quedar donde le corresponde en la nueva.
 */
export function renderEscucha() {
    const el = audio();
    const segmento = actual();
    const url = (rev.data && rev.data.liveMixUrl) || '';

    // Abrir otra clase trae otro Live-Mix. Y una clase sin Live-Mix tiene que
    // dejar el elemento vacío: si no, seguiría sonando el de la anterior sobre
    // los bordes de esta.
    if ((el.getAttribute('src') || '') !== url) {
        pausar();
        if (url) {
            el.src = url;
        } else {
            el.removeAttribute('src');
            el.load();
        }
        estado.bloque = null;
    }

    const bloque = segmento ? segmento.blockIndex : null;
    if (bloque !== estado.bloque) {
        estado.bloque = bloque;
        pausar();
        const marco = ventana();
        if (marco) irA(marco.from, marco);
    }

    pintar();
}

// ─── Entrada ──────────────────────────────────────────────────────────

function agujaA(evento, v) {
    const marco = v || ventana();
    if (!marco) return;
    const caja = $('rev-zoom-track').getBoundingClientRect();
    if (!caja.width) return;
    irA(segundoEn((evento.clientX - caja.left) / caja.width, marco), marco);
}

/**
 * Los atajos de esta pestaña.
 *
 * Van en el documento por lo mismo que los del reproductor: para que un elemento
 * reciba teclas tiene que tener el foco, y acá el foco lo tiene lo último que se
 * tocó (un botón de ±1 cuadro, la lista de bloques, nada).
 *
 * Se toma la barra espaciadora y nada más. En "Ver la clase" la barra ya
 * reproduce y pausa, y que en esta pestaña no hiciera lo mismo sería raro; el
 * oyente de allá se corta solo (`rev.tab !== 'clase'`), así que los dos conviven
 * sin conocerse. Las flechas NO se toman a propósito: acá tienen dos
 * significados igual de evidentes —mover el borde o mover la aguja— y elegir uno
 * en silencio es peor que no atender la tecla; los bordes se mueven con sus
 * botones, que dicen cuánto mueven.
 */
function teclas(evento) {
    if (rev.tab !== 'cortes' || !rev.data) return;
    // Con `rev.tab` en 'cortes' pero el visor cerrado —la tabla de clases, los
    // ajustes— la barra espaciadora no puede ponerse a sonar por detrás.
    if (!$('view-review').classList.contains('is-visible')) return;
    if (evento.metaKey || evento.ctrlKey || evento.altKey) return;
    if (estaEscribiendo(evento.target)) return;
    if (evento.key !== ' ') return;

    // Sin esto la barra baja la página, y además el botón que tenga el foco se
    // activaría de nuevo: apretar "+1 cuadro" y después la barra movería el
    // borde otro cuadro además de reproducir.
    evento.preventDefault();
    alternar();
}

export function wireEscucha() {
    $('rev-play').onclick = alternar;

    const tira = $('rev-zoom-track');
    tira.addEventListener('pointerdown', evento => {
        // Con captura: arrastrar la aguja y salirse de la tira con el botón
        // apretado tiene que seguir moviéndola, como cualquier deslizador.
        tira.setPointerCapture(evento.pointerId);
        agujaA(evento);
    });
    tira.addEventListener('pointermove', evento => {
        if (evento.buttons & 1) agujaA(evento);
    });

    // Si el archivo no se puede abrir, el botón se queda diciendo "Escuchar" y
    // no pasa nada: sin esto es el único desperfecto de esta pantalla que no
    // deja rastro en ningún lado. Con `src` puesto: soltar el archivo al cambiar
    // de clase no es una falla y no tiene que avisar nada.
    audio().addEventListener('error', () => {
        if (!audio().getAttribute('src')) return;
        pausar();
        toast('No se pudo abrir el Live-Mix de esta clase.');
    });

    document.addEventListener('keydown', teclas);
}
