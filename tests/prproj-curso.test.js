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
const nidos = require('../engine/prproj-nidos');
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

/**
 * El mismo XML, pero con material de verdad y una etiqueta de color a elección.
 *
 * Sirve para dos cosas que `xmlDe` no puede: comprobar que un archivo entra una
 * sola vez al panel aunque lo nombren tres XML, y provocar el aviso de la
 * etiqueta que no está entre las medidas, que es el que se repetiría una vez por
 * paso si no se filtrara.
 */
function xmlConMaterial(nombre, rutaMedio, etiqueta) {
    const archivo = `<file id="f1"><name>a.mov</name><pathurl>file://${rutaMedio}</pathurl>`
        + '<duration>300</duration><media><video></video></media></file>';
    const clip = '<clipitem id="c0"><name>corte</name><start>0</start><end>60</end>'
        + `<in>0</in><out>60</out>${archivo}`
        + (etiqueta ? `<labels><label2>${etiqueta}</label2></labels>` : '')
        + '</clipitem>';
    return xmlDe(nombre).replace('<video></video>', `<video><track>${clip}</track></video>`);
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
        // Del recuadro solo se puede hablar si la plantilla que se encontró trae
        // un clip con la escala o la posición movidas: es de donde se copia.
        const hayMovimiento = Boolean(
            require('../engine/prproj-moldes').detectarMoldes(prproj.Proyecto.leer(PLANTILLA)).efectoDeMovimiento
        );

        /**
         * Qué cuelga de un bin, por nombre y en el orden en que se ve el panel.
         *
         * Se sigue la lista `<Items>` y no el anidamiento del XML: en un
         * `.prproj` los bins están todos al mismo nivel del archivo y quién
         * cuelga de quién lo dice esa lista. Hace falta mirarlo así y no con
         * `porNombre` porque las tres versiones de una clase llevan el mismo
         * nombre a propósito: lo único que las distingue es el bin.
         */
        const hijosDe = (p, bin) => [...p.contenido(bin).matchAll(/<Item Index="\d+" ObjectURef="([^"]+)"\/>/g)]
            .map(m => prproj.clave('UID', m[1]))
            .filter(k => p.tiene(k));

        const dentroDe = (p, bin) => hijosDe(p, bin).map(k => p.nombre(k));

        const binDentroDe = (p, bin, nombre) => hijosDe(p, bin)
            .find(k => p.clase(k) === 'BinProjectItem' && p.nombre(k) === nombre) || null;

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

        /**
         * Un XML de clase con `cuantos` bloques pegados, de un minuto cada uno,
         * más el `cutplan.json` que dice con qué vista se pidió cada uno.
         *
         * Los dos van juntos porque el generador los lee juntos: del XML saca
         * dónde cae cada corte y del plan, con qué vista. Escribir uno sin el
         * otro sería preparar un caso que no existe en el disco.
         */
        const claseConVistas = (dir, nombre, medio, vistas, medioPantalla) => {
            const archivoDe = pista => (pista === 2 && medioPantalla) || medio;
            const clips = (pista, prendida) => vistas.map((vista, i) =>
                `<clipitem id="${pista}${i}"><name>c</name>`
                + `<enabled>${prendida(vista) ? 'TRUE' : 'FALSE'}</enabled>`
                + `<start>${i * 30}</start><end>${(i + 1) * 30}</end>`
                + `<in>${1800 + i * 30}</in><out>${1800 + (i + 1) * 30}</out>`
                + (i === 0
                    ? `<file id="f${pista}"><name>${path.basename(archivoDe(pista))}</name>`
                        + `<pathurl>file://${archivoDe(pista)}</pathurl>`
                        + '<duration>36000</duration><media><video></video>'
                        + '<audio><channelcount>2</channelcount></audio></media></file>'
                    : `<file id="f${pista}"/>`)
                + '</clipitem>').join('');
            const xml = xmlDe(nombre).replace('<video></video>',
                `<video><track>${clips(1, v => v === 'PV')}</track>`
                + `<track>${clips(2, v => v !== 'PV')}</track></video>`);
            fs.mkdirSync(path.join(dir, workspace.OUTPUT_DIR), { recursive: true });
            fs.writeFileSync(workspace.finalXml(dir, nombre), xml);

            fs.mkdirSync(path.dirname(workspace.artifact(dir, nombre, 'cutplan')), { recursive: true });
            fs.writeFileSync(workspace.artifact(dir, nombre, 'cutplan'), JSON.stringify({
                segments: vistas.map((view, i) => ({
                    keep: true, view, blockIndex: i,
                    timelineStartSec: i * 60, timelineEndSec: (i + 1) * 60,
                    sourceStartSec: 60 + i * 60
                }))
            }));
        };

        /**
         * La secuencia de ENTREGA de una clase.
         *
         * Se busca por el bin y no por el nombre porque las cuatro versiones de
         * una clase se llaman igual a propósito —la entrega y los tres pasos de
         * `Pre`— así que `porNombre` devuelve cualquiera. La que cuelga derecho
         * de `02 Secuencias` es la que corta sobre los nidos.
         */
        const entregaDe = (p, nombre) => {
            const cpi = hijosDe(p, p.porNombre('BinProjectItem', curso.BIN_SECUENCIAS))
                .find(k => p.clase(k) === 'ClipProjectItem' && p.nombre(k) === nombre);
            return cpi ? p.cierre([cpi], {}).find(k => p.clase(k) === 'Sequence') : null;
        };

        /** Las pistas de video de una secuencia, en orden. */
        const pistasVideoDe = (p, seq) => {
            const grupo = p.refsDe(seq).find(k => p.clase(k) === 'VideoTrackGroup');
            return [...p.contenido(grupo).matchAll(/<Track Index="\d+" ObjectURef="([^"]+)"\/>/g)]
                .map(m => prproj.clave('UID', m[1]))
                .filter(k => p.tiene(k));
        };

        // Toda entrada de lista del formato lleva su `Index` delante de la
        // referencia; sin él en el patrón no casa ninguna y todas las pistas
        // parecen vacías.
        const CORTE_EN_LA_LISTA = /<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g;

        /** Los `TrackItem` de una pista, en orden. */
        const cortesDe = (p, pista) => [...p.contenido(pista).matchAll(CORTE_EN_LA_LISTA)]
            .map(m => prproj.clave('ID', Number(m[1])));

        /** Cuántos cortes tiene cada pista de video, en orden. */
        const cortesPorPista = (p, seq) => pistasVideoDe(p, seq)
            .map(k => cortesDe(p, k).length);

        /** El nombre del nido que usa un corte, que es el `<Name>` de su subclip. */
        const nidoDelCorte = (p, item) => {
            const sub = p.refsDe(item).find(k => p.clase(k) === 'SubClip');
            return sub ? (/<Name>([^<]*)<\/Name>/.exec(p.contenido(sub)) || [])[1] : null;
        };

        /** Las pistas de audio de una secuencia, en orden. */
        const pistasAudioDe = (p, seq) => {
            const grupo = p.refsDe(seq).find(k => p.clase(k) === 'AudioTrackGroup');
            return [...p.contenido(grupo).matchAll(/<Track Index="\d+" ObjectURef="([^"]+)"\/>/g)]
                .map(m => prproj.clave('UID', m[1]))
                .filter(k => p.tiene(k));
        };

        /**
         * Si un corte mira a una secuencia o a un archivo.
         *
         * Es la única diferencia que importa entre las dos pistas de audio de la
         * entrega, y no se ve en el nombre: el nido se llama `AUDIO` y el WAV
         * `Live-Mix.wav`, pero los dos podrían llamarse igual. Lo que los separa
         * de verdad es la clase del objeto que hay al final de la cadena.
         */
        const miraAUnNido = (p, item) => p
            .cierre([item], { claseFrontera: ['Sequence', 'Media'] })
            .some(k => /SequenceSource$/.test(p.clase(k)));

        /**
         * Le agrega a una clase ya escrita sus pistas de audio, con la mezcla en
         * la posición `cualSuena`.
         *
         * Va aparte de `claseConVistas` porque casi ninguna prueba la necesita:
         * lo que se mira en las otras es el orden de las pistas de video, y diez
         * WAV de más solo harían más lento cada armado.
         */
        const conAudio = (dir, nombre, medios, cualSuena) => {
            const pistas = medios.map((ruta, i) =>
                '<track><clipitem id="a' + i + '"><name>c</name>'
                + `<enabled>${i === cualSuena ? 'TRUE' : 'FALSE'}</enabled>`
                + '<start>0</start><end>90</end><in>1800</in><out>1890</out>'
                + `<file id="fa${i}"><name>${path.basename(ruta)}</name>`
                + `<pathurl>file://${ruta}</pathurl><duration>36000</duration>`
                + '<media><audio><channelcount>2</channelcount></audio></media></file>'
                + '</clipitem></track>').join('');
            const ruta = workspace.finalXml(dir, nombre);
            fs.writeFileSync(ruta, fs.readFileSync(ruta, 'utf8')
                .replace('<audio></audio>', `<audio>${pistas}</audio>`));
        };

        t.test('sin ninguna S la clase lleva tres pistas: cámara, pantalla y recuadro', () => {
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV', 'R', 'PV']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                // Tres bloques en cámara y pantalla, y el recuadro solo en el
                // único que va con la pantalla.
                t.deep(cortesPorPista(p, entregaDe(p, '01_clase')), [3, 3, 1],
                    'tres pistas, y el recuadro solo donde hace falta');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('con una S la clase lleva cuatro, y el recuadro queda arriba de todo', () => {
            // El editor lo pidió así: con slides, `SLIDE` va en la dos y empuja
            // al grabador de pantalla a la tres, para que el recuadro del
            // profesor quede siempre solo en la última. Si el orden se diera
            // vuelta, el recuadro quedaría tapado — y eso no se ve en ningún
            // lado hasta que alguien mira el resultado en Premiere.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV', 'S', 'R']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const pistas = pistasVideoDe(p, entregaDe(p, '01_clase'));
                t.eq(pistas.length, 4, `cuatro pistas y no tres: ${pistas.length}`);
                t.deep(pistas.map(k => nidoDelCorte(p, cortesDe(p, k)[0])),
                    [nidos.NOMBRES.camara, nidos.NOMBRES.slide, nidos.NOMBRES.pantalla, nidos.NOMBRES.camara],
                    'de abajo hacia arriba: cámara, slide, pantalla y la cámara otra vez de recuadro');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('un corte entra en el nido corrido por la franja de su clase', () => {
            // **Esta es la cuenta que hace que todo lo demás sirva.** Un corte
            // que en el XML entraba en el segundo 1860 de su clase tiene que
            // entrar en `franja + 1860` del nido, porque adentro del nido esa
            // clase arranca ahí. Si se corrige mal no se ve al generar: el
            // archivo abre, el clip está y dura lo que tiene que durar; lo único
            // que pasa es que muestra otro pedazo de la clase.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            claseConVistas(dir, '01_clase', medio, ['PV']);
            claseConVistas(dir, '02_clase', medio, ['PV']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);

                // Las dos clases tienen el mismo material y el mismo corte, así
                // que lo único que puede diferenciarlas es la franja.
                const entradaDe = nombre => {
                    const pista = pistasVideoDe(p, entregaDe(p, nombre))[0];
                    const item = cortesDe(p, pista)[0];
                    const sub = p.refsDe(item).find(k => p.clase(k) === 'SubClip');
                    const clip = p.refsDe(sub).find(k => p.clase(k) === 'VideoClip');
                    return prproj.aSegundos(Number(/<InPoint>(\d+)<\/InPoint>/.exec(p.contenido(clip))[1]));
                };

                // El `<duration>` del XML va en CUADROS: 36000 a 30 fps son
                // veinte minutos, que es lo que dura la franja de cada clase.
                const LARGO = 36000 / 30;
                const primera = entradaDe('01_clase');
                const segunda = entradaDe('02_clase');
                t.near(primera, 60, 0.01, 'la primera clase arranca en cero, así que su corte no se corre');
                t.near(segunda, 60 + LARGO + nidos.AIRE_SEG, 0.01,
                    `la segunda se corre su franja entera: ${segunda}`);
                t.ok(segunda > primera, 'y dos clases con el mismo corte no pueden entrar en el mismo lugar');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('arriba el nido de audio y abajo el Live-Mix crudo, muteado', () => {
            // **Las dos pistas no pueden ser lo mismo.** El editor abrió la
            // primera versión y encontró el mismo nido dos veces: eso no es un
            // respaldo, porque dos copias del mismo nido se rompen juntas. El
            // respaldo tiene que apuntar al WAV, sin nido de por medio, para que
            // siga siendo lo que salió del aparato pase lo que pase arriba.
            const dir = carpeta({
                'material/a.mov': 'no importa qué diga',
                'material/1_COMBO-1.wav': 'ni esto',
                'material/Live-Mix.wav': 'ni esto tampoco'
            });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV']);
            conAudio(dir, '01_clase', [
                path.join(dir, 'material', '1_COMBO-1.wav'),
                path.join(dir, 'material', 'Live-Mix.wav')
            ], 1);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const pistas = pistasAudioDe(p, entregaDe(p, '01_clase'));
                t.eq(pistas.length, 2, `dos pistas de audio y no ${pistas.length}`);

                const arriba = cortesDe(p, pistas[0])[0];
                const abajo = cortesDe(p, pistas[1])[0];
                t.ok(arriba && abajo, 'las dos con su corte');
                t.eq(nidoDelCorte(p, arriba), nidos.NOMBRES.audio, 'la de arriba es el nido');
                t.ok(miraAUnNido(p, arriba), 'y mira de verdad a una secuencia');
                t.ok(!miraAUnNido(p, abajo), 'la de abajo mira al archivo, no a una secuencia');
                t.eq(nidoDelCorte(p, abajo), 'Live-Mix.wav', 'y el archivo es la mezcla, no el primer canal');
                t.ok(/<IsMuted>true<\/IsMuted>/.test(p.contenido(abajo)), 'el respaldo entra muteado');
                t.ok(!/<IsMuted>true<\/IsMuted>/.test(p.contenido(arriba)), 'y el nido sonando');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('sin saber cuál es la mezcla, la clase entra con una sola pista de audio', () => {
            // Con dos canales sonando no hay UNA mezcla, así que no hay a quién
            // señalar como respaldo. Antes que poner una pista cualquiera y
            // llamarla el respaldo del editor, no se pone ninguna: una pista
            // vacía en las trece clases es ruido que hay que saltear siempre.
            const dir = carpeta({
                'material/a.mov': 'no importa qué diga',
                'material/1_COMBO-1.wav': 'ni esto',
                'material/Live-Mix.wav': 'ni esto tampoco'
            });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV']);
            conAudio(dir, '01_clase', [
                path.join(dir, 'material', '1_COMBO-1.wav'),
                path.join(dir, 'material', 'Live-Mix.wav')
            ], -1);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                t.eq(pistasAudioDe(p, entregaDe(p, '01_clase')).length, 1);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('adentro de «CAM» está todo el sonido de la clase, alineado', () => {
            // Es para lo que el editor entra ahí: ver si las ondas coinciden y
            // resincronizar en un solo lugar para las trece clases. Abajo del
            // clip de cámara tiene que estar su propio audio, el de la otra
            // cámara y cada canal que el aparato grabó por separado.
            const dir = carpeta({
                'material/cam.mov': 'la cámara',
                'material/sr.mov': 'el grabador de pantalla',
                'material/1_COMBO-1.wav': 'un canal suelto',
                'material/Live-Mix.wav': 'la mezcla'
            });
            const f = n => path.join(dir, 'material', n);
            claseConVistas(dir, '01_clase', f('cam.mov'), ['PV'], f('sr.mov'));
            conAudio(dir, '01_clase', [f('1_COMBO-1.wav'), f('Live-Mix.wav')], 1);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const cam = p.porNombre('Sequence', nidos.NOMBRES.camara);
                const pistas = pistasAudioDe(p, cam);
                t.eq(pistas.length, 4, `su audio, el del SR y los dos canales: ${pistas.length} pista(s)`);

                const primeros = pistas.map(k => cortesDe(p, k)[0]);
                t.deep(primeros.map(it => it && nidoDelCorte(p, it)),
                    ['cam.mov', 'sr.mov', '1_COMBO-1.wav', 'Live-Mix.wav'],
                    'el propio arriba, después el de la otra cámara y después los sueltos');
                t.deep(primeros.map(it => !/<IsMuted>true<\/IsMuted>/.test(p.contenido(it))),
                    [false, false, false, true],
                    'solo suena el Live-Mix: doce pistas prendidas serían doce voces encima');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('«CAM» y «SR» no se contienen: sería una anidación circular', () => {
            // El editor lo pidió como «que traiga el audio de la anidación», y
            // así no se puede: cada uno adentro del otro es un ciclo y Premiere
            // no abre el proyecto. Entra el ARCHIVO, que suena lo mismo y está
            // en el mismo segundo porque el nido no es más que eso puesto en su
            // franja. Que ningún nido de imagen mire a una secuencia es la forma
            // de comprobar que no se coló el ciclo.
            const dir = carpeta({ 'material/cam.mov': 'la cámara', 'material/sr.mov': 'la pantalla' });
            const f = n => path.join(dir, 'material', n);
            claseConVistas(dir, '01_clase', f('cam.mov'), ['PV'], f('sr.mov'));
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                for (const nombre of [nidos.NOMBRES.camara, nidos.NOMBRES.pantalla]) {
                    const seq = p.porNombre('Sequence', nombre);
                    const adentro = p.cierre([seq], { claseFrontera: ['Media'] })
                        .filter(k => /SequenceSource$/.test(p.clase(k)));
                    t.eq(adentro.length, 0, `«${nombre}» no tiene ninguna secuencia adentro`);
                }
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('cada nido llega del color de su pista, también en el panel', () => {
            // El color del corte manda en la línea de tiempo; el del ítem del
            // panel manda en el panel Y lo hereda cualquier corte que se agregue
            // después a mano. Pintando solo el corte, `CAM` era una secuencia
            // verde más entre todas, que es justo donde el editor la busca.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const { ETIQUETAS } = require('../engine/prproj-moldes');
                const colorDelPanel = nombre => {
                    const cpi = p.porNombre('ClipProjectItem', nombre);
                    return (/<Column\.PropertyText\.Label>BE\.Prefs\.LabelColors\.(\d+)</
                        .exec(p.contenido(cpi)) || [])[1];
                };
                t.eq(colorDelPanel(nidos.NOMBRES.camara), String(ETIQUETAS[nidos.ETIQUETA_DE_CAMARA].indice));
                t.eq(colorDelPanel(nidos.NOMBRES.pantalla), String(ETIQUETAS[nidos.ETIQUETA_DE_PANTALLA].indice));
                t.eq(colorDelPanel(nidos.NOMBRES.audio), String(ETIQUETAS[nidos.ETIQUETA_DE_AUDIO].indice));
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('un nido dice que dura lo que dura, y no lo que duraba el molde', () => {
            // `OriginalDuration` es cuánto material cree Premiere que hay del
            // otro lado. Heredado del molde, un nido de nueve horas se presenta
            // como uno de treinta y cinco minutos y los cortes de las últimas
            // clases caen fuera de lo que existe.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            claseConVistas(dir, '01_clase', medio, ['PV']);
            claseConVistas(dir, '02_clase', medio, ['PV']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const cpi = p.porNombre('ClipProjectItem', nidos.NOMBRES.camara);
                const fuente = p.cierre([cpi], { claseFrontera: ['Sequence'] })
                    .find(k => p.clase(k) === 'VideoSequenceSource');
                const dice = prproj.aSegundos(
                    Number(/<OriginalDuration>(\d+)<\/OriginalDuration>/.exec(p.contenido(fuente))[1]));

                // Dos clases de veinte minutos con los cinco de aire en el medio.
                const LARGO = 36000 / 30;
                t.near(dice, 2 * LARGO + nidos.AIRE_SEG, 0.01, `el nido dice durar ${dice}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('y un archivo importado también, en las dos fuentes que lo declaran', () => {
            // Lo mismo que el nido pero para el material: `OriginalDuration` es
            // cuánto material dice haber, y venía copiada del archivo del que se
            // clonó el molde. Un WAV de cuarenta minutos entraba diciendo durar
            // treinta y cinco. Medido contra un proyecto que escribió Premiere:
            // ahí las 182 fuentes declaran lo que dura su stream.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['PV']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const cpi = p.porNombre('ClipProjectItem', 'a.mov');
                const partes = p.cierre([cpi], {});
                const fuentes = partes.filter(k => /^(Video|Audio)MediaSource$/.test(p.clase(k)));
                t.ok(fuentes.length >= 1, 'el archivo tiene al menos una fuente');

                // El `<duration>` del XML va en CUADROS: 36000 a 30 fps son
                // veinte minutos, que es lo que dice durar el archivo.
                for (const k of fuentes) {
                    const dice = prproj.aSegundos(
                        Number(/<OriginalDuration>(\d+)<\/OriginalDuration>/.exec(p.contenido(k))[1]));
                    t.near(dice, 36000 / 30, 0.01, `${p.clase(k)} dice durar ${dice}`);
                }
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('el recuadro es la misma «CAM», no una anidación aparte', () => {
            // Lo fue: `MINI` era `CAM` anidada una segunda vez con el efecto
            // adentro, así que el encuadre se escribía una sola vez para todo el
            // curso. El editor lo abrió y prefirió no tener una anidación sobre
            // otra, que es un nivel más para entrar cada vez que quiere ver qué
            // está mirando. La pista de arriba tiene que ser la MISMA `CAM` de
            // la de abajo, o el nido deja de ser un solo lugar donde tocar.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['R']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                t.eq(p.porNombre('Sequence', 'MINI'), null, 'no quedó ninguna secuencia MINI');

                const pistas = pistasVideoDe(p, entregaDe(p, '01_clase'));
                const arriba = cortesDe(p, pistas[2])[0];
                t.ok(arriba, 'la pista del recuadro tiene su corte');
                t.eq(nidoDelCorte(p, arriba), nidos.NOMBRES.camara, 'y mira a «CAM»');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('el recuadro ya no se avisa: ahora entra puesto sobre el corte', () => {
            // Durante meses el proyecto avisaba «entran en su lugar y con su
            // duración, pero sin el encuadre», porque el recuadro del profesor
            // viajaba en el XML y el generador no sabía escribirlo. Ahora se
            // escribe, así que el aviso dejó de tener de qué hablar. Que no esté
            // es el resultado.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            fs.mkdirSync(path.join(dir, 'The Cutter'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'The Cutter', '01_clase.xml'), xmlConRecuadro('01_clase', 5, medio));
            fs.writeFileSync(path.join(dir, 'The Cutter', '02_clase.xml'), xmlConRecuadro('02_clase', 3, medio));
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.ok(r.avisos.every(a => !/sin el encuadre/.test(a)),
                    `el aviso viejo no tiene de qué hablar: ${r.avisos.join(' | ')}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('el recuadro sale con la geometría medida en el Premiere del editor', () => {
            // Los cuatro números salieron de abrir su `Plantilla.prproj`, que se
            // armó importando los XML que escribe esta misma app: ahí Premiere
            // dejó el recuadro en `Position 0.879:0.806`, `Scale 30` y los
            // costados recortados al 18 %. Si esta prueba cae, el recuadro se
            // corrió, y se corrió respecto de lo que el editor ya venía viendo.
            if (!hayMovimiento) {
                t.skip('el recuadro sale con la geometría medida en el Premiere del editor',
                    'la plantilla que se encontró no tiene ningún clip con la escala movida');
                return null;
            }
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            // Un solo bloque, y con la pantalla a cuadro completo: es el único
            // caso que lleva recuadro, así que el proyecto tiene que quedar con
            // exactamente un efecto y se lo puede mirar entero.
            claseConVistas(dir, '01_clase', path.join(dir, 'material', 'a.mov'), ['R']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const efectos = p.porClase('VideoFilterComponent');
                t.eq(efectos.length, 1, 'uno solo, y no lo que viniera colgado en la plantilla');

                const valores = {};
                for (const k of p.cierre([efectos[0]], {})) {
                    const texto = p.contenido(k).replace(/\n\s*/g, ' ');
                    const nombre = (/<Name>([^<]*)<\/Name>/.exec(texto) || [])[1];
                    const valor = (/<StartKeyframe>[^,]*,([^,]*),/.exec(texto) || [])[1];
                    if (nombre) valores[nombre.trim()] = valor;
                }
                t.eq(valores.Position, '0.879:0.806', 'abajo a la derecha, donde lo dejó Premiere');
                t.eq(valores['Anchor Point'], '0.5:0.5');
                t.eq(valores.Scale, '30');
                t.eq(valores['Crop Left'], '18');
                t.eq(valores['Crop Right'], '18');
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

        t.group('el proyecto del curso · los pasos de antes del corte');

        /**
         * Una clase con sus dos pasos guardados en `Backup/`, como los deja el
         * pipeline: el mismo nombre de secuencia adentro de los tres XML y el
         * sufijo del paso pegado al nombre del archivo.
         */
        const conPasos = (dir, nombre, medio, pasos) => {
            fs.mkdirSync(path.join(dir, workspace.OUTPUT_DIR, workspace.BACKUP_DIR), { recursive: true });
            fs.writeFileSync(workspace.finalXml(dir, nombre), xmlConMaterial(nombre, medio));
            for (const paso of pasos) {
                fs.writeFileSync(workspace.artifact(dir, nombre, paso), xmlConMaterial(nombre, medio));
            }
        };

        t.test('los pasos previos entran en «Pre», un bin por paso y adentro cada clase', () => {
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            conPasos(dir, '01_clase', medio, ['populatedXml', 'alignedXml']);
            conPasos(dir, '02_clase', medio, ['populatedXml', 'alignedXml']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                t.ok(p.verificar().ok, 'el grafo cierra');

                const secuencias = p.porNombre('BinProjectItem', curso.BIN_SECUENCIAS);
                const pre = binDentroDe(p, secuencias, curso.BIN_PRE);
                t.ok(pre, `«${curso.BIN_PRE}» cuelga del bin de secuencias`);
                t.deep(dentroDe(p, secuencias),
                    ['01_clase', '02_clase', nidos.NOMBRES.raiz, curso.BIN_PRE],
                    'las clases primero, y detrás las dos cosas que se miran cuando algo falló');

                t.deep(dentroDe(p, pre), ['poblada', 'alineada', 'sin-anidar'],
                    'un bin por paso, con el nombre del paso y en el orden en que pasaron');
                for (const paso of ['poblada', 'alineada', 'sin-anidar']) {
                    t.deep(dentroDe(p, binDentroDe(p, pre, paso)), ['01_clase', '02_clase'],
                        `${paso} tiene la secuencia de cada clase, sin renombrar`);
                }
                // Dos clases por cuatro versiones: la entrega y los tres pasos.
                // Si el nombre se hubiera tocado en algún lado, alguna de las
                // ocho no se llamaría así.
                t.eq(p.porClase('Sequence').filter(k => /^0\d_clase$/.test(p.nombre(k))).length, 8);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('el material de los pasos previos es el mismo, no una segunda copia', () => {
            // Un `.prproj` con el mismo archivo importado tres veces le muestra
            // al editor tres filas en el panel para el mismo medio, y ninguna
            // dice cuál usar. El `registro` es por curso justamente por esto.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            conPasos(dir, '01_clase', medio, ['populatedXml', 'alignedXml']);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.ok(r.cuenta.some(c => /1 archivo\(s\) de material/.test(c)),
                    `un archivo y no tres: ${r.cuenta.join(' | ')}`);
                const p = prproj.Proyecto.leer(r.ruta);
                t.eq(p.porClase('ClipProjectItem').filter(k => p.nombre(k) === 'a.mov').length, 1,
                    'una sola fila en el panel');
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('a una clase le puede faltar un paso: se saltea y se cuenta, no se rompe', () => {
            // Una clase procesada con una versión vieja no tiene Backup, y
            // negarle el proyecto entero al editor por eso sería cambiar doce
            // pasos previos por ninguno.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            conPasos(dir, '01_clase', medio, ['populatedXml', 'alignedXml']);
            conPasos(dir, '02_clase', medio, ['populatedXml']);
            conPasos(dir, '03_clase', medio, []);
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.clases, 3, 'las tres clases entran igual');
                const p = prproj.Proyecto.leer(r.ruta);
                const pre = binDentroDe(p, p.porNombre('BinProjectItem', curso.BIN_SECUENCIAS), curso.BIN_PRE);
                t.deep(dentroDe(p, binDentroDe(p, pre, 'poblada')), ['01_clase', '02_clase']);
                t.deep(dentroDe(p, binDentroDe(p, pre, 'alineada')), ['01_clase']);
                t.ok(r.avisos.every(a => !/paso|previo|poblada|alineada/i.test(a)),
                    `que falte un paso no es un aviso: ${r.avisos.join(' | ')}`);
                t.ok(r.cuenta.some(c => /Otros 3 no estaban guardados/.test(c)),
                    `pero se cuenta: ${r.cuenta.join(' | ')}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('sin nada en Backup, «Pre» igual trae el corte sin anidar', () => {
            // Una clase cortada con una versión vieja no tiene `Backup/`, así que
            // no hay ni `poblada` ni `alineada`. Pero el XML de la entrega existe
            // siempre —es de donde se leyó la clase— y ese es el tercer paso, así
            // que `Pre` nunca queda vacío mientras haya clases. Es justamente el
            // que más se va a mirar: es lo único del proyecto que se parece a lo
            // que Resolve abre.
            const dir = carpeta({ 'The Cutter/01_clase.xml': xmlDe('01_clase') });
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const p = prproj.Proyecto.leer(r.ruta);
                const pre = binDentroDe(p, p.porNombre('BinProjectItem', curso.BIN_SECUENCIAS), curso.BIN_PRE);
                t.ok(pre, 'el bin está');
                t.deep(dentroDe(p, pre), ['sin-anidar'], 'con el único paso que siempre existe');
                t.eq(p.porNombre('BinProjectItem', 'poblada'), null, 'y sin los que no están');
                t.ok(r.cuenta.some(c => /Otros 2 no estaban guardados/.test(c)),
                    `y se cuenta cuáles faltaron: ${r.cuenta.join(' | ')}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('el aviso de una clase no se repite una vez por paso', () => {
            // El defecto que esto protege es el mismo de siempre: trece clases
            // por tres versiones son treinta y nueve líneas iguales tapando a la
            // única que pide hacer algo. La etiqueta es la misma en los tres
            // XML, así que el aviso también.
            const dir = carpeta({ 'material/a.mov': 'no importa qué diga' });
            const medio = path.join(dir, 'material', 'a.mov');
            fs.mkdirSync(path.join(dir, workspace.OUTPUT_DIR, workspace.BACKUP_DIR), { recursive: true });
            for (const ruta of [workspace.finalXml(dir, '01_clase'),
                workspace.artifact(dir, '01_clase', 'populatedXml'),
                workspace.artifact(dir, '01_clase', 'alignedXml')]) {
                fs.writeFileSync(ruta, xmlConMaterial('01_clase', medio, 'Turquesa'));
            }
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                const dela = r.avisos.filter(a => /Turquesa/.test(a));
                t.eq(dela.length, 1, `una vez y no tres: ${r.avisos.join(' | ')}`);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });

        t.test('las notas en vivo no tienen pasos previos que mostrar', () => {
            // No pasaron por el pipeline: son marcadores tomados mientras se
            // grababa. Ir a buscarles un `Backup/` sería buscar en la carpeta
            // equivocada de otro flujo.
            const dir = carpeta({
                'xml/01_notas.xml': xmlDe('01_notas'),
                'The Cutter/Backup/01_notas_poblada.xml': xmlDe('01_notas')
            });
            return curso.generar({ carpeta: dir, destino: path.join(dir, 'Proyecto', 's.prproj'), plantilla: PLANTILLA, semilla: 1 }).then(r => {
                t.eq(r.ok, true, r.error || '');
                t.eq(r.fuente, 'notas');
                const p = prproj.Proyecto.leer(r.ruta);
                t.eq(binDentroDe(p, p.porNombre('BinProjectItem', curso.BIN_SECUENCIAS), curso.BIN_PRE), null);
                fs.rmSync(dir, { recursive: true, force: true });
            });
        });


        t.group('el proyecto del curso · con una plantilla de verdad');

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
