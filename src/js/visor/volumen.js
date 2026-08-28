'use strict';
/**
 * volumen.js — El volumen de «Ver la clase», hasta el 150%.
 *
 * Por qué hace falta pasar del 100%: las clases se graban con el micro del
 * profesor y el nivel del Rodecaster no siempre queda parejo entre tomas. Con
 * el tope del sistema, un bloque bajo se revisa a oído pegado al parlante o no
 * se revisa.
 *
 * Y por qué no alcanza con `video.volume`: topa en 1 por especificación —
 * asignarle 1.5 no tira, se guarda 1— así que arriba del 100% hay que sacar el
 * audio del elemento y pasarlo por Web Audio, donde un `GainNode` sí amplifica.
 * Medido con el arnés sobre la clase 1 del curso real, conectando el `<video>` a
 * un analizador con ganancia 1,5: el pico pasó de cero exacto —el elemento
 * estaba "contaminado" y Chromium silenciaba el grafo sin avisar— a 0,0055 una
 * vez puestos `corsEnabled` en el registro del esquema (`main.js`) y la cabecera
 * `Access-Control-Allow-Origin` al servir (`engine/media-server.js`).
 *
 * El grafo se arma recién cuando alguien pasa del 100%, no al abrir la clase.
 * Conectar un elemento a `createMediaElementSource` es de ida: desde ahí su
 * audio sale por el grafo y nunca más por la salida directa, así que si mañana
 * se rompe la cabecera CORS la clase se queda muda. Mientras el volumen esté al
 * 100% o menos no hay nada que ganar con el grafo —`video.volume` hace
 * exactamente eso— y no tiene sentido pagar ese riesgo.
 */

import { $ } from '../chrome.js';

/**
 * Hasta dónde se puede subir.
 *
 * 150% es lo que pidió el editor y es también donde conviene parar: el Live-Mix
 * viene normalizado cerca del techo, así que amplificando más el recorte deja
 * de ser un aviso y se vuelve lo único que se escucha.
 */
export const MAXIMO = 150;
const POR_DEFECTO = 100;

/**
 * Se recuerda entre sesiones, como el ancho del panel de texto: es una
 * preferencia del oído de quien revisa, no una decisión por clase. Mismo
 * `try/catch` que `division.js` por si el modo privado bloquea el almacenamiento.
 */
const RECORDADO = 'cc.volumen-de-la-clase';

// ─── Las cuentas, sin DOM ─────────────────────────────────────────────
// Aparte y exportadas para poder probarlas (`tests/volumen.test.js`).

/**
 * Un porcentaje que se pueda usar, venga de donde venga.
 *
 * `null` y la cadena vacía se descartan a mano porque `Number` los convierte en
 * 0, que es un volumen perfectamente válido: sin esto, una preferencia que no
 * está guardada se lee como "el editor quiso silencio" y la clase abre muda.
 */
export function porcentajeValido(valor) {
    if (valor == null || valor === '') return POR_DEFECTO;
    const n = Number(valor);
    if (!Number.isFinite(n)) return POR_DEFECTO;
    return Math.max(0, Math.min(MAXIMO, Math.round(n)));
}

/** La ganancia del `GainNode`: 1 es el nivel del archivo. */
export function gananciaDe(porcentaje) {
    return porcentajeValido(porcentaje) / 100;
}

/**
 * Lo mismo pedido al elemento, para cuando no hay grafo. `volume` topa en 1,
 * así que de acá para arriba el número se pierde en silencio.
 */
export function volumenDelElemento(porcentaje) {
    return Math.min(1, gananciaDe(porcentaje));
}

/** Arriba del 100% puede recortar, y eso se avisa. */
export function puedeSaturar(porcentaje) {
    return porcentajeValido(porcentaje) > 100;
}

// ─── El grafo ─────────────────────────────────────────────────────────

const estado = {
    porcentaje: POR_DEFECTO,
    ctx: null,
    /**
     * El nodo de cada `<video>`.
     *
     * Un elemento se puede conectar a `createMediaElementSource` UNA sola vez:
     * la segunda llamada tira `InvalidStateError`. Hay un `<video>` por cámara y
     * se reciclan entre bloques, así que sin este registro cambiar de plano
     * rompería el audio. `WeakMap` porque los elementos se rehacen al abrir otra
     * clase y sus nodos se van con ellos.
     */
    nodos: new WeakMap(),
    // Una vez que el audio salió por el grafo, ya no puede volver a la salida
    // directa: no es un modo que se prenda y se apague, es una puerta de ida.
    porGrafo: false,
    // El volumen con el que empezó el clic, para saber si el doble clic movió
    // algo (ver `alDoblarElClic`).
    antesDelClic: null,
    alAplicar: () => {}
};

function contexto() {
    if (estado.ctx) return estado.ctx;
    try {
        estado.ctx = new AudioContext();
    } catch {
        // Sin Web Audio se sigue oyendo por la salida directa del elemento: lo
        // único que se pierde es pasar del 100%, que ahí topa y no sube más.
        estado.ctx = null;
    }
    return estado.ctx;
}

/** El nodo de un `<video>`, armándolo la primera vez. */
function nodoDe(video) {
    const ya = estado.nodos.get(video);
    if (ya) return ya;
    const ctx = contexto();
    if (!ctx) return null;
    try {
        const fuente = ctx.createMediaElementSource(video);
        const ganancia = ctx.createGain();
        fuente.connect(ganancia);
        ganancia.connect(ctx.destination);
        const nodo = { fuente, ganancia };
        estado.nodos.set(video, nodo);
        return nodo;
    } catch {
        return null;
    }
}

/**
 * El `AudioContext` arranca suspendido hasta que hay un gesto del usuario, y
 * suspendido no suena nada. Lo llama el reproductor al darle play, que es un
 * gesto por definición: se llega ahí por el botón o por la barra espaciadora.
 */
export function despertarAudio() {
    if (estado.ctx && estado.ctx.state === 'suspended') {
        estado.ctx.resume().catch(() => { /* lo dirá el silencio */ });
    }
}

/**
 * Pone el volumen donde tiene que estar, en todos los videos del bloque.
 *
 * El nivel se aplica por elemento y no una sola vez a la salida: en un bloque
 * con recuadro hay DOS videos sonando en potencia y solo el principal va sin
 * `muted` (ver `componer`). Si la ganancia fuera común, subir el volumen
 * destaparía al recuadro y se escucharía la clase encimada consigo misma. Los
 * que no son el principal van a ganancia cero, así que da igual qué haga
 * Chromium con `muted` cuando el elemento ya está enchufado al grafo.
 *
 * @param {HTMLVideoElement[]} videos todos los de la clase
 * @param {HTMLVideoElement|null} principal el único que tiene que sonar
 */
export function aplicarVolumen(videos, principal) {
    const porcentaje = estado.porcentaje;
    if (porcentaje > 100) estado.porGrafo = true;

    for (const video of videos || []) {
        const suena = video === principal;
        const nodo = estado.porGrafo ? nodoDe(video) : null;
        if (nodo) {
            // Con el grafo puesto, el elemento queda en 1 y todo el nivel lo
            // pone la ganancia: son dos atenuaciones en cadena y multiplicarlas
            // daría un volumen que no es el que dice el número.
            video.volume = 1;
            nodo.ganancia.gain.value = suena ? gananciaDe(porcentaje) : 0;
        } else {
            video.volume = suena ? volumenDelElemento(porcentaje) : 0;
        }
    }
}

/**
 * El grafo tal como quedó, para poder medirlo desde afuera.
 *
 * Se asoma en `window.dev.audio` por lo mismo que `dev.visor()` asoma el estado
 * del visor: el volumen no se ve en una captura de pantalla, así que sin esto
 * verificar que el recuadro se quedó callado al subir a 150% es escuchar la
 * computadora y opinar. Devuelve los nodos de verdad —no una copia— para que el
 * arnés pueda colgarles su propio analizador y medir el sonido que sale, sin que
 * el código de medición viva acá.
 */
export function estadoDelAudio(videos) {
    return {
        porcentaje: estado.porcentaje,
        porGrafo: estado.porGrafo,
        ctx: estado.ctx,
        estadoDelCtx: estado.ctx ? estado.ctx.state : null,
        nodos: (videos || []).map(video => ({
            video,
            nodo: estado.nodos.get(video) || null,
            muted: video.muted,
            volume: video.volume
        }))
    };
}

// ─── El control ───────────────────────────────────────────────────────

function pintar() {
    const porcentaje = estado.porcentaje;
    const saturando = puedeSaturar(porcentaje);

    $('player-vol-pct').textContent = `${porcentaje}%`;
    $('player-vol').classList.toggle('is-saturado', saturando);
    // El aviso va escrito y no solo en el color: "puede saturar" es una
    // afirmación sobre el sonido, y en un naranja se lee como decoración.
    $('player-vol-aviso').hidden = !saturando;
    $('player-volumen').setAttribute('aria-valuetext', `${porcentaje}%`);
    // El doble clic va escrito acá porque un gesto que no se ve no existe: es la
    // única pista de que existe, y va en renglón aparte para que el aviso de
    // recorte —que es sobre el sonido— no quede mezclado con una instrucción.
    $('player-volumen').title = (saturando
        ? `Volumen ${porcentaje}% · arriba del 100% el audio puede recortar`
        : `Volumen ${porcentaje}%`)
        + '\nDoble clic en el pomo para volver al 100%';
}

function guardar() {
    try { localStorage.setItem(RECORDADO, String(estado.porcentaje)); } catch { /* modo privado */ }
}

/** El volumen guardado, o el de fábrica si no hay o quedó fuera de rango. */
function recordado() {
    try {
        const guardado = localStorage.getItem(RECORDADO);
        if (guardado != null && guardado !== '') return porcentajeValido(guardado);
    } catch { /* modo privado */ }
    return POR_DEFECTO;
}

function mover(valor) {
    estado.porcentaje = porcentajeValido(valor);
    pintar();
    estado.alAplicar();
}

/**
 * Las teclas que el deslizador usa de verdad se paran acá.
 *
 * Es el mismo trato que hace el divisor del panel (`division.js`): con el foco
 * en el deslizador, las flechas suben y bajan el volumen y no tienen además que
 * mover la aguja del video. La barra espaciadora NO se para: sigue siendo
 * reproducir y pausar aunque el foco haya quedado acá después de un arrastre.
 */
function teclas(evento) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(evento.key)) {
        evento.stopPropagation();
    }
}

/**
 * Doble clic: de vuelta al 100%, que es el gesto de "valor de fábrica".
 *
 * En el pomo y no en toda la barra, porque en la barra un clic YA es una orden:
 * "poné el volumen acá". Si el doble clic volviera al 100% en cualquier parte,
 * dos clics en el mismo lugar —el "no sé si tomó" de siempre— darían 100% en vez
 * del valor que se estaba pidiendo.
 *
 * El problema es que un `input[range]` no dice dónde cayó el clic: el pomo lo
 * dibuja el navegador adentro del elemento y no es un nodo al que se le pueda
 * pedir la caja. Calcularlo a mano necesita el ancho del pomo, que es el de la
 * plataforma: un número adivinado, y si cambia el gesto dispara en otro lado.
 *
 * Así que se pregunta por lo que el clic HIZO, que es lo mismo y no necesita
 * ningún número: en el pomo, Chromium lo agarra para arrastrar y NO toca el
 * valor; en la barra, lo lleva a donde se clickeó. Entonces "el valor quedó igual
 * que antes del primer clic" es exactamente "fue en el pomo".
 *
 * Medido con el arnés, con clics de verdad y el volumen en 120%. El pomo va de
 * 284,6 a 300,6 (el deslizador arranca en 220,6, mide 96 y el pomo 16):
 *
 *   x=275 → 85%    fuera del pomo, el clic manda
 *   x=285 → 100%   filo izquierdo
 *   x=289 → 100%
 *   x=293 → 100%   centro
 *   x=297 → 100%   filo derecho
 *   x=301 → 135%   un píxel afuera, el clic manda
 *   x=311 → 150%
 *
 * Los cuatro del medio son el pomo entero y vuelven al 100%; los de afuera dejan
 * el valor que pidieron. Y no hay zona gris pegada al pomo: saliendo del filo, el
 * primer valor alcanzable ya está a quince puntos (120 → 135), porque el pomo
 * tapa tres pasos de la barra. Así que la prueba es exacta, sin tolerancias.
 */
function alDoblarElClic() {
    if (estado.antesDelClic !== estado.porcentaje) return;
    if (estado.porcentaje === POR_DEFECTO) return;
    mover(POR_DEFECTO);
    // El deslizador no se enteró: el valor lo cambió esto y no el mouse. Y se
    // guarda a mano porque `change` ya pasó, en el `mouseup` del segundo clic.
    $('player-volumen').value = String(POR_DEFECTO);
    guardar();
}

/**
 * @param {Function} alAplicar lo llama el reproductor para poner el nivel en
 *   sus videos: quién es el principal lo sabe él, no esto.
 */
export function wireVolumen(alAplicar) {
    estado.alAplicar = alAplicar || (() => {});

    const deslizador = $('player-volumen');
    // El tope se pone desde acá aunque el marcado ya lo traiga: el que manda es
    // el que usan las cuentas, y con el número escrito en dos lados subirlo
    // dejaría un deslizador que pide 200 y una ganancia que recorta en 150.
    deslizador.max = String(MAXIMO);
    deslizador.addEventListener('input', evento => mover(evento.target.value));
    deslizador.addEventListener('keydown', teclas);
    // Se guarda al soltar y no en cada `input`: arrastrar de 0 a 150 dispara
    // treinta eventos y ninguno de los veintinueve primeros es lo que el editor
    // quiso dejar. Igual que el ancho del panel, que se guarda al soltar.
    deslizador.addEventListener('change', guardar);
    // `detail` es el número de clic de la serie, así que el 1 es el que empieza:
    // ahí queda anotado desde dónde salió el gesto.
    deslizador.addEventListener('mousedown', evento => {
        if (evento.detail < 2) estado.antesDelClic = estado.porcentaje;
    });
    deslizador.addEventListener('dblclick', alDoblarElClic);

    estado.porcentaje = recordado();
    deslizador.value = String(estado.porcentaje);
    pintar();
}
