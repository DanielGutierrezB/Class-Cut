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
