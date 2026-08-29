'use strict';
/**
 * verificar-corte.js — Qué quedó de verdad en el corte, leído del corte.
 *
 * Todas las mediciones del proyecto —`medir-cortes.js`, `ordenes-cumplidas.js`,
 * `mirar-colgados.js`— leen el PLAN: los bloques con sus segundos y el
 * transcript del original. Eso mide si el plan es bueno, y no mide si el corte
 * que sale del plan es el corte que el plan describe. Son dos cosas distintas y
 * entre ellas hay tres traducciones —el plan a la línea de tiempo, la línea de
 * tiempo al XML, el XML a lo que suena— donde un error no lo ve nadie.
 *
 * Así que acá se cierra el círculo: se produce el corte, se lo transcribe y se
 * lee lo que quedó. Si el plan dice que el bloque 1 abre en "Ya Clauco nos
 * entregó los planos" y el render abre en "Claqueta 6, clase 6", el plan estaba
 * bien y el corte no, y ninguna otra herramienta lo habría dicho.
 *
 * **Solo el audio.** Lo que se valida es lo que se DIJO, y para eso el video no
 * agrega nada: cuesta minutos de ffmpeg por clase en vez de segundos, y armarlo
 * obligaría a reimplementar acá la elección de cámara por bloque que ya vive en
 * `export.js#cutTracks` — una segunda copia de esa decisión sería una manera de
 * que el render mienta sobre el corte que el editor va a importar. Para la
 * mirada visual está el XML, que se abre en Premiere.
 *
 * **La comparación es por contenido, no literal.** El transcript del render y el
 * del original no pueden coincidir palabra por palabra: es otro audio, y en los
 * bordes de cada corte Whisper oye un contexto que en el original no existía.
 * Comparar con `===` reportaría cientos de diferencias que no son defectos. Se
 * compara con distancia de edición y se agrupan las diferencias en corridas,
 * porque una palabra sola es ruido del modelo y cuatro seguidas son un problema.
 *
 *   node tools/verificar-corte.js "/ruta/al/curso" [clase] [--cache] [--corrida 2]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('../engine/paths');
const workspace = require('../engine/workspace');
const transcribe = require('../engine/transcribe');
const reloj = require('../engine/reloj');
const coherence = require('../engine/coherence');
const edges = require('../engine/speech-edges');
// Reconocer la claqueta lo hace el motor, que la busca en el audio para
// sincronizar: con una copia acá, esta verificación podría dejar de ver justo la
// que el piso está impidiendo que entre.
const clap = require('../engine/clap-detect');

// Cuántas palabras seguidas tienen que diferir para que valga contarlo. Con una
// sola, la lista se llena de variaciones del modelo sobre el mismo sonido
// ("spec"/"speck", "Clauco"/"Clauko") que no son defectos del corte.
const CORRIDA_MINIMA = 2;

// Cuánto puede desviarse el reloj de Whisper sobre el render antes de que una
// palabra del borde caiga en el bloque de al lado. No se usa para excusar nada
// —eso lo hace `esDeLaCostura`—, solo para repartir las palabras entre bloques.
const MIDPOINT = 0.5;

// ─── Comparación (lógica pura, con pruebas en tests/verificar-corte.test.js) ───

/** Un token comparable: sin acentos, sin puntuación, en minúscula. */
function normalizar(texto) {
    return String(texto == null ? '' : texto)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Palabras de Whisper → tokens comparables, conservando el texto y los tiempos.
 * El texto original se guarda con la clave `text` para que `speech-edges` y
 * `clap-detect` los puedan leer sin traducción.
 */
function tokenizar(palabras) {
    const out = [];
    for (const palabra of palabras || []) {
        const text = edges.textOf(palabra).trim();
        const t = normalizar(text);
        if (!t) continue;
        out.push({ text, t, start: palabra.start, end: palabra.end });
    }
    return out;
}

/**
 * Distancia de edición con techo: pasado el techo no hace falta el número
 * exacto, solo saber que se pasó, y cortar ahí ahorra la mitad de la tabla.
 */
function distancia(a, b, techo) {
    if (Math.abs(a.length - b.length) > techo) return techo + 1;
    let previa = new Array(b.length + 1);
    let actual = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) previa[j] = j;

    for (let i = 1; i <= a.length; i++) {
        actual[0] = i;
        let mejor = i;
        for (let j = 1; j <= b.length; j++) {
            const costo = a[i - 1] === b[j - 1] ? 0 : 1;
            actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + costo);
            if (actual[j] < mejor) mejor = actual[j];
        }
        if (mejor > techo) return techo + 1;
        const swap = previa; previa = actual; actual = swap;
    }
    return previa[b.length];
}

/**
 * ¿Son la misma palabra dicha dos veces?
 *
 * El margen crece con el largo porque el error de Whisper también: en una
 * palabra de cuatro letras una letra distinta ya es otra palabra, y en una de
 * doce dos letras siguen siendo la misma. Por debajo de cuatro se exige
 * igualdad: con margen, "de" y "que" pasarían por la misma.
 */
function iguales(a, b) {
    if (a === b) return true;
    const largo = Math.min(a.length, b.length);
    if (largo < 4) return false;
    const techo = largo >= 8 ? 2 : 1;
    return distancia(a, b, techo) <= techo;
}

/**
 * Los huecos entre lo que se esperaba y lo que salió.
 *
 * Se devuelve UN hueco por sitio donde las dos versiones se separan, con los dos
 * lados adentro, y no dos listas sueltas de "lo que falta" y "lo que sobra". La
 * diferencia no es cosmética: es lo único que distingue las tres cosas muy
 * distintas que pasan en un hueco.
 *
 *   solo del lado que salió   → material de más en el corte. El defecto.
 *   solo del lado esperado    → material que no llegó al corte.
 *   de los dos lados          → el MISMO sonido oído de otra manera. Con dos
 *                               listas sueltas esto aparecía como un "sobra" de
 *                               dos palabras: "Clauco" contra "Cloud Code" y
 *                               "spec-driven" contra "Spec Driven" llenaban el
 *                               informe de defectos que no existen.
 *
 * @returns {{huecos: Array<{eDesde,eHasta,sDesde,sHasta}>, comunes: number}}
 */
function huecos(esperado, salido) {
    const n = esperado.length;
    const m = salido.length;
    const tabla = new Int32Array((n + 1) * (m + 1));
    const en = (i, j) => i * (m + 1) + j;

    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            tabla[en(i, j)] = iguales(esperado[i], salido[j])
                ? tabla[en(i + 1, j + 1)] + 1
                : Math.max(tabla[en(i + 1, j)], tabla[en(i, j + 1)]);
        }
    }

    const out = [];
    let i = 0;
    let j = 0;
    let comunes = 0;
    while (i < n || j < m) {
        if (i < n && j < m && iguales(esperado[i], salido[j])) { i++; j++; comunes++; continue; }
        const eDesde = i;
        const sDesde = j;
        while (i < n || j < m) {
            if (i < n && j < m && iguales(esperado[i], salido[j])) break;
            // A igualdad de resto se avanza en lo esperado: mantiene el hueco de
            // un solo tramo en vez de partirlo en dos alternados.
            if (i < n && (j >= m || tabla[en(i + 1, j)] >= tabla[en(i, j + 1)])) i++;
            else j++;
        }
        out.push({ eDesde, eHasta: i, sDesde, sHasta: j });
    }

    return { huecos: out, comunes };
}

/**
 * Palabras que, si aparecen en el corte, no son ruido del modelo: son el defecto
 * que se está buscando. Una sola alcanza para contarla, sin esperar una corrida.
 */
function esDelatora(token) {
    return clap.looksLikeClaqueta(token)
        || edges.COUNT_WORD.test(token)
        || edges.STRONG_CHATTER.test(token);
}

/** ¿Aparece esta secuencia dentro de la lista, palabra por palabra y en orden? */
function contieneSecuencia(lista, secuencia) {
    if (!secuencia.length || secuencia.length > lista.length) return false;
    for (let i = 0; i + secuencia.length <= lista.length; i++) {
        let todas = true;
        for (let k = 0; k < secuencia.length; k++) {
            if (!iguales(lista[i + k], secuencia[k])) { todas = false; break; }
        }
        if (todas) return true;
    }
    return false;
}

/**
 * ¿Este tramo es en realidad una palabra del bloque vecino que cayó del otro
 * lado de la costura?
 *
 * Los bloques del render se reparten por tiempo, y en el empalme el reloj de
 * Whisper no es exacto: la última palabra de un bloque puede aparecer con un
 * arranque que ya pertenece al siguiente. Eso no es material de más ni de menos
 * —está donde tiene que estar— y contarlo taparía las diferencias de verdad.
 *
 * Tienen que darse las dos cosas: que el tramo esté pegado a un borde del bloque
 * y que el vecino de ese lado lo tenga. Sin lo primero, una frase que el profesor
 * repite en dos bloques excusaría cualquier repetición del medio.
 *
 * @param {object} tramo    {tokens, pegadoAlPrincipio, pegadoAlFinal}
 * @param {Array} antes     los tokens del vecino de la izquierda
 * @param {Array} despues   los tokens del vecino de la derecha
 */
function esDeLaCostura(tramo, antes, despues) {
    const margen = tramo.tokens.length + 4;
    if (tramo.pegadoAlPrincipio && contieneSecuencia(antes.slice(-margen), tramo.tokens)) return true;
    if (tramo.pegadoAlFinal && contieneSecuencia(despues.slice(0, margen), tramo.tokens)) return true;
    return false;
}

/** A qué bloque del corte pertenece cada palabra del render, por su tiempo. */
function repartir(bloques, salido) {
    const cajas = bloques.map(() => []);
    for (const token of salido) {
        const medio = (token.start + token.end) / 2;
        let elegido = bloques.findIndex(b => medio >= b.desdeSec && medio < b.hastaSec);
        if (elegido === -1) {
            // Fuera de todos los tramos: la palabra del último borde, o el reloj
            // corrido. Va al bloque más cercano, que es de donde salió el sonido.
            elegido = 0;
            let mejor = Infinity;
            bloques.forEach((b, i) => {
                const lejos = medio < b.desdeSec ? b.desdeSec - medio : medio - b.hastaSec;
                if (lejos < mejor) { mejor = lejos; elegido = i; }
            });
        }
        cajas[elegido].push(token);
    }
    return cajas;
}

/**
 * Compara el corte que salió contra el guion que se esperaba, bloque por bloque.
 *
 * @param {object} params
 *   bloques  [{n, blockIndex, desdeSec, hastaSec, esperado: tokens}] en la línea
 *            de tiempo DEL CORTE, no de la grabación
 *   salido   tokens del render, con los tiempos que les dio Whisper sobre él
 *   corrida  cuántas palabras seguidas tienen que diferir para contarlas
 */
function comparar(params) {
    const bloques = params.bloques || [];
    const salido = params.salido || [];
    const minimo = params.corrida == null ? CORRIDA_MINIMA : params.corrida;
    const cajas = repartir(bloques, salido);

    const informe = bloques.map((bloque, i) => {
        const suyos = cajas[i];
        const esperado = bloque.esperado.map(w => w.t);
        const dicho = suyos.map(w => w.t);
        const { huecos: gaps, comunes } = huecos(esperado, dicho);

        const antes = i > 0 ? bloques[i - 1].esperado.map(w => w.t) : [];
        const despues = i + 1 < bloques.length ? bloques[i + 1].esperado.map(w => w.t) : [];

        const diferencias = [];
        for (const g of gaps) {
            const faltaron = bloque.esperado.slice(g.eDesde, g.eHasta);
            const salieron = suyos.slice(g.sDesde, g.sHasta);
            const tramo = {
                // De más se cuenta lo que salió por encima de lo que se esperaba:
                // en un hueco con los dos lados, el sonido es el mismo y solo
                // sobra lo que no tiene con qué emparejarse.
                deMas: salieron.length - faltaron.length,
                tokens: salieron.map(w => w.t),
                pegadoAlPrincipio: g.sDesde === 0,
                pegadoAlFinal: g.sHasta === suyos.length,
                sobra: salieron.map(w => w.text).join(' '),
                falta: faltaron.map(w => w.text).join(' ')
            };

            const delatora = tramo.tokens.some(esDelatora);
            if (!delatora && esDeLaCostura(tramo, antes, despues)) continue;
            if (!delatora && !salieron.length && faltaron.length < minimo) continue;
            if (!delatora && salieron.length && tramo.deMas < minimo) continue;

            diferencias.push({
                tipo: !salieron.length ? 'falta' : (!faltaron.length ? 'sobra' : 'cambio'),
                deMas: tramo.deMas,
                cuantasFaltan: faltaron.length,
                cuantasSobran: salieron.length,
                delatora,
                sobra: tramo.sobra,
                falta: tramo.falta,
                enSec: salieron.length ? salieron[0].start : null
            });
        }

        return {
            n: bloque.n,
            blockIndex: bloque.blockIndex,
            desdeSec: bloque.desdeSec,
            hastaSec: bloque.hastaSec,
            esperadas: esperado.length,
            salidas: dicho.length,
            comunes,
            diferencias,
            textoEsperado: bloque.esperado.map(w => w.text).join(' '),
            textoSalido: suyos.map(w => w.text).join(' ')
        };
    });

    const cuantas = tipo => informe.reduce(
        (n, b) => n + b.diferencias.filter(d => d.tipo === tipo).length, 0);

    return {
        bloques: informe,
        totales: {
            esperadas: informe.reduce((n, b) => n + b.esperadas, 0),
            salidas: informe.reduce((n, b) => n + b.salidas, 0),
            comunes: informe.reduce((n, b) => n + b.comunes, 0),
            sobra: cuantas('sobra'),
            falta: cuantas('falta'),
            cambio: cuantas('cambio'),
            conDiferencias: informe.filter(b => b.diferencias.length).length
        }
    };
}

/**
 * Lo que no debería haber sobrevivido al corte, buscado en el render y no en el
 * plan. Es la pregunta directa del editor: ¿quedó la claqueta? ¿quedó un
 * "3, 2, 1"? Va aparte de la comparación porque no depende de que el plan
 * estuviera bien: si el plan también la incluía, el diff no la ve.
 */
function sospechas(salido) {
    const out = [];
    for (let i = 0; i < salido.length; i++) {
        const token = salido[i];
        const cola = () => salido.slice(i, i + 4).map(w => w.text).join(' ');
        if (clap.looksLikeClaqueta(token.t)) {
            out.push({ tipo: 'claqueta', enSec: token.start, texto: cola() });
            continue;
        }
        // El conteo con la misma definición que el motor: dos palabras de cuenta
        // seguidas, porque una sola es un número dicho dentro de la clase.
        const siguiente = salido[i + 1];
        if (siguiente && edges.esConteo(token, siguiente) && edges.esConteo(siguiente, token)) {
            out.push({ tipo: 'conteo', enSec: token.start, texto: cola() });
            i++;
        }
    }
    return out;
}

// ─── El render y su transcripción ──────────────────────────────────────────

/**
 * Concatena los tramos del Live-Mix que el plan deja dentro, en un WAV.
 *
 * Sale a 16 kHz mono porque es exactamente lo que Whisper quiere y lo que
 * `transcribe.js` prepara antes de leer cualquier audio: rendir a 48 kHz para
 * después convertirlo sería hacer dos veces el mismo trabajo.
 *
 * @returns {{ok: boolean, archivo?: string, tramos?: number, error?: string}}
 */
function renderAudio(params) {
    const { wavPath, tramos, destino } = params;
    const ffmpeg = paths.ffmpeg();
    if (!ffmpeg.path) return { ok: false, error: 'Falta ffmpeg.' };
    if (!tramos.length) return { ok: false, error: 'El plan no deja ningún tramo dentro.' };

    const filtro = [
        ...tramos.map((t, i) =>
            `[0:a]atrim=start=${t.desdeSec}:end=${t.hastaSec},asetpts=N/SR/TB[a${i}]`),
        `${tramos.map((_, i) => `[a${i}]`).join('')}concat=n=${tramos.length}:v=0:a=1[fin]`
    ].join(';');

    const r = spawnSync(ffmpeg.path, [
        '-v', 'error', '-y', '-i', wavPath,
        '-filter_complex', filtro, '-map', '[fin]',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        destino
    ], { encoding: 'utf8', maxBuffer: 1 << 24 });

    if (r.status !== 0 || !fs.existsSync(destino)) {
        return { ok: false, error: `ffmpeg terminó con ${r.status}: ${(r.stderr || '').trim().slice(-400)}` };
    }
    return { ok: true, archivo: destino, tramos: tramos.length };
}

/**
 * Prepara lo que hay que comparar: el plan y el guion esperado de una clase.
 * @returns {{sequenceName, bloques, tramos, keepSec, wavPath}}
 */
function preparar(root, sequenceName, wavPath) {
    const plan = workspace.readJson(workspace.artifact(root, sequenceName, 'cutplan'));
    const align = workspace.readJson(workspace.artifact(root, sequenceName, 'align'));
    const transcript = workspace.readJson(workspace.artifact(root, sequenceName, 'transcript'));
    if (!plan || !align || !transcript) {
        throw new Error(`A ${sequenceName} le falta cutplan, align o transcript en el Backup.`);
    }

    // Con el reloj CON EL QUE SE DECIDIÓ el plan, que el plan trae anotado. Es el
    // mismo cuidado que ya toma `medir-cortes.js` y acá faltaba: lo esperado de
    // cada bloque son las palabras que caen adentro, así que leer un plan del DTW
    // con los tiempos crudos del transcript inventa diferencias que no existen.
    // En el bloque 1 de la clase 13 informaba «SOBRA: una gran ventaja» sobre un
    // render que decía exactamente lo que el plan describe: esas tres palabras
    // figuran con `start` 121,41 —nueve segundos antes del IN— y su DTW las pone
    // en 130,68, adentro.
    const words = reloj.paraDecidir(transcript.words || [],
        align.reloj === 'dtw' ? 'auto' : 'crudo').palabras;
    const guion = coherence.buildScript(align.blocks, words);
    const dentro = plan.segments.filter(s => s.keep);

    // El guion y el plan filtran lo mismo (`enabled !== false` y `keep`), así que
    // van en el mismo orden; se emparejan por bloque igual, porque si algún día
    // dejaran de coincidir la comparación tiene que caerse y no mentir.
    const bloques = guion.blocks.map(b => {
        const segmento = dentro.find(s => s.blockIndex === b.index);
        if (!segmento) throw new Error(`El bloque ${b.index + 1} está en el guion y no en el plan.`);
        return {
            n: b.n,
            blockIndex: b.index,
            view: b.view,
            note: b.note,
            desdeSec: segmento.timelineStartSec,
            hastaSec: segmento.timelineEndSec,
            enElOriginal: [segmento.sourceStartSec, segmento.sourceEndSec],
            esperado: tokenizar(edges.wordsInside(words, b.startSec, b.endSec))
        };
    });

    return {
        sequenceName,
        bloques,
        tramos: dentro.map(s => ({ desdeSec: s.sourceStartSec, hastaSec: s.sourceEndSec })),
        keepSec: plan.totals.keepSec,
        wavPath: wavPath || (plan.audios || []).find(a => a.isLiveMix)?.path || null
    };
}

module.exports = {
    normalizar, tokenizar, distancia, iguales, huecos,
    esDelatora, contieneSecuencia, esDeLaCostura, repartir, comparar, sospechas,
    renderAudio, preparar, CORRIDA_MINIMA
};

// ─── Script ────────────────────────────────────────────────────────────────

function clasesDel(root) {
    const dir = path.join(root, 'The Cutter', 'Backup');
    if (!fs.existsSync(dir)) throw new Error(`No hay Backup en ${dir}.`);
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('_cutplan.json'))
        .map(f => f.replace(/_cutplan\.json$/, ''))
        .sort();
}

function fmt(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function recortar(texto, largo) {
    const limpio = String(texto).replace(/\s+/g, ' ').trim();
    return limpio.length > largo ? `${limpio.slice(0, largo)}…` : limpio;
}

async function main() {
    const root = process.argv[2];
    if (!root) {
        console.error('Uso: node tools/verificar-corte.js "/ruta/al/curso" [clase] [--cache] [--corrida 2]');
        process.exit(1);
    }
    const pedida = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
    const cacheando = process.argv.includes('--cache');
    const argCorrida = process.argv.indexOf('--corrida');
    const corrida = argCorrida === -1 ? CORRIDA_MINIMA : Number(process.argv[argCorrida + 1]);

    const nombres = clasesDel(root);
    const sequenceName = pedida
        ? nombres.find(n => n === pedida || n.startsWith(pedida) || n.startsWith(String(pedida).padStart(2, '0')))
        : nombres[0];
    if (!sequenceName) throw new Error(`No encontré la clase ${pedida}. Hay: ${nombres.join(', ')}`);

    const datos = preparar(root, sequenceName);
    if (!datos.wavPath || !fs.existsSync(datos.wavPath)) {
        throw new Error(`No encuentro el Live-Mix de ${sequenceName} (${datos.wavPath}).`);
    }

    // Un temporal por clase y no uno al azar: con `--cache` se puede iterar sobre
    // la comparación sin volver a pasar Whisper, que es lo que cuesta.
    const carpeta = path.join(os.tmpdir(), `classcut-verificar-${sequenceName}`);
    fs.mkdirSync(carpeta, { recursive: true });
    const wavCorte = path.join(carpeta, 'corte.wav');
    const cacheTranscript = path.join(carpeta, 'corte-transcript.json');

    console.log(`\nclase   ${sequenceName}`);
    console.log(`plan    ${datos.bloques.length} bloques · ${fmt(datos.keepSec)} de corte`);

    const render = renderAudio({ wavPath: datos.wavPath, tramos: datos.tramos, destino: wavCorte });
    if (!render.ok) throw new Error(render.error);
    console.log(`render  ${render.archivo} · ${render.tramos} tramos concatenados`);

    let leido = cacheando && fs.existsSync(cacheTranscript)
        ? JSON.parse(fs.readFileSync(cacheTranscript, 'utf8'))
        : null;
    if (!leido) {
        const desde = Date.now();
        leido = await transcribe.runWhisper(wavCorte, {
            onProgress: p => process.stdout.write(`\rwhisper ${p}%   `)
        });
        fs.writeFileSync(cacheTranscript, JSON.stringify(leido));
        process.stdout.write(`\rwhisper ${leido.words.length} palabras · ${leido.language} · ` +
            `${Math.round((Date.now() - desde) / 1000)}s      \n`);
    } else {
        console.log(`whisper ${leido.words.length} palabras · ${leido.language} · del cache`);
    }

    const salido = tokenizar(leido.words);
    const informe = comparar({ bloques: datos.bloques, salido, corrida });
    const pegan = informe.totales.esperadas
        ? Math.round((informe.totales.comunes / informe.totales.esperadas) * 100)
        : 0;

    console.log(`\n${informe.totales.esperadas} palabras esperadas · ${informe.totales.salidas} salieron · ` +
        `${pegan}% coinciden`);
    console.log(`${informe.totales.conDiferencias} de ${informe.bloques.length} bloques con diferencias que cuentan · ` +
        `${informe.totales.sobra} de más · ${informe.totales.falta} de menos · ` +
        `${informe.totales.cambio} oídas de otra manera\n`);

    for (const b of informe.bloques) {
        const cabecera = `bloque ${String(b.n).padStart(2)} · ${fmt(b.desdeSec)}→${fmt(b.hastaSec)} del corte · ` +
            `${b.esperadas} palabras`;
        if (!b.diferencias.length) {
            console.log(`  ✓ ${cabecera}`);
            continue;
        }
        console.log(`  ✗ ${cabecera}`);
        console.log(`      esperaba: ${recortar(b.textoEsperado, 150)}`);
        console.log(`      salió   : ${recortar(b.textoSalido, 150)}`);
        for (const d of b.diferencias) {
            const marca = d.delatora ? ' ¡DELATORA!' : '';
            if (d.tipo === 'sobra') {
                console.log(`      SOBRA (${d.cuantasSobran})${marca}: «${recortar(d.sobra, 110)}»`);
            } else if (d.tipo === 'falta') {
                console.log(`      FALTA (${d.cuantasFaltan}): «${recortar(d.falta, 110)}»`);
            } else {
                console.log(`      CAMBIO (+${d.deMas})${marca}: esperaba «${recortar(d.falta, 60)}» ` +
                    `y salió «${recortar(d.sobra, 60)}»`);
            }
        }
    }

    const encontradas = sospechas(salido);
    console.log('\nlo que no debería haber sobrevivido al corte:');
    for (const tipo of ['claqueta', 'conteo']) {
        const suyas = encontradas.filter(s => s.tipo === tipo);
        if (!suyas.length) { console.log(`  ✓ ${tipo}: no aparece`); continue; }
        console.log(`  ✗ ${tipo}: ${suyas.length}`);
        for (const s of suyas) console.log(`      ${fmt(s.enSec)} del corte · «${recortar(s.texto, 70)}»`);
    }
    console.log('');
}

if (require.main === module) {
    main().catch(err => {
        console.error(`\n${err.message}`);
        process.exit(1);
    });
}
