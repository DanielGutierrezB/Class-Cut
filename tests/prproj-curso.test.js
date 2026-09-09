'use strict';
/**
 * El armado del proyecto de un curso.
 *
 * Casi todo lo de acá es sobre **de dónde salen los datos**, que es la decisión
 * que más cambia lo que el editor recibe: del mismo botón sale un proyecto con
 * el material y los cortes puestos, o uno con marcadores solos, y de eso depende
 * qué carpeta se miró primero. Es también lo único que un usuario puede
 * disparar sin querer, dándole a «Generar» en una carpeta que grabó pero no
 * procesó.
 *
 * El armado en sí necesita una plantilla, que es un `.prproj` del disco del
 * editor y no algo que se pueda meter al repo. Esa parte se prueba entera en
 * `tools/prproj-molde.js`, y las pruebas de acá que la necesitan se saltean
 * solas si la plantilla no está.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const curso = require('../engine/prproj-curso');
const workspace = require('../engine/workspace');

/** Un XML mínimo pero legible, con un marcador para que la secuencia tenga algo. */
function xmlDe(nombre) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmeml version="4"><sequence id="sequence-1">',
        `<name>${nombre}</name><duration>300</duration>`,
        '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>',
        '<media><video></video><audio></audio></media>',
        '<marker><comment>una nota</comment><name>PV</name><in>30</in><out>60</out><pproColor>4281740498</pproColor></marker>',
        '</sequence></xmeml>'
    ].join('\n');
}

function carpeta(armar) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-curso-'));
    for (const [relativa, contenido] of Object.entries(armar || {})) {
        const destino = path.join(dir, relativa);
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.writeFileSync(destino, contenido);
    }
    return dir;
}

module.exports = t => {

    t.group('el proyecto del curso · de cuál de las dos fuentes sale');


    t.test('con clases procesadas manda The Cutter', () => {
        // Es el caso rico: esos XML traen el material, los cortes y los
        // marcadores. Si hay, no se mira nada más.
        const dir = carpeta({
            'The Cutter/01_clase.xml': xmlDe('01_clase'),
            'xml/01_notas.xml': xmlDe('01_notas')
        });
        const f = curso.ubicarFuente(dir);
        t.ok(f.ok);
        t.eq(f.tipo, 'cortes');
        t.eq(f.xmls.length, 1);
        t.eq(path.basename(f.xmls[0]), '01_clase.xml');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('sin clases procesadas se cae a las notas en vivo', () => {
        const dir = carpeta({ 'xml/01_notas.xml': xmlDe('01_notas') });
        const f = curso.ubicarFuente(dir);
        t.ok(f.ok);
        t.eq(f.tipo, 'notas');
        t.eq(f.xmls.length, 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('sin ninguna de las dos, el error dice cuál falta y cómo se consigue', () => {
        // Un "no encontré nada" pelado no le dice a nadie qué hacer después: una
        // carpeta sin procesar y una sin grabar se arreglan distinto.
        const dir = carpeta({});
        const f = curso.ubicarFuente(dir);
        t.ok(!f.ok);
        t.ok(f.error.includes(workspace.OUTPUT_DIR), 'nombra la carpeta de los cortes');
        t.ok(/\bxml\b/.test(f.error), 'y la de las notas');
        t.ok(/pesta.a Clases/.test(f.error), 'dice de dónde salen los cortes');
        t.ok(/pesta.a Grabar/.test(f.error), 'y de dónde las notas');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('una carpeta The Cutter vacía no cuenta como fuente', () => {
        // Existe desde la primera corrida del pipeline aunque no haya salido
        // ningún XML, así que la decisión es por lo que hay adentro.
        const dir = carpeta({ 'The Cutter/Backup/x_poblada.xml': xmlDe('x'), 'xml/01_notas.xml': xmlDe('01') });
        t.eq(curso.ubicarFuente(dir).tipo, 'notas');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('los intermedios del pipeline no se confunden con la entrega', () => {
        // `_poblada` y `_alineada` viven en `Backup/`, pero si alguien los copia
        // al lado, entrarían como si fueran clases y darían secuencias de más.
        const dir = carpeta({
            'The Cutter/01_clase.xml': xmlDe('01_clase'),
            'The Cutter/01_clase_poblada.xml': xmlDe('01_clase_poblada'),
            'The Cutter/01_clase_alineada.xml': xmlDe('01_clase_alineada'),
            'The Cutter/Sync.xml': xmlDe('Sync')
        });
        const f = curso.ubicarFuente(dir);
        t.eq(f.xmls.length, 1, 'solo la entrega');
        t.eq(path.basename(f.xmls[0]), '01_clase.xml');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('las clases salen en orden de clase, con la diez después de la nueve', () => {
        // El orden de texto pone la 10 después de la 1, y el editor abre el bin
        // esperando la clase 1 arriba.
        const armar = {};
        for (const n of ['1', '2', '9', '10', '11']) armar[`The Cutter/${n}_clase.xml`] = xmlDe(`${n}_clase`);
        const dir = carpeta(armar);
        t.deep(curso.ubicarFuente(dir).xmls.map(x => path.basename(x, '.xml')),
            ['1_clase', '2_clase', '9_clase', '10_clase', '11_clase']);
        fs.rmSync(dir, { recursive: true, force: true });
    });


    t.group('el proyecto del curso · no pisar nada');

    t.test('con el nombre libre, se usa el nombre del curso', () => {
        const dir = carpeta({});
        const r = curso.rutaLibre(dir, 'mi-curso');
        t.eq(path.basename(r.ruta), 'mi-curso.prproj');
        t.eq(r.corrida, 0);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('si ya hay uno, se escribe al lado y no encima', () => {
        // El .prproj de al lado puede tener horas de trabajo del editor encima.
        // Que queden dos archivos es un problema de dos segundos; perder el de
        // ayer, no.
        const dir = carpeta({ 'mi-curso.prproj': 'lo de ayer' });
        const r = curso.rutaLibre(dir, 'mi-curso');
        t.eq(path.basename(r.ruta), 'mi-curso (2).prproj');
        t.eq(r.corrida, 2);
        t.eq(fs.readFileSync(path.join(dir, 'mi-curso.prproj'), 'utf8'), 'lo de ayer', 'el viejo intacto');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('y si hay varios, sigue contando', () => {
        const dir = carpeta({ 'c.prproj': 'a', 'c (2).prproj': 'b', 'c (3).prproj': 'c' });
        t.eq(path.basename(curso.rutaLibre(dir, 'c').ruta), 'c (4).prproj');
        fs.rmSync(dir, { recursive: true, force: true });
    });


    t.group('el proyecto del curso · qué contesta cuando no puede');

    t.test('sin carpeta, sin plantilla y sin XML se contesta, no se tira', () => {
        // El puente devuelve `{ok:false, ...}` y la ventana muestra el texto: si
        // esto tirara, el botón quedaría girando para siempre.
        return Promise.all([
            curso.generar({}),
            curso.generar({ carpeta: '/no/existe/nada', plantilla: '/tampoco' }),
            curso.generar({ carpeta: os.tmpdir(), plantilla: '/no/hay/plantilla.prproj' })
        ]).then(([sinNada, sinCarpeta, sinPlantilla]) => {
            for (const r of [sinNada, sinCarpeta, sinPlantilla]) {
                t.eq(r.ok, false);
                t.ok(typeof r.error === 'string' && r.error.length > 10, 'con un error legible');
                t.eq(r.clases, 0);
                t.ok(Array.isArray(r.avisos));
            }
            t.ok(/carpeta/i.test(sinNada.error));
            t.ok(/plantilla/i.test(sinPlantilla.error));
        });
    });

    t.test('una plantilla que no es un proyecto se contesta con su nombre', () => {
        const dir = carpeta({
            'The Cutter/01_clase.xml': xmlDe('01_clase'),
            'no-soy-un-proyecto.prproj': 'esto no es gzip'
        });
        return curso.generar({ carpeta: dir, plantilla: path.join(dir, 'no-soy-un-proyecto.prproj') })
            .then(r => {
                t.eq(r.ok, false);
                t.eq(r.fuente, 'cortes', 'la fuente ya estaba decidida y se informa igual');
                t.ok(/plantilla/i.test(r.error));
                fs.rmSync(dir, { recursive: true, force: true });
            });
    });

    t.test('XML que no se pueden leer: se avisa de cada uno y no se escribe nada', () => {
        const dir = carpeta({ 'The Cutter/01_clase.xml': 'esto no tiene secuencia' });
        return curso.generar({ carpeta: dir, plantilla: __filename }).then(r => {
            t.eq(r.ok, false);
            t.eq(r.fuente, 'cortes');
            t.ok(r.avisos.some(a => /01_clase\.xml/.test(a)), 'el aviso dice qué archivo era');
            t.eq(fs.readdirSync(dir).filter(f => f.endsWith('.prproj')).length, 0);
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });


    t.group('el proyecto del curso · con una plantilla de verdad');

    // La plantilla es un `.prproj` del disco del editor: sin ella no hay nada que
    // clonar, y meterla al repo sería medio mega de binario para una prueba.
    const PLANTILLA = process.env.CC_PLANTILLA_PRPROJ || '';
    const hay = PLANTILLA && fs.existsSync(PLANTILLA);

    if (!hay) {
        t.skip('el curso entero sale en un proyecto que se puede releer',
            'hace falta un .prproj de plantilla en CC_PLANTILLA_PRPROJ; se prueba en tools/prproj-molde.js');
        t.skip('la fuente de notas da secuencias con marcadores y sin material',
            'hace falta un .prproj de plantilla en CC_PLANTILLA_PRPROJ');
    } else {
        const prproj = require('../engine/prproj');

        t.test('el curso entero sale en un proyecto que se puede releer', () => {
            const dir = carpeta({
                'The Cutter/01_clase.xml': xmlDe('01_clase'),
                'The Cutter/02_clase.xml': xmlDe('02_clase')
            });
            return curso.generar({ carpeta: dir, plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.clases, 2);
                t.eq(r.fuente, 'cortes');
                t.ok(r.avisos.some(a => /material, los cortes/.test(a)), 'dice de qué fuente salió');

                const p = prproj.Proyecto.leer(r.ruta);
                t.ok(p.verificar().ok, 'el grafo cierra');
                t.ok(p.porNombre('Sequence', '01_clase'), 'hay una secuencia por clase');
                t.ok(p.porNombre('Sequence', '02_clase'));
                t.eq(prproj.cabeceraDe(fs.readFileSync(r.ruta)), prproj.CABECERA_ESPERADA);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('la fuente de notas da secuencias con marcadores y sin material', () => {
            const dir = carpeta({ 'xml/01_notas.xml': xmlDe('01_notas') });
            return curso.generar({ carpeta: dir, plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.fuente, 'notas');
                t.ok(r.avisos.some(a => /no el material ni los cortes/.test(a)),
                    'el aviso avisa de lo que NO trae, que es el punto');
                t.ok(r.avisos.some(a => /0 corte\(s\)/.test(a)));
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });
    }
};
