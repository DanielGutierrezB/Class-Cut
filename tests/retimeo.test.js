'use strict';
/**
 * Que las palabras caigan donde está el sonido, y no donde Whisper dijo.
 *
 * Los dos casos que se prueban son los dos que rompen el karaoke en el material
 * real, con los números de la clase 1 del curso de spec-driven:
 *
 *   - la tirada amontonada: "Y el código es" empezando las cuatro en 271,51;
 *   - la tirada estirada sobre el silencio: "Es una aplicación web" ocupando 18
 *     de los 31 segundos del bloque 8 porque el audio arranca con un "3, 2, 1."
 *     que el plan no contempla.
 *
 * Lógica pura: el mapa de voz entra como dato, así que no hace falta ningún WAV.
 */

const retimeo = require('../engine/retimeo');
const voz = require('../engine/voz');

/** Un mapa de voz de mentira, con el mismo hop que el de verdad. */
function mapa(tramos) {
    return { hopSec: 0.02, tramos };
}

module.exports = async t => {
    t.group('cuánto se tarda en decir una palabra');

    t.test('pesa más la palabra más larga', () => {
        t.ok(retimeo.peso('especificación') > retimeo.peso('de'));
    });

    t.test('la puntuación no cuenta como letra', () => {
        t.eq(retimeo.peso('web'), retimeo.peso('web,'));
        t.eq(retimeo.peso('web'), retimeo.peso('¿web?'));
    });

    t.test('los acentos tampoco', () => {
        t.eq(retimeo.peso('codigo'), retimeo.peso('código'));
    });

    t.group('dónde queda tanto sonido');

    const pedazos = [[10, 10.5], [12, 12.5], [20, 21]];

    t.test('adentro del primer pedazo se cuenta derecho', () => {
        t.near(retimeo.cuando(pedazos, 0.2), 10.2, 0.001);
    });

    t.test('el silencio no reparte: se salta entero', () => {
        // Medio segundo de sonido termina el primer pedazo; lo que sigue arranca
        // en el segundo, no en el 10,5. Es todo el truco del re-timeo.
        t.near(retimeo.cuando(pedazos, 0.6), 12.1, 0.001);
    });

    t.test('yendo para atrás, igual', () => {
        // 0,3 s de sonido antes del 21 son 0,3 s adentro del último pedazo.
        t.near(retimeo.retroceder(pedazos, 21, 0.3), 20.7, 0.001);
        // Y 1,2 s se comen el último pedazo entero y siguen en el anterior.
        t.near(retimeo.retroceder(pedazos, 21, 1.2), 12.3, 0.001);
    });

    t.group('las tiradas amontonadas en un instante');

    // El caso real, recortado: cuatro palabras empezando todas en 271,51 y una
    // quinta que se quedó con el tiempo de las cuatro.
    const amontonadas = [
        { start: 271.51, end: 271.51, text: 'Y' },
        { start: 271.51, end: 271.51, text: 'el' },
        { start: 271.51, end: 271.51, text: 'código' },
        { start: 271.51, end: 271.59, text: 'es' },
        { start: 271.59, end: 272.27, text: 'simplemente' }
    ];
    const ondaAmontonadas = mapa([
        [271.50, 271.60], [271.71, 271.98], [272.03, 272.23], [272.25, 272.27]
    ]);

    t.test('ninguna palabra queda sin durar', () => {
        // Una palabra que empieza y termina en el mismo instante es una que el
        // panel no alumbra NUNCA: la aguja le pasa por encima sin verla.
        const r = retimeo.retimear(amontonadas, ondaAmontonadas);
        t.eq(r.stats.ceroAntes, 3);
        t.eq(r.stats.ceroDespues, 0);
        for (const p of r.palabras) t.ok(p.end > p.start, `"${p.text}" no dura nada`);
    });

    t.test('quedan en orden y sin pisarse', () => {
        const r = retimeo.retimear(amontonadas, ondaAmontonadas);
        for (let i = 1; i < r.palabras.length; i++) {
            t.ok(r.palabras[i].start >= r.palabras[i - 1].start,
                `"${r.palabras[i].text}" arranca antes que la anterior`);
        }
    });

    t.test('el reparto respeta cuánto tarda cada una', () => {
        // "código" tiene que ocupar más que "el": es lo único que hace que el
        // resaltado no vaya a los tumbos dentro de una frase.
        const r = retimeo.retimear(amontonadas, ondaAmontonadas);
        const dura = i => r.palabras[i].end - r.palabras[i].start;
        t.ok(dura(2) > dura(1), '"código" tendría que durar más que "el"');
    });

    t.group('las tiradas estiradas sobre el silencio');

    // El bloque 8: cuatro palabras repartidas sobre 18 s de los que solo suena
    // el final. Ninguna dura cero, así que mirar duraciones cero no lo ve.
    const estiradas = [
        { start: 1103.63, end: 1105.87, text: 'Es' },
        { start: 1105.87, end: 1108.78, text: 'una' },
        { start: 1108.78, end: 1119.41, text: 'aplicación' },
        { start: 1119.41, end: 1121.48, text: 'web' },
        { start: 1121.48, end: 1121.70, text: 'que' }
    ];
    // Lo que el micrófono registró de verdad en esos 18 segundos: nada durante
    // trece, después el "3, 2, 1." que no está en el transcript, y recién al
    // final "Es una aplicación web".
    const ondaEstiradas = mapa([
        [1116.91, 1117.05], [1117.11, 1117.24], [1118.49, 1118.80], [1119.08, 1119.29],
        [1119.71, 1119.88], [1120.64, 1120.96], [1120.97, 1121.47], [1121.85, 1122.04]
    ]);

    t.test('las palabras salen de los trece segundos de silencio', () => {
        // "Es" figuraba arrancando en 1103,63, diecisiete segundos antes de que
        // se oyera nada. Queda cerca del sonido, no encima: el "3, 2, 1." que
        // suena ahí no está en el transcript, así que para el reparto es sonido
        // sin dueño y se lleva parte del reparto. Es el techo de este método —
        // corrige de diecisiete segundos a uno, no a cero.
        const r = retimeo.retimear(estiradas, ondaEstiradas);
        t.ok(r.palabras[0].start > 1119, `"Es" quedó en ${r.palabras[0].start}, todavía en el silencio largo`);
        t.ok(r.palabras[3].end <= 1121.48, '"web" no puede terminar después de donde terminaba');
    });

    t.test('ninguna se queda sonando sobre el silencio', () => {
        // Es lo que el editor ve como "el bloque dura la mitad del corte sin
        // decir nada": la palabra alumbrada no cambia durante diez segundos.
        const r = retimeo.retimear(estiradas, ondaEstiradas);
        for (const p of r.palabras.slice(0, 4)) {
            t.ok(p.end - p.start < 1, `"${p.text}" sigue durando ${(p.end - p.start).toFixed(2)}s`);
        }
    });

    t.test('el final de la última se respeta', () => {
        // Whisper acierta los finales —sesgo medido de 0 frames— y de ahí cuelga
        // todo el reparto. Moverlo sería tirar el único dato bueno que hay.
        const r = retimeo.retimear(estiradas, ondaEstiradas);
        t.near(r.palabras[3].end, 1121.47, 0.05);
    });

    t.group('cuándo NO hay que tocar nada');

    // Una tirada sana: las palabras caen sobre el sonido y duran lo que suenan.
    const sanas = [
        { start: 10.00, end: 10.30, text: 'hola' },
        { start: 10.30, end: 10.70, text: 'qué' },
        { start: 10.70, end: 11.00, text: 'tal' }
    ];
    const ondaSanas = mapa([[10.00, 10.28], [10.32, 10.68], [10.72, 11.00]]);

    t.test('una tirada sana se deja como vino', () => {
        // Los tiempos de Whisper son buenos casi siempre: medidos contra el
        // render del corte de la clase 1, el error mediano es de 0,13 s. Tocar
        // las sanas empeoraba la mediana a 0,31 s.
        const r = retimeo.retimear(sanas, ondaSanas);
        t.deep(r.palabras, sanas);
        t.eq(r.stats.rotas, 0);
    });

    t.test('sin mapa de voz no se inventa nada', () => {
        // Una clase sin Live-Mix legible tiene que seguir abriendo.
        t.deep(retimeo.retimear(sanas, null).palabras, sanas);
        t.deep(retimeo.retimear(sanas, mapa([])).palabras, sanas);
    });

    // El director hablando desde el fondo de la sala mide igual que el silencio:
    // Whisper lo oye y el mapa de voz no. No hay a dónde mover esas palabras.
    const lejos = () => [
        { start: 50, end: 50.0, text: 'Perdón,' },
        { start: 50, end: 53, text: 'pausa.' }
    ];

    t.test('donde el micrófono no registró nada, no se las manda a otro lado', () => {
        // Moverlas al sonido más cercano sería llevárselas a la frase de al
        // lado, que es un error peor que el que se está arreglando.
        const r = retimeo.retimear(lejos(), mapa([[10, 11]]));
        t.eq(r.stats.sinSonido, 1);
        for (const p of r.palabras) {
            t.ok(p.start >= 50 && p.end <= 53, `"${p.text}" se fue de su ventana`);
        }
    });

    t.test('pero si venían amontonadas igual se separan', () => {
        // Quedarse quietas dejaría a "Perdón," empezando y terminando en el
        // mismo instante, o sea sin alumbrarse nunca. Repartirlas sobre su
        // propia ventana es lo único que se sabe de ellas, y alcanza para que se
        // puedan seguir leyendo.
        const r = retimeo.retimear(lejos(), mapa([[10, 11]]));
        t.ok(r.palabras[0].end > r.palabras[0].start, '"Perdón," sigue sin durar nada');
        t.ok(r.palabras[1].start > r.palabras[0].start, 'las dos siguen arrancando juntas');
    });

    t.test('no se toca lo que entró', () => {
        // Las mismas palabras las lee después el anclaje de los comentarios.
        const copia = amontonadas.map(p => ({ ...p }));
        retimeo.retimear(amontonadas, ondaAmontonadas);
        t.deep(amontonadas, copia);
    });

    t.group('el mapa de voz');

    t.test('un tramo con sonido sale con sus segundos', () => {
        // Cuatro hops callados, seis sonando, cuatro callados: 0,08 → 0,20.
        const env = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
        t.deep(voz.tramosDe(env, 0.02, 0.5), [[0.08, 0.2]]);
    });

    t.test('una caída de un hop no parte una palabra en dos', () => {
        // Adentro de una vocal larga el nivel late y cae un hop: sin puentear,
        // una palabra sola pesaría por tres en el reparto.
        const env = [1, 1, 1, 0, 1, 1, 1];
        t.deep(voz.tramosDe(env, 0.02, 0.5), [[0, 0.14]]);
    });

    t.test('un clic suelto no es alguien hablando', () => {
        // El golpe de 20 ms en mitad del silencio del bloque 3: contándolo, la
        // cuenta regresiva se paraba encima del golpe en vez de encima del "3".
        t.deep(voz.tramosDe([0, 0, 1, 0, 0], 0.02, 0.5), []);
    });
};
