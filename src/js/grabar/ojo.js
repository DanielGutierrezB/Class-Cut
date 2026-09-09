'use strict';
/**
 * ojo.js — Ver lo que está entrando por video. No se graba nada de esto.
 *
 * El hermano de `oido.js` para el otro cable. El Rodecaster Video entra por USB
 * y el sistema lo ve como una cámara más, así que mirar qué está mandando —o
 * hacia dónde apunta la del profesor— no debería obligar a abrir otra app al
 * lado justo mientras se toma nota.
 *
 * Lo que NO hace, y conviene decirlo primero: grabar. De acá no sale un archivo,
 * ni un cuadro que llegue al motor, ni nada que termine en el XML. Es un monitor
 * de referencia. La pantalla lo dice con todas las letras porque confundirlo con
 * una cámara que sí está grabando es un malentendido caro.
 *
 * **Con la vista cerrada, sin fuente elegida o fuera del paso Grabar no hay
 * ningún stream abierto.** No es una optimización: una cámara abierta y olvidada
 * se come batería y CPU justo en el momento en que la máquina no puede tener
 * nada de más corriendo, y encima deja su lucecita prendida en medio de una
 * clase, que es confuso para todos los que están en la sala. Esconder el
 * elemento con CSS o pausarlo no alcanza —el dispositivo sigue capturando—, así
 * que al cerrar se paran todas las pistas de verdad. La prueba de que está bien
 * hecho no es leer este archivo: es que la luz de la cámara se apague.
 *
 * A propósito NO se suelta cuando la ventana pasa a segundo plano. Se pensó
 * —ahorraría algo— y se descartó: la luz se prendería y se apagaría sola cada
 * vez que alguien cambia de app, y una luz que parpadea sin que nadie la toque
 * es peor que la que se queda quieta. Acá la luz significa exactamente una cosa:
 * la vista está abierta.
 */

import { $, anotar, recordado, recordar, toast } from '../chrome.js';

/**
 * Lo que la ventana recuerda de acá: qué fuente y si la vista quedó abierta.
 *
 * Las claves viven en este archivo y no con las de `index.js` porque quien las
 * escribe es el único que las lee, y así el estado del monitor se sigue leyendo
 * de un tirón. Es `localStorage`, como el resto de las preferencias de ventana.
 */
const FUENTE_RECORDADA = 'cc.grabar.video';
const ABIERTA_RECORDADA = 'cc.grabar.video.abierta';

/**
 * La opción que pide el permiso, cuando todavía no lo hay.
 *
 * Sin permiso de cámara el navegador contesta la lista sin ids y sin nombres
 * —no se puede ni distinguir una de otra— así que no hay nada que ofrecer más
 * que pedirlo. Es un valor imposible como id de dispositivo.
 */
const PEDIR = '?';

const estado = {
    fuente: recordado(FUENTE_RECORDADA) || '',
    abierta: recordado(ABIERTA_RECORDADA) === 'si',
    // Si el paso Grabar es el que se está viendo. Cambiar de pestaña suelta la
    // cámara: nadie puede estar mirando un monitor que no está en pantalla.
    enPantalla: false,
    /**
     * Por qué no se puede abrir ahora mismo: el dispositivo se desenchufó, o lo
     * tiene otra app. Con texto adentro no se vuelve a intentar, y eso es lo que
     * evita el bucle de pedirle cada segundo la cámara a algo que no está y
     * llenar la pantalla de carteles. Se limpia al refrescar o al cambiar de
     * fuente, que son los dos gestos con los que alguien dice "probá de nuevo".
     */
    caido: '',
    stream: null,
    // Un `getUserMedia` puede tardar un segundo largo; sin esto, dos gestos
    // seguidos abren dos veces y una de las dos cámaras queda sin dueño.
    abriendo: false,
    cableado: false
};

/* ─── Las dos cosas que se pueden probar sin navegador ──────────────────── */

/**
 * Qué corresponde hacer con el stream, mirando lo que se quiere y lo que hay.
 *
 * Es la regla entera de cuándo la cámara está prendida, en un solo lugar y sin
 * tocar nada: son cinco condiciones —hay fuente, la vista está abierta, el paso
 * está en pantalla, no está caído, y si ya hay stream— y con la decisión repartida
 * entre los cuatro sitios que la consultan alcanzaba con olvidarse de uno para
 * dejar la cámara prendida. Que sea pura es lo que permite probar los casos que
 * de otro modo piden desenchufar un cable a mano.
 *
 * @param {object} situacion `{fuente, abierta, enPantalla, caido, prendida}`
 * @returns {'abrir'|'soltar'|'nada'}
 */
export function queHacer(situacion) {
    const s = situacion || {};
    const quiere = Boolean(s.fuente) && Boolean(s.abierta) && Boolean(s.enPantalla) && !s.caido;
    if (quiere && !s.prendida) return 'abrir';
    if (!quiere && s.prendida) return 'soltar';
    return 'nada';
}

/**
 * Las cámaras que hay, de lo que conteste `enumerateDevices`.
 *
 * Se cuentan aparte las que vienen sin id: eso no es "no hay cámaras", es "hay
 * cámaras y todavía no tenemos permiso para saber cuáles". Los dos casos se ven
 * igual en la lista cruda y la pantalla tiene que decir cosas distintas — con
 * uno se ofrece pedir el permiso y con el otro no hay nada que ofrecer.
 *
 * Los repetidos se van: una cámara puede aparecer dos veces cuando el sistema la
 * ve por dos caminos, y en el selector queda como dos entradas idénticas de las
 * que ninguna se distingue de la otra.
 *
 * @returns {{lista: Array<{id: string, nombre: string}>, sinPermiso: number}}
 */
export function listar(dispositivos) {
    const vistos = new Set();
    const lista = [];
    let sinPermiso = 0;

    for (const d of dispositivos || []) {
        if (!d || d.kind !== 'videoinput') continue;
        if (!d.deviceId) { sinPermiso++; continue; }
        if (vistos.has(d.deviceId)) continue;
        vistos.add(d.deviceId);
        // Con permiso el nombre siempre viene; el respaldo numerado es para la
        // cámara que lo trae vacío, que sin él quedaría como una opción en blanco.
        lista.push({ id: d.deviceId, nombre: d.label || `Cámara ${lista.length + 1}` });
    }
    return { lista, sinPermiso };
}

/* ─── Abrir y soltar ────────────────────────────────────────────────────── */

/**
 * Parar la cámara de verdad.
 *
 * Las dos mitades hacen falta. Parar las pistas es lo que apaga el dispositivo y
 * su luz; soltar el `srcObject` es lo que hace que el elemento deje de tener el
 * stream agarrado —y de paso saca el último cuadro congelado, que quieto en
 * pantalla se lee como una cámara que sigue viva—.
 */
function soltar() {
    if (estado.stream) {
        for (const pista of estado.stream.getTracks()) {
            // Primero el aviso: parar una pista dispara su `onended`, y sin esto
            // apagar la vista a mano se anunciaría como un desenchufe.
            pista.onended = null;
            pista.stop();
        }
    }
    estado.stream = null;
    const pantalla = $('grabar-ojo-video');
    if (pantalla) pantalla.srcObject = null;
}

/** El dispositivo dejó de estar. Se suelta lo que quede y no se reintenta. */
function seCayo(por) {
    soltar();
    estado.caido = por;
    anotar('grabar.ojo-caido', { por });
    pintar();
}

async function abrir() {
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                deviceId: { exact: estado.fuente },
                // Un monitor de referencia no necesita 1080p60: se mira de reojo
                // para saber si entra imagen y hacia dónde apunta. Pedir menos es
                // menos CPU en el momento en que menos sobra. `ideal` y no `max`
                // porque una cámara que no sepa dar exactamente esto tiene que
                // abrirse igual: acá ningún número es un requisito.
                width: { ideal: 640 },
                frameRate: { ideal: 15 }
            }
        });
    } catch (e) {
        seCayo('No se pudo abrir esa entrada de video: ' + e.message);
        return;
    }

    estado.stream = stream;

    // Entre el pedido y la respuesta pasa un segundo largo, y en ese segundo se
    // pudo cerrar la vista, cambiar de fuente o irse a otro paso. Si ya no se
    // quiere, se suelta acá mismo: si no, queda prendida una cámara que nadie
    // pidió y a la que ya no la va a apagar nadie, porque el gesto que la habría
    // apagado pasó cuando todavía no existía.
    if (queHacer({ ...estado, prendida: true }) === 'soltar') { soltar(); return; }

    // El USB se puede ir en cualquier momento, y con la vista abierta eso es una
    // pista que termina. Se avisa una vez y se deja de intentar.
    for (const pista of stream.getTracks()) {
        pista.onended = () => seCayo('Se desconectó la entrada de video. Enchufala y apretá «Refrescar».');
    }
    $('grabar-ojo-video').srcObject = stream;
}

/** Deja el mundo como dice `queHacer`, y repinta. */
async function sincronizar() {
    if (estado.abriendo) return;
    const que = queHacer({ ...estado, prendida: Boolean(estado.stream) });

    if (que === 'soltar') soltar();
    if (que === 'abrir') {
        estado.abriendo = true;
        try { await abrir(); } finally { estado.abriendo = false; }
    }
    pintar();
}

/* ─── La lista y el permiso ─────────────────────────────────────────────── */

/**
 * Pedir la cámara, que es lo único que destraba los nombres.
 *
 * Sin permiso `enumerateDevices` contesta las cámaras sin id y sin nombre, así
 * que no hay lista posible hasta que alguien conceda. Es el mismo camino que
 * `oido.js` hace para el micrófono, con una diferencia que importa: acá NO se
 * pide al entrar al paso. Una app que enciende la cámara sola apenas se abre es
 * invasiva, y en macOS le pone el aviso del sistema en la cara a alguien que
 * venía a tomar notas. Se pide cuando el usuario elige una fuente, que es el
 * momento en que lo pidió él.
 *
 * Abre la cámara por defecto un instante para conseguirlo y la suelta enseguida:
 * es un parpadeo de la luz y es el precio de saber cómo se llama cada una.
 */
async function pedirPermiso() {
    let previo;
    try {
        previo = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (e) {
        toast('No se pudo acceder a la cámara: ' + e.message);
        return false;
    }
    for (const pista of previo.getTracks()) pista.stop();
    return true;
}

/** Las cámaras que hay. No pide permiso: solo mira lo que se pueda ver. */
async function fuentes() {
    try {
        return listar(await navigator.mediaDevices.enumerateDevices());
    } catch (e) {
        toast('No se pudo preguntar qué entradas de video hay: ' + e.message);
        return { lista: [], sinPermiso: 0 };
    }
}

/**
 * Llena el selector y deja `estado.fuente` en algo que exista de verdad.
 *
 * La elegida se mantiene si sigue apareciendo. Si se fue, se limpia: dejarla
 * puesta apuntando a un dispositivo que no está es lo que hace que la app
 * insista sola contra el vacío.
 */
async function llenar() {
    const select = $('grabar-video');
    const { lista, sinPermiso } = await fuentes();
    select.textContent = '';

    // Siempre primero y siempre presente: es la forma de decir "ninguna", y
    // elegirla es el gesto con el que se apaga la cámara desde el selector.
    const ninguna = document.createElement('option');
    ninguna.value = '';
    ninguna.textContent = lista.length || sinPermiso ? 'Ninguna' : 'No hay entradas de video';
    select.append(ninguna);

    if (!lista.length && sinPermiso) {
        const permiso = document.createElement('option');
        permiso.value = PEDIR;
        permiso.textContent = 'Permitir la cámara para ver cuáles hay…';
        select.append(permiso);
    }
    for (const fuente of lista) {
        const op = document.createElement('option');
        op.value = fuente.id;
        op.textContent = fuente.nombre;
        select.append(op);
    }

    if (!lista.some(f => f.id === estado.fuente)) estado.fuente = '';
    select.value = estado.fuente;
    return { lista, sinPermiso };
}

/* ─── La pantalla ───────────────────────────────────────────────────────── */

function pintar() {
    const hay = Boolean(estado.fuente);
    const mirando = hay && estado.abierta;

    const ver = $('grabar-ojo-ver');
    ver.disabled = !hay;
    ver.textContent = mirando ? 'Ocultar vista' : 'Ver vista';
    ver.setAttribute('aria-pressed', String(mirando));
    ver.title = !hay
        ? 'Elegí una entrada de video y después se puede desplegar la vista.'
        : (mirando
            ? 'Cerrar la vista y soltar la cámara: se apaga su luz.'
            : 'Desplegar la vista. Es solo para mirar: no se graba nada de esto.');

    $('grabar-ojo').hidden = !mirando;
    const nota = $('grabar-ojo-nota');
    nota.hidden = !estado.caido;
    nota.textContent = estado.caido;
    // Con la cámara caída el elemento se va: lo que quedaría es su último cuadro
    // congelado, que dice justo lo contrario de lo que pasó.
    $('grabar-ojo-video').hidden = Boolean(estado.caido);
}

/** Elegir una fuente en el selector. El `?` es pedir permiso, no una cámara. */
async function elegir(valor) {
    if (valor === PEDIR) {
        const dio = await pedirPermiso();
        // Con el permiso dado la lista pasa a tener nombres e ids. La primera
        // queda elegida porque elegir "permitir" era querer ver algo, y volver a
        // dejarlo en "Ninguna" sería pedir dos gestos para una sola intención.
        const { lista } = await llenar();
        if (!dio) { pintar(); return; }
        estado.fuente = lista.length ? lista[0].id : '';
        $('grabar-video').value = estado.fuente;
    } else {
        estado.fuente = valor;
    }
    // Cambiar de fuente es decir "probá con esta": lo que hubiera fallado antes
    // era de la anterior.
    estado.caido = '';
    recordar(FUENTE_RECORDADA, estado.fuente);
    anotar('grabar.ojo-fuente', { hay: Boolean(estado.fuente) });
    await sincronizar();
}

/** Abrir o cerrar la vista. Cerrar suelta la cámara; no la esconde. */
async function alternar(abierta) {
    estado.abierta = abierta;
    estado.caido = abierta ? '' : estado.caido;
    recordar(ABIERTA_RECORDADA, abierta ? 'si' : 'no');
    anotar('grabar.ojo', { abierta });
    await sincronizar();
}

/* ─── El enganche ───────────────────────────────────────────────────────── */

/** Se cablea una vez, con el resto del paso. */
export function cablear() {
    if (estado.cableado) return;
    estado.cableado = true;

    $('grabar-video').onchange = e => elegir(e.target.value);
    $('grabar-ojo-ver').onclick = () => alternar(!estado.abierta);
    $('grabar-ojo-cerrar').onclick = () => alternar(false);

    /**
     * Irse del paso Grabar también suelta la cámara.
     *
     * Se mira la clase de la vista en vez de engancharse a quien navega porque a
     * `showView` la llaman cinco pantallas y ninguna tiene por qué acordarse de
     * avisarle al monitor. Acá el que se entera es el que tiene algo que apagar,
     * y la regla no se puede olvidar en el paso que se agregue mañana.
     */
    const paso = $('view-grabar');
    new MutationObserver(() => {
        const visible = paso.classList.contains('is-visible');
        if (visible === estado.enPantalla) return;
        estado.enPantalla = visible;
        sincronizar();
    }).observe(paso, { attributes: true, attributeFilter: ['class'] });

    // Cerrar la ventana. El proceso se lleva la cámara puesta, pero la luz tarda
    // en apagarse lo que tarde el sistema en darse cuenta; soltarla acá la apaga
    // en el momento, que es lo que alguien mirando la cámara espera ver.
    window.addEventListener('pagehide', soltar);
}

/** Entrar al paso. No pide la cámara: solo mira qué hay y restaura lo de antes. */
export async function alEntrar() {
    // Se mira la pantalla en vez de creerle a quien llama, y no es lo mismo:
    // entrar al paso son varios `await` —las carpetas, las clases del disco— y
    // en ese rato se puede haber navegado a otro lado. Dando por sentado que
    // seguimos acá, la cámara se abría en un paso que ya nadie estaba mirando y
    // se quedaba prendida, porque el gesto que la habría apagado ya había pasado.
    estado.enPantalla = $('view-grabar').classList.contains('is-visible');
    await llenar();
    await sincronizar();
}

/**
 * "Refrescar", el mismo botón que las entradas de audio: volver a preguntar.
 *
 * Es también la salida del estado caído. Una cámara que se desenchufó y se
 * volvió a enchufar vuelve a estar disponible, y este es el gesto con el que se
 * dice "probá de nuevo" — el mismo con el que aparece el Rodecaster que se
 * enchufó minutos antes de grabar.
 */
export async function refrescar() {
    estado.caido = '';
    await llenar();
    await sincronizar();
}
