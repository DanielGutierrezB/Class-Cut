'use strict';
/**
 * Qué se puede afirmar del aire de un corte, y qué no.
 *
 * Existe por una confusión que costó una decisión de producto. `airFrames` es la
 * distancia entre el borde del sonido y el tiempo que traía el TRANSCRIPT, y se
 * venía leyendo como el aire del corte que sale. No es lo mismo: `evaluate` le
 * resta el colchón al borde, así que el corte que sale está SIEMPRE del lado del
 * silencio y `airFrames` negativo solo significa que la propuesta del transcript
 * estaba mal. Con esa lectura, decidir los cortes sobre los tiempos corregidos
 * contra la onda parecía multiplicar por cuatro los cortes a mitad de palabra
 * (4 → 15 sobre las trece clases del curso) y por eso el re-timeo se quedó
 * fuera del motor; medido como corresponde, los mismos dos planes dan 1 y 2.
 *
 * Así que acá se prueban las dos cosas: la invariante que hace imposible que
 * `airFrames` sea una vara de clipeo, y la vara que sí lo es.
 */

const onset = require('../engine/vendor/audio-onset');
const defectos = require('../tools/defectos');

/**
 * Una envolvente a mano: `[[desdeSec, hastaSec], …]` con sonido, el resto en
 * silencio. Los niveles son los que separa `stats`: piso bajo y voz alta.
 */
function envolvente(tramos, duracionSec, hopSec) {
    const hop = hopSec || 0.005;
    const env = new Array(Math.round(duracionSec / hop)).fill(0.001);
    for (const [a, b] of tramos) {
        for (let i = Math.round(a / hop); i < Math.round(b / hop) && i < env.length; i++) {
            env[i] = 0.5;
        }
    }
    return { env, hopSec: hop, windowStart: 0 };
}

module.exports = function (t) {
    t.group('audio-onset · el corte sale siempre del lado del silencio');

    t.test('el IN aplicado nunca pasa del borde del sonido, con colchón o sin él', () => {
        // Barrido: el borde en 10 s y el marcador cayendo por todos lados
        // alrededor, incluso pasado el sonido (que es el caso "airFrames
        // negativo"). En ninguno el corte puede quedar después del borde.
        for (let marcador = 9.0; marcador <= 11.0; marcador += 0.05) {
            const res = onset.evaluate({ time: 10, quietSec: 1.5 }, marcador, 'IN', { fps: 30 });
            t.ok(res.applyTime <= 10.001,
                `el IN quedó en ${res.applyTime} con el sonido arrancando en 10 (marcador ${marcador.toFixed(2)})`);
        }
    });

    t.test('el OUT aplicado nunca queda antes del borde del sonido', () => {
        for (let marcador = 9.0; marcador <= 11.0; marcador += 0.05) {
            const res = onset.evaluate({ time: 10, quietSec: 1.5 }, marcador, 'OUT', { fps: 30 });
            t.ok(res.applyTime >= 9.999,
                `el OUT quedó en ${res.applyTime} con el sonido terminando en 10 (marcador ${marcador.toFixed(2)})`);
        }
    });

    t.test('airFrames negativo es la propuesta mal puesta, no el corte adentro', () => {
        // El caso de la clase 4 bloque 5 del curso: airFrames -4,0 y el corte
        // aplicado con 5,4 frames de aire.
        const res = onset.evaluate({ time: 10, quietSec: 1.5 }, 10.133, 'IN', { fps: 30 });
        t.ok(res.airFrames <= -1, `airFrames tenía que dar negativo, dio ${res.airFrames}`);
        t.ok(res.applyTime < 10, 'y el corte, aire de verdad');
        t.near((10 - res.applyTime) * 30, 10, 1, 'el aire del corte es el colchón');
    });

    t.group('audio-onset · ¿hay alguien hablando en este frame?');

    t.test('adentro de un tramo de voz, sí; en el silencio, no', () => {
        const p = envolvente([[2, 4]], 6);
        const st = onset.stats(p.env, {});
        t.eq(onset.insideVoice(p, st.threshold, 3, { fps: 30 }), true, 'a mitad del sonido');
        t.eq(onset.insideVoice(p, st.threshold, 1, { fps: 30 }), false, 'antes');
        t.eq(onset.insideVoice(p, st.threshold, 5, { fps: 30 }), false, 'después');
    });

    t.test('pegarse al borde del sonido no es meterse dentro', () => {
        // El corte se escribe en frames, así que un frame de margen a cada lado
        // no es un defecto: es la resolución con la que se puede cortar. Sin el
        // margen, todos los cortes bien puestos —que caen justo en el borde—
        // contarían como cortes a mitad de palabra.
        const p = envolvente([[2, 4]], 6);
        const st = onset.stats(p.env, {});
        t.eq(onset.insideVoice(p, st.threshold, 2.02, { fps: 30 }), false, 'un frame adentro del arranque');
        t.eq(onset.insideVoice(p, st.threshold, 3.98, { fps: 30 }), false, 'un frame antes del final');
        t.eq(onset.insideVoice(p, st.threshold, 2.2, { fps: 30 }), true, 'seis frames adentro, sí');
    });

    t.test('un chasquido no es alguien hablando', () => {
        // 20 ms de sonido no llegan a `voiceMs`: es un golpe, un clic de mouse,
        // una silla. Contarlo como voz haría aparecer defectos donde no hay nadie.
        const p = envolvente([[2, 2.02]], 6);
        const st = onset.stats(p.env, {});
        t.eq(onset.insideVoice(p, st.threshold, 2.01, { fps: 30 }), false);
    });

    t.test('fuera de la ventana medida no se afirma nada', () => {
        const p = envolvente([[2, 4]], 6);
        const st = onset.stats(p.env, {});
        t.eq(onset.insideVoice(p, st.threshold, 30, { fps: 30 }), null);
        t.eq(onset.insideVoice(p, null, 3, { fps: 30 }), null, 'sin umbral tampoco');
    });

    t.group('defectos · la vara de "mitad de palabra"');

    t.test('lo que cuenta es el corte encima de la voz, no el airFrames', () => {
        t.eq(defectos.entraEnElSonido({ audio: { dentroDelSonido: true, airFrames: 12 } }), true,
            'con aire de sobra en la propuesta, pero el corte encima de alguien');
        t.eq(defectos.entraEnElSonido({ audio: { dentroDelSonido: false, airFrames: -4 } }), false,
            'el caso de la clase 4 bloque 5: la propuesta estaba mal y la onda la arregló');
    });

    t.test('sin la medición no se inventa un veredicto', () => {
        t.eq(defectos.entraEnElSonido({ audio: { dentroDelSonido: null } }), false);
        t.eq(defectos.entraEnElSonido({ audio: {} }), false, 'un plan de antes de que se midiera');
        t.eq(defectos.entraEnElSonido({}), false);
        t.eq(defectos.entraEnElSonido(null), false);
    });

    t.test('y se puede saber cuáles no traen medición', () => {
        // Un cero de "mitad de palabra" sobre bordes sin medir se lee como un
        // curso limpio, que es lo contrario de lo que pasó.
        t.eq(defectos.midioElSonido({ audio: { dentroDelSonido: false } }), true);
        t.eq(defectos.midioElSonido({ audio: { dentroDelSonido: null } }), false);
        t.eq(defectos.midioElSonido({ audio: { airFrames: -4 } }), false);

        const bloques = [
            { index: 0, startSec: 0, endSec: 10, in: { audio: { dentroDelSonido: false } }, out: { audio: {} } }
        ];
        t.eq(defectos.contarClase([], bloques).sinMedir, 1);
    });
};
