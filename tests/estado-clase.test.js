'use strict';
/**
 * Que el trabajo hecho sobreviva a entrar por otra carpeta.
 *
 * Lo que se prueba de verdad acá es el escenario que motivó todo: se procesa
 * soltando la carpeta del día, al día siguiente se suelta el curso entero, y las
 * clases del primer día tienen que seguir sabiendo que ya están hechas. Y el
 * lado feo: si el material cambió, lo guardado no puede darse por bueno, porque
 * reusar un transcript de otro audio no falla, miente.
 */

const fs = require('fs');
const path = require('path');

const estadoClase = require('../engine/estado-clase');
const workspace = require('../engine/workspace');
const scanner = require('../engine/course-scan');
const pipeline = require('../engine/pipeline');
const review = require('../engine/review');
const fixture = require('./lib/fixture');

/** Deja en el Backup de `root` unos artefactos reconocibles. */
function sembrarBackup(root, secuencia, marca) {
    workspace.writeJson(workspace.artifact(root, secuencia, 'transcript'),
        { words: [{ text: marca, start: 0, end: 1 }], wordCount: 1 });
    workspace.writeJson(workspace.artifact(root, secuencia, 'align'), { blocks: [], marca });
    workspace.writeJson(workspace.artifact(root, secuencia, 'notas'), { comentarios: [{ texto: marca }] });
}

/** La clase tal como la ve el pipeline, sacada de un escaneo de verdad. */
function claseDe(root) {
    const scan = scanner.scan(root);
    return scan.classes[0];
}

module.exports = t => {
    t.group('el trabajo guardado junto a la clase');

    t.test('guarda el trabajo dentro de la carpeta de la clase', () => {
        const root = fixture.tempRoot('estado');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'del día 1');

            const res = estadoClase.guardar({ root, cls, resumen: { app: '0.1.0', modelo: 'qwen3:4b' } });
            t.ok(res.ok, 'se guardó');
            t.eq(res.archivo, path.join(made.dir, estadoClase.ARCHIVO));

            const leido = estadoClase.leer(made.dir);
            t.eq(leido.secuencia, cls.sequenceName);
            t.eq(leido.modelo, 'qwen3:4b');
            t.eq(leido.trabajo.align.marca, 'del día 1', 'el trabajo va adentro, no una referencia');
            t.eq(leido.trabajo.notas.comentarios[0].texto, 'del día 1');
        } finally { fixture.rimraf(root); }
    });

    t.test('el archivo queda al lado del XML del Rodecaster', () => {
        const root = fixture.tempRoot('estado-sitio');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'x');
            estadoClase.guardar({ root, cls, resumen: {} });

            const juntos = fs.readdirSync(made.dir);
            t.ok(juntos.includes(estadoClase.ARCHIVO), 'está en la carpeta de la clase');
            t.ok(juntos.some(f => f.endsWith('.xml')), 'y el XML también');
        } finally { fixture.rimraf(root); }
    });

    t.group('entrar por otra carpeta');

    t.test('devuelve al Backup nuevo el trabajo hecho desde la carpeta del día', () => {
        // Se procesa soltando el día; después se suelta el curso, que es otra
        // raíz y por lo tanto otro "The Cutter", vacío.
        const curso = fixture.tempRoot('curso');
        try {
            const dia = path.join(curso, 'Day_1 RODECASTER_Video');
            fs.mkdirSync(dia);
            fixture.makeClassFolder(dia, { number: 4 });

            const clsDelDia = claseDe(dia);
            sembrarBackup(dia, clsDelDia.sequenceName, 'del día 1');
            estadoClase.guardar({ root: dia, cls: clsDelDia, resumen: {} });

            const clsDelCurso = claseDe(curso);
            t.ok(!fs.existsSync(workspace.artifact(curso, clsDelCurso.sequenceName, 'transcript')),
                'el Backup del curso arranca vacío');

            const res = estadoClase.hidratar({ root: curso, cls: clsDelCurso });
            t.ok(res.restaurados.includes('transcript'), 'volvió el transcript');
            t.ok(res.restaurados.includes('notas'), 'volvieron las notas');
            const vuelto = workspace.readJson(workspace.artifact(curso, clsDelCurso.sequenceName, 'align'));
            t.eq(vuelto.marca, 'del día 1');
        } finally { fixture.rimraf(curso); }
    });

    t.test('reprocesar ignora lo guardado y vuelve a empezar', async () => {
        const root = fixture.tempRoot('estado-force');
        try {
            // Sin Live-Mix el pipeline no llama a Whisper, así que la corrida es
            // instantánea y lo único que se mide es si miró lo guardado.
            fixture.makeClassFolder(root, { number: 4, liveMix: false });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'de antes');
            estadoClase.guardar({ root, cls, resumen: {} });
            fixture.rimraf(workspace.backupRoot(root));

            const etapas = [];
            await pipeline.processClass({
                root, cls, ai: null, force: true,
                onStage: stage => { if (!etapas.includes(stage)) etapas.push(stage); }
            });
            t.ok(!etapas.includes('reusar'), 'no recuperó nada');

            const align = workspace.readJson(workspace.artifact(root, cls.sequenceName, 'align'));
            t.ok(align && align.marca !== 'de antes', 'el alineado es nuevo, no el guardado');
        } finally { fixture.rimraf(root); }
    });

    t.test('sin reprocesar, recupera lo guardado antes de trabajar', async () => {
        const root = fixture.tempRoot('estado-reuso');
        try {
            fixture.makeClassFolder(root, { number: 4, liveMix: false });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'de antes');
            estadoClase.guardar({ root, cls, resumen: {} });
            fixture.rimraf(workspace.backupRoot(root));

            const etapas = [];
            await pipeline.processClass({
                root, cls, ai: null,
                onStage: stage => { if (!etapas.includes(stage)) etapas.push(stage); }
            });
            t.ok(etapas.includes('reusar'), 'recuperó lo que había');
        } finally { fixture.rimraf(root); }
    });

    t.test('no pisa lo que ya haya en esta raíz', () => {
        const root = fixture.tempRoot('estado-pisar');
        try {
            fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'viejo');
            estadoClase.guardar({ root, cls, resumen: {} });
            sembrarBackup(root, cls.sequenceName, 'nuevo');

            const res = estadoClase.hidratar({ root, cls });
            t.eq(res.restaurados.length, 0);
            t.eq(workspace.readJson(workspace.artifact(root, cls.sequenceName, 'align')).marca, 'nuevo');
        } finally { fixture.rimraf(root); }
    });

    t.test('el escaneo del curso ve las clases del día como ya procesadas', () => {
        const curso = fixture.tempRoot('curso-escaneo');
        try {
            const dia = path.join(curso, 'Day_1 RODECASTER_Video');
            fs.mkdirSync(dia);
            fixture.makeClassFolder(dia, { number: 4 });
            fixture.makeClassFolder(dia, { number: 5 });

            const scanDia = scanner.scan(dia);
            for (const cls of scanDia.classes) {
                sembrarBackup(dia, cls.sequenceName, 'hecho');
                estadoClase.guardar({ root: dia, cls, resumen: {} });
            }

            const scanCurso = scanner.scan(curso);
            t.eq(scanCurso.classes.length, 2);
            for (const cls of scanCurso.classes) {
                t.ok(cls.alreadyProcessed, `la clase ${cls.classNumber} se ve hecha desde el curso`);
                t.ok(cls.trabajoGuardado.sirve, 'y su trabajo sirve');
            }
        } finally { fixture.rimraf(curso); }
    });

    t.test('el visor abre una clase hecha desde otra carpeta', () => {
        const curso = fixture.tempRoot('curso-visor');
        try {
            const dia = path.join(curso, 'Day_1 RODECASTER_Video');
            fs.mkdirSync(dia);
            fixture.makeClassFolder(dia, { number: 4 });

            const clsDelDia = claseDe(dia);
            // Un cutplan mínimo: es lo que el visor exige para abrir.
            workspace.writeJson(workspace.artifact(dia, clsDelDia.sequenceName, 'cutplan'),
                { segments: [], totals: { kept: 0 } });
            sembrarBackup(dia, clsDelDia.sequenceName, 'del día 1');
            estadoClase.guardar({ root: dia, cls: clsDelDia, resumen: {} });

            const clsDelCurso = claseDe(curso);
            const data = review.loadReview({ root: curso, cls: clsDelCurso });
            t.ok(data.ok, 'abrió sin volver a procesar');
        } finally { fixture.rimraf(curso); }
    });

    t.test('una nota escrita después de procesar entra al archivo', () => {
        const root = fixture.tempRoot('estado-notas');
        try {
            fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'al procesar');
            estadoClase.guardar({ root, cls, resumen: {} });

            // El editor escribe un comentario en la revisión, mucho después.
            workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'notas'),
                { comentarios: [{ texto: 'esto lo escribió una persona' }] });
            t.ok(estadoClase.actualizar({ root, cls, claves: ['notas'] }).ok);

            const leido = estadoClase.leer(cls.folder);
            t.eq(leido.trabajo.notas.comentarios[0].texto, 'esto lo escribió una persona');
            t.eq(leido.trabajo.align.marca, 'al procesar', 'lo demás queda como estaba');
        } finally { fixture.rimraf(root); }
    });

    t.test('actualizar una clase sin trabajo guardado no inventa un archivo', () => {
        const root = fixture.tempRoot('estado-sin');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const res = estadoClase.actualizar({ root, cls: claseDe(root), claves: ['notas'] });
            t.ok(!res.ok);
            t.ok(!fs.existsSync(path.join(made.dir, estadoClase.ARCHIVO)));
        } finally { fixture.rimraf(root); }
    });

    t.group('lo procesado antes de que esto existiera');

    t.test('el escaneo le da su archivo a una clase ya procesada', () => {
        const root = fixture.tempRoot('estado-rescate');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            // Como quedó una corrida vieja: todo en el Backup, nada en la clase.
            sembrarBackup(root, cls.sequenceName, 'de una corrida vieja');
            workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'cutplan'), { segments: [] });
            t.eq(estadoClase.leer(made.dir), null, 'arranca sin archivo');

            const despues = claseDe(root);
            t.ok(despues.trabajoGuardado && despues.trabajoGuardado.sirve, 'quedó rescatada');
            t.eq(estadoClase.leer(made.dir).trabajo.align.marca, 'de una corrida vieja');
        } finally { fixture.rimraf(root); }
    });

    t.test('una corrida a medias no se rescata', () => {
        const root = fixture.tempRoot('estado-medias');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            // Transcribió y se canceló: sin plan de cortes no llegó al final.
            sembrarBackup(root, cls.sequenceName, 'a medias');

            t.ok(!claseDe(root).trabajoGuardado, 'no se da por hecha');
            t.eq(estadoClase.leer(made.dir), null);
        } finally { fixture.rimraf(root); }
    });

    t.test('el rescate no pisa un archivo que ya está', () => {
        const root = fixture.tempRoot('estado-rescate-2');
        try {
            fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'el bueno');
            workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'cutplan'), { segments: [] });
            estadoClase.guardar({ root, cls, resumen: { modelo: 'qwen3:4b' } });

            sembrarBackup(root, cls.sequenceName, 'otro');
            t.ok(!estadoClase.rescatar({ root, cls }), 'no hizo nada');
            t.eq(estadoClase.leer(cls.folder).trabajo.align.marca, 'el bueno');
        } finally { fixture.rimraf(root); }
    });

    t.group('cuando el material cambió');

    t.test('un Live-Mix distinto invalida lo guardado', () => {
        const root = fixture.tempRoot('estado-audio');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'x');
            estadoClase.guardar({ root, cls, resumen: {} });

            // Regrabaron el audio: mismo nombre, otro contenido.
            fs.writeFileSync(path.join(made.dir, 'Audio', 'Live-Mix.wav'), 'otro audio distinto');

            const despues = claseDe(root);
            const veredicto = estadoClase.vigente(estadoClase.leer(made.dir), despues);
            t.ok(!veredicto.vale, 'no vale');
            t.ok(/Live-Mix/.test(veredicto.porque), 'y dice por qué');
            t.eq(estadoClase.hidratar({ root, cls: despues }).restaurados.length, 0,
                'no devuelve un transcript de otro audio');
        } finally { fixture.rimraf(root); }
    });

    t.test('un XML retocado invalida lo guardado', () => {
        const root = fixture.tempRoot('estado-xml');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'x');
            estadoClase.guardar({ root, cls, resumen: {} });

            // El CD movió un marcador y volvió a exportar.
            const xml = path.join(made.dir, `${cls.sequenceName}.xml`);
            fs.writeFileSync(xml, fs.readFileSync(xml, 'utf8').replace('<in>600</in>', '<in>640</in>'));

            const veredicto = estadoClase.vigente(estadoClase.leer(made.dir), claseDe(root));
            t.ok(!veredicto.vale);
            t.ok(/XML/.test(veredicto.porque));
        } finally { fixture.rimraf(root); }
    });

    t.test('el escaneo avisa de un trabajo que ya no sirve', () => {
        const root = fixture.tempRoot('estado-aviso');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            const cls = claseDe(root);
            sembrarBackup(root, cls.sequenceName, 'x');
            estadoClase.guardar({ root, cls, resumen: {} });
            fs.writeFileSync(path.join(made.dir, 'Audio', 'Live-Mix.wav'), 'otro audio distinto');

            const despues = claseDe(root);
            t.ok(despues.alreadyProcessed, 'sigue constando que se procesó');
            t.ok(!despues.trabajoGuardado.sirve, 'pero el trabajo no sirve');
            t.ok(despues.warnings.some(w => w.code === 'trabajo_viejo'), 'y se avisa');
        } finally { fixture.rimraf(root); }
    });

    t.test('un archivo de otra versión se ignora en vez de romper', () => {
        const root = fixture.tempRoot('estado-version');
        try {
            const made = fixture.makeClassFolder(root, { number: 4 });
            workspace.writeJson(path.join(made.dir, estadoClase.ARCHIVO), { version: 99, secuencia: 'x' });
            t.eq(estadoClase.leer(made.dir), null);
            t.eq(estadoClase.resumen(claseDe(root)), null);
        } finally { fixture.rimraf(root); }
    });
};
