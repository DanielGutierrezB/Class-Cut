'use strict';
/**
 * Qué vistas hay, con qué fuente se ve cada una, y qué pasa con las que ya no.
 *
 * Son dos cosas que se rompen calladas y por eso están acá juntas.
 *
 * Una es que el mapeo de vista a fuente vuelva a estar escrito dos veces. Estuvo:
 * `cutplan.js` tenía su tabla con `PV` y `R`, la maqueta tenía la suya con las
 * seis, y no coincidían — así que una toma en `MG` se veía de una manera cuando
 * se miraba el diseño y de otra en la app, y nadie se enteraba porque las dos
 * "funcionaban". Acá se fija que la tabla del plan de cortes sea la lista de
 * vistas y ninguna otra.
 *
 * La otra es que `SL` y `SR` dejaron de ofrecerse al fundirse en `S`, pero siguen
 * escritas en el sidecar y en el XML de las clases que ya se grabaron, y pueden
 * llegar en un XML de afuera con esos nombres. Dejar de ofrecerlas no es dejar de
 * entenderlas: si llegaran crudas, la toma quedaría con una vista que no existe
 * —el selector sin nada marcado, el color caído al de `PV`— y el plan de cortes
 * la mandaría a la cámara del profesor avisando "vista desconocida".
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const vivo = require('../engine/notas-vivo');
const notasXml = require('../engine/notas-xml');
const cutplan = require('../engine/cutplan');
const rodecaster = require('../engine/rodecaster-xml');
const grabacion = require('../engine/grabacion');

/** El verde con el que el director de contenido marca las slides. */
const VERDE_DE_SLIDES = 4281828977;

/** Una clase de una sola toma, con la vista que se le pida. */
function sesionCon(vista) {
    return {
        secuencia: '01_curso_2026-09-04_13-00-00',
        clase: 1,
        parte: 1,
        curso: 'curso',
        ceroMs: Date.UTC(2026, 8, 4, 15, 0, 0),
        claqueta: { ms: Date.UTC(2026, 8, 4, 15, 0, 6), confirmada: true },
        sesiones: [],
        tomas: [{
            id: 1,
            vista,
            comentario: '',
            descartada: false,
            cuenta: '3, 2, 1.',
            inMs: Date.UTC(2026, 8, 4, 15, 0, 20),
            outMs: Date.UTC(2026, 8, 4, 15, 0, 50),
            palabras: [{ t: Date.UTC(2026, 8, 4, 15, 0, 21), texto: 'Hola' }],
            antes: [],
            despues: [],
            comentarios: []
        }]
    };
}

/** Una clase escrita en el disco tal como la dejó la app el día que se grabó. */
function conClaseEnElDisco(vista, hacer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vistas-'));
    try {
        const json = path.join(dir, '01_curso_2026-09-04_13-00-00_notas-en-vivo.json');
        const xml = path.join(dir, '01_curso_2026-09-04_13-00-00.xml');
        const estado = sesionCon(vista);
        fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(estado)));
        fs.writeFileSync(xml, notasXml.xmlDeNotas(estado));
        return hacer({ dir, json, xml });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = t => {

    t.group('vistas · con qué fuente se ve cada una');

    t.test('la lista de vistas es la que ofrece la pantalla de grabar', () => {
        t.deep(vivo.VISTAS.map(v => v.nombre), ['PV', 'R', 'S', 'MG', 'X2']);
    });

    t.test('el profesor va con la cámara y todo lo demás con la pantalla', () => {
        // `R`, `S`, `MG` y `X2` son cuatro maneras de mostrar lo que pasa en la
        // pantalla compartida, así que las cuatro salen del grabador de pantalla.
        // La única que sale de la cámara es el plano del profesor.
        t.deep(vivo.MAPA_DE_VISTAS, { PV: 0, R: 1, S: 1, MG: 1, X2: 1 });
        t.eq(vivo.CAMARA, 0);
        t.eq(vivo.PANTALLA, 1);
    });

    t.test('el plan de cortes usa esa tabla y no una copia suya', () => {
        // Con la copia, `MG` y `X2` no estaban y caían en la primera cámara con
        // un aviso de "vista desconocida" que el editor no tenía cómo arreglar.
        t.deep(cutplan.DEFAULT_VIEW_MAP, vivo.MAPA_DE_VISTAS);
    });

    t.test('un bloque de slides, multi o doble sale del grabador de pantalla', () => {
        const plan = cutplan.buildCutplan({
            blocks: ['PV', 'R', 'S', 'MG', 'X2'].map((view, index) => ({
                index, view, startSec: index * 10, endSec: index * 10 + 8
            })),
            videos: [{ name: '1_CAMERA 1.mp4' }, { name: '2_SCREEN.mp4' }],
            durationSec: 60
        });
        t.deep(plan.segments.map(s => s.cameraIndex), [0, 1, 1, 1, 1]);
        t.deep(plan.warnings.filter(w => w.code === 'vista_desconocida'), [],
            'ninguna de las cinco es desconocida para el plan');
    });

    t.test('lo guardado manda sobre lo de hoy, y lo que falta se completa', () => {
        // El plan escribe su tabla en el disco, así que una clase procesada antes
        // de que `S` existiera la tiene sin ella. Completarla es lo que evita que
        // ese bloque se vea con la cámara del profesor solo por la fecha en que
        // se procesó; respetar lo guardado es lo que evita pisar un mapeo que
        // alguien cambió a mano para una clase concreta.
        t.deep(cutplan.resolveViewMap({ PV: 0, R: 1 }),
            { PV: 0, R: 1, S: 1, MG: 1, X2: 1 });
        t.eq(cutplan.resolveViewMap({ R: 0 }).R, 0, 'lo del disco no se pisa');
        t.deep(cutplan.resolveViewMap(null), vivo.MAPA_DE_VISTAS);
    });

    t.group('vistas · SL y SR se leen como S');

    t.test('los dos nombres viejos son la misma vista de hoy', () => {
        t.eq(vivo.vistaLeida('SL'), 'S');
        t.eq(vivo.vistaLeida('SR'), 'S');
    });

    t.test('un nombre que no se renombró llega como vino', () => {
        // Traducir de más sería peor que no traducir: una vista que la app no
        // conoce tiene que llegar entera al aviso de "vista desconocida" para que
        // se pueda leer qué decía el marcador.
        t.eq(vivo.vistaLeida('PV'), 'PV');
        t.eq(vivo.vistaLeida('XX'), 'XX');
        t.eq(vivo.vistaLeida(null), '', 'sin nombre no se inventa uno');
    });

    t.test('un marcador del XML de afuera que dice SR entra como S', () => {
        // Estos XML los escribió la herramienta del director de contenido el día
        // que tomó esas notas, con los nombres que ofrecía entonces.
        const xml = notasXml.xmlDeNotas(sesionCon('SR'));
        t.ok(xml.includes('<name>S</name>'), 'lo que escribimos hoy ya va como S');

        const viejo = xml.replace(/<name>S<\/name>/g, '<name>SR</name>');
        const leido = rodecaster.parseXml(viejo);
        t.ok(leido.ok);
        t.deep(leido.blocks.map(b => b.view), ['S']);
        t.deep(leido.views, { S: 1 });
    });

    t.test('una toma guardada con SL aparece en S y el selector la marca', () => {
        // Lo que llega a la pantalla es lo que devuelve `listar`, y de ahí sale
        // el `data-vista` de la ficha y el botón que queda elegido. Con `SL`
        // crudo no habría ninguno elegido y la ficha se pintaría de gris.
        conClaseEnElDisco('SL', ({ dir }) => {
            const clases = grabacion.listar([dir]);
            t.eq(clases.length, 1);
            t.eq(clases[0].tomas[0].vista, 'S');
        });
    });

    t.test('el archivo se cura solo en el primer cambio que se le haga', () => {
        // Traducir al leer alcanza para que nada se rompa, así que el disco no se
        // toca por mirar una clase. Pero cualquier cambio reescribe el sidecar y
        // el XML enteros desde el estado ya traducido, y de ahí en adelante el
        // archivo dice `S` sin que nadie haya tenido que migrar nada.
        conClaseEnElDisco('SL', ({ json, xml }) => {
            t.ok(fs.readFileSync(json, 'utf8').includes('"vista":"SL"'), 'arranca con SL');

            grabacion.editarGrabada(json, { tipo: 'nota', toma: 1, texto: 'Revisar' });

            const guardado = JSON.parse(fs.readFileSync(json, 'utf8'));
            t.eq(guardado.tomas[0].vista, 'S');
            t.ok(fs.readFileSync(xml, 'utf8').includes('<name>S</name>'));
        });
    });

    t.test('el verde de las slides es el que las dos ya compartían', () => {
        // La distinción entre `SL` y `SR` era de encuadre, no de material: a la
        // secuencia llegaban del mismo verde. Al fundirlas se conserva ese, así
        // que una clase grabada antes y una de hoy se ven iguales en Premiere.
        t.eq(notasXml.colorDeVista('S'), VERDE_DE_SLIDES);
        t.eq(notasXml.colorDeVista(vivo.vistaLeida('SL')), VERDE_DE_SLIDES);
    });
};
