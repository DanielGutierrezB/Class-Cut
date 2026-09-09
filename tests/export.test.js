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

    t.group('export · solo lleva marcador el bloque que tiene algo escrito');

    t.test('el bloque sin nota no lleva nada', () => {
        // Antes iban todos, y los mudos iban de un frame con el nombre de la
        // vista, para poder saltar de bloque en bloque. Con la vista ya elegida y
        // encendida en su pista, esa raya no dice nada que el clip no diga.
        const plan = cutplan.buildCutplan({
            blocks: [
                alignedBlock(0, 100, 130),
                { ...alignedBlock(1, 200, 220), note: '' },
                { ...alignedBlock(2, 300, 340), note: '' }
            ],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers.length, 1, 'de tres bloques, uno solo escribió algo');
        t.eq(cut.markers[0].endSec != null, true, 'y abarca su bloque entero');
    });

    t.test('la cuenta cierra: los que dicen algo más los de selección', () => {
        // Con la forma de la clase 1 del curso: 15 bloques, 3 con nota del CD.
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
        t.eq(deBloque.length, 3, 'tres bloques con nota, tres marcadores');
        t.eq(deBloque.every(m => m.endSec != null), true, 'los tres abarcan su bloque');
        t.eq(cut.markers.length, 4, 'más el comentario de selección');
    });

    t.test('un bloque que el editor comentó después sí lleva', () => {
        // El CD no escribió nada, pero el editor sí: la nota corregida manda, y
        // es la única razón por la que este bloque aparece en la regla.
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '', view: 'R' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const guardadas = { bloques: { 0: { note: 'esto lo escribí yo' } }, comentarios: [] };
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, guardadas);
        t.eq(cut.markers.length, 1);
        t.eq(cut.markers[0].name, 'R');
        t.eq(cut.markers[0].comment, 'esto lo escribí yo');
        t.eq(cut.markers[0].endSec != null, true, 'y dura lo que dura el bloque');
    });

    t.test('el cue no cuenta como nota: es transcript, no algo que alguien escribió', () => {
        const plan = cutplan.buildCutplan({
            blocks: [{ ...alignedBlock(0, 100, 130), note: '', cueIn: 'Antes de la inteligencia artificial generat' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers.length, 0, 'tener cue no le da marcador a un bloque mudo');
    });

    t.test('el marcador de un bloque con nota dura el bloque entero', () => {
        const plan = cutplan.buildCutplan({
            blocks: [alignedBlock(0, 100, 130), { ...alignedBlock(1, 200, 220), note: '' }],
            videos: CAMERAS, audios: AUDIOS, durationSec: 600
        });
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, plan, null);
        t.eq(cut.markers.length, 1, 'el segundo bloque no escribió nada');
        t.eq(cut.markers[0].startSec, 0);
        t.eq(cut.markers[0].endSec, 30, 'de borde a borde del bloque');
        t.eq(cut.markers[0].comment, 'nota 0');
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
        t.eq(cut.markers.length, 1, 'el bloque no escribió nada: queda solo este');
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

    t.test('el clip del recuadro llega con su encuadre y los demás sin nada', () => {
        // Sin esto el editor tiene que escalar y ubicar el recuadro a mano en cada
        // bloque de pantalla. Y al revés importa igual: un encuadre colado en un
        // clip a pantalla completa lo achicaría sin que nadie lo haya pedido.
        const cut = exporter.cutTracks({ videos: CAMERAS, audios: AUDIOS }, planMixto(), null);
        t.eq(cut.videoTracks[2][0].encuadre.escala, 30, 'el 30 % del alto que pide el visor');
        t.eq(cut.videoTracks[0][0].encuadre, undefined, 'la cámara a pantalla completa, sin nada');
        t.eq(cut.videoTracks[1][1].encuadre, undefined, 'y la pantalla tampoco');
    });

    t.group('fcp-xml · el encuadre del recuadro sale de visor.css');

    /** Lo que se ve en pantalla, en píxeles, según lo que dice el encuadre. */
    function loQueSeVe(e, ancho = 1920, alto = 1080) {
        return {
            ancho: ancho * (1 - (e.recorte.izq + e.recorte.der) / 100) * e.escala / 100,
            alto: alto * (1 - (e.recorte.arriba + e.recorte.abajo) / 100) * e.escala / 100
        };
    }

    t.test('el recuadro sale con la proporción que el editor usa en Premiere', () => {
        // 1,14, que es lo que deja su Recorte redondeado de 18 % por lado sobre
        // 16:9 — y lo que se mide en su monitor. Si esto se afloja, el recuadro
        // llega 16:9 entero y se nota.
        const v = loQueSeVe(fcp.encuadreDelRecuadro());
        t.near(v.ancho / v.alto, 0.64 * 16 / 9, 0.001, 'ni cuadrado ni 16:9');
        t.near(v.alto, 0.30 * 1080, 0.01, 'y mide el 30 % del alto del cuadro');
    });

    t.test('el recorte es simétrico, que es lo que deja el recuadro en su lugar', () => {
        // El recorte de Premiere no reencuadra: solo vuelve transparente lo que
        // saca. Simétrico, el centro de lo que se ve sigue siendo el centro del
        // clip y la posición lo ubica. Desparejo, el recuadro se correría.
        const { recorte } = fcp.encuadreDelRecuadro();
        t.eq(recorte.izq, recorte.der, 'lo que se saca de un lado se saca del otro');
        t.eq(recorte.arriba, 0, 'y el alto queda entero: la forma sale del ancho');
        t.eq(recorte.abajo, 0);
    });

    t.test('el recuadro queda pegado abajo a la derecha, a 2,5 % y 4,4 %', () => {
        // Esta es la que atrapa el error que ya llegó a Premiere una vez: copiando
        // los números del export del editor, la caja quedaba por el medio del
        // cuadro. La cuenta va al revés de `aUnidadesDelCuadro`, de las unidades
        // del formato de vuelta a píxeles, para leer el margen de cada borde.
        const e = fcp.encuadreDelRecuadro();
        const v = loQueSeVe(e);
        const x = 1920 / 2 + e.centro.horiz * 1920;
        const y = 1080 / 2 + e.centro.vert * 1080;
        t.near(1920 - (x + v.ancho / 2), 0.025 * 1920, 0.01, '2,5 % del borde derecho');
        t.near(1080 - (y + v.alto / 2), 0.044 * 1080, 0.01, '4,4 % del inferior');
    });

    t.test('el anclaje se queda en el centro de la fuente', () => {
        // Moverlo obliga a compensar la posición: dos números para decir uno, y
        // dos lugares donde equivocarse.
        const { anclaje } = fcp.encuadreDelRecuadro();
        t.deep(anclaje, { horiz: 0, vert: 0 });
    });

    t.test('una fuente cuadrada se recorta de arriba y abajo, no de los lados', () => {
        // Con el recorte dicho como «18 % de los costados» esto salía deformado:
        // una cámara cuadrada quedaba más alta que ancha. Dicho como proporción,
        // se saca del lado que sobra y el recuadro se ve igual venga de donde
        // venga.
        const e = fcp.encuadreDelRecuadro({ fuenteAncho: 1080, fuenteAlto: 1080 });
        t.eq(e.recorte.izq, 0, 'el ancho ya es el que falta, no se toca');
        t.eq(e.recorte.arriba, e.recorte.abajo, 'y lo que sobra de alto sale parejo');
        const v = loQueSeVe(e, 1080, 1080);
        t.near(v.ancho / v.alto, 0.64 * 16 / 9, 0.001, 'misma proporción que con 16:9');
        t.near(v.alto, 0.30 * 1080, 0.01, 'y el mismo alto en pantalla');
    });

    t.test('las unidades del centro se dividen por el cuadro entero', () => {
        // La cuenta que confirmaron los archivos que escribió Premiere: un punto
        // corrido 285 px a la izquierda del centro de un cuadro de 3840 se escribe
        // −0,0742188. Con la mitad del cuadro daría el doble.
        const p = fcp.aUnidadesDelCuadro(3840 / 2 - 285, 2160 / 2 - 884, 3840, 2160);
        t.eq(p.horiz, -0.074219);
        t.eq(p.vert, -0.409259);
    });

    t.test('el centro del cuadro es el cero', () => {
        t.deep(fcp.aUnidadesDelCuadro(960, 540, 1920, 1080), { horiz: 0, vert: 0 });
    });

    t.group('fcp-xml · los filtros del recuadro');

    t.test('el recuadro escribe un Basic Motion y nada más', () => {
        const xml = fcp.encuadreXml(fcp.encuadreDelRecuadro());
        t.eq((xml.match(/<filter>/g) || []).length, 1, 'un solo filtro');
        t.ok(xml.includes('<effectid>basic</effectid>'), xml);
        t.ok(xml.includes('<parameterid>leftcrop</parameterid>'), 'el recorte va adentro');
        t.ok(!xml.includes('<effectid>crop</effectid>'), 'y no hay filtro de recorte aparte');
    });

    t.test('el dialecto de afuera saca el recorte a su propio filtro', () => {
        const xml = fcp.encuadreXml(fcp.encuadreDelRecuadro({
            dialectoDelRecorte: fcp.RECORTE_APARTE
        }));
        t.eq((xml.match(/<filter>/g) || []).length, 2, 'Basic Motion y Crop');
        t.ok(xml.includes('<effectid>crop</effectid>'), xml);
        // Los dos a la vez recortarían dos veces si Premiere entendiera ambos.
        const basic = xml.slice(0, xml.indexOf('<effectid>crop</effectid>'));
        t.ok(/<parameterid>leftcrop<\/parameterid><name>Left<\/name>[^]*?<value>0<\/value>/.test(basic),
            'los de Basic Motion quedan en cero');
    });

    t.test('un clip sin encuadre no lleva ningún filtro', () => {
        // Lo importante del otro lado: si un filtro mal escrito puede hacer que
        // Premiere rechace el XML entero, los clips que no lo necesitan no lo llevan.
        t.eq(fcp.encuadreXml(null), '');
        t.eq(fcp.encuadreXml(undefined), '');
    });

    t.test('en el XML de la clase el filtro está solo en la pista del recuadro', () => {
        // La prueba que importa de verdad: un encuadre colado en un clip a
        // pantalla completa lo achica, y un filtro mal puesto puede hacer que
        // Premiere rechace el archivo entero. Se cuenta por pista sobre el XML ya
        // escrito, que es lo que el editor abre.
        const cls = { videos: CAMERAS, audios: AUDIOS, width: 1920, height: 1080 };
        const cut = exporter.cutTracks(cls, planMixto(), null);
        const xml = fcp.sequenceXml({
            name: 'clase', fps: 30, width: 1920, height: 1080,
            videoTracks: cut.videoTracks, audioTracks: cut.audioTracks,
            markers: cut.markers, durationSec: cut.durationSec
        });
        // Las pistas de la secuencia son las únicas que llevan atributos TL.SQ*;
        // las de los clips maestros del bin van sin nada.
        const pistas = xml.match(/<track TL\.SQTrackShy[^>]*>[\s\S]*?<\/track>/g) || [];
        const conFiltro = pistas.map(p => (p.match(/<filter>/g) || []).length);
        t.deep(conFiltro, [0, 0, 1], 'V1 y V2 sin filtros, V3 con el del recuadro');
    });

    t.test('el encuadre entra adentro del clipitem y después del file', () => {
        // Es el orden en el que lo escribe Premiere en su propio export.
        const source = { path: '/curso/Video/1_CAMERA 1.mp4', name: '1_CAMERA 1.mp4', durationSec: 600 };
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10, audioTracks: [], markers: [],
            videoTracks: [[{
                source, startSec: 0, endSec: 10, sourceInSec: 0, enabled: true,
                encuadre: fcp.encuadreDelRecuadro()
            }]]
        });
        const clip = xml.match(/<clipitem id="clipitem-1"[\s\S]*?<\/clipitem>/)[0];
        t.ok(clip.includes('<effectid>basic</effectid>'), 'el filtro va adentro del clipitem');
        t.ok(clip.indexOf('</file>') < clip.indexOf('<filter>'), 'y después del file');
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
        // Dos cámaras y un audio estéreo, que son dos clipitem: uno por canal.
        t.eq((xml.match(/<clipitem id="clipitem-/g) || []).length, 4, 'no se cae ninguno');
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

    // ── El audio, canal por canal ─────────────────────────────────────────
    //
    // Todo lo de acá abajo está medido contra el XML que exportó el Premiere del
    // editor con el material de la clase 11 (dos cámaras estéreo, ocho WAV
    // estéreo y dos WAV mono). Mientras el XML decía un solo canal por clip,
    // Premiere hacía lo que se le pedía: partía cada clip en canales sueltos.

    const wav = (name, channels) => ({
        path: `/curso/Audio/${name}`, name, durationSec: 10, audioOnly: true, channels
    });
    const conAudios = fuentes => fcp.sequenceXml({
        name: 'x', fps: 30, durationSec: 10, videoTracks: [], markers: [],
        audioTracks: fuentes.map(source =>
            [{ source, startSec: 0, endSec: 10, sourceInSec: 0, enabled: true }])
    });
    const pistas = xml => xml.match(/<track TL\.SQTrackAudio[\s\S]*?<\/track>/g) || [];

    t.test('una fuente estéreo son dos pistas explotadas y no una', () => {
        const xml = conAudios([wav('Live-Mix.wav', 2)]);
        const p = pistas(xml);
        t.eq(p.length, 2, 'un canal por pista: el estéreo ocupa dos');
        t.ok(p[0].includes('currentExplodedTrackIndex="0" totalExplodedTrackCount="2"'), p[0].slice(0, 200));
        t.ok(p[1].includes('currentExplodedTrackIndex="1" totalExplodedTrackCount="2"'), p[1].slice(0, 200));
        t.ok(p[0].includes('<trackindex>1</trackindex>'), 'la izquierda pide el canal 1');
        t.ok(p[1].includes('<trackindex>2</trackindex>'), 'la derecha pide el canal 2');
        t.eq((xml.match(/premiereChannelType="stereo"/g) || []).length, 2);
    });

    t.test('los dos canales de un estéreo se nombran entre sí', () => {
        // Sin esto son dos objetos sueltos: se mueven por separado y una
        // selección de puro audio no se deja anidar.
        const xml = conAudios([wav('Live-Mix.wav', 2)]);
        const enlaces = xml.match(/<link>[\s\S]*?<\/link>/g) || [];
        t.eq(enlaces.length, 4, 'los dos clipitem llevan la lista entera');
        t.ok(enlaces[0].includes('<linkclipref>clipitem-1</linkclipref>'), enlaces[0]);
        t.ok(enlaces[1].includes('<linkclipref>clipitem-2</linkclipref>'), enlaces[1]);
        t.ok(enlaces.every(e => e.includes('<groupindex>1</groupindex>')), 'son un grupo de canales');
        t.eq(enlaces[0], enlaces[2], 'los dos hermanos dicen lo mismo');
    });

    t.test('un WAV mono del Rodecaster va en una sola pista, y mono', () => {
        // La regla no es la misma para todos: de los diez WAV que graba el
        // Rodecaster, los dos COMBO son mono de verdad. Partirlos en dos pediría
        // un canal 2 que no existe y dejaría medio clip en silencio.
        const xml = conAudios([wav('1_COMBO-1.wav', 1)]);
        const p = pistas(xml);
        t.eq(p.length, 1, 'un canal, una pista');
        t.ok(p[0].includes('totalExplodedTrackCount="1"'), p[0].slice(0, 200));
        t.ok(p[0].includes('premiereChannelType="mono"'), 'el clip se declara mono');
        t.ok(!xml.includes('<link>'), 'un mono no tiene hermano al que nombrar');
        t.ok(xml.includes('<channelcount>1</channelcount><audiochannel><sourcechannel>1</sourcechannel></audiochannel>'),
            'el archivo nombra su único canal');
    });

    t.test('mono y estéreo conviven, cada uno con su forma', () => {
        const xml = conAudios([wav('1_COMBO-1.wav', 1), wav('3_HDMI-2.wav', 2)]);
        const p = pistas(xml);
        t.eq(p.length, 3, 'una del mono y dos del estéreo');
        t.deep(p.map(t2 => /totalExplodedTrackCount="(\d)"/.exec(t2)[1]), ['1', '2', '2']);
    });

    t.test('las pistas salen por los dos canales del máster y no por veinte', () => {
        // El defecto viejo sumaba de a dos —1, 3, 5… hasta 19— contra un máster
        // declarado de dos canales. Pedir salidas que no existen es lo que le
        // hace armar a Premiere un máster multicanal en vez de uno estéreo.
        const xml = conAudios([wav('a.wav', 1), wav('b.wav', 1), wav('c.wav', 2)]);
        const canales = (xml.match(/<outputchannelindex>(\d+)<\/outputchannelindex>/g) || [])
            .map(m => Number(m.replace(/\D/g, '')));
        t.deep(canales, [1, 2, 1, 2], 'los mono alternan; el par explotado es izquierda y derecha');
    });

    t.test('la secuencia se declara explotada y con máster estéreo', () => {
        const xml = conAudios([wav('a.wav', 2)]);
        t.ok(xml.includes('<sequence id="sequence-1" explodedTracks="true">'), 'sin esto no se vuelven a juntar');
        t.ok(xml.includes('<numOutputChannels>2</numOutputChannels>'));
        t.ok(xml.includes('<outputs><group><index>1</index>'), 'el máster va canal por canal');
        t.eq((xml.match(/<group>/g) || []).length, 2, 'estéreo: dos salidas y nada más');
    });

    t.test('el clip maestro del bin también sabe cuántos canales tiene', () => {
        const xml = conAudios([wav('a.wav', 2)]);
        const bin = xml.slice(xml.indexOf('<bin>'), xml.indexOf('</bin>'));
        t.eq((bin.match(/<clipitem id="bin-a/g) || []).length, 2, 'uno por canal');
        t.ok(bin.includes('bin-a1-') && bin.includes('bin-a2-'), bin);
    });
};
