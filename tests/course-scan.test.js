'use strict';
/**
 * El escáner tiene que entender qué le dieron sin creerle a los nombres, y no
 * dejarse contar de más por lo que macOS, GoodSync y la propia app dejan al lado
 * del material.
 */

const fs = require('fs');
const path = require('path');
const scanner = require('../engine/course-scan');
const fixture = require('./lib/fixture');
const notasXml = require('../engine/notas-xml');

/**
 * Un XML como el que deja la toma de notas en vivo, con el nombre que se le pida.
 *
 * Se escribe con el mismo módulo que lo escribe la app, no a mano: lo que se
 * está probando es que el escáner elija bien entre varios, y un XML de mentira
 * podría pasar la prueba y fallar con uno de verdad.
 */
function escribirNotas(dir, nombre) {
    const cero = Date.UTC(2026, 7, 18, 16, 0, 0);
    fs.writeFileSync(path.join(dir, `${nombre}.xml`), notasXml.xmlDeNotas({
        secuencia: nombre,
        ceroMs: cero,
        claqueta: { ms: cero + 2000 },
        tomas: [{
            id: 1, vista: 'PV', comentario: '', cuenta: '3, 2, 1.',
            inMs: cero + 10000, outMs: cero + 40000,
            palabras: [{ t: cero + 10000, texto: 'Hola' }, { t: cero + 39000, texto: 'chau' }]
        }]
    }));
    return path.join(dir, `${nombre}.xml`);
}

module.exports = function (t) {
    t.group('course-scan · qué le dieron');

    t.test('una carpeta con una sola clase adentro se reconoce como clase', () => {
        const root = fixture.tempRoot('clase');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const result = scanner.scan(made.dir);
            t.eq(result.kind, 'class');
            t.eq(result.classCount, 1);
            t.eq(result.classes[0].classNumber, 4);
        } finally { fixture.rimraf(root); }
    });

    t.test('cada clase sabe su raíz y se identifica por su carpeta', () => {
        // Con varias carpetas cargadas a la vez, dos cursos pueden traer una
        // "Clase 01" cada uno: con el nombre de secuencia como id, la segunda
        // pisaba a la primera en todos los mapas de la ventana. Y la raíz decide
        // dónde va su "The Cutter", así que viaja en la clase.
        const root = fixture.tempRoot('ids');
        try {
            const uno = fixture.makeClassFolder(root, { number: 1 });
            fixture.makeClassFolder(root, { number: 2 });
            const result = scanner.scan(root);

            t.eq(result.classes.every(c => c.root === result.root), true, 'todas traen su raíz');
            t.eq(result.classes.find(c => c.classNumber === 1).id, uno.dir, 'el id es la carpeta');
            t.eq(new Set(result.classes.map(c => c.id)).size, result.classes.length,
                'y por eso no se repiten');
            // El mismo escaneo otra vez tiene que dar los mismos ids: `main.js`
            // vuelve a escanear antes de procesar y busca por id.
            t.deep(scanner.scan(root).classes.map(c => c.id), result.classes.map(c => c.id));
        } finally { fixture.rimraf(root); }
    });

    t.test('el XML de notas se encuentra aunque viva en otra carpeta', () => {
        // Las notas y el material nacen separados: la herramienta en vivo escribe
        // el XML donde el editor le dijo, porque la carpeta del Rodecaster está en
        // su tarjeta y no aparece en la Mac hasta que la grabación termina. Se
        // emparejan por número de clase, que es lo único que las dos mitades
        // comparten —los timestamps de los nombres los pone cada máquina—.
        const root = fixture.tempRoot('notas-aparte');
        try {
            const clase = fixture.makeClassFolder(root, { number: 6, xml: false });
            const notas = path.join(root, 'Notas del rodaje');
            fs.mkdirSync(notas, { recursive: true });
            // Con un nombre de los viejos, sin hora: se sigue emparejando por
            // número, que es lo único que había antes.
            escribirNotas(notas, '06_2609_curso-prueba-1785289335');

            const result = scanner.scan(root, { notasDirs: [notas] });
            const encontrada = result.classes.find(c => c.folder === clase.dir);
            t.eq(Boolean(encontrada.xmlPath), true, 'encontró el XML');
            t.eq(encontrada.xmlDeNotas, true, 'y sabe que vino de la carpeta de notas');
            t.eq(encontrada.deNotasEnVivo, true, 'y que lo escribió la herramienta en vivo');
            t.eq(encontrada.blockCount, 1);
            t.eq(encontrada.problems.some(p => p.code === 'sin_xml'), false);
        } finally { fixture.rimraf(root); }
    });

    t.test('y se encuentra igual dentro de xml/, que es donde cae ahora', () => {
        // La herramienta en vivo dejó de tirar todo suelto en la carpeta que
        // eligió el editor. Este es el punto donde un cambio de rutas se rompe
        // en silencio: el XML se sigue escribiendo, pero el flujo de corte deja
        // de emparejarlo con su carpeta del Rodecaster y la clase queda sin XML.
        const root = fixture.tempRoot('notas-en-xml');
        try {
            const clase = fixture.makeClassFolder(root, {
                number: 6, xml: false, stamp: '2026-08-18_1_16-00-00'
            });
            const notas = path.join(root, 'Notas del rodaje');
            fs.mkdirSync(path.join(notas, 'xml'), { recursive: true });
            escribirNotas(path.join(notas, 'xml'), '06_curso_2026-08-18_16-00-05');

            const encontrada = scanner.scan(root, { notasDirs: [notas] })
                .classes.find(c => c.folder === clase.dir);
            t.eq(Boolean(encontrada.xmlPath), true, 'lo encontró un piso más abajo');
            t.eq(encontrada.xmlDeNotas, true);
            t.eq(encontrada.problems.some(p => p.code === 'sin_xml'), false);
        } finally { fixture.rimraf(root); }
    });

    t.test('dos tandas de la misma clase: cada carpeta se lleva la suya', () => {
        // Una clase se puede grabar en dos veces, y entonces hay dos carpetas que
        // dicen "Clase 01" y dos XML que empiezan en "01". Antes ganaba el primero
        // que apareciera, así que las dos carpetas se llevaban el mismo y una
        // quedaba con los marcadores de la otra. Los separa la hora de arranque.
        const root = fixture.tempRoot('dos-tandas');
        try {
            const manana = fixture.makeClassFolder(root, {
                number: 1, xml: false, stamp: '2026-08-18_1_13-00-00'
            });
            const tarde = fixture.makeClassFolder(root, {
                number: 1, xml: false, stamp: '2026-08-18_2_15-00-00'
            });
            const notas = path.join(root, 'Notas del rodaje');
            fs.mkdirSync(notas, { recursive: true });
            // Cada una arranca unos segundos después que su Rodecaster: es la
            // demora entre apretar los dos botones.
            escribirNotas(notas, '01_curso_2026-08-18_13-00-12');
            escribirNotas(notas, '01_p2_curso_2026-08-18_15-00-08');

            const result = scanner.scan(root, { notasDirs: [notas] });
            const primera = result.classes.find(c => c.folder === manana.dir);
            const segunda = result.classes.find(c => c.folder === tarde.dir);

            t.eq(primera.xmlName, '01_curso_2026-08-18_13-00-12.xml');
            t.eq(segunda.xmlName, '01_p2_curso_2026-08-18_15-00-08.xml');
            t.eq(primera.parte, 1);
            t.eq(segunda.parte, 2, 'la segunda tanda se sabe segunda');
            // Y no son duplicados: las dos van, las dos marcadas.
            t.eq(primera.duplicate, false);
            t.eq(segunda.duplicate, false);
            t.eq(result.warnings.some(w => w.code === 'clase_duplicada'), false);
        } finally { fixture.rimraf(root); }
    });

    t.test('dos carpetas con la MISMA tanda siguen siendo duplicadas', () => {
        // Lo de arriba no puede tapar el caso que el aviso existe para atrapar:
        // la clase que se grabó dos veces porque la primera salió mal.
        const root = fixture.tempRoot('dos-iguales');
        try {
            fixture.makeClassFolder(root, { number: 4, stamp: '2026-08-18_1_13-00-00' });
            fixture.makeClassFolder(root, { number: 4, stamp: '2026-08-18_2_15-00-00' });
            const result = scanner.scan(root);
            t.eq(result.classes.filter(c => c.duplicate).length, 2);
            t.eq(result.classes.filter(c => c.selected).length, 1, 'queda marcada la más nueva');
        } finally { fixture.rimraf(root); }
    });

    t.test('un XML de notas de otro día se empareja igual, pero avisando', () => {
        // Es el único con ese número, así que es ese; pero lo normal es que las
        // dos horas estén a minutos, y a días significa que alguien reusó la
        // carpeta de notas de otro rodaje.
        const root = fixture.tempRoot('notas-lejos');
        try {
            const clase = fixture.makeClassFolder(root, {
                number: 3, xml: false, stamp: '2026-08-18_1_13-00-00'
            });
            const notas = path.join(root, 'Notas del rodaje');
            fs.mkdirSync(notas, { recursive: true });
            escribirNotas(notas, '03_curso_2026-08-11_13-00-00');

            const encontrada = scanner.scan(root, { notasDirs: [notas] })
                .classes.find(c => c.folder === clase.dir);
            t.eq(Boolean(encontrada.xmlPath), true, 'se emparejó igual');
            t.eq(encontrada.warnings.some(w => w.code === 'notas_de_otro_dia'), true);
        } finally { fixture.rimraf(root); }
    });

    t.test('el XML que viaja con el material le gana al de notas', () => {
        // Si la clase ya tiene el suyo adentro, uno de la carpeta de notas es una
        // versión vieja de lo mismo o, peor, de otra clase con el mismo número.
        const root = fixture.tempRoot('notas-pierde');
        try {
            const clase = fixture.makeClassFolder(root, { number: 6 });
            const notas = path.join(root, 'Notas del rodaje');
            fs.mkdirSync(notas, { recursive: true });
            fs.writeFileSync(path.join(notas, '06_otra-cosa.xml'), 'basura');

            const result = scanner.scan(root, { notasDirs: [notas] });
            const encontrada = result.classes.find(c => c.folder === clase.dir);
            t.eq(encontrada.xmlPath.startsWith(clase.dir), true);
            t.eq(encontrada.xmlDeNotas, false);
        } finally { fixture.rimraf(root); }
    });

    t.test('una carpeta con varias clases es un día', () => {
        const root = fixture.tempRoot('dia');
        try {
            fixture.makeClassFolder(root, { number: 1 });
            fixture.makeClassFolder(root, { number: 2 });
            const result = scanner.scan(root);
            t.eq(result.kind, 'day');
            t.eq(result.classCount, 2);
            t.eq(result.dayCount, 0);
        } finally { fixture.rimraf(root); }
    });

    t.test('una carpeta con días adentro es un curso', () => {
        const root = fixture.tempRoot('curso');
        try {
            const d1 = path.join(root, 'Day_1 RODECASTER_Video');
            const d2 = path.join(root, 'Dia 2 - rodecaster');
            fs.mkdirSync(d1); fs.mkdirSync(d2);
            fixture.makeClassFolder(d1, { number: 1 });
            fixture.makeClassFolder(d1, { number: 2 });
            fixture.makeClassFolder(d2, { number: 3 });
            const result = scanner.scan(root);
            t.eq(result.kind, 'course');
            t.eq(result.dayCount, 2);
            t.eq(result.classCount, 3);
            t.deep(result.classes.map(c => c.classNumber), [1, 2, 3]);
        } finally { fixture.rimraf(root); }
    });

    t.test('una carpeta sin clases lo dice sin fallar', () => {
        const root = fixture.tempRoot('vacio');
        try {
            const result = scanner.scan(root);
            t.eq(result.ok, true);
            t.eq(result.kind, 'empty');
            t.eq(result.classCount, 0);
        } finally { fixture.rimraf(root); }
    });

    t.test('una ruta que no existe falla con motivo', () => {
        const result = scanner.scan('/no/existe/esta/ruta');
        t.eq(result.ok, false);
        t.ok(result.error.length > 0);
    });

    t.group('course-scan · exclusiones');

    t.test('la propia carpeta de salida no se escanea ni cuenta', () => {
        const root = fixture.tempRoot('salida');
        try {
            fixture.makeClassFolder(root, { number: 1 });
            // Una salida anterior, con su propia estructura adentro.
            const out = path.join(root, scanner.OUTPUT_DIR);
            fixture.makeClassFolder(out, { number: 9 });
            const result = scanner.scan(root);
            t.eq(result.classCount, 1, 'la clase de "The Cutter" no debería contarse');
            t.eq(result.classes[0].classNumber, 1);
        } finally { fixture.rimraf(root); }
    });

    t.test('agregar la carpeta de salida directamente se rechaza con mensaje', () => {
        const root = fixture.tempRoot('salida-directa');
        try {
            const out = path.join(root, scanner.OUTPUT_DIR);
            fs.mkdirSync(out);
            const result = scanner.scan(out);
            t.eq(result.ok, false);
            t.ok(/The Cutter/.test(result.error));
        } finally { fixture.rimraf(root); }
    });

    t.test('Media, _gsdata_ y los ._ de macOS se ignoran', () => {
        const root = fixture.tempRoot('basura');
        try {
            const made = fixture.makeClassFolder(root, { number: 1 });
            fs.mkdirSync(path.join(root, 'Media'));
            fs.mkdirSync(path.join(root, '_gsdata_'));
            fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
            const result = scanner.scan(root);
            t.eq(result.classCount, 1);
            const videos = result.classes[0].videos.map(v => v.name);
            t.eq(videos.length, 2, `los AppleDouble se colaron: ${videos.join(', ')}`);
            t.ok(!videos.some(n => n.startsWith('._')), 'no debería haber ._');
            t.ok(made.dir.length > 0);
        } finally { fixture.rimraf(root); }
    });

    t.group('course-scan · material de cada clase');

    t.test('los audios van en orden numérico y Live-Mix al final', () => {
        const root = fixture.tempRoot('audios');
        try {
            fixture.makeClassFolder(root, {
                number: 1,
                audios: ['Live-Mix.wav', '9_USB-2.wav', '1_COMBO-1.wav', '2_COMBO-2.wav']
            });
            const result = scanner.scan(root);
            const names = result.classes[0].audios.map(a => a.name);
            t.deep(names, ['1_COMBO-1.wav', '2_COMBO-2.wav', '9_USB-2.wav', 'Live-Mix.wav']);
            t.eq(result.classes[0].audios[3].isLiveMix, true);
            t.ok(result.classes[0].liveMixPath, 'tiene que encontrar el Live-Mix');
        } finally { fixture.rimraf(root); }
    });

    t.test('Live-Mix se reconoce sin importar la caja ni el guion', () => {
        const root = fixture.tempRoot('livemix');
        try {
            fixture.makeClassFolder(root, { number: 1, audios: ['1_COMBO-1.wav', 'live mix.wav'] });
            const result = scanner.scan(root);
            t.ok(result.classes[0].liveMixPath, 'debería reconocer "live mix.wav"');
        } finally { fixture.rimraf(root); }
    });

    t.test('sin Live-Mix la clase se procesa igual, avisando', () => {
        const root = fixture.tempRoot('sin-livemix');
        try {
            fixture.makeClassFolder(root, { number: 1, liveMix: false });
            const result = scanner.scan(root);
            const cls = result.classes[0];
            t.eq(cls.liveMixPath, null);
            t.eq(cls.processable, true, 'debe seguir siendo procesable');
            t.ok(cls.warnings.some(w => w.code === 'sin_live_mix'));
        } finally { fixture.rimraf(root); }
    });

    t.test('sin XML la clase aparece como no procesable, sin tumbar a las otras', () => {
        const root = fixture.tempRoot('sin-xml');
        try {
            fixture.makeClassFolder(root, { number: 1 });
            fixture.makeClassFolder(root, { number: 2, xml: false, folderName: 'Clase rota' });
            const result = scanner.scan(root);
            t.eq(result.classCount, 2);
            t.eq(result.processableCount, 1);
            const rota = result.classes.find(c => c.folderName === 'Clase rota');
            t.eq(rota.processable, false);
            t.eq(rota.selected, false);
            t.ok(rota.problems.some(p => p.code === 'sin_xml'));
        } finally { fixture.rimraf(root); }
    });

    t.test('la carpeta Video vacía deja la clase no procesable', () => {
        const root = fixture.tempRoot('sin-video');
        try {
            fixture.makeClassFolder(root, { number: 1, videos: [] });
            const result = scanner.scan(root);
            t.eq(result.classes[0].processable, false);
            t.ok(result.classes[0].problems.some(p => p.code === 'sin_video'));
        } finally { fixture.rimraf(root); }
    });

    t.test('dos XML en la carpeta piden elegir', () => {
        const root = fixture.tempRoot('dos-xml');
        try {
            fixture.makeClassFolder(root, { number: 1, extraXml: '02_otra_secuencia' });
            const result = scanner.scan(root);
            const cls = result.classes[0];
            t.eq(cls.xmlAmbiguous, true);
            t.eq(cls.processable, false);
            t.ok(cls.xmlOptions.length >= 2);
        } finally { fixture.rimraf(root); }
    });

    t.group('course-scan · duplicados y estado');

    t.test('la clase re-grabada se muestra dos veces y solo queda marcada la nueva', () => {
        const root = fixture.tempRoot('duplicada');
        try {
            fixture.makeClassFolder(root, {
                number: 5, folderName: 'Clase 05 - Default_2026-08-19_1_12-00-00',
                stamp: '2026-08-19_1_12-00-00'
            });
            fixture.makeClassFolder(root, {
                number: 5, folderName: 'Clase 05 retoma - Default_2026-08-19_2_17-30-00',
                stamp: '2026-08-19_2_17-30-00'
            });
            const result = scanner.scan(root);
            t.eq(result.classCount, 2);
            const selected = result.classes.filter(c => c.selected);
            t.eq(selected.length, 1, 'solo una puede quedar marcada');
            t.ok(/retoma/.test(selected[0].folderName), `quedó marcada ${selected[0].folderName}`);
            t.ok(result.classes.every(c => c.duplicate));
        } finally { fixture.rimraf(root); }
    });

    t.test('una clase ya exportada se reporta como procesada', () => {
        const root = fixture.tempRoot('procesada');
        try {
            const made = fixture.makeClassFolder(root, { number: 1 });
            const out = path.join(root, scanner.OUTPUT_DIR);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, `${made.sequenceName}.xml`), '<xmeml/>');
            const result = scanner.scan(root);
            t.eq(result.classes[0].alreadyProcessed, true);
        } finally { fixture.rimraf(root); }
    });

    t.test('una clase sin número se ordena por fecha y avisa', () => {
        const root = fixture.tempRoot('sin-numero');
        try {
            fixture.makeClassFolder(root, { number: 1 });
            fixture.makeClassFolder(root, {
                number: 2, sequenceName: 'FIRS_CLASS_sin_prefijo', folderName: 'FIRS CLASS Default_2026-08-20_4_14-31-49'
            });
            const result = scanner.scan(root);
            const sinNumero = result.classes.find(c => c.classNumber == null);
            t.ok(sinNumero, 'debería existir la clase sin número');
            t.ok(sinNumero.warnings.some(w => w.code === 'sin_numero'));
            t.eq(result.classes[result.classes.length - 1], sinNumero, 'va al final');
        } finally { fixture.rimraf(root); }
    });

    t.group('course-scan · el curso real');

    if (!fixture.courseAvailable()) {
        t.skip('el curso completo', 'no está montado');
        return;
    }

    t.test('el curso entero: 3 días, 13 clases, todas procesables y en orden', () => {
        const result = scanner.scan(fixture.COURSE);
        t.eq(result.ok, true, result.error);
        t.eq(result.kind, 'course');
        t.eq(result.dayCount, 3);
        t.eq(result.classCount, 13);
        t.eq(result.processableCount, 13, JSON.stringify(
            result.classes.filter(c => !c.processable).map(c => [c.folderName, c.problems])));
        t.deep(result.classes.map(c => c.classNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    t.test('cada clase real trae 2 cámaras, 10 audios y su Live-Mix', () => {
        const result = scanner.scan(fixture.COURSE);
        for (const cls of result.classes) {
            t.eq(cls.videos.length, 2, `${cls.folderName}: cámaras`);
            t.eq(cls.audios.length, 10, `${cls.folderName}: audios`);
            t.ok(cls.liveMixPath, `${cls.folderName}: sin Live-Mix`);
            t.eq(cls.audios[9].isLiveMix, true, `${cls.folderName}: Live-Mix no quedó al final`);
        }
    });

    t.test('"FIRS CLASS" se reconoce como la clase 13 por su XML', () => {
        const result = scanner.scan(fixture.COURSE);
        const trece = result.classes.find(c => c.classNumber === 13);
        t.ok(/FIRS CLASS/i.test(trece.folderName), `la 13 es ${trece.folderName}`);
        t.ok(trece.sequenceName.startsWith('13_'));
    });

    t.test('agregar un solo día detecta sus clases', () => {
        const day = path.join(fixture.COURSE, 'Day_2 RODECASTER_Video');
        const result = scanner.scan(day);
        t.eq(result.kind, 'day');
        t.eq(result.classCount, 6);
        t.deep(result.classes.map(c => c.classNumber), [5, 6, 7, 8, 9, 10]);
    });

    t.test('agregar una clase suelta del curso funciona', () => {
        const dir = path.join(fixture.COURSE, 'Day_1 RODECASTER_Video', 'Clase 04 -Default_2026-08-18_4_16-10-29');
        const result = scanner.scan(dir);
        t.eq(result.kind, 'class');
        t.eq(result.classCount, 1);
        t.eq(result.classes[0].classNumber, 4);
        t.eq(result.classes[0].blockCount, 16, 'la clase 04 tiene 34 marcadores → 16 bloques');
    });
};
