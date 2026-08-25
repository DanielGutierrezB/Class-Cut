'use strict';
/**
 * Alineación: la claqueta, la elección del desfase y las invariantes que ningún
 * bloque puede romper al salir.
 *
 * El material real vive en las clases del curso; acá se arman transcripts a mano
 * para poder provocar los casos que en el curso no pasan (claqueta inaudible,
 * bloques invertidos, tomas repetidas).
 */

const clapDetect = require('../engine/clap-detect');
const align = require('../engine/align');

/** Palabras con tiempos a partir de "texto" y un tiempo de inicio. */
function say(text, startSec, wordSec) {
    const step = wordSec || 0.4;
    return text.split(/\s+/).map((word, i) => ({
        text: word,
        start: Math.round((startSec + i * step) * 1000) / 1000,
        end: Math.round((startSec + i * step + step * 0.8) * 1000) / 1000
    }));
}

function block(index, startSec, endSec, cueIn, cueOut, view) {
    return {
        index,
        view: view || 'PV',
        note: '',
        complete: true,
        cueIn,
        cueOut,
        startSec,
        endSec,
        durationSec: endSec - startSec
    };
}

module.exports = function (t) {
    t.group('clap-detect · la claqueta hablada');

    t.test('reconoce "claqueta 4, clase 4"', () => {
        const words = say('claqueta 4, clase 4, listo', 10);
        const hit = clapDetect.findSpokenClap(words, 4);
        t.ok(hit, 'debería encontrarla');
        t.eq(hit.matchedNumber, 4);
        t.eq(hit.hasClaquetaWord, true);
        t.eq(hit.start, 10);
    });

    t.test('aguanta que whisper escriba "Cleta" o "Secleta"', () => {
        for (const deformada of ['Cleta', 'Secleta', 'Tecleta', 'claketa']) {
            const words = say(`${deformada} 4, clase 4`, 5);
            const hit = clapDetect.findSpokenClap(words, 4);
            t.ok(hit && hit.hasClaquetaWord, `no reconoció "${deformada}"`);
        }
    });

    t.test('reconoce el número escrito con palabras', () => {
        const words = say('claqueta cuatro, clase cuatro', 3);
        const hit = clapDetect.findSpokenClap(words, 4);
        t.ok(hit, 'debería encontrarla');
        t.eq(hit.matchedNumber, 4);
    });

    t.test('sin la palabra claqueta se ancla igual en "clase N"', () => {
        const words = say('bueno, clase 7, arrancamos', 2);
        const hit = clapDetect.findSpokenClap(words, 7);
        t.ok(hit, 'debería encontrarla');
        t.eq(hit.hasClaquetaWord, false);
    });

    t.test('prefiere la clase correcta sobre otra que aparezca antes', () => {
        const words = say('clase 3, no, perdón', 4).concat(say('claqueta 5, clase 5', 20));
        const hit = clapDetect.findSpokenClap(words, 5);
        t.eq(hit.matchedNumber, 5);
        t.eq(hit.start, 20);
    });

    t.test('no busca la claqueta en medio de la clase', () => {
        const words = say('claqueta 4, clase 4', 900);
        t.eq(clapDetect.findSpokenClap(words, 4), null);
    });

    t.test('sin claqueta el desfase es 0 y lo dice', () => {
        const result = clapDetect.detectClap({
            words: say('hola qué tal, empezamos', 1),
            classNumber: 4,
            markerSec: 8
        });
        t.eq(result.found, false);
        t.eq(result.offsetSec, 0);
        t.eq(result.confidence, 'baja');
        t.ok(/claqueta/i.test(result.reason));
    });

    t.test('sin audio se usa el arranque de la frase', () => {
        const result = clapDetect.detectClap({
            words: say('claqueta 4, clase 4', 12),
            classNumber: 4,
            markerSec: 10
        });
        t.eq(result.found, true);
        t.eq(result.method, 'frase');
        t.eq(result.offsetSec, 2);
    });

    t.group('align · elección del desfase');

    // El transcript dice lo mismo que los marcadores, pero 5 s más tarde.
    const DELAY = 5;
    const cues = [
        ['la constitución es lo primero que hay que definir', 'antes de escribir una sola línea de código'],
        ['ahora vamos a ver las especificaciones del proyecto', 'y eso es todo por esta sección'],
        ['el tercer paso es la implementación real', 'con esto cerramos la clase de hoy']
    ];

    function scenario(offsetInAudio) {
        const blocks = [];
        let words = [];
        let at = 60;
        cues.forEach(([cueIn, cueOut], i) => {
            const inWords = say(cueIn, at + offsetInAudio);
            const outWords = say(cueOut, at + offsetInAudio + 30);
            words = words.concat(inWords, outWords);
            blocks.push(block(i, at, at + 30 + cueOut.split(' ').length * 0.4, cueIn, cueOut));
            at += 120;
        });
        return { blocks, words };
    }

    t.test('la deriva de los anclajes se detecta sola cuando no hay claqueta', () => {
        const { blocks, words } = scenario(DELAY);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: null });
        t.near(result.offset.appliedSec, DELAY, 1, 'debería encontrar el retraso real');
        t.eq(result.offset.source, 'deriva de los anclajes');
    });

    t.test('una claqueta mentirosa se descarta comparando distancias', () => {
        const { blocks, words } = scenario(DELAY);
        // "clase 1" dicho en 100 s con el marcador en 10 → pediría correr +90 s.
        const withClap = say('claqueta 1, clase 1', 100).concat(words);
        const result = align.alignClass({ blocks, words: withClap, classNumber: 1, clapMarkerSec: 10 });
        t.ok(Math.abs(result.offset.appliedSec - 90) > 10, `aplicó ${result.offset.appliedSec}`);
        t.ok(result.warnings.some(w => w.code === 'claqueta_descartada'), 'tiene que avisar que la descartó');
    });

    t.test('un desfase enorme pide confirmación', () => {
        const blocks = [block(0, 100, 130, 'primera frase del bloque uno', 'última frase del bloque uno')];
        const words = say('claqueta 1, clase 1', 200);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: 10 });
        t.eq(result.offset.needsConfirmation, true);
        t.ok(result.warnings.some(w => w.code === 'desfase_grande'));
    });

    t.group('align · anclaje y confianza');

    t.test('un bloque cuya frase aparece una sola vez queda en confianza alta', () => {
        const { blocks, words } = scenario(0);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: null });
        t.eq(result.blocks[0].confidence, 'alta', JSON.stringify(result.blocks[0].in.reason));
        t.eq(result.stats.confidence.alta > 0, true);
    });

    t.test('una frase que no está en el transcript deja el marcador quieto', () => {
        const blocks = [block(0, 60, 90, 'esta frase no la dijo nadie nunca jamás', 'y esta tampoco existe en el audio')];
        const words = say('acá se habla de otra cosa completamente distinta', 60);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: null });
        t.eq(result.blocks[0].startSec, 60, 'no se puede mover lo que no se encontró');
        t.eq(result.blocks[0].endSec, 90);
        t.eq(result.blocks[0].confidence, 'baja');
    });

    t.test('una toma repetida lejos no se lleva el marcador', () => {
        // El bloque 13 de la clase 13: el CD repite la frase de cierre toma tras
        // toma durante tres minutos. La coincidencia de texto puntúa igual —o
        // mejor— en una toma fallida de hace 200 s que en la buena, que quedó a
        // dos segundos del marcador. Ganaba la lejana y el bloque pasaba de los
        // 10 s marcados a 3.4 minutos de tomas falsas.
        // La toma vieja empareja EXACTO; la buena quedó con un "si" de menos, así
        // que puntúa un poco peor. Sin mirar la distancia, gana la vieja.
        const cue = 'pero si quieres comenzar a desarrollar productos reales';
        const words = say(`${cue} eh no, pausa`, 960)
            .concat(say('tres dos uno', 1150))
            .concat(say('pero quieres comenzar a desarrollar productos reales y a materializar tus ideas.', 1158));

        const result = align.alignClass({
            blocks: [block(0, 1158, 1168, cue, 'materializar tus ideas')],
            words,
            classNumber: 1,
            clapMarkerSec: null
        });

        const b = result.blocks[0];
        t.ok(b.startSec > 1100,
            `el marcador se fue a la toma vieja: quedó en ${b.startSec}`);
        t.ok(b.endSec - b.startSec < 60,
            `el bloque se comió las tomas falsas: dura ${(b.endSec - b.startSec).toFixed(1)}s`);
    });

    t.test('sin transcript no se mueve nada y no falla', () => {
        const blocks = [block(0, 60, 90, 'una frase cualquiera del bloque', 'el cierre del bloque')];
        const result = align.alignClass({ blocks, words: [], classNumber: 1, clapMarkerSec: 8 });
        t.eq(result.blocks[0].startSec, 60);
        t.eq(result.stats.confidence.baja, 1);
    });

    t.group('align · invariantes');

    t.test('un bloque que termina antes de empezar se arregla y baja a revisión', () => {
        const blocks = [block(0, 100, 90, 'frase de entrada que no aparece', 'frase de salida que no aparece')];
        const result = align.alignClass({ blocks, words: [], classNumber: 1, clapMarkerSec: null });
        t.ok(result.blocks[0].endSec > result.blocks[0].startSec, 'el OUT tiene que quedar después del IN');
        t.eq(result.blocks[0].confidence, 'baja');
        t.ok(result.warnings.some(w => w.code === 'bloque_invertido'));
    });

    t.test('lo que se pasa del final del material se recorta', () => {
        const blocks = [block(0, 100, 5000, 'frase de entrada que no aparece', 'frase de salida que no aparece')];
        const result = align.alignClass({ blocks, words: [], classNumber: 1, clapMarkerSec: null, durationSec: 600 });
        t.eq(result.blocks[0].endSec, 600);
        t.ok(result.warnings.some(w => w.code === 'bloque_fuera_del_material'));
    });

    t.test('nada empieza antes del comienzo del material', () => {
        const blocks = [block(0, 1, 40, 'frase de entrada que no aparece', 'frase de salida que no aparece')];
        const words = say('claqueta 1, clase 1', 2);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: 60 });
        t.ok(result.blocks[0].startSec >= 0, `empezaba en ${result.blocks[0].startSec}`);
    });

    t.test('los bloques solapados se marcan de los dos lados', () => {
        const blocks = [
            block(0, 100, 200, 'frase de entrada que no aparece uno', 'frase de salida que no aparece uno'),
            block(1, 150, 260, 'frase de entrada que no aparece dos', 'frase de salida que no aparece dos')
        ];
        const result = align.alignClass({ blocks, words: [], classNumber: 1, clapMarkerSec: null });
        t.eq(result.blocks[0].confidence, 'baja');
        t.eq(result.blocks[1].confidence, 'baja');
        t.ok(result.warnings.some(w => w.code === 'bloques_solapados'));
    });

    t.test('el comentario del marcador nunca se toca', () => {
        const { blocks, words } = scenario(DELAY);
        const original = blocks.map(b => b.cueIn);
        const result = align.alignClass({ blocks, words, classNumber: 1, clapMarkerSec: null });
        t.deep(result.blocks.map(b => b.cueIn), original);
    });
};
