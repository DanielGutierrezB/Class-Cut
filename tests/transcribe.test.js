'use strict';
/**
 * Transcripción: lo que se puede probar sin gastar minutos de Whisper — el
 * parseo de su salida, el colapso de bucles y la caché, que es lo que decide si
 * una clase se vuelve a transcribir o no.
 */

const fs = require('fs');
const path = require('path');
const transcribe = require('../engine/transcribe');
const workspace = require('../engine/workspace');
const fixture = require('./lib/fixture');

function whisperJson(segments) {
    return {
        result: { language: 'es' },
        transcription: segments.map(([text, from, to]) => ({
            text,
            offsets: { from: from * 1000, to: to * 1000 }
        }))
    };
}

module.exports = function (t) {
    t.group('transcribe · salida de whisper');

    t.test('cada segmento de una palabra se vuelve {start, end, text}', () => {
        const words = transcribe.wordsFromWhisperJson(whisperJson([
            [' Imagínate', 18.92, 19.88],
            [' que', 19.88, 20.01]
        ]));
        t.deep(words, [
            { start: 18.92, end: 19.88, text: 'Imagínate' },
            { start: 19.88, end: 20.01, text: 'que' }
        ]);
    });

    t.test('los segmentos vacíos que mete whisper se descartan', () => {
        const words = transcribe.wordsFromWhisperJson(whisperJson([
            ['', 0, 0], ['  ', 1, 1], [' hola', 2, 2.5]
        ]));
        t.eq(words.length, 1);
        t.eq(words[0].text, 'hola');
    });

    t.group('transcribe · bucles de whisper');

    t.test('una palabra repetida en bucle se colapsa', () => {
        const words = [];
        for (let i = 0; i < 20; i++) words.push({ start: i, end: i + 0.5, text: 'gracias' });
        const result = transcribe.collapseLoops(words);
        t.eq(result.words.length, transcribe.MAX_REPEATS);
        t.eq(result.removed, 20 - transcribe.MAX_REPEATS);
    });

    t.test('el tiempo del bucle no desaparece de la línea de tiempo', () => {
        const words = [];
        for (let i = 0; i < 10; i++) words.push({ start: i, end: i + 0.5, text: 'sí' });
        const result = transcribe.collapseLoops(words);
        t.eq(result.words[result.words.length - 1].end, 9.5, 'el último tiene que absorber el final');
    });

    t.test('una repetición corta y legítima se respeta', () => {
        const words = [
            { start: 0, end: 0.4, text: 'sí' },
            { start: 0.5, end: 0.9, text: 'sí' },
            { start: 1.0, end: 1.6, text: 'claro' }
        ];
        t.eq(transcribe.collapseLoops(words).words.length, 3);
    });

    t.test('el bucle de frase también se colapsa', () => {
        // El caso real de la clase 4: Whisper rellenó 27 segundos de silencio con
        // los créditos de un subtitulador, cuarenta y cinco veces seguidas.
        const words = [];
        for (let i = 0; i < 45; i++) {
            words.push({ start: i * 3, end: i * 3 + 1, text: 'Andrea' });
            words.push({ start: i * 3 + 1, end: i * 3 + 2, text: 'Oroz' });
            words.push({ start: i * 3 + 2, end: i * 3 + 3, text: 'Sincronización' });
        }
        const result = transcribe.collapseLoops(words);
        t.eq(result.words.length, 3, 'sobrevive una vuelta');
        t.eq(result.words.map(w => w.text).join(' '), 'Andrea Oroz Sincronización');
        t.eq(result.removed, 132);
    });

    t.test('el tiempo de un bucle de frase tampoco desaparece', () => {
        const words = [];
        for (let i = 0; i < 10; i++) {
            words.push({ start: i * 2, end: i * 2 + 1, text: 'muchas' });
            words.push({ start: i * 2 + 1, end: i * 2 + 2, text: 'gracias' });
        }
        const result = transcribe.collapseLoops(words);
        t.eq(result.words[result.words.length - 1].end, 20, 'el último absorbe el final');
    });

    t.test('una frase dicha dos veces no es un bucle', () => {
        // El profesor repite para enfatizar: eso se dijo y tiene que quedar.
        const words = [];
        for (let i = 0; i < 2; i++) {
            words.push({ start: i * 2, end: i * 2 + 1, text: 'muy' });
            words.push({ start: i * 2 + 1, end: i * 2 + 2, text: 'importante' });
        }
        words.push({ start: 4, end: 5, text: 'esto.' });
        t.eq(transcribe.collapseLoops(words).words.length, 5);
    });

    t.test('la palabra suelta repetida sigue dejando tres, no una', () => {
        // Sin esto, el detector de frases vería un bucle de "sí sí" y dejaría dos:
        // los dos casos existen y cada uno tiene su regla.
        const words = [];
        for (let i = 0; i < 20; i++) words.push({ start: i, end: i + 0.5, text: 'sí' });
        t.eq(transcribe.collapseLoops(words).words.length, transcribe.MAX_REPEATS);
    });

    t.test('la puntuación no engaña al detector de bucles', () => {
        const words = [];
        for (let i = 0; i < 12; i++) words.push({ start: i, end: i + 0.4, text: i % 2 ? 'Gracias.' : 'gracias,' });
        t.eq(transcribe.collapseLoops(words).words.length, transcribe.MAX_REPEATS);
    });

    t.group('transcribe · frases rearmadas');

    t.test('las palabras se agrupan en frases por puntuación', () => {
        const words = [
            { start: 0, end: 0.5, text: 'Hola' },
            { start: 0.5, end: 1.0, text: 'a' },
            { start: 1.0, end: 1.6, text: 'todos.' },
            { start: 1.7, end: 2.2, text: 'Empezamos' },
            { start: 2.2, end: 2.9, text: 'ya.' }
        ];
        const segments = transcribe.segmentsFromWords(words);
        t.eq(segments.length, 2);
        t.eq(segments[0].text, 'Hola a todos.');
        t.eq(segments[1].text, 'Empezamos ya.');
    });

    t.test('una pausa larga corta la frase aunque no haya puntuación', () => {
        const words = [
            { start: 0, end: 0.5, text: 'esto' },
            { start: 0.5, end: 1.0, text: 'sigue' },
            { start: 30, end: 30.5, text: 'otra' },
            { start: 30.5, end: 31, text: 'toma' }
        ];
        const segments = transcribe.segmentsFromWords(words);
        t.eq(segments.length, 2);
        t.eq(segments[1].start, 30);
    });

    t.group('transcribe · caché');

    function transcriptFor(source, overrides) {
        return {
            version: transcribe.TRANSCRIPT_VERSION,
            source,
            engine: { tool: 'whisper-cli', model: 'ggml-large-v3-turbo.bin', vad: false },
            words: [{ start: 0, end: 1, text: 'hola' }],
            ...(overrides || {})
        };
    }

    t.test('sirve cuando el audio es el mismo', () => {
        const source = { path: '/x/Live-Mix.wav', size: 100, mtimeMs: 5 };
        t.eq(transcribe.isUsable(transcriptFor(source), source), true);
    });

    t.test('no sirve si el audio cambió de tamaño o de fecha', () => {
        const source = { path: '/x/Live-Mix.wav', size: 100, mtimeMs: 5 };
        t.eq(transcribe.isUsable(transcriptFor(source), { ...source, size: 101 }), false);
        t.eq(transcribe.isUsable(transcriptFor(source), { ...source, mtimeMs: 6 }), false);
    });

    t.test('no sirve un transcript de una versión anterior', () => {
        const source = { path: '/x/Live-Mix.wav', size: 100, mtimeMs: 5 };
        t.eq(transcribe.isUsable(transcriptFor(source, { version: 0 }), source), false);
    });

    t.test('no sirve uno hecho con VAD', () => {
        // Los de antes se hacían con VAD, que arruinaba los tiempos de cada
        // palabra. Hay que rehacerlos, no darlos por buenos.
        const source = { path: '/x/Live-Mix.wav', size: 100, mtimeMs: 5 };
        const conVad = transcriptFor(source, { engine: { tool: 'whisper-cli', vad: true } });
        t.eq(transcribe.isUsable(conVad, source), false);
    });

    t.test('no sirve uno vacío (una corrida cancelada no puede pasar por buena)', () => {
        const source = { path: '/x/Live-Mix.wav', size: 100, mtimeMs: 5 };
        t.eq(transcribe.isUsable(transcriptFor(source, { words: [] }), source), false);
    });

    t.group('workspace · dónde se escribe');

    t.test('todo cuelga de una sola carpeta en la raíz', () => {
        const root = '/curso';
        t.eq(workspace.outputRoot(root), '/curso/The Cutter');
        t.eq(workspace.finalXml(root, '04_clase'), '/curso/The Cutter/04_clase.xml');
    });

    t.test('los artefactos van sueltos, diciendo qué son al final del nombre', () => {
        const root = '/curso';
        t.eq(workspace.artifact(root, '04_clase', 'transcript'), '/curso/The Cutter/Backup/04_clase_transcript.json');
        t.eq(workspace.artifact(root, '04_clase', 'alignedXml'), '/curso/The Cutter/Backup/04_clase_alineada.xml');
        t.eq(workspace.artifact(root, '04_clase', 'coherence'), '/curso/The Cutter/Backup/04_clase_coherence.json');
    });

    t.test('un artefacto que no existe se rechaza en vez de escribir en cualquier lado', () => {
        let falló = false;
        try { workspace.artifact('/curso', '04_clase', 'inventado'); } catch (e) { falló = true; }
        t.eq(falló, true);
    });

    t.test('la migración pasa los Backup viejos al formato plano sin perder nada', () => {
        const root = fixture.tempRoot('migrar');
        try {
            const vieja = path.join(root, 'The Cutter', 'Backup', '04_clase');
            fs.mkdirSync(vieja, { recursive: true });
            fs.writeFileSync(path.join(vieja, 'transcript.json'), '{"version":2}');
            fs.writeFileSync(path.join(vieja, 'alineada.xml'), '<xmeml/>');

            const result = workspace.migrateBackup(root);
            t.eq(result.moved, 2);
            t.eq(result.folders, 1);
            t.deep(workspace.readJson(workspace.artifact(root, '04_clase', 'transcript')), { version: 2 });
            t.eq(fs.existsSync(vieja), false, 'la carpeta vacía se saca del medio');
        } finally { fixture.rimraf(root); }
    });

    t.test('migrar dos veces no rompe nada', () => {
        const root = fixture.tempRoot('migrar-dos');
        try {
            const vieja = path.join(root, 'The Cutter', 'Backup', '04_clase');
            fs.mkdirSync(vieja, { recursive: true });
            fs.writeFileSync(path.join(vieja, 'align.json'), '{}');
            workspace.migrateBackup(root);
            const segunda = workspace.migrateBackup(root);
            t.eq(segunda.moved, 0);
        } finally { fixture.rimraf(root); }
    });

    t.test('un nombre de secuencia con barras no se escapa de su carpeta', () => {
        t.eq(workspace.safeName('a/b:c'), 'a-b-c');
        const escapado = workspace.safeName('../../etc/passwd');
        t.ok(!escapado.includes('/'), `quedó una barra: ${escapado}`);
        t.ok(!escapado.startsWith('.'), `empieza con punto: ${escapado}`);
        t.eq(workspace.safeName(''), 'sin-nombre');
    });

    t.test('la escritura atómica no deja archivos a medias', () => {
        const root = fixture.tempRoot('atomic');
        try {
            const target = path.join(root, 'sub', 'archivo.json');
            workspace.writeJson(target, { hola: 'mundo' });
            t.deep(workspace.readJson(target), { hola: 'mundo' });
            const sobras = fs.readdirSync(path.dirname(target)).filter(n => n.includes('.tmp-'));
            t.eq(sobras.length, 0, `quedaron temporales: ${sobras.join(', ')}`);
        } finally { fixture.rimraf(root); }
    });

    t.test('leer un artefacto que no existe devuelve null en vez de explotar', () => {
        t.eq(workspace.readJson('/no/existe.json'), null);
    });
};
