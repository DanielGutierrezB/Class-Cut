'use strict';
/**
 * La lectura de vuelta de los XML que escribe Class Cut.
 *
 * Es la parte con más riesgo de las tres, porque es la única que interpreta algo
 * que escribió otro módulo. Si `export.js` cambia cómo declara una pista, esto
 * lo tiene que notar acá y no en el `.prproj` de un curso de trece clases.
 *
 * Los XML de las pruebas se escriben a mano y cortos, con la forma exacta que
 * tienen los reales: se sacaron de `The Cutter/` de un curso del disco y se
 * podaron hasta lo que cada prueba mira.
 */

const lector = require('../engine/clase-del-xml');

/** Un XML de clase armable por partes, con la forma que escribe `export.js`. */
function xml(partes) {
    const p = partes || {};
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE xmeml>',
        '<xmeml version="4">',
        p.firma || '',
        '<sequence id="sequence-1">',
        `<name>${p.nombre || '01_la-clase'}</name>`,
        `<duration>${p.duracion == null ? 300 : p.duracion}</duration>`,
        `<rate><timebase>${p.timebase || 30}</timebase><ntsc>${p.ntsc || 'FALSE'}</ntsc></rate>`,
        '<media>',
        '<video>',
        '<format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>',
        ...(p.video || []),
        '</video>',
        '<audio>',
        ...(p.audio || []),
        '</audio>',
        '</media>',
        ...(p.marcadores || []),
        '</sequence>',
        '</xmeml>'
    ].join('\n');
}


/** Una definición de archivo del bin, que es donde vive lo que se sabe del medio. */
function archivo(o) {
    const partes = [
        `<file id="${o.id}">`,
        `<name>${o.nombre}</name>`,
        `<pathurl>file://localhost${o.url}</pathurl>`,
        `<rate><timebase>${o.timebase || 30}</timebase><ntsc>FALSE</ntsc></rate>`,
        `<duration>${o.duracion == null ? 9000 : o.duracion}</duration>`
    ];
    if (o.conVideo) partes.push('<media><video><samplecharacteristics/></video></media>');
    if (o.canales != null) {
        partes.push(`<audio><channelcount>${o.canales}</channelcount><samplerate>48000</samplerate></audio>`);
    }
    partes.push('</file>');
    return partes.join('');
}

function clip(o) {
    const partes = [
        '<clipitem id="' + (o.id || 'clipitem-1') + '">',
        `<name>${o.nombre || 'x'}</name>`,
        `<enabled>${o.sonando === false ? 'FALSE' : 'TRUE'}</enabled>`,
        `<start>${o.desde == null ? 0 : o.desde}</start>`,
        `<end>${o.hasta}</end>`,
        `<in>${o.entrada == null ? 0 : o.entrada}</in>`,
        `<out>${o.salida == null ? o.hasta : o.salida}</out>`
    ];
    if (o.etiqueta) partes.push(`<labels><label2>${o.etiqueta}</label2></labels>`);
    partes.push(`<file id="${o.archivo}"/>`);
    if (o.canal) partes.push(`<sourcetrack><mediatype>audio</mediatype><trackindex>${o.canal}</trackindex></sourcetrack>`);
    if (o.conEfecto) partes.push('<filter><effect><name>Basic Motion</name></effect></filter>');
    partes.push('</clipitem>');
    return partes.join('');
}

function pista(clips) {
    return `<track>${clips.join('')}</track>`;
}

const CAMARA = { id: 'file-1', nombre: '1_CAMERA 1.mp4', url: '/Users/x/Video/1_CAMERA%201.mp4', conVideo: true, canales: 2 };
const COMBO = { id: 'file-2', nombre: '1_COMBO-1.wav', url: '/Users/x/Audio/1_COMBO-1.wav', canales: 1 };
const HDMI = { id: 'file-3', nombre: '3_HDMI-2.wav', url: '/Users/x/Audio/3_HDMI-2.wav', canales: 2 };

module.exports = t => {

    t.group('el XML de clase · la cabecera');

    t.test('salen el nombre, los cuadros y el tamaño', () => {
        const r = lector.leerXml(xml({ nombre: '07_una-clase' }));
        t.ok(r.ok);
        t.eq(r.nombre, '07_una-clase');
        t.eq(r.fps, 30);
        t.eq(r.ancho, 1920);
        t.eq(r.alto, 1080);
    });

    t.test('el NTSC da los cuadros nominales y no el entero', () => {
        // Con 30 en vez de 29,97 un marcador se separa de su clip un cuadro cada
        // pocos minutos, que en una clase de una hora ya se ve.
        const r = lector.leerXml(xml({ timebase: 30, ntsc: 'TRUE' }));
        t.near(r.fps, 29.97, 0.001);
        const m = lector.leerXml(xml({
            timebase: 30, ntsc: 'TRUE',
            marcadores: ['<marker><name>PV</name><comment>x</comment><in>30000</in><out>-1</out><pproColor>1</pproColor></marker>']
        })).marcadores[0];
        t.near(m.desdeSeg, 1001, 0.0001, 'mil cuadros a 29,97 son 1001 segundos justos');
    });

    t.test('sin <sequence> se contesta que no es un XML de Class Cut', () => {
        const r = lector.leerXml('<xmeml version="4"></xmeml>');
        t.ok(!r.ok);
        t.ok(/no tiene una <sequence>/.test(r.error));
    });

    t.test('la firma de las notas en vivo se reconoce', () => {
        t.eq(lector.leerXml(xml({})).deNotasEnVivo, false);
        t.eq(lector.leerXml(xml({ firma: '<!-- class-cut: notas-en-vivo v1 -->' })).deNotasEnVivo, true);
    });


    t.group('el XML de clase · los archivos');

    t.test('la ruta vuelve desescapada', () => {
        // `pathUrl` de `fcp-xml.js` escapa cada segmento, así que "1_CAMERA 1.mp4"
        // viaja como "1_CAMERA%201.mp4". Sin desescapar, el clip apuntaría a un
        // archivo que no existe y Premiere lo mostraría faltante.
        const r = lector.leerXml(xml({ video: [archivo(CAMARA)] }));
        t.eq(r.archivos.get('file-1').ruta, '/Users/x/Video/1_CAMERA 1.mp4');
    });

    t.test('un nombre con acentos y espacios sobrevive la ida y la vuelta', () => {
        const raro = { id: 'file-9', nombre: 'Clase 04 - Introducción.mp4', conVideo: true, canales: 2,
            url: '/Users/x/' + encodeURIComponent('Clase 04 - Introducción.mp4') };
        const r = lector.leerXml(xml({ video: [archivo(raro)] }));
        t.eq(r.archivos.get('file-9').ruta, '/Users/x/Clase 04 - Introducción.mp4');
    });

    t.test('el recuento de canales es el que midió ffprobe, no una suposición', () => {
        // Es la distinción que arregló el commit 88327d4: los dos COMBO del
        // Rodecaster son micrófonos mono y los otros ocho WAV son estéreo. El
        // número está en el XML porque lo puso ffprobe al generarlo, así que acá
        // se lee y no se vuelve a medir.
        const r = lector.leerXml(xml({ video: [archivo(COMBO), archivo(HDMI)] }));
        t.eq(r.archivos.get('file-2').canales, 1, 'el COMBO es mono');
        t.eq(r.archivos.get('file-3').canales, 2, 'el HDMI es estéreo');
    });

    t.test('sin recuento se supone estéreo, y más de dos se topa en dos', () => {
        const sin = { id: 'file-4', nombre: 'x.wav', url: '/tmp/x.wav' };
        const seis = { id: 'file-5', nombre: 'y.wav', url: '/tmp/y.wav', canales: 6 };
        const r = lector.leerXml(xml({ video: [archivo(sin), archivo(seis)] }));
        t.eq(r.archivos.get('file-4').canales, 2, 'sin dato, el caso común');
        t.eq(r.archivos.get('file-5').canales, 2, 'se topa igual que canalesDe en fcp-xml');
    });

    t.test('el video se reconoce por traer bloque de video', () => {
        const r = lector.leerXml(xml({ video: [archivo(CAMARA), archivo(COMBO)] }));
        t.eq(r.archivos.get('file-1').conVideo, true);
        t.eq(r.archivos.get('file-2').conVideo, false);
    });


    t.group('el XML de clase · los cortes');

    t.test('los tiempos salen en segundos y la etiqueta se lee del XML', () => {
        // La etiqueta NO se recalcula: la regla —cerúleo a la cámara, rosa al
        // grabador de pantalla— vive en `fcp-xml.js` y ya se aplicó al escribir
        // esto. Decidirla otra vez acá sería tenerla en dos lugares.
        const r = lector.leerXml(xml({
            video: [archivo(CAMARA), pista([clip({ archivo: 'file-1', desde: 0, hasta: 371, entrada: 2744, etiqueta: 'Cerulean' })])]
        }));
        const c = r.pistas.video[0].cortes[0];
        t.near(c.desdeSeg, 0, 1e-9);
        t.near(c.hastaSeg, 371 / 30, 1e-9);
        t.near(c.entradaSeg, 2744 / 30, 1e-9);
        t.eq(c.etiqueta, 'Cerulean');
        t.eq(c.sonando, true);
    });

    t.test('un <enabled>FALSE</enabled> es una pista que entra apagada', () => {
        // Nueve de las diez pistas de audio entran así: están para tenerlas a
        // mano, no para escucharlas todas a la vez.
        const r = lector.leerXml(xml({
            video: [archivo(COMBO)],
            audio: [pista([clip({ archivo: 'file-2', hasta: 100, sonando: false })])]
        }));
        t.eq(r.pistas.audio[0].cortes[0].sonando, false);
    });

    t.test('un corte con el recuadro puesto se marca, y se cuentan', () => {
        const r = lector.leerXml(xml({
            video: [archivo(CAMARA),
                pista([clip({ archivo: 'file-1', hasta: 100 })]),
                pista([clip({ archivo: 'file-1', hasta: 50, conEfecto: true }),
                    clip({ archivo: 'file-1', desde: 50, hasta: 90, conEfecto: true })])]
        }));
        t.eq(r.pistas.video[0].cortes[0].conEfecto, false);
        t.eq(r.pistas.video[1].cortes[0].conEfecto, true);
        t.eq(r.conEfectos, 2, 'para poder decir cuántos entran sin encuadre');
    });


    t.test('un corte que nombra un archivo que no está se saltea y se avisa', () => {
        const r = lector.leerXml(xml({
            video: [archivo(CAMARA), pista([clip({ archivo: 'file-1', hasta: 100 }), clip({ archivo: 'file-77', hasta: 200 })])]
        }));
        t.eq(r.pistas.video[0].cortes.length, 1, 'el bueno entra');
        t.eq(r.avisos.length, 1);
        t.ok(/file-77/.test(r.avisos[0]), 'y el aviso dice cuál era');
    });

    t.test('la duración es donde termina el último corte', () => {
        // Se usa para el zoom de la línea de tiempo. La nominal del XML puede ser
        // el largo del material y no el del corte, y con esa la secuencia abriría
        // con los clips convertidos en una raya.
        const r = lector.leerXml(xml({
            duracion: 90000,
            video: [archivo(CAMARA), pista([clip({ archivo: 'file-1', hasta: 300 })])]
        }));
        t.near(r.duracionSeg, 10, 1e-9);
    });

    t.test('sin cortes se cae a la duración nominal', () => {
        t.near(lector.leerXml(xml({ duracion: 600 })).duracionSeg, 20, 1e-9);
    });


    t.group('el XML de clase · volver a juntar el estéreo');

    t.test('un par explotado vuelve a ser una pista', () => {
        // **Es la ganancia grande del .prproj.** En el XML de intercambio una
        // pista de audio lleva un canal, así que un clip estéreo son dos
        // `clipitem` en dos pistas. En un `.prproj` el estéreo se declara, y un
        // clip estéreo es un clip en una pista: el baile que el XML tuvo que
        // hacer no hace falta, y se deshace acá.
        const izq = pista([clip({ archivo: 'file-3', desde: 0, hasta: 100, entrada: 50, canal: 1 })]);
        const der = pista([clip({ archivo: 'file-3', desde: 0, hasta: 100, entrada: 50, canal: 2 })]);
        const r = lector.leerXml(xml({ video: [archivo(HDMI)], audio: [izq, der] }));
        t.eq(r.pistas.audio.length, 1, 'las dos pistas del par son una sola');
        t.eq(r.pistas.audio[0].cortes.length, 1);
    });

    t.test('el mismo archivo en dos pistas con cortes distintos NO se junta', () => {
        // El molde del editor tiene el Live-Mix en dos pistas a propósito.
        // Juntarlas por tener el mismo archivo perdería la mitad de los cortes.
        const una = pista([clip({ archivo: 'file-3', desde: 0, hasta: 100 })]);
        const otra = pista([clip({ archivo: 'file-3', desde: 200, hasta: 300 })]);
        const r = lector.leerXml(xml({ video: [archivo(HDMI)], audio: [una, otra] }));
        t.eq(r.pistas.audio.length, 2);
    });

    t.test('dos pistas de archivos distintos no se juntan nunca', () => {
        const r = lector.leerXml(xml({
            video: [archivo(COMBO), archivo(HDMI)],
            audio: [pista([clip({ archivo: 'file-2', hasta: 100 })]), pista([clip({ archivo: 'file-3', hasta: 100 })])]
        }));
        t.eq(r.pistas.audio.length, 2);
    });

    t.test('solo se juntan las pistas pegadas, no dos separadas por otra', () => {
        // El par explotado se escribe siempre en pistas consecutivas. Juntar dos
        // que tienen una tercera en el medio reordenaría el audio de la clase.
        const a = pista([clip({ archivo: 'file-3', hasta: 100 })]);
        const b = pista([clip({ archivo: 'file-2', hasta: 100 })]);
        const r = lector.leerXml(xml({ video: [archivo(COMBO), archivo(HDMI)], audio: [a, b, a] }));
        t.eq(r.pistas.audio.length, 3);
    });

    t.test('diez fuentes distintas quedan en diez pistas', () => {
        // Es la forma de los XML reales del curso del disco: una pista por fuente
        // del Rodecaster, sin explotar.
        const archivos = [];
        const pistas = [];
        for (let i = 0; i < 10; i++) {
            archivos.push(archivo({ id: `file-${i}`, nombre: `${i}.wav`, url: `/tmp/${i}.wav`, canales: 2 }));
            pistas.push(pista([clip({ archivo: `file-${i}`, hasta: 100 })]));
        }
        const r = lector.leerXml(xml({ video: archivos, audio: pistas }));
        t.eq(r.pistas.audio.length, 10);
    });


    t.group('el XML de clase · los marcadores');

    t.test('el comentario, el nombre y el entero de color llegan enteros', () => {
        // El entero es el punto de todo esto: `pproColor` es el color nativo y en
        // el `.prproj` viaja como número, sin pasar por los once nombres fijos a
        // los que el XML de intercambio lo degradaba.
        const r = lector.leerXml(xml({
            marcadores: ['<marker><comment>OUT ANTES DE: &quot;En Spec&quot;</comment>'
                + '<name>PV</name><in>1178</in><out>1557</out><pproColor>4281740498</pproColor></marker>']
        }));
        const m = r.marcadores[0];
        t.eq(m.nombre, 'PV');
        t.eq(m.comentario, 'OUT ANTES DE: "En Spec"', 'las entidades vuelven a ser comillas');
        t.eq(m.color, 4281740498);
        t.near(m.desdeSeg, 1178 / 30, 1e-9);
        t.near(m.hastaSeg, 1557 / 30, 1e-9);
    });

    t.test('un <out> de -1 es un marcador de punto y no una duración negativa', () => {
        const r = lector.leerXml(xml({
            marcadores: ['<marker><comment>x</comment><name>K</name><in>300</in><out>-1</out><pproColor>7</pproColor></marker>']
        }));
        t.eq(r.marcadores[0].desdeSeg, r.marcadores[0].hastaSeg, 'arranca y termina en el mismo cuadro');
    });

    t.test('un marcador sin <in> válido no entra', () => {
        const r = lector.leerXml(xml({
            marcadores: ['<marker><comment>x</comment><name>K</name><in>-1</in><out>-1</out><pproColor>7</pproColor></marker>']
        }));
        t.eq(r.marcadores.length, 0);
    });

    t.test('los marcadores del bin no se cuelan entre los de la secuencia', () => {
        // Los clips maestros del bin también pueden traer marcadores, y buscarlos
        // en el archivo entero mezclaría los del material con los de la clase.
        const conBin = xml({ marcadores: ['<marker><comment>de la clase</comment><name>PV</name><in>10</in><out>20</out><pproColor>1</pproColor></marker>'] })
            .replace('<sequence id="sequence-1">',
                '<clip id="masterclip-1"><marker><comment>del material</comment><name>X</name><in>5</in><out>6</out><pproColor>2</pproColor></marker></clip>\n<sequence id="sequence-1">');
        const r = lector.leerXml(conBin);
        t.eq(r.marcadores.length, 1);
        t.eq(r.marcadores[0].comentario, 'de la clase');
    });
};
