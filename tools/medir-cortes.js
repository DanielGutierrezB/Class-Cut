'use strict';
/**
 * medir-cortes.js — Los defectos de los cortes, contados sobre el curso entero.
 *
 * Es la vara del plan "Cortes con criterio": antes de tocar nada, el curso tenía
 * 66 bloques terminando con habla del director, 103 con una frase colgando, 2
 * cortados a mitad de palabra y 2 repitiendo el bloque anterior. Esto vuelve a
 * medir lo mismo para poder decir si el trabajo sirvió, en vez de mirar un XML y
 * confiar. (El conector huérfano no tiene vara hacia atrás: la razón está abajo,
 * en `baseline`.)
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
    // El conector huérfano no tiene vara hacia atrás, y es a propósito. El 7 que
    // había acá lo contó la primera versión de la regla, que preguntaba por el
    // hueco hasta el bloque anterior —material grabado— cuando lo que decide es
    // si el CD abrió el bloque ahí. Esa versión informaba 12 sobre el curso con la
    // alineación acústica y los 12 los había escrito así el director (con los
    // conectores de dos palabras que la lista no podía ver son 15, y también); con la
    // pregunta correcta son 0. El 7 y el 12 miden los dos la misma cosa
    // equivocada, así que comparar contra el 7 diría que se arreglaron siete
    // cortes y no se movió ninguno. Los planes viejos ya no están para volver a
    // contarlos bien. El detalle está en `speech-edges.conectorSinPedir`.
    conector: 0,
    // "Abre partiendo una frase" tampoco tiene vara hacia atrás: se agregó
    // mirando estos 170 bloques, cuando ya no había planes viejos con los que
    // contarlo.
    //
    // El 7 que había acá lo contó la primera versión, que preguntaba sobre el
    // transcript si la palabra del otro lado del corte cerraba frase. Cinco de
    // esos 7 estaban ADENTRO del bloque: se los oye cortando el Live-Mix por los
    // bordes del plan («Y justo ese es el problema…», «Un PROM sirve para crear
    // demos…», «Ahora vamos a hacer el ejercicio…», «Y si damos clic en este
    // link…»). El reloj los ponía 3, 10, 17 y 30 ms antes del corte —menos de un
    // frame— con duraciones de 10 ms, y `wordsInside` los dejaba afuera por su
    // margen de 20. Con la pregunta contestada por la onda son 2, y no se movió
    // ningún corte: comparar contra el 7 diría que se arreglaron cinco. El
    // detalle está en `speech-edges.abreAMitad`.
    abriendo: 2,
    mitadPalabra: 2,
    repetido: 2,
    // La vara de la retoma interna no es la de "antes de Cortes con criterio":
    // cuando se agregó el defecto ya no había con qué comparar hacia atrás, así
    // que es lo que había en el curso el día que se empezó a ver — 4 bloques de
    // 172, en las clases 1, 4, 7 y 11, con 137,8 s dichos dos veces.
    //
    // Los 4 se arreglaron y el renglón quedó en 0, y después el detector aprendió
    // a ver la toma que se corta SIN cuenta (`retoma.mirarLaOrden`): sobre el
    // curso entregado eso encontró 1 más, el bloque 1 de la clase 11, con 62,6 s
    // de charla de rodaje adentro. La vara sigue siendo 4 porque es la única cifra
    // con historia; lo que hay que mirar es que el renglón vuelva a 0.
    retoma: 4,
    // "Aire muerto adentro" no tiene vara hacia atrás por la misma razón que
    // `abriendo`: se agregó mirando estos 170 bloques. El 4 es lo que el curso
    // entregado tenía el día que se empezó a medir —cuatro bloques de cámara con
    // catorce huecos de más de cinco segundos entre todos, 2,1 minutos—, y los
    // cuatro se escucharon uno por uno; están anotados con lo que suena en la
    // cabecera de `engine/aire.js`.
    //
    // De los 4, tres los arregla el motor: dos moviendo el IN (`aire.quitarAire`)
    // y uno moviendo el OUT (`retoma`, que ve la misma toma abandonada desde el
    // transcript). El cuarto, el bloque 4 de la clase 2, son tres arrancadas
    // fallidas en el medio del bloque y se avisa a propósito en vez de cortarlo:
    // el razonamiento, con las tres opciones que se descartaron, está en esa misma
    // cabecera.
    aire: 4,
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
            // El mapa de voz sale del Backup, donde el motor ya lo dejó. Hace
            // falta para "abre partiendo una frase": esa cuenta no se la puede
            // contestar el transcript (ver `speech-edges.abreAMitad`).
            const vozPath = path.join(dir, `${name}_voz.json`);
            return {
                name,
                align,
                reloj: align.reloj || 'crudo',
                words: reloj.paraDecidir(words, align.reloj === 'dtw' ? 'auto' : 'crudo').palabras,
                voz: fs.existsSync(vozPath) ? JSON.parse(fs.readFileSync(vozPath, 'utf8')) : null
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
// Y los bloques de clases sin mapa de voz, por lo mismo: sin él "abre partiendo
// una frase" da cero porque nadie miró, no porque no haya.
let sinVoz = 0;

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
        if (!cls.voz) sinVoz++;
        for (const [tipo, texto] of defectos.revisarBloque(cls.words, block, anterior, cls.voz)) {
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
console.log(`  abre partiendo una frase         ${fmt(cuenta.abriendo, baseline.abriendo)}` +
    (sinVoz ? `   ⚠ ${sinVoz} bloques sin mapa de voz: no se pudo medir` : ''));
console.log(`  arranca con conector huérfano    ${fmt(cuenta.conector, baseline.conector)}`);
console.log(`  cortado a mitad de palabra       ${fmt(cuenta.mitadPalabra, baseline.mitadPalabra)}` +
    (sinMedir ? `   ⚠ ${sinMedir} bordes sin la medición: reprocesá para poder contarlo` : ''));
console.log(`  repite el bloque anterior        ${fmt(cuenta.repetido, baseline.repetido)}`);
console.log(`  la retoma quedó adentro          ${fmt(cuenta.retoma, baseline.retoma)}`);
console.log(`  aire muerto adentro              ${fmt(cuenta.aire, baseline.aire)}` +
    (sinVoz ? `   ⚠ ${sinVoz} bloques sin mapa de voz: no se pudo medir` : ''));

const objetivos = [
    ['0 bloques terminando en chatter', cuenta.chatter === 0],
    ['0 cortes a mitad de palabra', cuenta.mitadPalabra === 0],
    ['finales a mitad de frase en una decena', cuenta.colgando <= 15],
    ['0 retomas dentro de un bloque', cuenta.retoma === 0],
    // El objetivo es 0 y el motor llega a 1: el bloque 4 de la clase 2 son tres
    // arrancadas fallidas en el medio del bloque, y las tres maneras de cortarlas
    // dejan la clase peor que el hueco (el razonamiento y los números están en la
    // cabecera de `engine/aire.js`). Queda en rojo a propósito, porque es un
    // bloque para que lo mire el editor y no algo que el motor pueda resolver.
    ['0 bloques con aire muerto adentro', cuenta.aire === 0]
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
