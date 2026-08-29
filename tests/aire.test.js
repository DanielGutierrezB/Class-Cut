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
const speech = require('../engine/speech-edges');
const aire = require('../engine/aire');

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

    t.group('el mapa de voz sin las migas');

    /** Los ocho tramos que el mapa reporta en los nueve segundos mudos de la clase 13. */
    const MIGAS_CLASE_13 = [
        [118.50, 118.64], [123.12, 123.18], [123.24, 123.30], [124.60, 124.66],
        [125.18, 125.24], [125.30, 125.40], [127.12, 127.40], [127.84, 128.02]
    ];

    t.test('un crujido de sala no es una sílaba', () => {
        // El caso que costó el arreglo: preguntarle al mapa "¿suena algo?"
        // contesta que sí a medio segundo del IN, y con esa respuesta el borde se
        // mueve 0,5 s y los nueve segundos de aire quedan igual.
        const voz = { tramos: MIGAS_CLASE_13 };
        t.eq(speech.suenaEntre(voz, 118, 127, 30), true,
            'el mapa crudo dice que sí, y por eso no alcanza');
        t.deep(speech.vozSostenida(voz).map(([a]) => a), [127.12],
            'con el filtro queda solo el tramo de 280 ms');
    });

    t.test('el arranque del sonido es el primer tramo sostenido', () => {
        const voz = { tramos: MIGAS_CLASE_13 };
        t.near(speech.arranqueDelSonido(voz, 118, 141), 127.12, 0.01);
        t.eq(speech.arranqueDelSonido({ tramos: MIGAS_CLASE_13.slice(0, 6) }, 118, 141), null,
            'si todo son migas, nadie habla');
        t.eq(speech.arranqueDelSonido(null, 118, 141), null, 'sin mapa no se afirma nada');
    });

    t.test('hablando encima del corte, el arranque es el corte', () => {
        // Cuando el tramo de voz ARRANCA antes del IN y sigue después, ningún
        // comienzo de tramo cae adentro del bloque. Contestar "acá no habla
        // nadie" sería inventar un hueco justo donde hay voz continua.
        t.near(speech.arranqueDelSonido({ tramos: [[9, 20]] }, 10, 30), 10, 0.001);
    });

    t.group('los huecos de aire de un bloque');

    t.test('mide el hueco del arranque y el del medio', () => {
        const voz = { tramos: [[0, 1], [8, 9], [20, 25]] };
        const huecos = speech.huecosDeAire(voz, 0, 25);
        t.eq(huecos.length, 2);
        t.deep(huecos.map(h => [h.largoSec, h.alAbrir]), [[7, false], [11, false]],
            'el de 1→8 y el de 9→20; ninguno abre porque en 0 ya se habla');
    });

    t.test('el hueco del arranque se marca como tal', () => {
        const huecos = speech.huecosDeAire({ tramos: [[9.12, 25]] }, 0, 25);
        t.eq(huecos.length, 1);
        t.eq(huecos[0].alAbrir, true);
        t.near(huecos[0].largoSec, 9.12, 0.01);
    });

    t.test('el aire del final también se ve', () => {
        // No pasa en el curso entregado —los catorce huecos son al abrir o
        // adentro— y se mide igual: es el mismo defecto visto desde el otro
        // borde, y no verlo sería dejar el agujero medio tapado.
        const huecos = speech.huecosDeAire({ tramos: [[0, 20]] }, 0, 26);
        t.eq(huecos.length, 1);
        t.eq(huecos[0].alCerrar, true);
        t.near(huecos[0].largoSec, 6, 0.01);
    });

    t.test('una pausa del profesor no es aire muerto', () => {
        // El listón de cinco segundos: por debajo entran sus pausas, y el hueco
        // de 3,34 s con que abre el bloque 14 de la clase 2 renderizado suena
        // «Déjamelo en los comentarios y luego le damos», o sea clase.
        t.deep(speech.huecosDeAire({ tramos: [[3.34, 20]] }, 0, 20), []);
    });

    t.test('sin mapa de voz no se contesta que no hay huecos', () => {
        // Un array vacío se lee "medido y limpio"; null se lee "no se pudo
        // medir". Son cosas opuestas y las dos veces el número es cero.
        t.eq(speech.huecosDeAire(null, 0, 25), null);
        t.eq(speech.huecosDeAire({ tramos: [] }, 0, 25), null);
    });

    t.group('aire · en pantalla el hueco es la clase');

    function bloque(startSec, endSec, view) {
        return {
            index: 0, view, startSec, endSec,
            in: { kind: 'IN', originalSec: startSec, alignedSec: startSec, timeSec: startSec },
            out: { kind: 'OUT', originalSec: endSec, alignedSec: endSec, timeSec: endSec }
        };
    }

    t.test('el hueco de ADENTRO es defecto en cámara y no en pantalla', () => {
        // La medición que decidió esto: de los catorce huecos del curso, los ocho
        // de vista R son el profesor tipeando o esperando a una herramienta —el
        // de 13,46 s de la clase 7 bloque 5 renderizado suena «Para»— y los seis
        // de vista PV son, los seis, tomas que se abandonaron.
        const voz = { tramos: [[0, 5], [21, 25]] };
        t.eq(aire.huecos(bloque(0, 25, 'PV'), voz).length, 1, 'en cámara, defecto');
        t.deep(aire.huecos(bloque(0, 25, 'R'), voz), [], 'en pantalla, la clase');
        t.eq(aire.huecos(bloque(0, 25), voz).length, 1, 'sin vista se mide, que es lo prudente');
    });

    t.test('el hueco AL ABRIR es defecto en las dos vistas', () => {
        // Lo que hace legítimo el silencio en un bloque de pantalla es que el
        // profesor esté trabajando y el alumno mirando, y eso pasa durante la
        // clase. Un bloque que abre sobre aire todavía no empezó.
        const voz = { tramos: [[15.9, 25]] };
        t.eq(aire.huecos(bloque(0, 25, 'R'), voz).length, 1);
        t.ok(aire.abreSobreAire(bloque(0, 25, 'R'), voz), 'y se arregla igual');
    });

    t.test('sin mapa de voz tampoco se afirma nada', () => {
        t.eq(aire.huecos(bloque(0, 25, 'PV'), null), null);
    });

    t.group('aire · qué mueve el IN y qué no');

    t.test('el hueco del arranque, sí', () => {
        // La forma del bloque 1 de la clase 13 y del 8 de la clase 7.
        const b = bloque(0, 25, 'PV');
        const hallazgo = aire.abreSobreAire(b, { tramos: [[9.12, 25]] });
        t.ok(hallazgo, 'lo vio');
        t.eq(hallazgo.alAbrir, true);
        t.near(hallazgo.hastaSec, 9.12, 0.01, 'y apunta a donde se empieza a hablar');
    });

    t.test('el hueco del medio, no', () => {
        // Los doce huecos internos se avisan y no se cortan: en el único que
        // quedaría sin arreglo —clase 2 bloque 4— el silencio es lo que separa
        // tres arrancadas fallidas de la misma frase, y pegar los bordes vuelve
        // audible la repetición.
        const b = bloque(0, 25, 'PV');
        t.eq(aire.abreSobreAire(b, { tramos: [[0, 8], [20, 25]] }), null);
        t.eq(aire.huecos(b, { tramos: [[0, 8], [20, 25]] }).length, 1,
            'pero medido y contado sigue estando');
    });

    t.test('un bloque entero mudo no se arregla moviendo el IN', () => {
        // Mover el borde no le pone contenido: eso es un bloque que no tiene
        // nada, y lo tiene que ver una persona.
        const b = bloque(0, 25, 'PV');
        t.eq(aire.abreSobreAire(b, { tramos: [[40, 50]] }), null);
    });

    t.test('no se abre tan tarde que no quede bloque', () => {
        // 25,5 → 27 son 1,5 s de clase: mover el IN ahí deja un bloque que no se
        // puede ver. Se avisa y se deja como está.
        const b = bloque(0, 27, 'PV');
        const voz = { tramos: [[25.5, 27]] };
        const hallazgo = aire.buscarEnBloque([], b, voz, { fps: 30 });
        t.ok(hallazgo, 'el hueco existe');
        t.eq(aire.aplicar({ block: b, hallazgo, words: [], wav: null, voz, options: { fps: 30 } }), null,
            'y no se aplica');
        t.eq(b.startSec, 0, 'el bloque quedó intacto');
    });

    t.test('el IN no cruza el piso de la claqueta', () => {
        // La claqueta es el peor defecto que existe y su piso lo respeta todo el
        // mundo. Acá el destino está DESPUÉS del piso, así que lo que se prueba
        // es que la guarda no deshaga un movimiento legítimo.
        const b = bloque(0, 25, 'PV');
        const voz = { tramos: [[9.12, 25]] };
        const hallazgo = aire.buscarEnBloque([], b, voz, { fps: 30 });
        const nuevo = aire.aplicar({
            block: b, hallazgo, words: [], wav: null, voz, options: { fps: 30, pisoSec: 5 }
        });
        t.ok(nuevo != null, 'se movió');
        t.near(b.startSec, 9.12, 0.05);
        t.ok(b.startSec >= 5, 'y quedó del lado bueno del piso');
    });

    t.test('mover el IN deja el bloque sin aire al abrir', () => {
        const b = bloque(0, 25, 'PV');
        const voz = { tramos: [[9.12, 25]] };
        const hallazgo = aire.buscarEnBloque([], b, voz, { fps: 30 });
        aire.aplicar({ block: b, hallazgo, words: [], wav: null, voz, options: { fps: 30 } });
        t.eq(aire.abreSobreAire(b, voz), null, 'el defecto se fue');
        t.deep(aire.huecos(b, voz), [], 'y no dejó otro');
    });

    t.test('el hueco que no se corta igual se avisa', () => {
        // Es la mitad del trabajo: doce de los catorce huecos del curso están en
        // el medio del bloque y la regla no los toca a propósito. Si tampoco se
        // dijeran, el editor tendría que volver a encontrarlos escuchando, que es
        // de dónde salió este arreglo.
        const b = bloque(0, 40, 'PV');
        const res = aire.quitarAire({
            alignResult: { blocks: [b] }, words: [], wav: null,
            voz: { tramos: [[0, 8], [15, 16], [23, 40]] }, options: { fps: 30 }
        });
        t.eq(res.stats.movidos, 0, 'no se movió nada');
        t.eq(res.quedan.length, 1, 'y el bloque queda avisado');
        t.eq(res.quedan[0].huecos.length, 2);
        t.near(res.quedan[0].totalSec, 14, 0.1);
    });

    t.test('el hueco que sí se corta no se avisa dos veces', () => {
        const b = bloque(0, 25, 'PV');
        const res = aire.quitarAire({
            alignResult: { blocks: [b] }, words: [], wav: null,
            voz: { tramos: [[9.12, 25]] }, options: { fps: 30 }
        });
        t.eq(res.stats.movidos, 1);
        t.deep(res.quedan, [], 'ya no hay nada que avisar');
    });

    t.group('defectos · el aire muerto se cuenta');

    t.test('un bloque de cámara con un hueco de trece segundos deja de medir cero', () => {
        // Es el agujero que estaba escrito en la cabecera de `defectos.js`: las
        // otras nueve comprobaciones miran PALABRAS, y un bloque puede tener
        // trece segundos de nada con todas sus palabras "bien" puestas.
        const b = bloque(0, 25, 'PV');
        const fallas = defectos.revisarBloque([], b, null, { tramos: [[0, 5], [18, 25]] });
        const deAire = fallas.filter(([tipo]) => tipo === 'aire');
        t.eq(deAire.length, 1, 'lo vio');
        t.ok(/13s/.test(deAire[0][1]), `y dice cuánto: «${deAire[0][1]}»`);
    });

    t.test('un bloque con dos huecos es un bloque, no dos', () => {
        // La unidad de la vara es el bloque —el porcentaje sale sobre los 170— y
        // la forma del bloque 4 de la clase 2, con sus dos huecos de 6,9 s, tiene
        // que contar una vez.
        const b = bloque(0, 40, 'PV');
        const voz = { tramos: [[0, 8], [15, 16], [23, 40]] };
        const fallas = defectos.revisarBloque([], b, null, voz).filter(([tipo]) => tipo === 'aire');
        t.eq(fallas.length, 1);
        t.ok(/2 huecos/.test(fallas[0][1]), `y lo dice: «${fallas[0][1]}»`);
    });

    t.test('en pantalla no se cuenta, y por eso el renglón sirve', () => {
        // Contarlo pondría ocho defectos permanentes que nadie debería arreglar,
        // y un renglón que nunca puede llegar a cero deja de ser un objetivo.
        const b = bloque(0, 25, 'R');
        t.deep(defectos.revisarBloque([], b, null, { tramos: [[0, 5], [18, 25]] })
            .filter(([tipo]) => tipo === 'aire'), []);
    });
};
