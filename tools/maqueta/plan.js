'use strict';
/**
 * maqueta/plan.js — Cómo es la clase de mentira. Lo leen los dos lados.
 *
 * Existe por una razón concreta: el audio que se genera con ffmpeg y la silueta
 * que dibuja la interfaz tienen que venir del MISMO reparto de bloques. Si cada
 * lado tuviera el suyo, al reproducir se oiría silencio donde la onda muestra
 * sonido, y entonces cualquier cosa que se mire acá —el karaoke, la tira de
 * bloques, dónde cae un corte— parecería estar mal cuando lo que está mal es la
 * maqueta. Con un solo reparto, lo que se ve y lo que se oye son lo mismo.
 *
 * Se carga como módulo de Node (`tools/maqueta.js`, para armar el audio) y como
 * script del navegador (`window.maquetaPlan`, para el puente de mentira), que es
 * lo que pide tener un solo archivo sin un empaquetador de por medio.
 *
 * Las vistas entran por parámetro porque son del motor y no de la maqueta: en
 * Node se las pide directo y en el navegador llegan por `window.maquetaVistas`,
 * que `tools/maqueta.js` sirve copiadas de `engine/notas-vivo.js`. Es el único
 * `require` que este archivo puede tener y va acá, en la envoltura, porque del
 * otro lado no existe.
 */

(function (raiz, definir) {
    if (typeof module === 'object' && module.exports) module.exports = definir(require('../../engine/notas-vivo'));
    else raiz.maquetaPlan = definir(raiz.maquetaVistas);
})(typeof self !== 'undefined' ? self : this, function (vistas) {

    /** Lo que dura la grabación entera, en segundos. */
    const DURACION_SEC = 600;

    /**
     * Los bloques, con el hueco que dejan detrás.
     *
     * Los huecos son lo que se saca —el conteo, las repeticiones, las pausas— y
     * tienen que existir: sin ellos la onda es un rectángulo lleno, la lista de
     * silencios sale vacía y la barra del reproductor muestra una grabación
     * entera en vez de un corte, que es justo lo que hay que poder mirar.
     *
     * La variedad tampoco es de adorno. Hay bloques de confianza baja, notas del
     * que tomó apuntes y uno que queda fuera del corte, porque son los estados
     * que en el uso normal aparecen de a uno y nunca se ven juntos.
     */
    const BLOQUES = [
        { view: 'PV', dura: 62, hueco: 18, keep: true, confidence: 'alta', note: '', cueIn: '3, 2, 1.', cueOut: 'Pausa.' },
        { view: 'R', dura: 74, hueco: 12, keep: true, confidence: 'media', note: 'Cortar antes de "spec driven development"', cueIn: 'Retomamos.', cueOut: 'Pausa.' },
        { view: 'R', dura: 55, hueco: 25, keep: true, confidence: 'alta', note: '', cueIn: '3, 2, 1.', cueOut: '' },
        { view: 'PV', dura: 48, hueco: 9, keep: true, confidence: 'baja', note: 'Se repite, revisar', cueIn: '', cueOut: 'Pausa.' },
        { view: 'S', dura: 66, hueco: 14, keep: true, confidence: 'alta', note: '', cueIn: '3, 2, 1.', cueOut: 'Pausa.' },
        { view: 'PV', dura: 52, hueco: 20, keep: true, confidence: 'media', note: '', cueIn: 'Retomamos.', cueOut: '' },
        { view: 'R', dura: 58, hueco: 11, keep: false, confidence: 'alta', note: 'Acá tose, ver si se nota', cueIn: '', cueOut: 'Pausa.' },
        { view: 'X2', dura: 44, hueco: 0, keep: true, confidence: 'baja', note: '', cueIn: '3, 2, 1.', cueOut: '' }
    ];

    /**
     * Qué fuente usa cada vista: la del motor, no una copia.
     *
     * Acá había una tabla escrita a mano y mandaba `MG` y `X2` a la cámara,
     * mientras que la app las dejaba sin mapear. O sea que la maqueta enseñaba un
     * comportamiento que la app no tenía, que es lo único que no puede pasar acá:
     * lo que se mira para opinar del diseño tiene que ser lo que después se usa.
     */
    const VIEW_MAP = vistas.MAPA_DE_VISTAS;

    /** Dónde empieza la primera toma: lo de antes es la claqueta y el conteo. */
    const ARRANQUE_SEC = 8;

    const dosDecimales = n => Number(n.toFixed(2));

    /**
     * Los bloques con sus tiempos ya resueltos.
     *
     * `sourceStartSec`/`sourceEndSec` son segundos de la GRABACIÓN, y
     * `timelineStartSec`/`timelineEndSec` segundos del CORTE —los segundos del
     * corte solo existen para lo que se queda—. Es la misma distinción que hace
     * `engine/cutplan.js`, y confundirlas es el error clásico acá.
     */
    function segmentos() {
        const salida = [];
        let source = ARRANQUE_SEC;
        let linea = 0;

        BLOQUES.forEach((b, i) => {
            const sourceStartSec = dosDecimales(source);
            const sourceEndSec = dosDecimales(source + b.dura);
            salida.push({
                index: i,
                blockIndex: i,
                keep: b.keep,
                sourceStartSec,
                sourceEndSec,
                durationSec: dosDecimales(b.dura),
                timelineStartSec: b.keep ? dosDecimales(linea) : null,
                timelineEndSec: b.keep ? dosDecimales(linea + b.dura) : null,
                view: b.view,
                cameraIndex: VIEW_MAP[b.view],
                note: b.note,
                cueIn: b.cueIn,
                cueOut: b.cueOut,
                confidence: b.confidence,
                disabledReason: b.keep ? '' : 'Se repite entero en el bloque 8',
                problems: []
            });
            if (b.keep) linea += b.dura;
            source += b.dura + b.hueco;
        });
        return salida;
    }

    /** Los huecos: lo que queda fuera del corte, incluidas las puntas. */
    function removidos(segs) {
        const fuera = [];
        let cursor = 0;
        for (const s of segs) {
            if (s.sourceStartSec > cursor) fuera.push({ startSec: dosDecimales(cursor), endSec: s.sourceStartSec });
            cursor = s.sourceEndSec;
        }
        if (DURACION_SEC > cursor) fuera.push({ startSec: dosDecimales(cursor), endSec: DURACION_SEC });
        return fuera.map(t => ({ ...t, durationSec: dosDecimales(t.endSec - t.startSec) }));
    }

    /**
     * La silueta del audio, del mismo reparto del que sale el sonido.
     *
     * Alta donde hay bloque y casi plana en los huecos, con relieve adentro: una
     * onda de ruido parejo se dibuja igual de linda y no deja ver si el recorte
     * por bloque agarra el pedazo que dice agarrar.
     */
    function picos(segs, desdeSec, hastaSec, cuantos) {
        const salida = [];
        for (let i = 0; i < cuantos; i++) {
            const t = desdeSec + (hastaSec - desdeSec) * (i / cuantos);
            const dentro = segs.some(s => t >= s.sourceStartSec && t < s.sourceEndSec);
            const base = dentro ? 0.92 : 0.05;
            // Tres ritmos multiplicados, no sumados: multiplicar deja huecos
            // —cuando cualquiera de los tres pasa por cero, el resultado cae— y
            // eso es lo que hace que se parezca a alguien hablando en vez de a
            // un bloque macizo. El rápido son las sílabas, el medio las frases y
            // el lento el que sube y baja la voz a lo largo del rato.
            const silabas = Math.abs(Math.sin(t * 9.7));
            const frases = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.3 + 0.7));
            const aliento = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.23));
            salida.push(Number(Math.min(1, base * silabas * frases * aliento).toFixed(3)));
        }
        return salida;
    }

    return { DURACION_SEC, BLOQUES, VIEW_MAP, ARRANQUE_SEC, segmentos, removidos, picos };
});
