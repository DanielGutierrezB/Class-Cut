'use strict';
/**
 * oido.js — Abrir el micrófono y mandar el audio.
 *
 * La ventana es la única que puede abrir un dispositivo de audio
 * (`getUserMedia` vive acá), así que este archivo es la puerta: abre la entrada
 * elegida y manda el PCM al motor. De paso mide el nivel, que es lo único que
 * dice "está entrando audio" antes de que alguien hable.
 *
 * Encontrar el aplauso de la claqueta NO es de acá aunque las muestras pasen por
 * este archivo: la regla vive en `engine/golpe.js`, del lado que escribe el WAV.
 * Ahí se la puede probar pasándole el Live-Mix de una clase de verdad, y de este
 * lado solo se podía probar aplaudiendo delante del micrófono.
 *
 * **Se abre la entrada apenas se elige la fuente**, no al apretar "Iniciar
 * grabación", y el medidor se mueve desde ese momento. Es para poder ver que el
 * Rodecaster está llegando ANTES de comprometerse: descubrir que el cable estaba
 * en la entrada equivocada después de la primera toma es lo que esto evita.
 *
 * El audio, en cambio, se manda recién al apretar "Iniciar". No es una falta:
 * antes de ese botón no hay a qué referirlo —el cero del XML es ese botón, que
 * es el mismo con el que se pone a grabar el Rodecaster— y la claqueta llega
 * siempre después, entre siete y veinte segundos según las trece clases medidas.
 */

const CANAL_UNICO = 1;

const estado = {
    contexto: null,
    stream: null,
    nodo: null,
    fuente: null,
    dispositivo: null,
    sampleRate: 48000,
    // A quién avisarle. Lo pone la vista.
    alNivel: () => {},
    alCaerse: () => {},
    // El audio solo se manda cuando la grabación está armada; escuchar arranca
    // antes, para no perderse la claqueta.
    mandando: false
};

/**
 * Las entradas que hay.
 *
 * Hace falta pedir permiso antes: sin permiso, `enumerateDevices` devuelve los
 * dispositivos sin nombre y el selector queda con tres "Micrófono" iguales.
 */
export async function entradas() {
    try {
        const previo = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of previo.getTracks()) track.stop();
    } catch (e) {
        return { ok: false, error: 'No se pudo acceder al audio: ' + e.message, lista: [] };
    }
    const todos = await navigator.mediaDevices.enumerateDevices();
    const lista = todos
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, nombre: d.label || 'Entrada sin nombre' }));
    return { ok: true, lista };
}

/**
 * Abre una entrada y empieza a escuchar.
 *
 * Sin procesado de ninguna clase: el cancelador de eco, el control automático de
 * ganancia y el supresor de ruido están hechos para una llamada, y acá arruinan
 * las dos cosas que importan. El automático de ganancia sube el fondo en los
 * silencios, que es justo cuando la claqueta tiene que destacar; el supresor se
 * come los transitorios, que es lo que la claqueta ES.
 */
export async function abrir(deviceId, avisos) {
    await cerrar();
    Object.assign(estado, avisos || {});

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: CANAL_UNICO
            }
        });
    } catch (e) {
        return { ok: false, error: 'No se pudo abrir esa entrada: ' + e.message };
    }

    const contexto = new AudioContext();
    try {
        await contexto.audioWorklet.addModule('js/grabar/pcm-worklet.js');
    } catch (e) {
        await contexto.close();
        for (const t of stream.getTracks()) t.stop();
        return { ok: false, error: 'No cargó el capturador de audio: ' + e.message };
    }

    const fuente = contexto.createMediaStreamSource(stream);
    const nodo = new AudioWorkletNode(contexto, 'pcm-processor');
    nodo.port.onmessage = e => recibir(e.data);
    fuente.connect(nodo);
    // El nodo no va a los parlantes: conectarlo daría realimentación con el
    // micrófono abierto. Un `AudioWorkletNode` sin salida igual procesa.

    // Si el USB se va, el track avisa. Se enciende el estado rojo y nada de lo
    // escrito se pierde: el WAV tiene su cabecera al día y el reloj de pared
    // siguió andando, así que reconectar sigue donde estaba.
    for (const track of stream.getTracks()) {
        track.onended = () => estado.alCaerse();
    }

    Object.assign(estado, {
        contexto, stream, nodo, fuente,
        dispositivo: deviceId || 'por defecto',
        sampleRate: contexto.sampleRate
    });
    return { ok: true, sampleRate: contexto.sampleRate, canales: CANAL_UNICO };
}

/**
 * Un pedazo de PCM: se manda y se mide el nivel.
 *
 * Se manda PRIMERO. Si medir tirara una excepción, el audio ya salió — y lo que
 * se está grabando no se puede repetir.
 *
 * El nivel que se calcula acá es para el medidor y nada más. Quién decide si un
 * pedazo fue el aplauso de la claqueta es el motor (`engine/golpe.js`), que ve
 * este mismo audio al escribirlo: teniendo la regla de un solo lado se la puede
 * probar contra el Live-Mix de una clase de verdad, y de este lado solo se podía
 * probar aplaudiendo delante del micrófono.
 */
function recibir(muestras) {
    if (estado.mandando) window.cc.grabarPcm(muestras);

    let pico = 0;
    for (let i = 0; i < muestras.length; i++) {
        const v = Math.abs(muestras[i]) / 32768;
        if (v > pico) pico = v;
    }
    estado.alNivel(pico);
}

/** Desde acá se manda el audio al motor. Antes solo se escuchaba. */
export function empezarAMandar() { estado.mandando = true; }
export function dejarDeMandar() { estado.mandando = false; }

export function escuchando() { return Boolean(estado.contexto); }

/** Con qué se está capturando, que es lo que el WAV tiene que declarar. */
export function comoSuena() {
    return {
        dispositivo: estado.dispositivo,
        sampleRate: estado.sampleRate,
        canales: CANAL_UNICO
    };
}

export async function cerrar() {
    estado.mandando = false;
    if (estado.nodo) {
        estado.nodo.port.onmessage = null;
        try { estado.nodo.disconnect(); } catch (e) { /* ya estaba */ }
    }
    if (estado.fuente) { try { estado.fuente.disconnect(); } catch (e) { /* ya estaba */ } }
    if (estado.stream) {
        for (const track of estado.stream.getTracks()) { track.onended = null; track.stop(); }
    }
    if (estado.contexto) { try { await estado.contexto.close(); } catch (e) { /* ya estaba */ } }
    Object.assign(estado, { contexto: null, stream: null, nodo: null, fuente: null });
}

