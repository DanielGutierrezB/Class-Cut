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

/**
 * Hasta dónde se levanta el pico de la clase al nivelarla.
 *
 * 0,7 son unos −3 dBFS. No se va a 1 porque el pico sale de los picos que ya
 * calculó `engine/waveform.js`, y esos se leen por muestreo —un pedazo por
 * cubo—, así que el pico de verdad puede ser un poco más alto que el que se ve.
 * Dejar aire evita que el nivelado solo, sin que nadie toque el deslizador, entre
 * al limitador.
 */
const OBJETIVO = 0.7;

/**
 * Cuánto se puede levantar una clase. Diez veces son +20 dB.
 *
 * El tope existe porque el pico puede venir de una clase casi muda —un archivo
 * mal grabado, o uno donde lo único que se oye es la sala—, y sin límite el
 * nivelado convertiría el ruido de fondo en el sonido principal.
 */
const NIVELADO_MAXIMO = 10;

/**
 * Cuánto le falta a esta clase para sonar a un nivel usable.
 *
 * **Por qué hace falta.** El material del curso está grabado 18-20 dB por debajo
 * de lo normal: medido con `loudnorm` sobre el Live-Mix, la clase 1 da −36,0
 * LUFS y la 13 −34,0, contra los −16 LUFS con los que se publica voz. Con el
 * archivo tal cual, revisar es pegar la oreja al parlante — y por eso el tope de
 * 150% no alcanzaba: son +3,5 dB peleando contra un problema de veinte.
 *
 * **De dónde sale el número.** Del pico de la clase, que la app ya tiene: los
 * picos de la onda vienen en escala absoluta (`engine/waveform.js` divide por el
 * máximo del formato), así que el más alto de todos ES el pico del archivo. No
 * hay que medir nada aparte. En el curso da ×3,7 para la clase 1 y ×6,2 para la
 * 13, que es exactamente lo que les falta.
 *
 * Se nivela por CLASE y no por bloque a propósito: bloque a bloque, cada corte
 * cambiaría de volumen y la clase se escucharía como una escalera.
 *
 * @param {number[]} picos los de `rev.data.waveform`
 */
export function niveladoDe(picos) {
    const lista = picos || [];
    let pico = 0;
    for (const p of lista) if (p > pico) pico = p;
    // Sin onda —una clase sin Live-Mix— no hay nada que medir y se deja como
    // viene: inventar una ganancia a ciegas puede reventar un audio que estaba
    // bien.
    if (!(pico > 0)) return 1;
    return Math.min(NIVELADO_MAXIMO, Math.max(1, OBJETIVO / pico));
}

/**
 * La ganancia del `GainNode`: el nivelado de la clase por lo que pide el
 * deslizador. En 100% suena la clase nivelada, que es lo que se quiere oír.
 */
export function gananciaDe(porcentaje, nivelado) {
    return (porcentajeValido(porcentaje) / 100) * (nivelado || 1);
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
    // Cuánto se levanta esta clase para que se oiga a un nivel usable. Lo pone
    // `ponerNivelado` al abrirla; en 1 mientras no se sepa.
    nivelado: 1,
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

/**
 * El nodo de un `<video>`, armándolo la primera vez.
 *
 * Después de la ganancia va un limitador, y no es un adorno: nivelando la clase
 * al pico, un bloque grabado más fuerte que el resto llegaría al techo, y
 * subiendo el deslizador por arriba del 100% se pasa seguro. Sin él eso cruje.
 * Con él, lo que se pasa se aplasta y lo que está bajo —el arranque de la clase
 * 13, catorce dB por debajo del resto de su propia clase— se oye igual.
 *
 * Es un compresor con relación alta y rodilla dura, que es la forma que tiene
 * Web Audio de decir "limitador". El ataque corto agarra las consonantes fuertes
 * antes de que se recorten; la soltura larga evita que el fondo de sala suba y
 * baje entre palabra y palabra, que es lo que hace que un audio comprimido
 * "respire".
 */
function nodoDe(video) {
    const ya = estado.nodos.get(video);
    if (ya) return ya;
    const ctx = contexto();
    if (!ctx) return null;
    try {
        const fuente = ctx.createMediaElementSource(video);
        const ganancia = ctx.createGain();
        const limite = ctx.createDynamicsCompressor();
        limite.threshold.value = -3;
        limite.knee.value = 0;
        limite.ratio.value = 20;
        limite.attack.value = 0.003;
        limite.release.value = 0.25;
        fuente.connect(ganancia);
        ganancia.connect(limite);
        limite.connect(ctx.destination);
        const nodo = { fuente, ganancia, limite };
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
    // El grafo va siempre, porque nivelar la clase YA es pasar del 100%: el
    // material está veinte dB abajo y `video.volume` topa en 1. Antes se armaba
    // solo al subir el deslizador, cuando lo único que se perdía sin él era el
    // tramo de arriba; ahora, sin grafo, la clase se oiría como venía del
    // Rodecaster, o sea inaudible.
    for (const video of videos || []) {
        const suena = video === principal;
        const nodo = nodoDe(video);
        if (nodo) {
            estado.porGrafo = true;
            // Con el grafo puesto, el elemento queda en 1 y todo el nivel lo
            // pone la ganancia: son dos atenuaciones en cadena y multiplicarlas
            // daría un volumen que no es el que dice el número.
            video.volume = 1;
            nodo.ganancia.gain.value = suena ? gananciaDe(porcentaje, estado.nivelado) : 0;
        } else {
            // Sin Web Audio no hay nivelado posible: el elemento no pasa de 1.
            // Se oye bajo, que es peor, pero se oye.
            video.volume = suena ? volumenDelElemento(porcentaje) : 0;
        }
    }
}

/**
 * El nivelado de la clase que se abrió.
 *
 * Lo pone el reproductor con los picos que ya vinieron con la revisión. Va por
 * clase: cada una se grabó con su propio nivel, y el curso tiene 4,5 dB de
 * diferencia entre la más fuerte y la más floja.
 */
export function ponerNivelado(picos) {
    estado.nivelado = niveladoDe(picos);
    pintar();
    return estado.nivelado;
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
        // Cuánto se levantó esta clase. Va acá porque es lo que explica que dos
        // clases suenen distinto con el deslizador en el mismo lugar, y sin
        // asomarlo no hay forma de verificarlo salvo escuchando y opinando.
        nivelado: estado.nivelado,
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
    // Cuánto se levantó la clase, dicho en dB porque es la unidad en la que se
    // habla de nivel. No es un detalle de implementación: explica por qué esta
    // clase se oye distinto de la anterior con el deslizador en el mismo lugar.
    const dB = Math.round(20 * Math.log10(estado.nivelado));
    $('player-volumen').title = (saturando
        ? `Volumen ${porcentaje}% · arriba del 100% el audio puede recortar`
        : `Volumen ${porcentaje}%`)
        + (dB > 0 ? `\nEsta clase se grabó baja: va levantada +${dB} dB` : '')
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
