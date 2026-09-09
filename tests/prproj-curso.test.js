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

/**
 * El mismo XML, pero con `cuantos` cortes de video con el recuadro puesto.
 *
 * El `<filter>` es lo que `clase-del-xml` mira para contarlos: es el encuadre del
 * profesor, que viaja en el XML y que el proyecto todavía no aplica. El `<video>`
 * de adentro del `<file>` es lo que le dice que el archivo trae imagen; sin eso
 * el armado se corta al poner un corte de video sobre un medio que no la tiene.
 */
function xmlConRecuadro(nombre, cuantos, rutaMedio) {
    const archivo = `<file id="f1"><name>a.mov</name><pathurl>file://${rutaMedio}</pathurl>`
        + '<duration>300</duration><media><video></video></media></file>';
    const clips = Array.from({ length: cuantos }, (_, i) =>
        `<clipitem id="c${i}"><name>corte ${i}</name><start>${i * 30}</start>`
        + `<end>${(i + 1) * 30}</end><in>0</in><out>30</out>`
        + (i === 0 ? archivo : '<file id="f1"/>')
        + '<filter><effect><name>Basic 3D</name></effect></filter></clipitem>').join('');
    return xmlDe(nombre).replace('<video></video>', `<video><track>${clips}</track></video>`);
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


    t.group('el proyecto del curso · el destino llega hecho');

    t.test('sin destino no se arranca, aunque todo lo demás esté', () => {
        // El motor no inventa nombres. Si nadie le dijo dónde escribir, es que
        // el puente se olvidó de resolverlo, y adivinar una ruta acá sería
        // dejar el archivo donde nadie lo va a buscar.
        const dir = carpeta({ 'The Cutter/una.xml': xmlDe('una') });
        return curso.generar({ carpeta: dir, plantilla: __filename }).then(r => {
            t.eq(r.ok, false);
            t.ok(/dónde escribir/.test(r.error), `esperaba que dijera dónde: ${r.error}`);
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });

    t.test('el motor no calcula ninguna ruta por su cuenta', () => {
        // Dos lugares que deciden el nombre y uno solo que manda es exactamente
        // cómo aparece un archivo escrito donde nadie lo busca. El cálculo vive
        // en `ipc/prproj.js` y acá no tiene que quedar ni el resto.
        t.eq(typeof curso.rutaLibre, 'undefined');
        const fuente = fs.readFileSync(path.join(__dirname, '..', 'engine', 'prproj-curso.js'), 'utf8');
        t.eq(/\$\{[^}]*\}\.prproj/.test(fuente), false, 'no se arma ningún nombre de .prproj');
    });


    t.group('el proyecto del curso · qué contesta cuando no puede');

    t.test('sin carpeta, sin plantilla y sin XML se contesta, no se tira', () => {
        // El puente devuelve `{ok:false, ...}` y la ventana muestra el texto: si
        // esto tirara, el botón quedaría girando para siempre.
        return Promise.all([
            curso.generar({}),
            curso.generar({ carpeta: '/no/existe/nada', destino: '/tampoco/x.prproj', plantilla: '/tampoco' }),
            curso.generar({ carpeta: os.tmpdir(), destino: path.join(os.tmpdir(), 'x.prproj'), plantilla: '/no/hay/plantilla.prproj' })
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
        return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 'x.prproj'), plantilla: path.join(dir, 'no-soy-un-proyecto.prproj') })
            .then(r => {
                t.eq(r.ok, false);
                t.eq(r.fuente, 'cortes', 'la fuente ya estaba decidida y se informa igual');
                t.ok(/plantilla/i.test(r.error));
                fs.rmSync(dir, { recursive: true, force: true });
            });
    });

    t.test('XML que no se pueden leer: se avisa de cada uno y no se escribe nada', () => {
        const dir = carpeta({ 'The Cutter/01_clase.xml': 'esto no tiene secuencia' });
        const destino = path.join(dir, 'Proyecto', 'x.prproj');
        return curso.generar({ carpeta: dir, destino, plantilla: __filename }).then(r => {
            t.eq(r.ok, false);
            t.eq(r.fuente, 'cortes');
            t.ok(r.avisos.some(a => /01_clase\.xml/.test(a)), 'el aviso dice qué archivo era');
            t.ok(!fs.existsSync(path.dirname(destino)), 'ni siquiera se creó la carpeta del destino');
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });


    t.group('el proyecto del curso · con una plantilla de verdad');

    // La plantilla es un `.prproj` del disco del editor: sin ella no hay nada que
    // clonar, y meterla al repo sería medio mega de binario para una prueba.
    //
    // Se busca igual que en la app, que es lo que la app hace desde que dejó de
    // preguntarla. En una máquina con Premiere estas dos pruebas —las únicas que
    // arman un proyecto entero y lo vuelven a leer— pasan de saltearse a correr
    // siempre, sin que nadie tenga que acordarse de exportar una variable.
    const PLANTILLA = process.env.CC_PLANTILLA_PRPROJ || require('../ipc/prproj').buscarPlantilla();
    const hay = PLANTILLA && fs.existsSync(PLANTILLA);

    if (!hay) {
        const comoSeConsigue = 'hace falta un .prproj que sirva de molde: se busca solo en '
            + 'Movies, Documents y Desktop, o se apunta uno con CC_PLANTILLA_PRPROJ';
        t.skip('el curso entero sale en un proyecto que se puede releer', comoSeConsigue);
        t.skip('la fuente de notas da secuencias con marcadores y sin material', comoSeConsigue);
    } else {
        const prproj = require('../engine/prproj');

        t.test('el curso entero sale en un proyecto que se puede releer', () => {
            const dir = carpeta({
                'The Cutter/01_clase.xml': xmlDe('01_clase'),
                'The Cutter/02_clase.xml': xmlDe('02_clase')
            });
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 'salida.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.clases, 2);
                t.eq(r.fuente, 'cortes');
                // Va en `cuenta` y no en `avisos`: que haya salido de la fuente
                // buena es narración, no algo que haya que ir a mirar.
                t.ok(r.cuenta.some(a => /material, los cortes/.test(a)), 'dice de qué fuente salió');
                t.deep(r.avisos, [], 'con todo en orden no hay nada que avisar');

                const p = prproj.Proyecto.leer(r.ruta);
                t.ok(p.verificar().ok, 'el grafo cierra');
                t.ok(p.porNombre('Sequence', '01_clase'), 'hay una secuencia por clase');
                t.ok(p.porNombre('Sequence', '02_clase'));
                t.eq(prproj.cabeceraDe(fs.readFileSync(r.ruta)), prproj.CABECERA_ESPERADA);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('lo del recuadro se dice una vez y con el total, no una vez por clase', () => {
            // Este es el mensaje que ocupaba media pantalla. Casi toda clase con
            // pantalla compartida trae recuadro, así que trece clases dejaban
            // trece líneas iguales en el cartel y tapaban a las que sí eran de
            // una clase y de ninguna otra. Sumadas ocupan un renglón y dicen lo
            // mismo: cuántos cortes, de cuántas clases, y qué es lo que no viaja.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            fs.mkdirSync(path.join(dir, 'The Cutter'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'The Cutter', '01_clase.xml'), xmlConRecuadro('01_clase', 5, medio));
            fs.writeFileSync(path.join(dir, 'The Cutter', '02_clase.xml'), xmlConRecuadro('02_clase', 3, medio));
            fs.writeFileSync(path.join(dir, 'The Cutter', '03_clase.xml'), xmlDe('03_clase'));
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const delRecuadro = r.avisos.filter(a => /recuadro/.test(a));
                t.eq(delRecuadro.length, 1, 'una línea, no una por clase');
                t.ok(/8 corte\(s\) de 2 clase\(s\)/.test(delRecuadro[0]),
                    `suma los cortes y cuenta las clases, y dice: ${delRecuadro[0]}`);
                t.ok(/sin el encuadre/.test(delRecuadro[0]),
                    'y dice qué es lo que no viaja, que es el punto del aviso');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('un aviso de una sola clase no queda tapado por la narración', () => {
            // El defecto que esto protege: el archivo que falta es lo único que
            // pide hacer algo, y se perdía entre las líneas de «13 secuencias,
            // 2106 cortes» y trece del recuadro. Ahora la narración vive aparte.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            fs.mkdirSync(path.join(dir, 'The Cutter'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'The Cutter', '01_clase.xml'), xmlConRecuadro('01_clase', 4, medio));
            fs.writeFileSync(path.join(dir, 'The Cutter', '02_clase.xml'), xmlConRecuadro('02_clase', 4, medio));
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.ok(r.avisos.every(a => !/secuencia\(s\)/.test(a)),
                    'la cuenta de lo que entró no es un aviso');
                t.ok(r.cuenta.some(a => /secuencia\(s\)/.test(a)),
                    'pero sigue estando, para poder comprobar que entraron todas');
                t.ok(r.avisos.length <= 2,
                    `dos clases no pueden dejar ${r.avisos.length} avisos: ${r.avisos.join(' | ')}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('la fuente de notas da secuencias con marcadores y sin material', () => {
            const dir = carpeta({ 'xml/01_notas.xml': xmlDe('01_notas') });
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 'salida.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.fuente, 'notas');
                // Este sí es un aviso, y no narración: hay algo que hacer al
                // respecto —procesar las clases y volver a generar—, así que
                // tiene que quedar donde se lo va a ir a mirar.
                t.ok(r.avisos.some(a => /no el material ni los cortes/.test(a)),
                    'el aviso avisa de lo que NO trae, que es el punto');
                t.ok(r.cuenta.some(a => /0 corte\(s\)/.test(a)));
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });
    }
};
