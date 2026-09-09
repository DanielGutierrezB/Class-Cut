'use strict';
/**
 * prproj-molde.js — Revisa el generador de `.prproj` contra una plantilla de
 * verdad y, si se le da una, contra un curso de verdad.
 *
 *   node tools/prproj-molde.js <plantilla.prproj> [carpeta-del-curso]
 *
 * **Es una herramienta y no una prueba de la suite porque necesita un `.prproj`
 * del disco del editor.** Meter medio mega de proyecto de Premiere al repo para
 * que una prueba tenga qué clonar sería pagar mucho por poco: la lógica se
 * prueba con objetos inventados en `tests/prproj.test.js`, que es donde tiene
 * que estar. Lo que no se puede probar sin un proyecto real es otra cosa —que
 * los moldes se reconozcan en un proyecto que hizo una persona— y para eso está
 * esto.
 *
 * Lo que revisa, y por qué cada cosa:
 *
 * 1. **Que los moldes aparezcan.** Se buscan por forma y no por nombre, así que
 *    la pregunta es si esa búsqueda encuentra algo en un proyecto que no se
 *    escribió pensando en ella.
 * 2. **Que el grafo cierre**, releyendo el archivo escrito y no el de memoria.
 *    Una referencia a un objeto que no está es lo único que separa un archivo
 *    que abre de uno que Premiere declara dañado.
 * 3. **Que lo que se pidió esté puesto**: las pistas con sus `<ID>` en las dos
 *    listas, los cortes en su tiempo, el mono mono y el estéreo estéreo, los
 *    marcadores ordenados por GUID y su color exacto.
 * 4. **Que la plantilla no se haya tocado más de lo necesario**, comparando
 *    objeto por objeto contra el original. Lo único que tiene derecho a cambiar
 *    es la lista de la raíz del panel de proyecto.
 *
 * Lo que NO puede revisar es si Premiere lo abre. Eso hay que hacerlo a mano, y
 * el propio archivo que deja esto en `/tmp` sirve para probarlo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const prproj = require('../engine/prproj');
const secuencia = require('../engine/prproj-secuencia');
const curso = require('../engine/prproj-curso');

const estado = { bien: 0, mal: 0, fallos: [] };

function revisar(que, condicion, detalle) {
    if (condicion) {
        estado.bien++;
        console.log(`  ✓ ${que}${detalle ? ` · ${detalle}` : ''}`);
    } else {
        estado.mal++;
        estado.fallos.push(`${que}${detalle ? ` · ${detalle}` : ''}`);
        console.log(`  ✗ ${que}${detalle ? ` · ${detalle}` : ''}`);
    }
}

function titulo(texto) {
    console.log(`\n${texto}`);
}

/** Las pistas de un grupo, con su `<ID>` interno y su `<Index>`. */
function pistasDe(p, grupo) {
    const claves = [...p.contenido(grupo).matchAll(/<Track Index="\d+" ObjectURef="([^"]+)"\/>/g)]
        .map(m => prproj.clave('UID', m[1]));
    return claves.map(k => ({
        k,
        id: Number((/\n\t\t\t\t<ID>(\d+)<\/ID>/.exec(p.contenido(k)) || [])[1]),
        indice: Number((/\n\t\t\t\t<Index>(\d+)<\/Index>/.exec(p.contenido(k)) || [])[1]),
        cortes: [...p.contenido(k).matchAll(/<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g)]
            .map(m => prproj.clave('ID', m[1]))
    }));
}

function gruposDe(p, seq) {
    const salida = {};
    for (const m of p.contenido(seq).matchAll(/<Second ObjectRef="(\d+)"\/>/g)) {
        const k = prproj.clave('ID', m[1]);
        salida[p.clase(k)] = k;
    }
    return salida;
}


// ─── 1. Los moldes ───────────────────────────────────────────────────

function revisarMoldes(p) {
    titulo('Los moldes que la plantilla presta');
    let moldes;
    try {
        moldes = secuencia.detectarMoldes(p);
    } catch (e) {
        revisar('los moldes se reconocen', false, e.message);
        return null;
    }
    for (const nombre of ['secuencia', 'itemDeSecuencia', 'corteVideo', 'corteMono',
        'corteEstereo', 'medioVideo', 'medioMono', 'medioEstereo', 'bin']) {
        const k = moldes[nombre];
        revisar(`hay molde de ${nombre}`, Boolean(k),
            k ? `${p.clase(k)} «${p.nombre(k) || '—'}»` : 'no se encontró');
    }
    // El mono y el estéreo tienen que ser DISTINTOS: si la detección devolviera
    // el mismo para los dos, todo el audio saldría con la misma cantidad de
    // canales y el defecto pasaría desapercibido hasta que alguien escuchara.
    revisar('el corte mono y el estéreo no son el mismo objeto',
        moldes.corteMono && moldes.corteEstereo && moldes.corteMono !== moldes.corteEstereo);
    revisar('el medio mono y el estéreo tampoco',
        moldes.medioMono && moldes.medioEstereo && moldes.medioMono !== moldes.medioEstereo);
    revisar('el corte mono declara un canal',
        secuencia.canalesDeclarados(p, p.cierre([moldes.corteMono], { claseFrontera: secuencia.FRONTERA_DEL_CORTE })
            .find(k => p.clase(k) === 'AudioClip')) === 1);
    revisar('el corte estéreo declara dos',
        secuencia.canalesDeclarados(p, p.cierre([moldes.corteEstereo], { claseFrontera: secuencia.FRONTERA_DEL_CORTE })
            .find(k => p.clase(k) === 'AudioClip')) === 2);
    return moldes;
}


// ─── 2. Una secuencia armada a mano, revisada al detalle ─────────────

function revisarCirugia(rutaPlantilla, dir) {
    titulo('Una secuencia armada de cero');
    const p = prproj.Proyecto.leer(rutaPlantilla);
    const base = prproj.Proyecto.leer(rutaPlantilla);
    const taller = new secuencia.Taller(p, { semilla: 20260909 });
    const antes = p.bloques.length;

    const s = taller.crearSecuencia({ nombre: 'MOLDE-PRUEBA', pistasVideo: 3, pistasAudio: 10, duracionSeg: 356.47 });
    taller.guardarEn(taller.raizDelPanel(), s.itemDelPanel);

    // La fórmula del informe: 22 del esqueleto + 1 por pista de video de más + 8
    // por pista de audio de más + 14 del ítem del panel.
    const modelo = taller.moldes.pistasDeLaSecuencia;
    const esperado = 22 + (3 - modelo.video) * 1 + (10 - modelo.audio) * 8 + 14;
    revisar('el esqueleto pesa lo que dice la fórmula', p.bloques.length - antes === esperado,
        `${p.bloques.length - antes} objetos, esperados ${esperado}`);

    const camara = taller.importarMedio({
        ruta: '/tmp/no-existe/1_CAMERA 1.mp4', nombre: '1_CAMERA 1.mp4',
        duracionSeg: 2516, canales: 2, conVideo: true, etiqueta: 'Cerulean'
    });
    const mono = taller.importarMedio({
        ruta: '/tmp/no-existe/1_COMBO-1.wav', nombre: '1_COMBO-1.wav',
        duracionSeg: 2516, canales: 1, conVideo: false
    });
    const estereo = taller.importarMedio({
        ruta: '/tmp/no-existe/Live-Mix.wav', nombre: 'Live-Mix.wav',
        duracionSeg: 2516, canales: 2, conVideo: false
    });
    for (const m of [camara, mono, estereo]) taller.guardarEn(taller.raizDelPanel(), m.clipProjectItem);

    taller.colocarCorte({ pista: s.pistasVideo[0], medio: camara, desdeSeg: 0, hastaSeg: 12.37, entradaSeg: 91.47, etiqueta: 'Cerulean' });
    taller.colocarCorte({ pista: s.pistasVideo[1], medio: camara, desdeSeg: 0, hastaSeg: 12.37, entradaSeg: 91.47, etiqueta: 'Rose' });
    taller.colocarCorte({ pista: s.pistasAudio[0], medio: mono, desdeSeg: 0, hastaSeg: 12.37, entradaSeg: 91.47, sonando: false });
    taller.colocarCorte({ pista: s.pistasAudio[1], medio: estereo, desdeSeg: 0, hastaSeg: 12.37, entradaSeg: 91.47, sonando: true });
    taller.ponerMarcadores(s.secuencia, [
        { nombre: 'PV', comentario: 'OUT ANTES DE: "En Spec"', desdeSeg: 39.27, hastaSeg: 51.9, color: 4281740498 },
        { nombre: 'R', comentario: 'PV al prompt', desdeSeg: 185.17, hastaSeg: 220.23, color: 4280578025 }
    ]);

    const ruta = path.join(dir, 'molde-prueba.prproj');
    try {
        p.guardar(ruta);
        revisar('se pudo guardar (o sea que verificó limpio)', true, ruta);
    } catch (e) {
        revisar('se pudo guardar', false, e.message);
        return;
    }

    // Desde acá se lee el ARCHIVO y no el proyecto de memoria: es la única forma
    // de comprobar que lo que se creyó escribir es lo que quedó escrito.
    const d = prproj.Proyecto.leer(ruta);
    revisar('el grafo del archivo cierra', d.verificar().ok);
    revisar('la cabecera gzip es la de Premiere',
        prproj.cabeceraDe(fs.readFileSync(ruta)) === prproj.CABECERA_ESPERADA);

    const seq = d.porNombre('Sequence', 'MOLDE-PRUEBA');
    revisar('la secuencia está y con su nombre', Boolean(seq));
    if (!seq) return;

    const g = gruposDe(d, seq);
    const pv = pistasDe(d, g.VideoTrackGroup);
    const pa = pistasDe(d, g.AudioTrackGroup);
    revisar('tiene tres pistas de video y diez de audio', pv.length === 3 && pa.length === 10,
        `V${pv.length} A${pa.length}`);
    revisar('los <ID> de video arrancan en 1', pv.every((x, i) => x.id === i + 1), pv.map(x => x.id).join(','));
    // Los de audio arrancan en 2 porque el 1 se lo queda el AudioMixTrack, que
    // es una pista más para el formato aunque el editor no la vea.
    revisar('los de audio arrancan en 2, que el 1 es del mix', pa.every((x, i) => x.id === i + 2),
        pa.map(x => x.id).join(','));
    revisar('los <Index> son densos desde cero',
        pv.every((x, i) => x.indice === i) && pa.every((x, i) => x.indice === i));
    revisar('NextTrackID va uno más allá del último',
        Number(/<NextTrackID>(\d+)</.exec(d.contenido(g.VideoTrackGroup))[1]) === 4
        && Number(/<NextTrackID>(\d+)</.exec(d.contenido(g.AudioTrackGroup))[1]) === 12);

    // La segunda lista, la que es fácil olvidarse: una pista que está en el
    // grupo pero no acá queda sin llegar al máster.
    const mix = prproj.clave('ID', /<MasterTrack ObjectRef="(\d+)"\/>/.exec(d.contenido(g.AudioTrackGroup))[1]);
    const inlet = prproj.clave('ID', /<Inlet ObjectRef="(\d+)"\/>/.exec(d.contenido(mix))[1]);
    const fuentes = [...d.contenido(inlet).matchAll(/<Source Index="\d+" ObjectURef="([^"]+)"\/>/g)]
        .map(m => prproj.clave('UID', m[1]));
    revisar('el AudioTrackInlet lista las mismas diez pistas',
        JSON.stringify(fuentes) === JSON.stringify(pa.map(x => x.k)));

    revisar('las pistas son nuevas y no las de la plantilla',
        pv.concat(pa).every(x => !base.tiene(x.k)));

    // Los cortes: donde caen, qué pedazo del origen piden, y de qué color son.
    const leerCorte = k => {
        const t = d.contenido(k);
        const sub = prproj.clave('ID', /<SubClip ObjectRef="(\d+)"\/>/.exec(t)[1]);
        const clip = prproj.clave('ID', /<Clip ObjectRef="(\d+)"\/>/.exec(d.contenido(sub))[1]);
        const ct = d.contenido(clip);
        const fuente = prproj.clave('ID', /<Source ObjectRef="(\d+)"\/>/.exec(ct)[1]);
        const medio = prproj.clave('UID', /<Media ObjectURef="([^"]+)"/.exec(d.contenido(fuente))[1]);
        return {
            nombre: d.nombre(sub),
            desde: Number((/<Start>(\d+)</.exec(t) || [, 0])[1]),
            hasta: Number(/<End>(\d+)</.exec(t)[1]),
            entrada: Number(/<InPoint>(\d+)</.exec(ct)[1]),
            salida: Number(/<OutPoint>(\d+)</.exec(ct)[1]),
            etiqueta: (/asl\.clip\.label\.name>BE\.Prefs\.LabelColors\.(\d+)</.exec(ct) || [])[1],
            color: (/<asl\.clip\.label\.color>(\d+)</.exec(ct) || [])[1],
            mudo: /<IsMuted>true<\/IsMuted>/.test(t),
            canales: (((/<AudioChannelLayout>([^<]*)</.exec(ct) || [, ''])[1]).match(/channellabel/g) || []).length,
            ruta: (/<FilePath>([^<]*)</.exec(d.contenido(medio)) || [, ''])[1]
        };
    };

    const v1 = leerCorte(pv[0].cortes[0]);
    revisar('el corte de video cae donde se pidió',
        v1.desde === 0 && v1.hasta === prproj.aTicks(12.37), `0 → ${prproj.aSegundos(v1.hasta).toFixed(2)}s`);
    revisar('y pide el pedazo del origen que se pidió',
        v1.entrada === prproj.aTicks(91.47) && v1.salida - v1.entrada === v1.hasta - v1.desde,
        `${prproj.aSegundos(v1.entrada).toFixed(2)}s, mismo largo que en la línea`);
    revisar('apunta al archivo nuevo', v1.ruta === '/tmp/no-existe/1_CAMERA 1.mp4', v1.ruta);
    revisar('lleva las DOS caras del cerúleo, el índice y el entero',
        v1.etiqueta === String(secuencia.ETIQUETAS.Cerulean.indice)
        && v1.color === String(secuencia.ETIQUETAS.Cerulean.entero),
        `índice ${v1.etiqueta}, entero ${v1.color}`);
    const v2 = leerCorte(pv[1].cortes[0]);
    revisar('el de la otra pista lleva el rosa',
        v2.etiqueta === String(secuencia.ETIQUETAS.Rose.indice)
        && v2.color === String(secuencia.ETIQUETAS.Rose.entero));

    // El estéreo, que es el punto de haber hecho esto en vez de quedarse con el
    // XML de intercambio: acá se DECLARA, y un clip estéreo es un clip.
    const a1 = leerCorte(pa[0].cortes[0]);
    const a2 = leerCorte(pa[1].cortes[0]);
    revisar('el corte del WAV mono declara un canal', a1.canales === 1, `${a1.nombre}: ${a1.canales}`);
    revisar('el del WAV estéreo declara dos', a2.canales === 2, `${a2.nombre}: ${a2.canales}`);
    revisar('el que entra apagado tiene el ojo apagado', a1.mudo === true && a2.mudo === false);

    // Los marcadores: ordenados por GUID y con el color como entero exacto.
    const cont = prproj.clave('ID', /<Markers ObjectRef="(\d+)"\/>/.exec(d.contenido(seq))[1]);
    const llaves = [...d.contenido(cont).matchAll(/<First>([^<]+)<\/First>/g)].map(m => m[1]);
    revisar('los marcadores van ordenados por GUID, no por tiempo',
        JSON.stringify(llaves) === JSON.stringify([...llaves].sort()));
    revisar('el contenedor lo declara con ByGUID', /<ByGUID>byGUID<\/ByGUID>/.test(d.contenido(cont)));
    const cuerpos = [...d.contenido(cont).matchAll(/<Second ObjectRef="(\d+)"\/>/g)]
        .map(m => JSON.parse(/<DVAMarker>([\s\S]*?)<\/DVAMarker>/.exec(d.contenido(prproj.clave('ID', m[1])))[1]
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&apos;/g, "'")).DVAMarker);
    const pv1 = cuerpos.find(c => c.mName === 'PV');
    revisar('el comentario del marcador llega tal cual, con sus comillas',
        pv1 && pv1.mComment === 'OUT ANTES DE: "En Spec"', pv1 && JSON.stringify(pv1.mComment));
    revisar('el color viaja como el entero exacto y no degradado a un nombre',
        pv1 && JSON.parse(pv1.mCuePointList.find(c => /keywordExt/.test(c.mKey)).mValue).color === 4281740498);
    revisar('el marcador arranca en su tick', pv1 && pv1.mStartTime.ticks === prproj.aTicks(39.27));

    // Los medios: sin transcripción, sin huellas del archivo de origen y sin
    // ruta relativa apuntando a otro lado.
    const medios = d.porClase('MasterClip').filter(k => !base.tiene(k) && /\.(mp4|wav)$/.test(d.nombre(k) || ''));
    revisar('los clips maestros nuevos no arrastran transcripción',
        medios.every(k => !d.refsDe(k).some(x => d.clase(x) === 'TranscriptClip')),
        `${medios.length} medios`);
    const archivos = d.porClase('Media').filter(k => !base.tiene(k));
    revisar('ningún medio nuevo miente una huella del archivo viejo',
        archivos.every(k => !/ModificationState|ContentAndMetadataState/.test(d.contenido(k))));
    revisar('ni deja una ruta relativa apuntando a otro lado',
        archivos.every(k => !/<RelativePath>/.test(d.contenido(k))));

    // Y la plantilla: lo único que tiene derecho a cambiar es la lista de la raíz.
    const tocados = base.claves().filter(k => d.tiene(k) && d.contenido(k) !== base.contenido(k));
    revisar('de la plantilla solo cambió la lista de la raíz del panel',
        tocados.length === 1 && base.clase(tocados[0]) === 'RootProjectItem',
        tocados.map(k => `${base.clase(k)} «${base.nombre(k) || '—'}»`).join(', ') || 'nada');
    revisar('y no se borró ni un objeto de la plantilla',
        base.claves().every(k => d.tiene(k)));
}


// ─── 3. Un curso de verdad, si se dio uno ────────────────────────────

function revisarCurso(rutaPlantilla, carpeta, dir) {
    titulo(`El curso de «${path.basename(carpeta)}»`);
    const fuente = curso.ubicarFuente(carpeta);
    if (!fuente.ok) {
        revisar('la carpeta tiene XML de alguna de las dos clases', false, fuente.error);
        return Promise.resolve();
    }
    revisar('se eligió una fuente', true, `${fuente.tipo}, ${fuente.xmls.length} XML`);

    // Se trabaja en una carpeta aparte con un enlace a los XML: el proyecto se
    // escribe al lado de la carpeta que se le da, y la del curso es del usuario.
    const trabajo = path.join(dir, path.basename(carpeta));
    fs.mkdirSync(trabajo, { recursive: true });
    fs.symlinkSync(path.dirname(fuente.xmls[0]), path.join(trabajo, path.basename(path.dirname(fuente.xmls[0]))));

    const arranque = Date.now();
    return curso.generar({ carpeta: trabajo, plantilla: rutaPlantilla, semilla: 20260909 }).then(r => {
        revisar('el curso se armó', r.ok, r.error || `${r.clases} clases en ${Date.now() - arranque} ms`);
        if (!r.ok) return;
        revisar('dice de qué fuente salió', r.fuente === fuente.tipo, r.fuente);
        revisar('una secuencia por clase', r.clases === fuente.xmls.length,
            `${r.clases} de ${fuente.xmls.length}`);

        const d = prproj.Proyecto.leer(r.ruta);
        const base = prproj.Proyecto.leer(rutaPlantilla);
        revisar('el grafo del curso entero cierra', d.verificar().ok);
        revisar('la cabecera gzip es la de Premiere',
            prproj.cabeceraDe(fs.readFileSync(r.ruta)) === prproj.CABECERA_ESPERADA);

        const nuevas = d.porClase('Sequence').filter(k => !base.tiene(k));
        revisar('las secuencias están y con el nombre de su clase',
            nuevas.length === r.clases && fuente.xmls.every(x =>
                nuevas.some(k => d.nombre(k) === path.basename(x, '.xml'))));

        // El zoom: heredado de la plantilla, una clase corta abre con los clips
        // convertidos en una raya y parece que no se generó nada.
        revisar('cada secuencia abre con su propio zoom',
            new Set(nuevas.map(k => /<TL.SQTimePerPixel>([^<]*)</.exec(d.contenido(k))[1])).size > 1);

        for (const k of nuevas) {
            const g = gruposDe(d, k);
            const pv = pistasDe(d, g.VideoTrackGroup);
            const pa = pistasDe(d, g.AudioTrackGroup);
            const cortes = pv.concat(pa).reduce((n, x) => n + x.cortes.length, 0);
            const bien = pv.every((x, i) => x.id === i + 1 && x.indice === i)
                && pa.every((x, i) => x.id === i + 2 && x.indice === i);
            revisar(`«${d.nombre(k)}»`, bien, `V${pv.length} A${pa.length}, ${cortes} cortes`);
        }

        const tocados = base.claves().filter(k => d.tiene(k) && d.contenido(k) !== base.contenido(k));
        revisar('de la plantilla solo cambió la lista de la raíz del panel',
            tocados.length === 1 && base.clase(tocados[0]) === 'RootProjectItem');

        const bytes = fs.statSync(r.ruta).size;
        console.log(`\n  → ${r.ruta}`);
        console.log(`     ${(bytes / 1048576).toFixed(2)} MB comprimido, ${d.bloques.length} objetos`);
        for (const a of r.avisos) console.log(`     · ${a}`);
    });
}


// ─── La corrida ──────────────────────────────────────────────────────

function main() {
    const plantilla = process.argv[2];
    const carpeta = process.argv[3];
    if (!plantilla || !fs.existsSync(plantilla)) {
        console.error('Uso: node tools/prproj-molde.js <plantilla.prproj> [carpeta-del-curso]');
        console.error('La plantilla es cualquier .prproj de Premiere con una secuencia,');
        console.error('un archivo de video y dos de audio (uno mono y uno estéreo).');
        process.exit(2);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-molde-'));
    console.log(`Plantilla: ${plantilla}`);

    let p;
    try {
        p = prproj.Proyecto.leer(plantilla);
    } catch (e) {
        console.error(`No se pudo abrir la plantilla: ${e.message}`);
        process.exit(2);
    }
    console.log(`           ${p.bloques.length} objetos, ${p.porClase('Sequence').length} secuencia(s)`);

    const moldes = revisarMoldes(p);
    if (moldes) revisarCirugia(plantilla, dir);

    const despues = () => {
        titulo(`${estado.bien} bien · ${estado.mal} mal`);
        if (estado.mal) {
            console.log('\nLo que falló:');
            for (const f of estado.fallos) console.log(`  · ${f}`);
        }
        console.log(`\nLos archivos quedaron en ${dir} para abrirlos en Premiere.`);
        process.exit(estado.mal ? 1 : 0);
    };

    if (carpeta && fs.existsSync(carpeta) && moldes) {
        revisarCurso(plantilla, carpeta, dir).then(despues, e => {
            revisar('el curso se armó', false, e.message);
            despues();
        });
    } else {
        despues();
    }
}

main();
