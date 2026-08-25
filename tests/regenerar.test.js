'use strict';
/**
 * Que ninguna clase se quede con el XML atrasado.
 *
 * El comentario que el editor escribe se guarda al instante, pero al XML llega
 * solo al exportar. Si exportar depende de estar parado en esa clase, comentar
 * en la 3, seguir a la 7 y guardar ahí deja los comentarios de la 3 fuera de
 * Premiere sin que nadie se entere. Acá se prueban las dos mitades: la decisión
 * de a quién hay que rehacerle el XML —que es la que escribe en la carpeta del
 * cliente— y que reexportar no se lleve por delante los bordes que el editor
 * movió.
 */

const fs = require('fs');
const path = require('path');

const fixture = require('./lib/fixture');
const workspace = require('../engine/workspace');
const scanner = require('../engine/course-scan');
const rodecaster = require('../engine/rodecaster-xml');
const cutplanEngine = require('../engine/cutplan');
const exporter = require('../engine/export');
const notas = require('../engine/notas');
const estadoClase = require('../engine/estado-clase');
const review = require('../engine/review');
const regenerar = require('../engine/regenerar');

const DURACION = 720;

/** Las fechas de archivo se comparan en milisegundos: dos escrituras seguidas caen en el mismo. */
function esperarUnPoco() {
    return new Promise(listo => setTimeout(listo, 12));
}

/**
 * Una clase alineada como la dejaría el pipeline.
 *
 * Se arma a mano y no corriendo `align`: eso necesitaría transcribir audio de
 * verdad, y lo que se prueba acá no es el alineado sino qué pasa después.
 */
function alinear(cls) {
    const parsed = rodecaster.parseFile(cls.xmlPath);
    return {
        version: 1,
        fps: 30,
        durationSec: cls.durationSec,
        pisoSec: 0,
        offset: { appliedSec: 0, applied: false, source: 'claqueta', candidates: [], reason: 'prueba' },
        blocks: parsed.blocks.map(b => ({
            index: b.index,
            view: b.view,
            color: b.color,
            note: b.note,
            complete: b.complete,
            cueIn: b.cueIn,
            cueOut: b.cueOut,
            inSpanSec: b.inSpanSec,
            startSec: b.startSec,
            endSec: b.endSec,
            in: { decidedBy: 'nota', reason: '', confidence: 'alta' },
            out: { decidedBy: 'nota', reason: '', confidence: 'alta' },
            confidence: 'alta',
            problems: []
        })),
        stats: { blocks: parsed.blocks.length },
        warnings: []
    };
}

/** Deja una clase como si se hubiera procesado y exportado recién. */
function procesar(cls) {
    const align = alinear(cls);
    workspace.writeJson(workspace.artifact(cls.root, cls.sequenceName, 'align'), align);
    const plan = cutplanEngine.buildCutplan({
        blocks: align.blocks,
        videos: cls.videos,
        audios: cls.audios,
        durationSec: cls.durationSec,
        fps: 30
    });
    exporter.exportClass({ root: cls.root, cls, alignResult: align, cutplan: plan });
    estadoClase.guardar({ root: cls.root, cls, resumen: {} });
    return plan;
}

/**
 * Una carpeta con clases procesadas y exportadas.
 *
 * El material se mide con ffprobe en la app; acá se le pone la duración a mano
 * porque los archivos de la carpeta temporal son de un byte.
 */
function curso(numeros) {
    const root = fixture.tempRoot('regenerar');
    for (const numero of numeros) fixture.makeClassFolder(root, { number: numero });

    const scan = scanner.scan(root);
    for (const cls of scan.classes) {
        cls.durationSec = DURACION;
        cls.fps = 30;
        for (const media of cls.videos.concat(cls.audios)) media.durationSec = DURACION;
        procesar(cls);
    }
    return { root, clases: scan.classes };
}

function clase(curso, numero) {
    return curso.clases.find(c => c.classNumber === numero);
}

function xmlDe(cls) {
    return fs.readFileSync(workspace.finalXml(cls.root, cls.sequenceName), 'utf8');
}

module.exports = async function (t) {
    t.group('a quién hay que rehacerle el XML');

    t.test('una clase sin trabajo hecho no se toca', () => {
        // Reexportar lo que no se procesó no escribiría un XML: escribiría uno vacío.
        t.deep(regenerar.decidir({ hayTrabajo: false, exportadoEn: null, escritoEn: null }),
            { regenerar: false, porque: 'sin-trabajo' });
    });

    t.test('trabajo hecho y ningún XML en esta carpeta: hay que exportarla', () => {
        // Se procesó entrando por otra carpeta y acá no hay nada que importar.
        t.deep(regenerar.decidir({ hayTrabajo: true, exportadoEn: null, escritoEn: 1000 }),
            { regenerar: true, porque: 'sin-xml' });
    });

    t.test('lo escrito después de exportar es exactamente el caso a resolver', () => {
        t.deep(regenerar.decidir({ hayTrabajo: true, exportadoEn: 1000, escritoEn: 2000 }),
            { regenerar: true, porque: 'escrito-despues' });
    });

    t.test('un XML más nuevo que las notas ya las tiene', () => {
        t.deep(regenerar.decidir({ hayTrabajo: true, exportadoEn: 2000, escritoEn: 1000 }),
            { regenerar: false, porque: 'al-dia' });
    });

    t.test('una clase sin nada escrito está al día', () => {
        t.deep(regenerar.decidir({ hayTrabajo: true, exportadoEn: 2000, escritoEn: null }),
            { regenerar: false, porque: 'al-dia' });
    });

    t.test('el mismo milisegundo no es material nuevo', () => {
        // Guardar exporta después de escribir; si caen en el mismo milisegundo lo
        // escrito YA entró en ese XML. Reexportar acá sería un lote que crece solo.
        t.deep(regenerar.decidir({ hayTrabajo: true, exportadoEn: 1000, escritoEn: 1000 }),
            { regenerar: false, porque: 'al-dia' });
    });

    t.test('un motivo que nadie enseñó a explicar falla en vez de mentir', () => {
        let exploto = false;
        try { regenerar.texto('vaya-a-saber'); } catch (e) { exploto = true; }
        t.ok(exploto, 'un código nuevo sin texto tiene que romper acá y no en la interfaz');
    });

    t.group('las señales salen del disco');

    t.test('recién exportada está al día; un comentario la deja atrasada', async () => {
        const c = curso([3]);
        const cls = clase(c, 3);
        t.eq(regenerar.decidir(regenerar.senales({ root: cls.root, cls })).porque, 'al-dia');

        await esperarUnPoco();
        notas.guardar(cls.root, cls.sequenceName, {
            comentarios: [{ sourceStartSec: 25, comentario: 'Acá falta el ejemplo' }]
        });
        t.eq(regenerar.decidir(regenerar.senales({ root: cls.root, cls })).porque, 'escrito-despues');

        fixture.rimraf(c.root);
    });

    t.test('guardar la misma nota dos veces no la vuelve a marcar como atrasada', async () => {
        // El campo de la nota guarda al salir del foco: entrar y salir sin
        // escribir nada movía la fecha del archivo y el botón anunciaba clases
        // atrasadas que estaban al día.
        const c = curso([3]);
        const cls = clase(c, 3);
        const mismas = { comentarios: [{ sourceStartSec: 25, comentario: 'igual' }] };

        notas.guardar(cls.root, cls.sequenceName, mismas);
        regenerar.unaClase(cls);
        await esperarUnPoco();
        notas.guardar(cls.root, cls.sequenceName, mismas);

        t.eq(regenerar.decidir(regenerar.senales({ root: cls.root, cls })).porque, 'al-dia');
        fixture.rimraf(c.root);
    });

    t.group('el comentario llega al XML de la clase que no estaba abierta');

    t.test('se regenera la 3 y la 7 queda como estaba', async () => {
        const c = curso([3, 7]);
        const tres = clase(c, 3);
        const siete = clase(c, 7);

        await esperarUnPoco();
        notas.guardar(tres.root, tres.sequenceName, {
            comentarios: [{ sourceStartSec: 25, texto: 'lo que dice', comentario: 'Repetir esta parte' }]
        });

        // Con la 7 abierta, la atrasada es solo la 3.
        const pendientes = regenerar.pendientes({ clases: c.clases.filter(x => x.id !== siete.id) });
        t.eq(pendientes.length, 1);
        t.eq(pendientes[0].classNumber, 3);
        t.eq(pendientes[0].porque, 'escrito-despues');

        t.ok(!xmlDe(tres).includes('Repetir esta parte'), 'todavía no está en el XML');
        const antesLa7 = fs.statSync(workspace.finalXml(siete.root, siete.sequenceName)).mtimeMs;

        const lote = regenerar.varias({ clases: [tres] });
        t.eq(lote.hechas.length, 1);
        t.eq(lote.fallas.length, 0);

        const xml = xmlDe(tres);
        t.ok(xml.includes('Repetir esta parte'), 'el comentario tiene que estar en el XML de la 3');
        t.ok(xml.includes('<name>Nota</name>'), 'y como marcador de nota, no de corte');
        t.eq(fs.statSync(workspace.finalXml(siete.root, siete.sequenceName)).mtimeMs, antesLa7,
            'la 7 estaba al día: no se le toca el XML');

        // Y el archivo que viaja con la carpeta queda con este plan.
        t.ok(estadoClase.leer(tres.folder).trabajo.cutplan, 'el trabajo guardado sigue completo');
        fixture.rimraf(c.root);
    });

    t.test('nadie queda pendiente después de regenerar', () => {
        const c = curso([3, 7]);
        t.deep(regenerar.pendientes({ clases: c.clases }), []);
        fixture.rimraf(c.root);
    });

    t.group('reexportar no se lleva el trabajo del editor');

    t.test('un borde movido y guardado sigue movido después de regenerar', async () => {
        // Los bordes que el editor mueve viven en el plan; el alineado se queda
        // con lo que calculó la herramienta. Reexportar desde el alineado le
        // devolvería a la clase los cortes automáticos, que es peor que el bug.
        const c = curso([3]);
        const cls = clase(c, 3);
        const antes = workspace.readJson(workspace.artifact(cls.root, cls.sequenceName, 'cutplan'));
        const movido = antes.segments[0].sourceStartSec + 4;

        review.saveReview({
            root: cls.root,
            cls,
            segments: [{
                blockIndex: antes.segments[0].blockIndex,
                sourceStartSec: movido,
                sourceEndSec: antes.segments[0].sourceEndSec,
                view: antes.segments[0].view,
                keep: false,
                disabledReason: 'Lo sacaste de la clase',
                reviewed: true
            }],
            viewMap: antes.viewMap
        });

        await esperarUnPoco();
        notas.guardar(cls.root, cls.sequenceName, {
            comentarios: [{ sourceStartSec: 45, comentario: 'Va con la otra cámara' }]
        });
        regenerar.unaClase(cls);

        const despues = workspace.readJson(workspace.artifact(cls.root, cls.sequenceName, 'cutplan'));
        t.eq(despues.segments[0].sourceStartSec, movido, 'el borde movido se respeta');
        t.eq(despues.segments[0].keep, false, 'y el bloque que sacó sigue afuera');
        t.eq(despues.segments[0].confidence, 'alta', 'lo que ya se revisó no vuelve a "para revisar"');
        // Y lo que el bloque trae del XML del CD y nadie edita —la vista, el
        // texto del marcador, cuánto duraba— sale del alineado en cada
        // reexportado. Si se perdiera por el camino, regenerar una clase la
        // dejaría peor que antes de tocarla.
        const comoVino = s => ({ view: s.view, cueIn: s.cueIn, inSpanSec: s.inSpanSec });
        t.deep(comoVino(despues.segments[0]), comoVino(antes.segments[0]));
        t.eq(despues.segments[0].cueIn, 'arranca el bloque de 600', 'y es lo que decía el marcador');
        t.ok(xmlDe(cls).includes('Va con la otra cámara'), 'y el comentario llegó igual');

        fixture.rimraf(c.root);
    });

    t.test('una que no se puede rehacer no frena a las demás', () => {
        // Son clases independientes: dejar las otras atrasadas porque un XML no se
        // pudo escribir no arregla nada, y el que falló hay que decirlo.
        const c = curso([3, 7]);
        const roto = clase(c, 3);
        fs.rmSync(workspace.artifact(roto.root, roto.sequenceName, 'align'));
        fs.rmSync(estadoClase.ruta(roto.folder));

        const lote = regenerar.varias({ clases: [roto, clase(c, 7)] });
        t.eq(lote.hechas.length, 1);
        t.eq(lote.fallas.length, 1);
        t.eq(lote.fallas[0].classNumber, 3);
        t.ok(lote.fallas[0].error.includes('alineado'), lote.fallas[0].error);

        fixture.rimraf(c.root);
    });

    t.group('una clase procesada por otra carpeta');

    t.test('sin XML en esta raíz se exporta, con lo que la clase trae guardado', () => {
        // El caso de `estado-clase`: se procesó soltando el día y ahora se entró
        // por el curso. El trabajo viaja en la carpeta, el XML no.
        const c = curso([5]);
        const original = clase(c, 5);

        const otraRaiz = fixture.tempRoot('regenerar-mudanza');
        // Con las fechas intactas, que es lo que pasa al mover una carpeta de
        // verdad: si cambiaran, el trabajo guardado dejaría de valer para este
        // material y habría que rehacerlo, no reexportarlo.
        fs.cpSync(original.folder, path.join(otraRaiz, path.basename(original.folder)),
            { recursive: true, preserveTimestamps: true });

        const scan = scanner.scan(otraRaiz);
        const mudada = scan.classes[0];
        mudada.durationSec = DURACION;
        for (const media of mudada.videos.concat(mudada.audios)) media.durationSec = DURACION;

        const pendientes = regenerar.pendientes({ clases: scan.classes });
        t.eq(pendientes.length, 1, 'está hecha pero acá no hay XML');
        t.eq(pendientes[0].porque, 'sin-xml');

        t.ok(regenerar.unaClase(mudada).ok);
        t.ok(fs.existsSync(workspace.finalXml(otraRaiz, mudada.sequenceName)), 'el XML aparece en la raíz nueva');
        t.deep(regenerar.pendientes({ clases: scan.classes }), [], 'y deja de estar pendiente');

        fixture.rimraf(c.root);
        fixture.rimraf(otraRaiz);
    });
};
