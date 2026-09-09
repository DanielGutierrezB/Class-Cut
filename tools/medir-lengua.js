'use strict';
/**
 * medir-lengua.js — De dónde salen las bandas de `engine/lengua.js`.
 *
 * Las tres bandas que deciden si el panel avisa —ritmo, muletillas y aire
 * muerto— son números que se miden, no que se estiman. Esta herramienta es la
 * que los mide, y está para poder volver a medirlos: el día que haya un segundo
 * curso, las bandas de un solo profesor van a quedar chicas y esto es lo que hay
 * que correr antes de moverlas a ojo.
 *
 * Se mide en dos materiales distintos, y la diferencia es el punto:
 *
 *   - **Crudo**, agrupado en tiradas de habla. Es lo que se parece a una toma
 *     recién cerrada: con los arranques fallidos y las muletillas puestas. Es
 *     contra esto que se mide lo que el profesor va a ver mientras graba.
 *
 *   - **El corte final**, bloque por bloque, tal como quedó alineado. Es material
 *     que un editor humano miró y dio por bueno, así que su distribución dice
 *     qué ritmo pasa el filtro de alguien que sabe. Si la banda dejara afuera un
 *     tercio del corte final, la banda está mal y no el profesor.
 *
 * La banda buena es el solape de las dos. Se toman los deciles de afuera —una de
 * cada diez por cada lado— porque una señal en vivo que salta la mitad de las
 * veces se deja de mirar a los dos minutos.
 *
 *   node tools/medir-lengua.js "/ruta/al/curso"
 */

const fs = require('fs');
const path = require('path');

const lengua = require('../engine/lengua');
const oir = require('../engine/oir');
const voz = require('../engine/voz');

/** Las palabras del transcript en la forma de una toma: hora en ms, texto. */
function comoToma(words) {
    return words.map(w => ({ t: Math.round(w.start * 1000), texto: w.text }));
}

/**
 * El material crudo partido en tiradas de habla.
 *
 * Se corta donde `oir` corta —2,5 s de silencio— y se tiran las tiradas de menos
 * de 25 s: son el "ajá", el "esperen" y el carraspeo entre dos explicaciones, y
 * una tasa por minuto sobre cuatro segundos no es una tasa, es una división.
 */
function tiradas(words) {
    const salida = [];
    let actual = [];
    let previo = null;
    for (const w of words) {
        if (previo != null && w.start - previo >= oir.HUECO_SEC) {
            if (actual.length) salida.push(actual);
            actual = [];
        }
        actual.push(w);
        previo = w.end;
    }
    if (actual.length) salida.push(actual);
    return salida.filter(t => t[t.length - 1].end - t[0].start >= 25);
}

/** La medida de un tramo, con la misma cuenta que hace el motor en vivo. */
function medirTramo(words, desdeSec, hastaSec) {
    const toma = {
        inMs: Math.round(desdeSec * 1000),
        outMs: Math.round(hastaSec * 1000),
        palabras: comoToma(words)
    };
    return lengua.medir(toma);
}

const pct = (lista, p) => {
    if (!lista.length) return null;
    const orden = lista.slice().sort((a, b) => a - b);
    return orden[Math.min(orden.length - 1, Math.floor((orden.length - 1) * p))];
};

function contar(nombre, valores, decimales) {
    const d = decimales == null ? 0 : decimales;
    const f = v => (v == null ? '—' : v.toFixed(d));
    console.log(`   ${nombre.padEnd(22)} n=${String(valores.length).padStart(4)}` +
        `  p5=${f(pct(valores, 0.05))}  p10=${f(pct(valores, 0.10))}` +
        `  p50=${f(pct(valores, 0.50))}  p90=${f(pct(valores, 0.90))}` +
        `  p95=${f(pct(valores, 0.95))}`);
}

function main() {
    const raiz = process.argv[2];
    if (!raiz) { console.error('Falta la carpeta del curso.'); process.exit(1); }

    const dir = path.join(raiz, 'The Cutter', 'Backup');
    if (!fs.existsSync(dir)) { console.error(`No hay Backup en ${dir}.`); process.exit(1); }

    const crudo = { ppm: [], mule: [], aire: [] };
    const corte = { ppm: [], mule: [], aire: [] };
    let clases = 0;
    let palabras = 0;
    const cuenta = new Map();

    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('_align.json')).sort()) {
        const name = file.replace(/_align\.json$/, '');
        const tp = path.join(dir, `${name}_transcript.json`);
        if (!fs.existsSync(tp)) continue;

        const t = JSON.parse(fs.readFileSync(tp, 'utf8'));
        const words = (t.words || []).filter(w => w && w.text);
        if (!words.length) continue;
        const blocks = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).blocks || [];
        clases++;
        palabras += words.length;

        for (const cual of lengua.muletillasEn(comoToma(words)).cuales) {
            cuenta.set(cual, (cuenta.get(cual) || 0) + 1);
        }

        for (const tirada of tiradas(words)) {
            const m = medirTramo(tirada, tirada[0].start, tirada[tirada.length - 1].end);
            if (m.ppm != null) { crudo.ppm.push(m.ppm); crudo.mule.push(m.muletillasPorMin); }
        }

        // El aire muerto del corte final se mide con el mapa de voz de verdad y
        // no con los huecos del transcript: es la única de las tres que puede
        // estar mintiendo por una palabra que Whisper no escribió, y justo esa
        // palabra convertiría un silencio real en habla.
        const wav = t.source && t.source.path;
        const mapa = wav && fs.existsSync(wav) ? voz.deLaClase(wav) : null;

        for (const b of blocks) {
            if (b.startSec == null || b.endSec == null) continue;
            const dentro = words.filter(w => w.start >= b.startSec && w.end <= b.endSec);
            if (dentro.length < 20) continue;
            const m = medirTramo(dentro, b.startSec, b.endSec);
            if (m.ppm != null) { corte.ppm.push(m.ppm); corte.mule.push(m.muletillasPorMin); }
            if (mapa) corte.aire.push(airePorVoz(mapa, b.startSec, b.endSec));
        }
    }

    console.log(`\n${clases} clases · ${palabras} palabras\n`);
    console.log('── crudo, en tiradas de habla (lo que se parece a una toma)');
    contar('palabras por minuto', crudo.ppm);
    contar('muletillas por minuto', crudo.mule, 2);
    console.log('\n── el corte final, bloque por bloque (lo que un editor dio por bueno)');
    contar('palabras por minuto', corte.ppm);
    contar('muletillas por minuto', corte.mule, 2);
    contar('aire muerto (%)', corte.aire, 1);

    console.log('\n── qué muletillas son, sobre el curso entero');
    for (const [cual, veces] of [...cuenta.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(veces).padStart(4)}  ${cual}`);
    }
    console.log('');
}

/**
 * Qué parte del bloque el mapa de voz no oye a nadie, en huecos que cuentan.
 *
 * Se restan los tramos con voz recortados al bloque, y de lo que queda callado
 * solo suman los pedazos de 2,5 s o más: el mismo listón que usa `oir`, para que
 * una pausa no sea aire muerto acá y una pausa normal en el resto de la app.
 */
function airePorVoz(mapa, desdeSec, hastaSec) {
    const largo = hastaSec - desdeSec;
    if (largo <= 0) return 0;

    let callado = 0;
    let previo = desdeSec;
    for (const [a, b] of mapa.tramos || []) {
        if (b <= desdeSec || a >= hastaSec) continue;
        const arranca = Math.max(a, desdeSec);
        if (arranca - previo >= oir.HUECO_SEC) callado += arranca - previo;
        previo = Math.max(previo, Math.min(b, hastaSec));
    }
    if (hastaSec - previo >= oir.HUECO_SEC) callado += hastaSec - previo;
    return (callado / largo) * 100;
}

main();
