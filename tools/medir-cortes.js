'use strict';
/**
 * medir-cortes.js — Los defectos de los cortes, contados sobre el curso entero.
 *
 * Es la vara del plan "Cortes con criterio": antes de tocar nada, el curso tenía
 * 66 bloques terminando con habla del director, 103 con una frase colgando, 7
 * arrancando con un conector huérfano, 2 cortados a mitad de palabra y 2
 * repitiendo el bloque anterior. Esto vuelve a medir lo mismo para poder decir
 * si el trabajo sirvió, en vez de mirar un XML y confiar.
 *
 * Mide sobre los artefactos del Backup, no reprocesando: lo que se juzga es lo
 * que quedó en el disco, que es lo que el editor va a importar.
 *
 *   node tools/medir-cortes.js "/ruta/al/curso" [--detalle]
 */

const fs = require('fs');
const path = require('path');
const reloj = require('../engine/reloj');
const defectos = require('./defectos');

const root = process.argv[2];
const detalle = process.argv.includes('--detalle');

if (!root) {
    console.error('Falta la carpeta del curso.');
    process.exit(1);
}

const baseline = {
    claqueta: 0,
    chatter: 66,
    colgando: 103,
    conector: 7,
    mitadPalabra: 2,
    repetido: 2,
    // La vara de la retoma interna no es la de "antes de Cortes con criterio":
    // cuando se agregó el defecto ya no había con qué comparar hacia atrás, así
    // que es lo que había en el curso el día que se empezó a ver — 4 bloques de
    // 172, en las clases 1, 4, 7 y 11, con 137,8 s dichos dos veces.
    retoma: 4,
    total: 174
};

function backupDir() {
    const dir = path.join(root, 'The Cutter', 'Backup');
    if (!fs.existsSync(dir)) {
        console.error(`No hay Backup en ${dir}. Procesá el curso primero.`);
        process.exit(1);
    }
    return dir;
}

/**
 * Las clases del Backup, cada una con su alineado y sus palabras.
 *
 * Las palabras van con el reloj CON EL QUE SE DECIDIÓ el plan, que el plan trae
 * anotado. Leerlas con el reloj crudo del transcript no es un detalle: los
 * defectos se cuentan mirando qué palabras caen dentro de cada bloque, así que un
 * plan del DTW leído con los tiempos de Whisper informaba 26 bloques terminando en
 * habla del director donde no había ninguno. Un plan sin la anotación es de antes
 * de que el reloj existiera y se lee con el crudo, que es con el que se hizo.
 */
function clases() {
    const dir = backupDir();
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('_align.json'))
        .sort()
        .map(file => {
            const name = file.replace(/_align\.json$/, '');
            const transcriptPath = path.join(dir, `${name}_transcript.json`);
            if (!fs.existsSync(transcriptPath)) return null;
            const align = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const words = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')).words || [];
            return {
                name,
                align,
                reloj: align.reloj || 'crudo',
                words: reloj.paraDecidir(words, align.reloj === 'dtw' ? 'auto' : 'crudo').palabras
            };
        })
        .filter(Boolean);
}

function fmt(actual, antes) {
    const pct = n => `${Math.round((n / baseline.total) * 100)}%`;
    const flecha = actual < antes ? '↓' : (actual > antes ? '↑' : '=');
    return `${String(antes).padStart(4)} → ${String(actual).padStart(4)} ${flecha}  (${pct(antes)} → ${pct(actual)})`;
}

// De la definición, no a mano: cada vez que se agregaba un defecto había que
// acordarse de sumarlo acá, y si no, la medición se caía al encontrarlo.
const cuenta = Object.fromEntries(defectos.TIPOS.map(t => [t, 0]));
const ejemplos = Object.fromEntries(defectos.TIPOS.map(t => [t, []]));
let total = 0;
// Los bordes que no traen la medición de sonido. Sin este número, un plan de
// antes de que el motor la escribiera informa "0 cortes a mitad de palabra" y se
// lee como un curso limpio cuando lo que pasa es que nadie miró.
let sinMedir = 0;

for (const cls of clases()) {
    let anterior = null;
    // Sin los bloques apagados, igual que `defectos.contarClase`. Un bloque
    // apagado es una arrancada en falso que ya se descartó: sigue en el plan con
    // su marca pero no sale en la clase, así que contar sus defectos es contar
    // como problema justo lo que se resolvió sacándolo. Las dos cuentas del
    // proyecto decían números distintos por esto — el lote informaba 1 repetido
    // y esta tabla 2, y el de más estaba en un bloque que no se exporta.
    for (const block of (cls.align.blocks || []).filter(b => b.enabled !== false)) {
        total++;
        for (const edge of [block.in, block.out]) {
            if (edge && !defectos.midioElSonido(edge)) sinMedir++;
        }
        for (const [tipo, texto] of defectos.revisarBloque(cls.words, block, anterior)) {
            cuenta[tipo]++;
            ejemplos[tipo].push(`  clase ${cls.name.slice(0, 2)} bloque ${block.index + 1}: ${texto}`);
        }
        anterior = block;
    }
}

console.log(`\n${total} bloques medidos · vara: los ${baseline.total} de antes de "Cortes con criterio"\n`);
// La claqueta se contaba y no se imprimía, así que el peor defecto que existe
// —la clase que abre con "Claqueta 6, clase 6. 3, 2, 1."— era el único que esta
// tabla no podía mostrar. La vara es 0 y no un número viejo: cuando se agregó el
// defecto ya no había con qué comparar hacia atrás.
console.log(`  la claqueta quedó dentro         ${fmt(cuenta.claqueta, baseline.claqueta)}`);
console.log(`  termina con habla del director   ${fmt(cuenta.chatter, baseline.chatter)}`);
console.log(`  abre con el conteo de la toma    ${fmt(cuenta.conteo, baseline.conteo || 0)}`);
console.log(`  frase colgando al final          ${fmt(cuenta.colgando, baseline.colgando)}`);
console.log(`  arranca con conector huérfano    ${fmt(cuenta.conector, baseline.conector)}`);
console.log(`  cortado a mitad de palabra       ${fmt(cuenta.mitadPalabra, baseline.mitadPalabra)}` +
    (sinMedir ? `   ⚠ ${sinMedir} bordes sin la medición: reprocesá para poder contarlo` : ''));
console.log(`  repite el bloque anterior        ${fmt(cuenta.repetido, baseline.repetido)}`);
console.log(`  la retoma quedó adentro          ${fmt(cuenta.retoma, baseline.retoma)}`);

const objetivos = [
    ['0 bloques terminando en chatter', cuenta.chatter === 0],
    ['0 cortes a mitad de palabra', cuenta.mitadPalabra === 0],
    ['finales a mitad de frase en una decena', cuenta.colgando <= 15],
    ['0 retomas dentro de un bloque', cuenta.retoma === 0]
];
console.log('\nobjetivos del plan:');
for (const [texto, ok] of objetivos) console.log(`  ${ok ? '✓' : '✗'} ${texto}`);

if (detalle) {
    for (const [tipo, lista] of Object.entries(ejemplos)) {
        if (!lista.length) continue;
        console.log(`\n${tipo} (${lista.length}):`);
        console.log(lista.slice(0, 20).join('\n'));
        if (lista.length > 20) console.log(`  … y ${lista.length - 20} más`);
    }
}

process.exit(objetivos.every(([, ok]) => ok) ? 0 : 1);
