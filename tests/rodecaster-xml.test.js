'use strict';
/**
 * Lo que se prueba acá es el emparejamiento de marcadores, que es donde una
 * decisión equivocada parte una clase por la mitad sin que nada falle.
 */

const rodecaster = require('../engine/rodecaster-xml');
const fixture = require('./lib/fixture');

module.exports = function (t) {
    t.group('rodecaster-xml · comentario del marcador IN');

    t.test('la claqueta no tiene nota ni conteo', () => {
        const parsed = rodecaster.parseInComment(' - Clapperboard');
        t.eq(parsed.note, '');
        t.eq(parsed.cue, 'Clapperboard');
        t.eq(parsed.hasCount, false);
    });

    t.test('sin nota, el cue empieza después del conteo', () => {
        const parsed = rodecaster.parseInComment(' -  3, 2, 1. Imagínate que vas a construir tu casa. Y');
        t.eq(parsed.note, '');
        t.eq(parsed.cue, 'Imagínate que vas a construir tu casa. Y');
        t.eq(parsed.count, '3, 2, 1.');
    });

    t.test('la nota del CD se separa del cue', () => {
        const parsed = rodecaster.parseInComment(
            'Highlightear sección: Naturaleza del proyecto. -  3, 2, 1. Ahora vamos a entender qué debe tener un');
        t.eq(parsed.note, 'Highlightear sección: Naturaleza del proyecto.');
        t.eq(parsed.cue, 'Ahora vamos a entender qué debe tener un');
    });

    t.test('una nota que dice "OUT ANTES DE" sigue siendo nota', () => {
        const parsed = rodecaster.parseInComment(
            'OUT ANTES DE: "También le estamos diciendo" -  3, 2, 1. Y, finalmente, el 6º componente que vamo');
        t.eq(parsed.note, 'OUT ANTES DE: "También le estamos diciendo"');
        t.eq(parsed.cue, 'Y, finalmente, el 6º componente que vamo');
    });

    t.test('un falso arranque ("3 2 3 2 1") no se cuela en el cue', () => {
        const parsed = rodecaster.parseInComment(' -  3 2 3 2 1. La constitución en spectric and develo');
        t.eq(parsed.cue, 'La constitución en spectric and develo');
    });

    t.test('una nota con " - " adentro no corta en el guion equivocado', () => {
        const parsed = rodecaster.parseInComment(
            'PV EN: "Te preguntarás cómo fue - déjame explicartelo". Luego pasamos a SR. -  3 2 1. Te preguntarás cómo Cloud');
        t.eq(parsed.note, 'PV EN: "Te preguntarás cómo fue - déjame explicartelo". Luego pasamos a SR.');
        t.eq(parsed.cue, 'Te preguntarás cómo Cloud');
    });

    t.test('el conteo también se reconoce con palabras', () => {
        const parsed = rodecaster.parseInComment(' -  tres, dos, uno. Vamos a empezar');
        t.eq(parsed.hasCount, true);
        t.eq(parsed.cue, 'Vamos a empezar');
    });

    t.group('rodecaster-xml · comentario del marcador OUT');

    t.test('se le quita el prefijo OUT:', () => {
        const parsed = rodecaster.parseOutComment('OUT:  permiso para construir en esa zona en específico.');
        t.eq(parsed.cue, 'permiso para construir en esa zona en específico.');
        t.eq(parsed.hadPrefix, true);
    });

    t.test('sin prefijo se usa el texto tal cual', () => {
        const parsed = rodecaster.parseOutComment('termina acá');
        t.eq(parsed.cue, 'termina acá');
        t.eq(parsed.hadPrefix, false);
    });

    t.group('rodecaster-xml · entidades y número de clase');

    t.test('las comillas escapadas del XML se decodifican', () => {
        t.eq(rodecaster.decodeEntities('dice &quot;hola&quot; &amp; chau'), 'dice "hola" & chau');
    });

    t.test('&amp;lt; no se decodifica dos veces', () => {
        t.eq(rodecaster.decodeEntities('&amp;lt;'), '&lt;');
    });

    t.test('el número de clase sale del nombre de secuencia', () => {
        t.eq(rodecaster.classNumberFromSequenceName('04_2608_spec-driven-dev-1783694681_105913'), 4);
        t.eq(rodecaster.classNumberFromSequenceName('13_2608_spec-driven-dev-1783694681_105921'), 13);
        t.eq(rodecaster.classNumberFromSequenceName('sin-numero_2608'), null);
    });

    t.group('rodecaster-xml · emparejamiento');

    t.test('el par se decide por duración, no por el texto del comentario', () => {
        // El IN dice "OUT ANTES DE:" y dura 300 frames; el OUT no dura nada.
        const xml = fixture.makeXml('01_test', fixture.CLAP_PAIR.concat([
            { comment: 'OUT ANTES DE: "algo" -  3, 2, 1. arranca', name: 'PV', in: 600, out: 900 },
            { comment: 'OUT: termina', name: 'PV', in: 1200 }
        ]));
        const parsed = rodecaster.parseXml(xml);
        t.ok(parsed.ok, parsed.error);
        t.eq(parsed.blockCount, 1);
        t.eq(parsed.blocks[0].complete, true);
        t.eq(parsed.blocks[0].startFrame, 600);
        t.eq(parsed.blocks[0].endFrame, 1200, 'el bloque termina en el OUT, no en el out del IN');
        t.eq(parsed.blocks[0].note, 'OUT ANTES DE: "algo"');
    });

    t.test('un OUT dentro de los 10 s del IN cierra el bloque ahí', () => {
        const xml = fixture.makeXml('01_test', fixture.CLAP_PAIR.concat([
            { comment: ' -  3, 2, 1. arranca', name: 'PV', in: 5940, out: 6240 },
            { comment: 'OUT: termina', name: 'PV', in: 6120 }
        ]));
        const parsed = rodecaster.parseXml(xml);
        t.eq(parsed.blocks[0].endFrame, 6120);
        t.near(parsed.blocks[0].durationSec, 6, 0.001, 'bloque de 6 s');
    });

    t.test('la claqueta se reconoce y no genera bloque', () => {
        const xml = fixture.makeXml('01_test', fixture.CLAP_PAIR.concat(fixture.pair(600, 900)));
        const parsed = rodecaster.parseXml(xml);
        t.ok(parsed.clap, 'debería encontrar la claqueta');
        t.eq(parsed.clap.frame, 300);
        t.near(parsed.clap.seconds, 10, 0.001);
        t.eq(parsed.blockCount, 1, 'la claqueta no cuenta como bloque');
    });

    t.test('un IN sin OUT queda como bloque incompleto y avisa', () => {
        const xml = fixture.makeXml('01_test', fixture.CLAP_PAIR.concat([
            { comment: ' -  3, 2, 1. arranca', name: 'PV', in: 600, out: 900 },
            { comment: ' -  3, 2, 1. arranca otro', name: 'R', in: 1800, out: 2100 },
            { comment: 'OUT: termina', name: 'R', in: 2400 }
        ]));
        const parsed = rodecaster.parseXml(xml);
        t.eq(parsed.blockCount, 2);
        t.eq(parsed.blocks[0].complete, false);
        t.eq(parsed.blocks[1].complete, true);
        t.ok(parsed.warnings.some(w => w.code === 'bloque_sin_out'), 'tiene que avisar');
    });

    t.test('un OUT huérfano se ignora avisando', () => {
        const xml = fixture.makeXml('01_test', fixture.CLAP_PAIR.concat([
            { comment: 'OUT: suelto', name: 'PV', in: 600 }
        ]));
        const parsed = rodecaster.parseXml(xml);
        t.eq(parsed.blockCount, 0);
        t.ok(parsed.warnings.some(w => w.code === 'out_huerfano'));
    });

    t.test('sin claqueta avisa pero sigue', () => {
        const xml = fixture.makeXml('01_test', fixture.pair(600, 900));
        const parsed = rodecaster.parseXml(xml);
        t.eq(parsed.clap, null);
        t.eq(parsed.blockCount, 1);
        t.ok(parsed.warnings.some(w => w.code === 'sin_claqueta'));
    });

    t.test('un archivo que no es del Rodecaster falla con motivo', () => {
        const parsed = rodecaster.parseXml('<?xml version="1.0"?><otra-cosa/>');
        t.eq(parsed.ok, false);
        t.ok(/sequence/.test(parsed.error), 'el error tiene que decir qué le falta');
    });

    t.group('rodecaster-xml · el curso real (13 clases)');

    if (!fixture.courseAvailable()) {
        t.skip('el curso completo', 'no está montado');
        return;
    }

    const real = fixture.realClassFolders();

    t.test('se leen las 13 clases', () => {
        t.eq(real.length, 13);
    });

    t.test('cada clase tiene número, timebase 30 y marcadores pares', () => {
        const numbers = [];
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            t.ok(parsed.ok, `${item.folderName}: ${parsed.error || ''}`);
            t.eq(parsed.timebase, 30, `${item.folderName}: timebase`);
            t.eq(parsed.markerCount % 2, 0, `${item.folderName}: marcadores impares`);
            t.ok(parsed.classNumber != null, `${item.folderName}: sin número de clase`);
            numbers.push(parsed.classNumber);
        }
        t.deep(numbers.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    t.test('todas tienen claqueta y bloques = pares - 1', () => {
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            t.ok(parsed.clap, `${item.folderName}: sin claqueta`);
            t.eq(parsed.blockCount, parsed.markerCount / 2 - 1, `${item.folderName}: bloques`);
        }
    });

    t.test('no hay bloques incompletos ni solapes en el curso real', () => {
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            const incomplete = parsed.blocks.filter(b => !b.complete);
            t.eq(incomplete.length, 0, `${item.folderName}: ${incomplete.length} bloques sin cerrar`);
            const overlap = parsed.warnings.filter(w => w.code === 'bloques_solapados');
            t.eq(overlap.length, 0, `${item.folderName}: bloques solapados`);
        }
    });

    t.test('las vistas son solo PV y R (K nunca abre bloque)', () => {
        const seen = new Set();
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            for (const view of Object.keys(parsed.views)) seen.add(view);
        }
        t.deep([...seen].sort(), ['PV', 'R']);
    });

    t.test('todo bloque tiene cue de entrada y de salida para anclar', () => {
        let sinCue = 0;
        let total = 0;
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            for (const block of parsed.blocks) {
                total++;
                if (!block.cueIn || !block.cueOut) sinCue++;
            }
        }
        t.ok(total > 150, `esperaba muchos bloques, hay ${total}`);
        t.eq(sinCue, 0, `${sinCue} de ${total} bloques sin texto para anclar`);
    });

    t.test('el conteo "3, 2, 1" se reconoce en casi todos los bloques', () => {
        let conConteo = 0;
        let total = 0;
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            for (const block of parsed.blocks) {
                total++;
                if (block.hasCount) conConteo++;
            }
        }
        const ratio = conConteo / total;
        t.ok(ratio > 0.9, `solo ${conConteo}/${total} bloques (${(ratio * 100).toFixed(1)}%) traen conteo`);
    });

    t.test('la duración del XML es nominal (2 h) en las 13', () => {
        for (const item of real) {
            const parsed = rodecaster.parseFile(item.xmlPath);
            t.eq(parsed.nominalDurationFrames, 216000, `${item.folderName}`);
        }
    });
};
