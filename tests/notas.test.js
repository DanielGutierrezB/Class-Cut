'use strict';
/**
 * Que lo que el editor escribe llegue entero al editor de verdad.
 *
 * Las notas son lo único de una revisión que no se puede volver a calcular: si
 * se pierden o llegan cortadas al XML, no hay de dónde sacarlas otra vez. Por
 * eso se prueban el guardado, el anclaje y la traducción a la línea de tiempo
 * del corte, que es donde terminan siendo un marcador.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const notas = require('../engine/notas');
const workspace = require('../engine/workspace');

function raizTemporal() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notas-'));
    fs.mkdirSync(path.join(dir, 'The Cutter', 'Backup'), { recursive: true });
    return dir;
}

const SECUENCIA = '01_clase_de_prueba';

/** Un corte de dos bloques: del 100 al 130 y del 300 al 310 de la grabación. */
function segmentosDeEjemplo() {
    return [
        { blockIndex: 0, keep: true, sourceStartSec: 100, sourceEndSec: 130, timelineStartSec: 0, timelineEndSec: 30 },
        { blockIndex: 1, keep: true, sourceStartSec: 300, sourceEndSec: 310, timelineStartSec: 30, timelineEndSec: 40 }
    ];
}

module.exports = t => {
    t.group('guardar lo que escribió el editor');

    t.test('una nota y un comentario vuelven tal cual', () => {
        const raiz = raizTemporal();
        notas.guardar(raiz, SECUENCIA, {
            bloques: { 3: { note: 'Cambiar la entrada' } },
            comentarios: [{ sourceStartSec: 120, sourceEndSec: 124, texto: 'lo que dice', comentario: 'Revisar esto' }]
        });

        const leido = notas.leer(raiz, SECUENCIA);
        t.eq(leido.bloques[3].note, 'Cambiar la entrada');
        t.eq(leido.comentarios.length, 1);
        t.eq(leido.comentarios[0].comentario, 'Revisar esto');
        t.eq(leido.comentarios[0].sourceStartSec, 120);
    });

    t.test('una clase sin notas devuelve algo usable, no null', () => {
        // Quien lo lee no debería tener que preguntar si el archivo existe.
        const vacio = notas.leer(raizTemporal(), SECUENCIA);
        t.eq(vacio.comentarios.length, 0);
        t.eq(Object.keys(vacio.bloques).length, 0);
    });

    t.test('los saltos de línea se aplanan', () => {
        // El campo del marcador es de una línea: un salto llega partido o cortado.
        t.eq(notas.limpiar('dos\nlíneas   con   aire'), 'dos líneas con aire');
    });

    t.test('un comentario larguísimo se recorta', () => {
        t.eq(notas.limpiar('x'.repeat(900)).length, 500);
    });

    t.test('vaciar una nota la borra en vez de guardarla en blanco', () => {
        // Vaciarla es "volvé a la del marcador", no "dejala sin texto".
        const raiz = raizTemporal();
        notas.guardar(raiz, SECUENCIA, { bloques: { 2: { note: 'algo' } }, comentarios: [] });
        notas.guardar(raiz, SECUENCIA, { bloques: { 2: { note: '   ' } }, comentarios: [] });
        t.eq(notas.leer(raiz, SECUENCIA).bloques[2], undefined);
    });

    t.test('un comentario sin texto no se guarda', () => {
        const raiz = raizTemporal();
        notas.guardar(raiz, SECUENCIA, {
            comentarios: [{ sourceStartSec: 10, comentario: '  ' }, { sourceStartSec: 20, comentario: 'sí' }]
        });
        t.eq(notas.leer(raiz, SECUENCIA).comentarios.length, 1);
    });

    t.test('los comentarios quedan ordenados por cuándo se dijo', () => {
        const raiz = raizTemporal();
        notas.guardar(raiz, SECUENCIA, {
            comentarios: [
                { sourceStartSec: 300, comentario: 'tarde' },
                { sourceStartSec: 100, comentario: 'temprano' }
            ]
        });
        t.eq(notas.leer(raiz, SECUENCIA).comentarios.map(c => c.comentario).join(','), 'temprano,tarde');
    });

    t.test('reprocesar la clase no se lleva las notas', () => {
        // El pipeline reescribe el plan y el alineado; esto vive en otro archivo
        // justamente para sobrevivir a eso.
        const raiz = raizTemporal();
        notas.guardar(raiz, SECUENCIA, { bloques: { 0: { note: 'mía' } }, comentarios: [] });
        workspace.writeJson(workspace.artifact(raiz, SECUENCIA, 'cutplan'), { segments: [] });
        workspace.writeJson(workspace.artifact(raiz, SECUENCIA, 'align'), { blocks: [] });
        t.eq(notas.leer(raiz, SECUENCIA).bloques[0].note, 'mía');
    });

    t.group('qué nota va a leer el editor');

    t.test('la corregida le gana a la del marcador', () => {
        const guardadas = { bloques: { 1: { note: 'la mía' } } };
        t.eq(notas.notaDeBloque(guardadas, 1, 'la del Rodecaster'), 'la mía');
    });

    t.test('sin corrección, sigue valiendo la del marcador', () => {
        t.eq(notas.notaDeBloque({ bloques: {} }, 1, 'la del Rodecaster'), 'la del Rodecaster');
        t.eq(notas.notaDeBloque(null, 1, 'la del Rodecaster'), 'la del Rodecaster');
    });

    t.group('del tiempo de la grabación al del corte');

    t.test('un comentario cae donde corresponde en la clase montada', () => {
        // El segundo 110 del archivo es el 10 del corte: el bloque arranca en 100.
        t.eq(notas.enLaLineaDeTiempo(110, segmentosDeEjemplo()), 10);
        // Y el 305 cae en el segundo bloque, que empieza en el 30 del corte.
        t.eq(notas.enLaLineaDeTiempo(305, segmentosDeEjemplo()), 35);
    });

    t.test('un comentario sobre material que quedó afuera se descarta', () => {
        // Un marcador suelto en la secuencia final confunde más de lo que ayuda.
        t.eq(notas.enLaLineaDeTiempo(200, segmentosDeEjemplo()), null);
    });

    t.test('un comentario en un bloque que se sacó tampoco viaja', () => {
        const segmentos = segmentosDeEjemplo();
        segmentos[1].keep = false;
        t.eq(notas.enLaLineaDeTiempo(305, segmentos), null);
    });
};
