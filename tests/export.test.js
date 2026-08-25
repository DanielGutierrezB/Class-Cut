'use strict';
/**
 * Plan de cortes y XML de salida. Acá se prueba lo que el editor va a importar,
 * que es lo único que al final importa: que los tiempos sean los que se
 * calcularon, que la cámara correcta esté encendida y que el archivo no se
 * defina dos veces.
 */

const cutplan = require('../engine/cutplan');
const fcp = require('../engine/fcp-xml');
const exporter = require('../engine/export');

function alignedBlock(index, startSec, endSec, view, confidence) {
    return {
        index,
        view: view || 'PV',
        note: `nota ${index}`,
        cueIn: `entra ${index}`,
        cueOut: `sale ${index}`,
        startSec,
        endSec,
        confidence: confidence || 'alta',
        problems: []
    };
}

const CAMERAS = [
    { name: '1_CAMERA 1.mp4', path: '/curso/Video/1_CAMERA 1.mp4', durationSec: 600 },
    { name: '2_CAMERA 2.mp4', path: '/curso/Video/2_CAMERA 2.mp4', durationSec: 600 }
];

const AUDIOS = [
    { name: '1_COMBO-1.wav', path: '/curso/Audio/1_COMBO-1.wav', durationSec: 600, isLiveMix: false },
    { name: 'Live-Mix.wav', path: '/curso/Audio/Live-Mix.wav', durationSec: 600, isLiveMix: true }
];

module.exports = function (t) {
    t.group('cutplan · qué se queda y con qué cámara');

    t.test('los bloques se pegan uno detrás de otro en la línea de tiempo', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), alignedBlock(1, 300, 320)],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.eq(plan.segments[0].timelineStartSec, 0);
        t.eq(plan.segments[0].timelineEndSec, 30);
        t.eq(plan.segments[1].timelineStartSec, 30, 'el segundo bloque arranca donde termina el primero');
        t.eq(plan.segments[1].timelineEndSec, 50);
        t.eq(plan.totals.keepSec, 50);
    });

    t.group('export · todos los bloques llevan marcador, en dos formas');

    t.test('cada bloque del corte tiene el suyo', () => {
        // En Premiere se salta de marcador en marcador: si falta el de un bloque,
        // ese bloque no se puede alcanzar con esa navegación.
        const plan = cutplan.buildCutplan({
            blocks: [
                alignedBlock(0, 100, 130),
                { ...alignedBlock(1, 200, 220), note: '' },
                { ...alignedBlock(2, 300, 340), note: '' }
            ],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers.length, 3, 'tres bloques, tres marcadores');
        t.eq(cut.markers.filter(m => m.endSec != null).length, 1, 'uno largo, el que tiene nota');
    });

    t.test('la cuenta cierra: un marcador por bloque más los de selección', () => {
        // Con la forma de la clase 1 del curso: 15 bloques, 3 con nota del CD.
        // Esta es la afirmación que faltaba — sin ella, "solo los que dicen algo"
        // pasaba todas las pruebas y dejaba 12 bloques sin manera de alcanzarlos.
        const conNota = new Set([2, 9, 12]);
        const blocks = [];
        for (let i = 0; i < 15; i++) {
            blocks.push({
                ...alignedBlock(i, 100 + i * 50, 130 + i * 50),
                note: conNota.has(i) ? `nota ${i}` : ''
            });
        }
        const plan = cutplan.buildCutplan({
            blocks, videos: CAMERAS, audios: AUDIOS, durationSec: 1000
        });
        const guardadas = {
            bloques: {},
            comentarios: [{ sourceStartSec: 110, sourceEndSec: 115, comentario: 'un comentario mío' }]
        };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);

        const deBloque = cut.markers.filter(m => m.name !== 'Nota');
        t.eq(deBloque.length, 15, 'quince bloques, quince marcadores');
        t.eq(deBloque.filter(m => m.endSec != null).length, 3, 'tres largos, los que tienen nota');
        t.eq(deBloque.filter(m => m.endSec == null).length, 12, 'y doce cortos para saltar');
        t.eq(cut.markers.length, 16, 'más el comentario de selección');
    });

    t.test('sin nota va corto y solo con el nombre de la vista', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '', view: 'R' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers.length, 1);
        t.eq(cut.markers[0].name, 'R');
        t.eq(cut.markers[0].comment, '', 'no dice nada: nadie escribió nada');
        t.eq(cut.markers[0].endSec, null, 'sin duración, que el formato escribe out=-1');
    });

    t.test('el cue no cuenta como nota: es transcript, no algo que alguien escribió', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '', cueIn: 'Antes de la inteligencia artificial generat' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers[0].comment, '', 'el cue no se cuela como comentario');
        t.eq(cut.markers[0].endSec, null, 'y tener cue no lo hace largo');
    });

    t.test('el marcador de un bloque con nota dura el bloque entero', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), { ...alignedBlock(1, 200, 220), note: '' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers[0].startSec, 0);
        t.eq(cut.markers[0].endSec, 30, 'de borde a borde del bloque');
        t.eq(cut.markers[0].comment, 'nota 0');
        t.eq(cut.markers[1].startSec, 30, 'y el corto del siguiente arranca ahí');
        t.eq(cut.markers[1].endSec, null);
    });

    t.test('la nota que corrigió el editor manda sobre la del marcador', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130)],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = { bloques: { 0: { note: 'la corregida' } }, comentarios: [] };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        t.eq(cut.markers[0].comment, 'la corregida');
        t.eq(cut.markers[0].endSec, 30, 'y sigue durando el bloque');
    });

    t.test('escribirle una nota a un bloque que no la tenía lo pasa a largo', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = { bloques: { 0: { note: 'esto lo escribí yo' } }, comentarios: [] };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        t.eq(cut.markers[0].comment, 'esto lo escribí yo');
        t.eq(cut.markers[0].endSec, 30, 'ahora dice algo, así que abarca el bloque');
    });

    t.test('el color del marcador de la nota sigue siendo el que eligió el CD', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), color: 4281740498 }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers[0].color, 4281740498);
    });

    t.group('export · el comentario de una selección es otro objeto');

    t.test('sale blanco y dura lo que duraba la selección', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = {
            bloques: {},
            comentarios: [{ sourceStartSec: 110, sourceEndSec: 114.5, comentario: 'esto se repite después' }]
        };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        t.eq(cut.markers.length, 2, 'el corto del bloque y este');
        const nota = cut.markers.find(m => m.name === 'Nota');
        t.eq(nota.startSec, 10);
        t.eq(nota.endSec, 14.5, 'los 4,5 s de la selección');
        // Blanco de Premiere: el mismo entero que el Rodecaster escribe en sus
        // marcadores de claqueta.
        t.eq(nota.color, 4294967295);
    });

    t.test('una selección que se pasa del corte se recorta en el borde', () => {
        // Lo de más allá del borde no está en la secuencia: un marcador que cruza
        // el corte señalaría material que no es el que se comentó.
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), alignedBlock(1, 300, 320)],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = {
            bloques: {},
            comentarios: [{ sourceStartSec: 128, sourceEndSec: 305, comentario: 'cruza el corte' }]
        };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        const nota = cut.markers.find(m => m.name === 'Nota');
        t.eq(nota.startSec, 28);
        t.eq(nota.endSec, 30, 'hasta donde termina el bloque donde empezó');
    });

    t.test('un comentario en material que quedó afuera no va a ningún lado', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), alignedBlock(1, 300, 320)],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = {
            bloques: {},
            comentarios: [{ sourceStartSec: 200, sourceEndSec: 210, comentario: 'esto se sacó' }]
        };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        t.eq(cut.markers.filter(m => m.name === 'Nota').length, 0);
    });

    t.group('export · los dos XML espejo siguen llevando los marcadores del CD');

    t.test('el marcador del CD conserva sus diez segundos en poblada.xml', () => {
        // Estos dos XML son el espejo del original —sirven para ver si el problema
        // ya estaba antes—, así que ahí los marcadores van todos y con el largo
        // que les puso el CD.
        const parsed = {
            timebase: 30,
            clap: null,
            blocks: [{
                index: 0, view: 'PV', inComment: 'nota - entra', outComment: '',
                startFrame: 3000, endFrame: 3900, inSpanSec: 10, complete: true, color: 4281740498
            }]
        };
        const markers = exporter.markersFromParsed(parsed);
        t.eq(markers.length, 2, 'el de entrada y el de salida');
        t.eq(markers[0].startSec, 100);
        t.eq(markers[0].endSec, 110, 'diez segundos, como en el XML del Rodecaster');
    });

    t.group('export · las pistas quedan por papel');

    /** Una clase con un bloque de cámara y uno de pantalla. */
    function planMixto() {
        return cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'PV'), alignedBlock(1, 30, 40, 'R')],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
    }

    t.test('V1 la cámara, V2 la pantalla, y cada una encendida en su bloque', () => {
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, planMixto(), null);
        t.eq(cut.videoTracks[0][0].enabled, true, 'V1 encendida en el bloque de cámara');
        t.eq(cut.videoTracks[0][1].enabled, false, 'y apagada en el de pantalla');
        t.eq(cut.videoTracks[1][0].enabled, false, 'V2 apagada en el de cámara');
        t.eq(cut.videoTracks[1][1].enabled, true, 'y encendida en el de pantalla');
    });

    t.test('V3 lleva la cámara del profesor, solo en los bloques de pantalla', () => {
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, planMixto(), null);
        t.eq(cut.videoTracks.length, 3, 'hay una pista más para el recuadro');
        const recuadro = cut.videoTracks[2];
        t.eq(recuadro.length, 1, 'un solo clip: el bloque de pantalla');
        t.eq(recuadro[0].source.name, CAMERAS[0].name, 'y es la cámara del profesor');
        t.eq(recuadro[0].enabled, true);
        // El mismo tramo del original que la pantalla: es el mismo momento.
        t.eq(recuadro[0].sourceInSec, 30);
        t.eq(recuadro[0].startSec, 10, 'y va donde va ese bloque en el corte');
    });

    t.test('una clase toda de cámara no estrena pista de recuadro', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'PV'), alignedBlock(1, 30, 40, 'PV')],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.videoTracks.length, 2, 'sin bloques de pantalla no hay recuadro');
    });

    t.test('con una sola cámara no hay recuadro que armar', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'PV')],
            videos: [CAMERAS[0]], audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: [CAMERAS[0]], audios: AUDIOS }, plan, null);
        t.eq(cut.videoTracks.length, 1);
    });

    t.group('cutplan · qué se queda y con qué cámara (sigue)');

    t.test('cada vista va a su cámara', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'PV'), alignedBlock(1, 30, 40, 'R')],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.eq(plan.segments[0].cameraIndex, 0, 'PV es la cámara del presentador');
        t.eq(plan.segments[1].cameraIndex, 1, 'R es la de la pantalla');
    });

    t.test('una vista desconocida no rompe nada: va a la primera cámara y avisa', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'XYZ')],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.eq(plan.segments[0].cameraIndex, 0);
        t.ok(plan.warnings.some(w => w.code === 'vista_desconocida'));
    });

    t.test('con una sola cámara todas las vistas caen en ella', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20, 'R')],
            videos: [CAMERAS[0]], audios: AUDIOS, durationSec: 600
        });
        t.eq(plan.segments[0].cameraIndex, 0);
        t.ok(plan.warnings.some(w => w.code === 'vista_sin_camara'));
    });

    t.test('lo que queda entre bloques es lo que se elimina', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), alignedBlock(1, 300, 320)],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.deep(plan.removed.map(r => [r.startSec, r.endSec]), [[0, 100], [130, 300], [320, 600]]);
        t.eq(plan.totals.removeSec, 550);
    });

    t.test('un bloque desmarcado no entra ni ocupa lugar', () => {
        const blocks = [alignedBlock(0, 100, 130), alignedBlock(1, 300, 320)];
        blocks[0].enabled = false;
        const plan = cutplan.buildCutplan({ blocks, videos: CAMERAS, audios: AUDIOS, durationSec: 600 });
        t.eq(plan.totals.kept, 1);
        t.eq(plan.segments[1].timelineStartSec, 0, 'el que queda arranca en cero');
        t.eq(plan.totals.keepSec, 20);
    });

    t.test('solo el Live-Mix queda sonando', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 20)], videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.deep(plan.audios.map(a => a.enabled), [false, true]);
    });

    t.test('un bloque de menos de un segundo se avisa', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 10, 10.4)], videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        t.ok(plan.warnings.some(w => w.code === 'bloque_corto'));
    });

    t.group('fcp-xml · cuentas de frames');

    t.test('30 exactos no es NTSC', () => {
        const rate = fcp.rateFor(30);
        t.eq(rate.timebase, 30);
        t.eq(rate.ntsc, false);
        t.eq(fcp.toFrames(10, 30), 300);
    });

    t.test('29.97 usa la fracción exacta 30000/1001', () => {
        const rate = fcp.rateFor(29.97);
        t.eq(rate.timebase, 30);
        t.eq(rate.ntsc, true);
        // Una hora a 29.97 son 107892 frames, no 107892.1: el redondeo ingenuo
        // (29.97 * 3600 = 107892.0) coincide acá, pero la fracción es la que
        // aguanta las tres horas sin correrse.
        t.eq(fcp.toFrames(3600, 29.97), 107892);
        t.eq(fcp.toFrames(1, 29.97), 30);
    });

    t.test('los segundos vuelven a ser los mismos al ida y vuelta', () => {
        for (const seconds of [0, 1, 61.5, 3600.25]) {
            const frames = fcp.toFrames(seconds, 30);
            t.near(fcp.framesToSeconds(frames, 30), seconds, 1 / 30);
        }
    });

    t.group('fcp-xml · rutas y escapes');

    t.test('los espacios y las tildes se escapan en la ruta', () => {
        const url = fcp.pathUrl('/Volumes/Extreme SSD/Clase 04 -Default/Nicolás.mp4');
        t.ok(url.startsWith('file://localhost/'), url);
        t.ok(!/ /.test(url), `quedó un espacio sin escapar: ${url}`);
        t.ok(url.includes('Nicol%C3%A1s.mp4'), url);
    });

    t.test('las barras de la ruta no se escapan (si no, el clip queda offline)', () => {
        const url = fcp.pathUrl('/a/b/c.mp4');
        t.eq(url, 'file://localhost/a/b/c.mp4');
    });

    t.test('el comentario del CD con comillas no rompe el XML', () => {
        const safe = fcp.xmlSafe('OUT ANTES DE: "También le estamos diciendo" & <eso>');
        t.ok(!/[<>]/.test(safe.replace(/&[a-z]+;/g, '')), safe);
        t.ok(safe.includes('&quot;'));
        t.ok(safe.includes('&amp;'));
    });

    t.group('fcp-xml · secuencia');

    function build(overrides) {
        return fcp.sequenceXml({
            name: '04_clase',
            fps: 30,
            durationSec: 50,
            videoTracks: [
                [{ source: { path: CAMERAS[0].path, name: CAMERAS[0].name, durationSec: 600 }, startSec: 0, endSec: 30, sourceInSec: 100, enabled: true }],
                [{ source: { path: CAMERAS[1].path, name: CAMERAS[1].name, durationSec: 600 }, startSec: 0, endSec: 30, sourceInSec: 100, enabled: false }]
            ],
            audioTracks: [
                [{ source: { path: AUDIOS[1].path, name: AUDIOS[1].name, durationSec: 600, audioOnly: true }, startSec: 0, endSec: 30, sourceInSec: 100, enabled: true }]
            ],
            markers: [{ name: 'PV', comment: 'nota del CD', startSec: 0, color: 'blue' }],
            ...(overrides || {})
        });
    }

    t.test('la secuencia sale bien formada y con el bin delante', () => {
        const xml = build();
        t.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'falta la cabecera');
        t.ok(xml.indexOf('<bin>') < xml.indexOf('<sequence'), 'el bin tiene que ir antes de la secuencia');
        t.ok(xml.includes('<!DOCTYPE xmeml>'));
    });

    t.test('cada archivo se define una sola vez', () => {
        const xml = build();
        const definiciones = (xml.match(/<pathurl>/g) || []).length;
        t.eq(definiciones, 3, 'dos cámaras y un audio: tres definiciones y nada más');
    });

    t.test('los pedazos de una cámara comparten clip maestro', () => {
        const source = { path: CAMERAS[0].path, name: CAMERAS[0].name, durationSec: 600 };
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 60,
            videoTracks: [[
                { source, startSec: 0, endSec: 30, sourceInSec: 100, enabled: true },
                { source, startSec: 30, endSec: 60, sourceInSec: 400, enabled: true }
            ]],
            audioTracks: [], markers: []
        });
        const ids = (xml.match(/<masterclipid>([^<]+)<\/masterclipid>/g) || []);
        t.eq(new Set(ids).size, 1, `deberían compartir el maestro: ${ids.join(', ')}`);
    });

    t.test('la cámara que no toca entra deshabilitada, no se borra', () => {
        const xml = build();
        t.ok(/<enabled>FALSE<\/enabled>/.test(xml), 'tiene que haber un clip apagado');
        t.eq((xml.match(/<clipitem id="clipitem-/g) || []).length, 3, 'los tres clips van igual');
    });

    t.test('el corte usa el tramo pedido del origen', () => {
        const xml = build();
        const first = xml.match(/<clipitem id="clipitem-1"[\s\S]*?<\/clipitem>/)[0];
        t.ok(first.includes('<start>0</start>'), first.slice(0, 200));
        t.ok(first.includes('<end>900</end>'), '30 s a 30 fps son 900 frames');
        t.ok(first.includes('<in>3000</in>'), 'el origen arranca en el segundo 100');
        t.ok(first.includes('<out>3900</out>'));
    });

    t.test('el marcador de punto lleva out -1', () => {
        const xml = build();
        const marker = xml.match(/<marker>[\s\S]*?<\/marker>/)[0];
        t.ok(marker.includes('<in>0</in>'));
        t.ok(marker.includes('<out>-1</out>'), marker);
        t.ok(marker.includes('nota del CD'));
    });

    t.test('un marcador con duración conserva su tramo', () => {
        const xml = build({ markers: [{ name: 'PV', comment: 'x', startSec: 10, endSec: 20, color: 'blue' }] });
        const marker = xml.match(/<marker>[\s\S]*?<\/marker>/)[0];
        t.ok(marker.includes('<in>300</in>'), marker);
        t.ok(marker.includes('<out>600</out>'), marker);
    });

    t.test('cada pista de audio sale por su par de canales', () => {
        const source = { path: '/a.wav', name: 'a.wav', durationSec: 10, audioOnly: true };
        const other = { path: '/b.wav', name: 'b.wav', durationSec: 10, audioOnly: true };
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10,
            videoTracks: [],
            audioTracks: [
                [{ source, startSec: 0, endSec: 10, sourceInSec: 0, enabled: true }],
                [{ source: other, startSec: 0, endSec: 10, sourceInSec: 0, enabled: false }]
            ],
            markers: []
        });
        const channels = (xml.match(/<outputchannelindex>(\d+)<\/outputchannelindex>/g) || [])
            .map(m => Number(m.replace(/\D/g, '')));
        t.deep(channels, [1, 3], 'estéreo: cada pista ocupa dos canales');
    });
};
