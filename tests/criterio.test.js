'use strict';
/**
 * Los bordes con criterio: que no entre lo que el profesor le dice al editor,
 * que el bloque cierre una idea, y que una respuesta inventada del modelo no
 * mueva nada.
 */

const speech = require('../engine/speech-edges');
const refine = require('../engine/cut-refine');
const coherence = require('../engine/coherence');
const ai = require('../engine/ai-local');
const fcp = require('../engine/fcp-xml');

/** Palabras con tiempos a partir de un texto. */
function say(text, startSec, wordSec) {
    const step = wordSec || 0.3;
    return text.split(/\s+/).map((word, i) => ({
        text: word,
        start: Math.round((startSec + i * step) * 1000) / 1000,
        end: Math.round((startSec + i * step + step * 0.85) * 1000) / 1000
    }));
}

module.exports = function (t) {
    t.group('speech-edges · habla del director');

    t.test('"pausa" y "corte" son siempre del director', () => {
        t.eq(speech.isChatter({ text: 'Pausa.' }, 0), true);
        t.eq(speech.isChatter({ text: 'corte' }, 0), true);
        t.eq(speech.isChatter({ text: 'Tres.' }, 0), true);
    });

    t.test('"listo" solo cuenta si viene después de un silencio', () => {
        t.eq(speech.isChatter({ text: 'listo' }, 0.05), false, 'dentro de la frase es una palabra normal');
        t.eq(speech.isChatter({ text: 'listo' }, 1.2), true, 'suelto es un aparte al editor');
    });

    t.test('una palabra cualquiera nunca es del director', () => {
        t.eq(speech.isChatter({ text: 'constitución' }, 3), false);
    });

    t.group('speech-edges · límites de palabra');

    t.test('el OUT no puede llegar a la palabra siguiente', () => {
        const words = say('la idea termina acá', 10).concat(say('Pausa', 12.5));
        const limits = speech.wordLimits(words, 12.2, 'OUT');
        t.eq(limits.maxTime, 12.5, 'el tope es donde empieza "Pausa"');
    });

    t.test('el IN no puede llevarse la palabra anterior', () => {
        const words = say('algo anterior', 5).concat(say('arranca el bloque', 9));
        const limits = speech.wordLimits(words, 8.9, 'IN');
        t.ok(limits.minTime <= 8.9 && limits.minTime > 5, `minTime raro: ${limits.minTime}`);
    });

    t.test('el más ajustado de dos límites es el que manda', () => {
        const merged = speech.tightest({ minTime: 5, maxTime: 20 }, { minTime: 8, maxTime: 15 });
        t.deep(merged, { minTime: 8, maxTime: 15 });
        t.deep(speech.tightest({ minTime: null, maxTime: 9 }, { minTime: 3, maxTime: null }),
            { minTime: 3, maxTime: 9 });
    });

    t.group('speech-edges · recorte del chatter');

    t.test('el "Pausa" del final se va y el bloque queda entero', () => {
        const words = say('esto es lo que queremos decir.', 10).concat(say('Pausa.', 12));
        const cut = speech.trimChatter(words, 9.9, 12.6);
        t.ok(cut.endSec <= 12, `el corte tenía que retroceder, quedó en ${cut.endSec}`);
        t.deep(cut.removed, ['Pausa.']);
    });

    t.test('el conteo del principio no entra', () => {
        const words = say('tres dos uno', 5).concat(say('ahora sí empieza la clase.', 7));
        const cut = speech.trimChatter(words, 4.9, 9.5);
        t.ok(cut.startSec >= 5.3, `debería arrancar después del conteo, arrancó en ${cut.startSec}`);
    });

    t.test('recortar no puede dejar el bloque en nada', () => {
        const words = say('Pausa.', 10);
        const cut = speech.trimChatter(words, 9.9, 10.4);
        t.eq(cut.startSec, 9.9, 'si no queda nada, se deja como estaba');
        t.deep(cut.removed, []);
    });

    t.group('speech-edges · cerrar la frase');

    t.test('un fragmento colgando se retrae a la frase anterior', () => {
        // "…que debes aprender. Igual," — el caso real medido 103 veces.
        const words = say('esa es la metodología que debes aprender.', 10)
            .concat(say('Igual, esto sigue después', 12.5));
        const snap = speech.snapToSentence(words, 13.1, 'OUT');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec < 12.5, `tenía que retroceder, quedó en ${snap.timeSec}`);
        t.ok(/retrajo/.test(snap.how), snap.how);
    });

    t.test('una frase cortada por la mitad se extiende hasta cerrar', () => {
        const words = say('la documentación se vuelve un artefacto vivo que le va a dar órdenes al modelo.', 10);
        const snap = speech.snapToSentence(words, 12.3, 'OUT');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec > 12.3, `tenía que extenderse, quedó en ${snap.timeSec}`);
        t.ok(/extendió/.test(snap.how), snap.how);
    });

    t.test('no se extiende más allá de una orden al editor', () => {
        const words = say('esto queda a medias', 10).concat(say('Pausa. y sigue otra cosa.', 11.4));
        const snap = speech.snapToSentence(words, 11.2, 'OUT');
        t.ok(!snap.moved || snap.timeSec <= 11.4, `se pasó del "Pausa": ${snap.timeSec}`);
    });

    t.test('un borde que ya cierra una frase no se toca', () => {
        const words = say('esto cierra bien.', 10).concat(say('otra cosa después', 13));
        const snap = speech.snapToSentence(words, 11.1, 'OUT');
        t.eq(snap.moved, false);
        t.ok(/ya cerraba/.test(snap.how), snap.how);
    });

    t.test('el IN se abre al principio de la frase, no a la mitad', () => {
        const words = say('lo primero que hay que entender es esto.', 10)
            .concat(say('Y ahora viene lo importante de verdad.', 14));
        const snap = speech.snapToSentence(words, 15.2, 'IN');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec <= 14.1, `tenía que abrir en "Y", quedó en ${snap.timeSec}`);
    });

    t.group('cut-refine · candidatos');

    t.test('los finales de frase entran como candidatos aunque no haya pausa', () => {
        // El caso del bloque 4: todo hablado de corrido, el cierre bueno está en
        // el punto y no en ninguna pausa.
        const words = say('la documentación se vuelve un artefacto vivo que le va a dar órdenes al modelo.', 100);
        const merged = refine.withSentenceCandidates({ candidates: [], current: 0 }, words, 103, 'OUT', {});
        t.ok(merged.candidates.length >= 1, 'tiene que ofrecer el final de la frase');
        t.ok(merged.candidates.some(c => c.fromSentence), 'y marcarlo como tal');
    });

    t.test('un candidato que deja "Pausa" adentro se descarta', () => {
        const words = say('esto termina acá.', 10).concat(say('Pausa.', 11.5));
        const bad = { frontier: 12.2, gapSec: 0.1 };
        t.eq(refine.dropsChatter(bad, words, 'OUT'), true);
    });

    t.test('cerrar una frase puntúa más que cortar en cualquier frontera', () => {
        const words = say('esto cierra la idea completa.', 10).concat(say('y esto es otra cosa', 12.5));
        const enFrase = refine.scoreCandidate({ frontier: 11.5, gapSec: 0.05 }, words, 'OUT', 11.5);
        const cierre = refine.scoreCandidate({ frontier: 11.65, gapSec: 0.85 }, words, 'OUT', 11.5);
        t.ok(cierre > enFrase, `cerrar (${cierre}) tiene que ganarle a cortar al voleo (${enFrase})`);
    });

    t.test('solo se revisan los bloques que lo necesitan', () => {
        const bueno = { confidence: 'alta', in: { anchored: true, snap: { how: 'ya cerraba' } }, out: { anchored: true, snap: { how: 'ya cerraba' } } };
        const dudoso = { confidence: 'media', in: { anchored: true }, out: { anchored: true } };
        const sinAnclar = { confidence: 'alta', in: { anchored: false }, out: { anchored: true } };
        t.eq(refine.needsCriterion(bueno), false);
        t.eq(refine.needsCriterion(dudoso), true);
        t.eq(refine.needsCriterion(sinAnclar), true);
    });

    t.group('IA local · nada de lo que diga se aplica sin validar');

    t.test('una respuesta que no es JSON se descarta', () => {
        t.eq(ai.parseJson('el corte va en el segundo 42'), null);
    });

    t.test('un JSON envuelto en texto se rescata', () => {
        t.deep(ai.parseJson('```json\n{"choice": 4}\n```'), { choice: 4 });
        t.deep(ai.parseJson('Claro: {"choice": 2, "reason": "x"}'), { choice: 2, reason: 'x' });
    });

    t.test('un hallazgo que apunta a un bloque que no existe se tira', () => {
        const script = { blocks: [{ n: 1 }, { n: 2 }] };
        const valid = coherence.validateFindings({
            hallazgos: [
                { bloque: 1, tipo: 'repetido', gravedad: 'alta', detalle: 'esto sí' },
                { bloque: 99, tipo: 'repetido', gravedad: 'alta', detalle: 'bloque inventado' },
                { bloque: 2, tipo: 'repetido', gravedad: 'alta', detalle: '' }
            ]
        }, script);
        t.eq(valid.length, 1);
        t.eq(valid[0].bloque, 1);
    });

    t.test('un tipo o una gravedad inventados se normalizan', () => {
        const valid = coherence.validateFindings({
            hallazgos: [{ bloque: 1, tipo: 'catastrófico', gravedad: 'urgentísima', detalle: 'algo' }]
        }, { blocks: [{ n: 1 }] });
        t.eq(valid[0].tipo, 'otro');
        t.eq(valid[0].gravedad, 'media');
    });

    t.group('coherencia · el guion final');

    t.test('el guion es solo lo que sobrevive, en orden', () => {
        const words = say('primero esto.', 10).concat(say('esto se elimina', 20)).concat(say('después aquello.', 30));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 11, view: 'PV' },
            { index: 1, startSec: 29.9, endSec: 31, view: 'R' }
        ], words);
        t.eq(script.blocks.length, 2);
        t.eq(script.blocks[0].n, 1);
        t.ok(/primero esto/.test(script.blocks[0].text), script.blocks[0].text);
        t.ok(!/se elimina/.test(script.text), 'lo eliminado no puede estar en el guion');
    });

    t.test('un bloque desmarcado no entra al guion', () => {
        const words = say('esto queda.', 10);
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 11 },
            { index: 1, startSec: 9.9, endSec: 11, enabled: false }
        ], words);
        t.eq(script.blocks.length, 1);
    });

    t.test('un conector que la nota no pedía se avisa', () => {
        const words = say('la fuente de la verdad es la especificación.', 10)
            .concat(say('Y entonces eso cambia todo el desarrollo.', 20));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 14, cueIn: 'la fuente de la verdad' },
            { index: 1, startSec: 19.9, endSec: 23, cueIn: 'cambia todo el desarrollo' }
        ], words);
        t.ok(coherence.localFindings(script).some(f => f.tipo === 'conector'));
    });

    t.test('un conector que el CD escribió en la nota no molesta', () => {
        // En el curso real, 24 de 25 bloques que abren con "Y" o "Luego" los
        // escribió así el CD: es su forma de hablar, no un corte mal puesto.
        const words = say('la fuente de la verdad es la especificación.', 10)
            .concat(say('Y entonces eso cambia todo el desarrollo.', 20));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 14, cueIn: 'la fuente de la verdad' },
            { index: 1, startSec: 19.9, endSec: 23, cueIn: 'Y entonces eso cambia' }
        ], words);
        t.eq(coherence.localFindings(script).filter(f => f.tipo === 'conector').length, 0);
    });

    t.group('colores · el XML conserva lo que puso el CD');

    t.test('el entero de Premiere se decodifica a su color real', () => {
        // PV en el curso real: 4281740498 = RGB(54, 44, 210)
        const color = fcp.colorComponents(4281740498);
        t.eq(color.red, 54 * 257);
        t.eq(color.green, 44 * 257);
        t.eq(color.blue, 210 * 257);
    });

    t.test('la claqueta blanca sigue siendo blanca', () => {
        const color = fcp.colorComponents(4294967295);
        t.eq(color.red, 65535);
        t.eq(color.green, 65535);
        t.eq(color.blue, 65535);
    });

    t.test('un nombre de color sigue funcionando', () => {
        t.deep(fcp.colorComponents('green'), fcp.MARKER_COLORS.green);
        t.deep(fcp.colorComponents(null), fcp.MARKER_COLORS.white);
    });

    t.test('cada fuente lleva su etiqueta y la primera es Cerulean', () => {
        t.eq(fcp.CLIP_LABELS[0], 'Cerulean');
        t.eq(fcp.CLIP_LABELS[1], 'Rose');
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10,
            videoTracks: [[{
                source: { path: '/a.mp4', name: 'a.mp4', durationSec: 10, label: 'Cerulean' },
                startSec: 0, endSec: 10, sourceInSec: 0, enabled: true
            }]],
            audioTracks: [], markers: []
        });
        t.ok(xml.includes('<labels><label2>Cerulean</label2></labels>'), 'falta la etiqueta en el clip');
    });

    t.test('el audio no lleva etiqueta de color', () => {
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10,
            videoTracks: [],
            audioTracks: [[{
                source: { path: '/a.wav', name: 'a.wav', durationSec: 10, audioOnly: true },
                startSec: 0, endSec: 10, sourceInSec: 0, enabled: true
            }]],
            markers: []
        });
        t.ok(!xml.includes('<label2>'), 'el audio queda con su color por defecto');
    });
};
