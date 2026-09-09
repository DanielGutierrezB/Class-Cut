'use strict';
/**
 * Compara dos `.prproj` por lo que el editor ve, no por lo que dicen los bytes.
 *
 *     node tools/prproj-contra.js <esperado.prproj> <generado.prproj>
 *
 * **Nació porque el editor armó a mano el proyecto que quería.** Importó el
 * curso en Premiere, lo acomodó y guardó, y ese archivo es la mejor prueba que
 * hay de este generador: no una lista de cosas que a mí se me ocurrió revisar,
 * sino el resultado completo, hecho por Premiere, contra el que se puede poner
 * lo que sale y ver dónde difiere.
 *
 * Comparar byte a byte no sirve para nada: los GUID son nuevos cada vez, los
 * `ObjectID` se renumeran y el orden de los objetos en el archivo no significa
 * nada. Lo que sí significa algo, y es lo que se compara acá, es qué se ve en la
 * ventana de proyecto, de qué color, con cuántas pistas, con cuántos cortes y
 * con cuántos canales cada uno.
 *
 * Las diferencias que salen no son necesariamente errores. Hay dos que se
 * esperan y que la herramienta señala como tales: los objetos de transcripción,
 * que Premiere genera solo y nosotros a propósito no, y los canales de audio,
 * donde el archivo del editor tiene mono lo que el material tiene en estéreo
 * porque así se lo pidió el XML de intercambio. Ahí el generado está mejor que
 * el esperado, y por eso existe este camino.
 */

const prproj = require('../engine/prproj');
const secuencia = require('../engine/prproj-secuencia');

/**
 * Todo lo que el editor ve de un proyecto, en estructuras comparables.
 *
 * Los nombres de clase se normalizan a `<clase>` porque son distintos en cada
 * curso y lo que interesa es la forma: trece bins de clase con doce archivos
 * adentro, no cómo se llama cada uno.
 */
function retrato(ruta) {
    const p = prproj.Proyecto.leer(ruta);
    const r = {
        ruta,
        objetos: p.bloques.length,
        arbol: [],
        etiquetas: new Map(),
        pistas: new Map(),
        canales: new Map(),
        cortes: 0,
        transcripciones: p.porClase('TranscriptClip').length
    };

    // Los marcadores, separados por dónde cuelgan. Premiere, al importar el XML
    // de intercambio, los deja DOS veces: en la línea de tiempo y otra vez en el
    // clip maestro. El generador los pone solo en la línea, que es donde el
    // editor los busca; contarlos juntos escondería esa decisión detrás de un
    // «140 contra 70» que parecería que se perdió la mitad.
    r.marcadoresEnLaSecuencia = 0;
    r.marcadoresEnElMaterial = 0;
    for (const k of p.porClase('Markers')) {
        const cuantos = (p.contenido(k).match(/<Marker /g) || []).length;
        if (!cuantos) continue;
        const dueños = p.quienReferencia(k).map(x => p.clase(x));
        if (dueños.includes('Sequence')) r.marcadoresEnLaSecuencia += cuantos;
        else r.marcadoresEnElMaterial += cuantos;
    }

    const generico = s => String(s).replace(/^\d{2}_.*_\d+_\d+$/, '<clase>');

    // El árbol del panel: se recorre por la lista `<Items>` y no por el
    // anidamiento del XML, que no dice quién cuelga de quién.
    const raiz = p.porClase('RootProjectItem')[0];
    const bajar = (k, hondo) => {
        r.arbol.push('  '.repeat(hondo) + generico(p.nombre(k) || '—') + ' · ' + p.clase(k));
        for (const hijo of secuencia.entradasDeLista(p, k, 'Items')) {
            const m = /ObjectURef="([^"]+)"/.exec(hijo);
            if (m && p.tiene(prproj.clave('UID', m[1]))) bajar(prproj.clave('UID', m[1]), hondo + 1);
        }
    };
    if (raiz) bajar(raiz, 0);

    for (const k of p.claves()) {
        const m = /<Column.PropertyText.Label>BE\.Prefs\.LabelColors\.(\d+)</.exec(p.contenido(k));
        if (!m) continue;
        const nom = p.nombre(k) || '—';
        const que = p.clase(k) === 'BinProjectItem' ? '«bin»'
            : (/\.(mp4|mov|wav|mp3|aac)$/i.test(nom) ? nom.replace(/^\d+_/, '') : '«secuencia»');
        cuenta(r.etiquetas, `${m[1]} · ${que}`);
    }

    for (const seq of p.porClase('Sequence')) {
        const grupos = {};
        for (const m of p.contenido(seq).matchAll(/<Second ObjectRef="(\d+)"\/>/g)) {
            grupos[p.clase(prproj.clave('ID', m[1]))] = prproj.clave('ID', m[1]);
        }
        const cuantas = g => g ? (p.contenido(g).match(/<Track Index="\d+"/g) || []).length : 0;
        cuenta(r.pistas, `V${cuantas(grupos.VideoTrackGroup)} A${cuantas(grupos.AudioTrackGroup)}`);
    }

    for (const clase of ['VideoClipTrackItem', 'AudioClipTrackItem']) {
        for (const k of p.porClase(clase)) {
            r.cortes++;
            if (clase !== 'AudioClipTrackItem') continue;
            const piezas = p.cierre([k], { claseFrontera: secuencia.FRONTERA_DEL_CORTE });
            const sub = piezas.find(x => p.clase(x) === 'SubClip');
            const clip = piezas.find(x => p.clase(x) === 'AudioClip');
            cuenta(r.canales, `${p.nombre(sub) || '?'} → ${secuencia.canalesDeclarados(p, clip)} canal(es)`);
        }
    }
    return r;
}

function cuenta(mapa, clave) { mapa.set(clave, (mapa.get(clave) || 0) + 1); }

/** Una tabla de dos columnas, marcando dónde no coinciden. */
function contra(titulo, a, b, nota) {
    const claves = [...new Set([...a.keys(), ...b.keys()])].sort();
    const distintos = claves.filter(k => (a.get(k) || 0) !== (b.get(k) || 0));
    console.log(`\n─── ${titulo} ───   ${distintos.length ? `${distintos.length} diferencia(s)` : 'coinciden'}`);
    for (const k of claves) {
        const x = a.get(k) || 0, y = b.get(k) || 0;
        if (x === y && distintos.length) continue;   // con diferencias, solo se listan esas
        console.log('  ' + k.padEnd(40) + String(x).padStart(6) + String(y).padStart(9)
            + (x === y ? '' : '   ←'));
    }
    if (distintos.length && nota) console.log('  ' + nota);
}

function main() {
    const [esperado, generado] = process.argv.slice(2);
    if (!esperado || !generado) {
        console.error('uso: node tools/prproj-contra.js <esperado.prproj> <generado.prproj>');
        process.exit(2);
    }
    const A = retrato(esperado), B = retrato(generado);
    console.log(`esperado: ${A.ruta}\n            ${A.objetos} objetos`);
    console.log(`generado: ${B.ruta}\n            ${B.objetos} objetos`);
    console.log('\n' + ' '.repeat(42) + 'esperado  generado');

    console.log(`\n─── el árbol de la ventana de proyecto ───   `
        + (A.arbol.join('\n') === B.arbol.join('\n') ? 'idéntico' : 'DIFIERE'));
    if (A.arbol.join('\n') !== B.arbol.join('\n')) {
        const n = Math.max(A.arbol.length, B.arbol.length);
        let mostradas = 0;
        for (let i = 0; i < n && mostradas < 20; i++) {
            if (A.arbol[i] === B.arbol[i]) continue;
            console.log(`  línea ${i}\n    esperado: ${A.arbol[i] || '(no está)'}\n    generado: ${B.arbol[i] || '(no está)'}`);
            mostradas++;
        }
    }

    contra('los colores del panel', A.etiquetas, B.etiquetas);
    contra('las pistas de cada secuencia', A.pistas, B.pistas);
    contra('los canales de cada corte de audio', A.canales, B.canales,
        'esperada: el archivo del editor salió de un XML de intercambio, que pide un solo\n'
        + '  canal por clip y deja en mono lo que el material tiene en estéreo. Lo generado\n'
        + '  declara lo que midió ffprobe, que es el motivo de que este camino exista.');

    const suelto = r => new Map([
        ['cortes', r.cortes],
        ['marcadores en la línea de tiempo', r.marcadoresEnLaSecuencia],
        ['marcadores repetidos en el material', r.marcadoresEnElMaterial],
        ['transcripciones', r.transcripciones]
    ]);
    contra('el resto', suelto(A), suelto(B),
        'esperadas: las transcripciones las genera Premiere solo y ocupan líneas de\n'
        + '  millones de caracteres, así que el generador no las escribe. Y los marcadores\n'
        + '  repetidos en el material son cosa de la importación del XML: el generador los\n'
        + '  pone una vez, en la línea de tiempo, que es donde el editor los busca.');
}

if (require.main === module) main();

module.exports = { retrato };
