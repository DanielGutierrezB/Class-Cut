'use strict';
/**
 * transcribe.js — El Live-Mix a palabras con tiempos, con whisper.cpp local.
 *
 * Tres decisiones que se tomaron midiendo, no leyendo documentación:
 *
 * 1. **VAD obligatorio.** Sin él, whisper reparte las palabras a lo largo de todo
 *    el segmento, y en material crudo un segmento es media toma más el silencio
 *    que sigue. Medido en la clase 04: sin VAD, "3, 2, 1. Imagínate…" se reportaba
 *    empezando en 0.0 s cuando en el audio arranca en 17.1 s — 17 segundos de
 *    error, con lo que ningún anclaje puede funcionar. Con VAD los tiempos caen
 *    donde está el sonido. De paso aparece la claqueta hablada, que sin VAD se
 *    perdía entera dentro del primer segmento.
 * 2. **Una palabra por segmento** (`-ml 1 -sow`): los tiempos de segmento de
 *    whisper.cpp son mucho más fiables que repartir los tokens de adentro. Las
 *    frases se rearman acá con la puntuación, que sale gratis.
 * 3. **La alineación por DTW, prendida** (`-nfa -dtw … -ojf`). whisper.cpp sabe
 *    calcular una alineación de cada token contra el espectrograma, y hasta hoy
 *    nunca corrió: desde que *flash attention* viene prendida por defecto, la
 *    apaga sin decir nada. Medido sobre 90 s de la clase 1 con el mismo audio y
 *    el mismo modelo: con las banderas de antes, `t_dtw` venía en -1 en las
 *    221/221 palabras; con `-nfa`, poblado en las 199/199.
 *
 * Los tiempos que salen de acá dicen QUÉ se dijo y MÁS O MENOS cuándo. El frame
 * exacto del corte lo mide después `audio-onset` sobre el WAV.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const workspace = require('./workspace');
const onset = require('./vendor/audio-onset');
const silencios = require('./silencios');
const speech = require('./speech-edges');

// 2: las palabras se guardan como {start, end, text} y ya vienen corregidas
//    contra el audio (`audio-onset.alignWords`).
// 3: sin VAD, que arruinaba los tiempos de cada palabra, y leyendo el audio ya
//    convertido a 16 kHz mono, que es como Whisper lo quiere.
// 4: sin arrastrar el texto de una ventana a la siguiente (`-mc 0`). Los
//    transcripts de la 3 pueden traer tramos enteros sin puntuación, y de la
//    puntuación viven los cortes: hay que rehacerlos.
// 5: cada palabra puede traer además `dtw`, el instante que le puso la
//    alineación contra el espectrograma.
// 6: y la palabra que abre cada tirada dice si su arranque lo MIDIÓ la onda
//    (`onset`) o si quedó el tiempo crudo del STT porque no había ataque que
//    medir. Los dos casos se veían iguales, y de eso vivía un defecto del panel.
const TRANSCRIPT_VERSION = 6;

/**
 * Qué versiones del Backup se dan por buenas sin volver a transcribir.
 *
 * La 4 y la 5 entran, y a propósito. Lo que agregan la 5 y la 6 son campos NUEVOS
 * que solo lee el reloj del panel; ni un corte, ni una repetición, ni un SRT
 * cambian de decisión por que estén o falten. Sacarlas de la lista sería cobrarle
 * al editor cuarenta minutos de Whisper por clase —el curso entero de nuevo— nada
 * más que para poder abrir una clase que ya estaba lista. Un transcript de la 4
 * sigue andando por el camino de siempre (`retimeo`).
 *
 * Lo que se pierde abriendo una 5 conviene tenerlo dicho: sin la marca de la 6, el
 * reloj del panel no puede saber qué arranques midió la onda, así que los da todos
 * por no medidos y va entero por DTW. Eso empeora el borde de cada tirada de 20 a
 * 60 ms —lo mismo que el DTW puro, que ya se midió— y no toca nada más. Es un
 * precio chico, se paga solo en una clase transcripta la única noche que existió la
 * versión 5, y se arregla transcribiéndola de nuevo si a alguien le molesta.
 */
const VERSIONES_QUE_SIRVEN = new Set([4, 5, TRANSCRIPT_VERSION]);

/**
 * El nombre con el que whisper.cpp identifica la grilla de cabezas de atención
 * de cada modelo, que es lo que el DTW necesita para saber dónde mirar.
 *
 * No es un detalle cosmético: pasarle la grilla de otro modelo no degrada la
 * alineación, **no arranca**. Con `ggml-large-v3-turbo.bin` y `-dtw medium`,
 * whisper-cli sale con código 3 y "tried to set alignment head on text layer
 * 14, but model only has 4 text layers". Y `paths.whisperModel()` cae al mejor
 * modelo que encuentre, que en una instalación vieja puede ser cualquiera de
 * los siete: si el nombre no está en esta tabla no se pide DTW, porque un
 * transcript sin alineación sirve y una transcripción que no arranca no.
 */
const DTW_POR_MODELO = {
    'ggml-large-v3-turbo.bin': 'large.v3.turbo',
    'ggml-large-v3.bin': 'large.v3',
    'ggml-large-v2.bin': 'large.v2',
    'ggml-large.bin': 'large.v1',
    'ggml-medium.bin': 'medium',
    'ggml-small.bin': 'small',
    'ggml-base.bin': 'base'
};
// Una palabra repetida idéntica más veces que esto es un bucle de whisper en un
// silencio, no algo que alguien dijo.
const MAX_REPEATS = 3;

// Y el bucle también viene en frases. Whisper rellena los silencios largos con
// créditos de subtítulos aprendidos de su entrenamiento: en la clase 4 del curso
// escribió "Andrea Oroz Sincronización" CUARENTA Y CINCO veces seguidas, 134 de
// sus 4.056 palabras, sobre un tramo donde el profesor no dice nada porque está
// trabajando en pantalla. Ninguna regla de palabra suelta lo ve —"Andrea" nunca
// va seguida de "Andrea"— y lo que llega a la lectura del guion es una clase que
// dice cinco veces el nombre de un subtitulador.
const MAX_FRASE = 6;      // hasta cuántas palabras puede tener la frase que da vueltas
const VUELTAS_BUCLE = 3;  // cuántas vueltas hacen falta para llamarlo bucle

class TranscribeError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code || 'transcribe';
    }
}

function checkTools() {
    const cli = paths.whisper();
    if (!cli.path) {
        throw new TranscribeError(
            'Falta whisper-cli. Mirá Diagnóstico: la app lo trae incluido, así que esto pasa solo en desarrollo.',
            'sin_whisper');
    }
    const model = paths.whisperModel();
    if (!model.path) {
        throw new TranscribeError(
            'No encontré el modelo de Whisper. Mirá Diagnóstico para ver dónde lo busqué.',
            'sin_modelo');
    }
    return { cli: cli.path, model: model.path, modelName: model.name };
}

/**
 * Palabras crudas del JSON de whisper → `{start, end, text}`, que es el formato
 * que hablan los módulos de análisis (`marker-anchor`, `audio-onset`), más `dtw`
 * cuando la alineación contra el espectrograma dejó algo.
 *
 * `dtw` va en un campo APARTE y no encima de `start`, y sigue así incluso ahora que
 * los cortes se deciden con él (`engine/reloj.js`). El transcript guardado tiene
 * que decir lo que MIDIÓ cada alineador y nada más: el instante del DTW, el
 * `start`/`end` de la onda y la marca de dónde la onda pudo medir. El reloj que
 * combina las tres cosas se arma al decidir y al servir el visor, que cuesta
 * milisegundos, y así una mejora en la combinación no obliga a volver a pasar
 * Whisper por las trece clases — que es exactamente el costo que se pagó la noche
 * que la combinación cambió dos veces.
 */
function wordsFromWhisperJson(data) {
    const out = [];
    for (const segment of (data.transcription || [])) {
        const text = String(segment.text == null ? '' : segment.text).trim();
        if (!text) continue;
        const from = segment.offsets ? segment.offsets.from / 1000 : null;
        const to = segment.offsets ? segment.offsets.to / 1000 : null;
        if (from == null || to == null) continue;
        const word = { start: round(from), end: round(Math.max(to, from)), text };
        const dtw = dtwDelSegmento(segment);
        // El campo se pone solo cuando hay dato: así una palabra sin alineación y
        // un transcript entero sin ella se leen igual, con una sola pregunta.
        if (dtw != null) word.dtw = dtw;
        out.push(word);
    }
    return out;
}

/**
 * El instante que el DTW le puso a una palabra, en segundos.
 *
 * Dos cosas que el JSON de whisper.cpp no avisa. Primero, `t_dtw` viene en
 * CENTÉSIMAS de segundo, mientras que los `offsets` de al lado vienen en
 * milésimas. Segundo, vale `-1` cuando el token no se pudo ubicar en la grilla,
 * y eso no es un cero: es "no sé".
 *
 * Con `-ml 1 -sow` un segmento es una palabra y sus tokens son los pedazos con
 * los que el modelo la escribió ("Reside" sale como " Res" + "ide"), así que el
 * instante de la palabra es el del primero que traiga dato. Se puede tomar el
 * primero porque el DTW no vuelve para atrás: sobre 634 palabras de un tramo de
 * 6 minutos de la clase 1, cero veces `t_dtw` bajó respecto de la anterior.
 */
function dtwDelSegmento(segment) {
    for (const token of (segment.tokens || [])) {
        const centesimas = token ? token.t_dtw : null;
        if (typeof centesimas !== 'number' || centesimas < 0) continue;
        return round(centesimas / 100);
    }
    return null;
}

function round(n) {
    return Math.round(n * 1000) / 1000;
}

/**
 * Whisper entra en bucle en los silencios y repite la misma palabra o la misma
 * frase decenas de veces. Se dejan las primeras y se tiran las demás: como cada
 * repetición ocupa tiempo, dejarlas correría el resto del transcript.
 *
 * Van dos pasadas, y en este orden. Primero las frases, porque una palabra
 * suelta repetida es también una "frase de una palabra" y si se colapsara antes
 * dejaría al detector de frases sin nada que ver. Después la palabra suelta.
 */
function collapseLoops(words) {
    const deFrases = colapsarFrases(words);
    const dePalabras = colapsarPalabras(deFrases.words);
    return {
        words: dePalabras.words,
        removed: deFrases.removed + dePalabras.removed,
        phraseLoops: deFrases.bucles
    };
}

function colapsarPalabras(words) {
    const out = [];
    let run = 0;
    let removed = 0;
    for (const word of words) {
        const prev = out[out.length - 1];
        const same = prev && norm(prev.text) === norm(word.text);
        run = same ? run + 1 : 0;
        if (run >= MAX_REPEATS) {
            removed++;
            // La palabra se descarta pero su tiempo se absorbe: el bloque de
            // silencio sigue existiendo en la línea de tiempo.
            if (prev) prev.end = Math.max(prev.end, word.end);
            continue;
        }
        out.push(word);
    }
    return { words: out, removed };
}

/**
 * ¿Empieza en `i` una frase que se repite a sí misma?
 *
 * Se prueba de la frase más corta a la más larga para dar con el período de
 * verdad: "Andrea Oroz Sincronización" repetida también hace que la frase de
 * seis palabras se repita, y quedarse con esa dejaría el doble de basura.
 *
 * @returns {{largo: number, vueltas: number}|null}
 */
function bucleEn(words, i) {
    for (let largo = 2; largo <= MAX_FRASE; largo++) {
        if (i + largo * VUELTAS_BUCLE > words.length) break;

        // Una frase hecha de la misma palabra repetida no es cosa de esta
        // pasada: la resuelve mejor la de palabra suelta, que deja tres y no una.
        const primera = norm(words[i].text);
        let variada = false;
        for (let k = 1; k < largo; k++) {
            if (norm(words[i + k].text) !== primera) { variada = true; break; }
        }
        if (!variada) continue;

        let vueltas = 1;
        while (mismaFrase(words, i, i + vueltas * largo, largo)) vueltas++;
        if (vueltas >= VUELTAS_BUCLE) return { largo, vueltas };
    }
    return null;
}

function mismaFrase(words, a, b, largo) {
    if (b + largo > words.length) return false;
    for (let k = 0; k < largo; k++) {
        if (norm(words[a + k].text) !== norm(words[b + k].text)) return false;
    }
    return true;
}

/**
 * De un bucle de frase sobrevive UNA vuelta, no tres como en la palabra suelta.
 * Nadie repite tres palabras seguidas idénticas cuatro veces; cuando pasa, es
 * relleno de silencio, y dejar tres copias es dejar tres veces el ruido.
 */
function colapsarFrases(words) {
    const out = [];
    let removed = 0;
    let bucles = 0;
    let i = 0;

    while (i < words.length) {
        const bucle = bucleEn(words, i);
        if (!bucle) { out.push(words[i]); i++; continue; }

        const hasta = i + bucle.largo * bucle.vueltas;
        for (let k = 0; k < bucle.largo; k++) out.push(words[i + k]);
        // El tiempo del bucle no desaparece de la línea de tiempo: se lo queda la
        // última palabra que sobrevive, y el silencio sigue estando donde estaba.
        const ultima = out[out.length - 1];
        ultima.end = Math.max(ultima.end, words[hasta - 1].end);
        removed += bucle.largo * (bucle.vueltas - 1);
        bucles++;
        i = hasta;
    }
    return { words: out, removed, bucles };
}

function norm(text) {
    return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Frases rearmadas desde las palabras, cortando en puntuación fuerte o pausa. */
function segmentsFromWords(words) {
    const segments = [];
    let current = null;
    for (const word of words) {
        if (current && (word.start - current.end) > 1.2) {
            segments.push(current);
            current = null;
        }
        if (!current) {
            current = { start: word.start, end: word.end, text: word.text };
        } else {
            current.text += ` ${word.text}`;
            current.end = word.end;
        }
        if (/[.!?…]"?$/.test(word.text) && (current.end - current.start) > 1) {
            segments.push(current);
            current = null;
        }
    }
    if (current) segments.push(current);
    return segments.map(s => ({ start: round(s.start), end: round(s.end), text: s.text.trim() }));
}

/**
 * Deja el audio como Whisper lo quiere: 16 kHz, mono, 16 bits.
 *
 * El Live-Mix del Rodecaster viene en 48 kHz estéreo de 24 bits. Whisper lo
 * acepta sin quejarse y lo convierte por dentro, pero tarda cuatro veces más:
 * medido sobre una clase de 42 minutos, 334 s leyendo el original contra 68 s
 * leyendo el convertido, y la conversión cuesta 12 s. El resultado es el mismo
 * —recortando cuarenta segundos de las dos fuentes, las palabras salen con menos
 * de 20 ms de diferencia—, así que lo único que cambia es el reloj.
 *
 * También le saca al motor la responsabilidad de lidiar con lo que traiga cada
 * grabadora: 96 kHz, coma flotante o cuatro canales entran todos por acá.
 *
 * @returns {string|null} el temporal, o null si no se pudo (se sigue con el original)
 */
function aTasaDeWhisper(wavPath) {
    const ffmpeg = paths.ffmpeg();
    if (!ffmpeg || !ffmpeg.path) return null;

    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-16k-')), 'audio.wav');
    const r = spawnSync(ffmpeg.path, [
        '-v', 'error', '-y', '-i', wavPath,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        destino
    ], { encoding: 'utf8' });

    if (r.status !== 0 || !fs.existsSync(destino)) return null;
    return destino;
}

/** Borra el temporal y su carpeta, sin hacer ruido si ya no están. */
function tirar(temporal) {
    if (!temporal) return;
    try { fs.rmSync(path.dirname(temporal), { recursive: true, force: true }); } catch (e) { /* da igual */ }
}

/**
 * Corre whisper-cli sobre un WAV. Devuelve el transcript ya normalizado.
 * @param {object} options { language, onProgress, signal }
 */
function runWhisper(wavPath, options) {
    const opts = options || {};
    const tools = checkTools();
    const outBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-stt-')), 'out');

    // Sin `--vad` a propósito. El VAD recorta el audio a los pedazos con voz y
    // después remapea los tiempos al reloj original, y ese remapeo los arruina:
    // sobre una clase entera deja 788 palabras con una duración de exactamente
    // 0,10 s y 540 que empiezan antes de que termine la anterior, contra 111 y
    // CERO sin él. Eso se ve en el panel como palabras que se atropellan y otra
    // que se queda clavada, que es justo lo que hay que poder leer para validar
    // un corte. Además se come habla real: en una clase perdió 847 palabras,
    // entre ellas la charla del director ("Perdón, pausa. Me gustaría…"), que es
    // lo que el recorte de muletillas necesita oír. Y no era más rápido.
    //
    // Lo que el VAD sí evitaba —que Whisper alucine sobre el silencio, típico
    // "sí, sí, sí…" doce veces— ya lo tapaba `collapseLoops`, que colapsa la
    // repetición y no depende de estimar dónde hay voz.
    const args = [
        '-m', tools.model,
        '-f', wavPath,
        '-l', opts.language || 'auto',
        '-oj',
        '-ml', '1',
        '-sow',
        '-of', outBase,
        '-np',
        '-pp',
        // Sin arrastrar el texto de una ventana a la siguiente. whisper.cpp le
        // pasa a cada ventana de 30 s lo que transcribió en la anterior, y en
        // material de clase eso se traba: en cuanto una ventana sale sin
        // puntuación, la siguiente la imita porque es lo que trae en el prompt, y
        // no se recupera nunca más. Medido sobre la clase 6 del curso, el MISMO
        // audio con y sin esto: 70 palabras cerrando frase contra 247, y un tramo
        // de 1112 s (de 3:44 a 22:16, dieciocho minutos y medio) sin un solo
        // punto contra el peor de 76 s. Y de la puntuación viven los cortes —es
        // lo que `speech-edges` mira para no terminar un bloque a mitad de
        // frase—, así que sin ella los ocho bloques de la clase quedaban
        // colgando por definición y ningún candidato mejor existía.
        //
        // Lo mismo arregla los bucles, que son la otra cara del prompt trabado:
        // 127 palabras colapsadas por repetición contra 1. Y tarda un 33% menos,
        // porque son menos tokens de prompt por ventana.
        //
        // Lo que se pierde es la coherencia de un nombre propio entre ventanas.
        // Medido en el mismo audio, no se notó: "Cloud Code" y "EARS" salen igual
        // en las dos, y a cambio aparece el "Tres, dos, uno." de una toma que la
        // versión con contexto no escribía.
        '-mc', '0'
    ];

    // La alineación por DTW: whisper.cpp la calcula contra el espectrograma, o
    // sea contra el sonido, en vez de deducirla de los tokens de tiempo que el
    // modelo escribe. Hasta hoy no corría nunca, y no porque no se pidiera: con
    // *flash attention* prendida whisper.cpp la apaga sin avisar por ningún lado
    // que se mire. Medido sobre 90 s de la clase 1, mismo audio y mismo modelo:
    // con las banderas de antes `t_dtw` venía en -1 en las 221/221 palabras; con
    // `-nfa` viene poblado en las 199/199.
    //
    // Lo que cuesta apagar flash attention, medido sobre 6 minutos de la clase
    // 1: 10,64 s de reloj contra 9,12 s, un 17% más. Y el texto casi no se
    // mueve: el habla limpia sale palabra por palabra idéntica y lo único que
    // divergió fue la cola, donde el micrófono no registra a nadie y las dos
    // versiones inventan distinto.
    //
    // `-ojf` es lo único que hace aparecer los tokens en el JSON, que es donde
    // vive `t_dtw`. Sin él la alineación se calcula y se tira.
    const dtwModel = DTW_POR_MODELO[tools.modelName] || null;
    if (dtwModel) args.push('-nfa', '-dtw', dtwModel, '-ojf');

    return new Promise((resolve, reject) => {
        const child = spawn(tools.cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let stdout = '';
        let lastPercent = -1;
        let killedByUser = false;

        const onAbort = () => {
            killedByUser = true;
            try { child.kill('SIGTERM'); } catch (e) { /* ya se fue */ }
        };
        if (opts.signal) {
            if (opts.signal.aborted) { onAbort(); }
            else opts.signal.addEventListener('abort', onAbort, { once: true });
        }

        const readProgress = chunk => {
            const text = String(chunk);
            const matches = text.match(/progress\s*=\s*(\d+)%/g);
            if (!matches || !opts.onProgress) return;
            const last = matches[matches.length - 1];
            const percent = parseInt(last.replace(/\D/g, ''), 10);
            if (!isNaN(percent) && percent !== lastPercent) {
                lastPercent = percent;
                opts.onProgress(percent);
            }
        };

        child.stdout.on('data', c => { stdout += c; readProgress(c); });
        child.stderr.on('data', c => { stderr += c; readProgress(c); });

        child.on('error', err => {
            reject(new TranscribeError(`No se pudo ejecutar whisper-cli: ${err.message}`, 'spawn'));
        });

        child.on('close', code => {
            if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
            if (killedByUser) {
                return reject(new TranscribeError('Transcripción cancelada.', 'cancelado'));
            }
            if (code !== 0) {
                // whisper.cpp cuenta el motivo por stdout tan seguido como por
                // stderr; mirar uno solo deja al editor con un código pelado.
                const detail = (stderr || stdout || '').trim().split('\n').slice(-4).join(' ');
                return reject(new TranscribeError(
                    `whisper-cli terminó con código ${code}. ${detail}`, 'whisper'));
            }

            const jsonPath = `${outBase}.json`;
            let data;
            try {
                data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            } catch (e) {
                return reject(new TranscribeError(
                    `whisper-cli terminó bien pero no dejó un JSON legible (${e.message}).`, 'json'));
            } finally {
                try { fs.rmSync(path.dirname(outBase), { recursive: true, force: true }); } catch (e) { /* nada */ }
            }

            const rawWords = wordsFromWhisperJson(data);
            const collapsed = collapseLoops(rawWords);
            resolve({
                language: (data.result && data.result.language) || opts.language || null,
                model: tools.modelName,
                dtwModel,
                words: collapsed.words,
                segments: segmentsFromWords(collapsed.words),
                loopsRemoved: collapsed.removed
            });
        });
    });
}

/**
 * Transcribe el Live-Mix de una clase y lo guarda en su Backup.
 * Si ya hay uno guardado para el MISMO audio y el mismo motor, no se rehace.
 *
 * @param {object} params { root, sequenceName, wavPath, language, force, onProgress, signal }
 */
async function transcribeClass(params) {
    const { root, sequenceName, wavPath } = params;
    if (!wavPath) throw new TranscribeError('Esta clase no tiene Live-Mix.', 'sin_live_mix');

    const target = workspace.artifact(root, sequenceName, 'transcript');
    const source = workspace.fingerprint(wavPath);
    if (!source) throw new TranscribeError(`No pude leer ${wavPath}.`, 'sin_audio');

    if (!params.force) {
        const cached = workspace.readJson(target);
        if (isUsable(cached, source)) return { ...cached, fromCache: true };
    }

    // Whisper lee el convertido; todo lo demás mira el original, que es el que
    // manda para los tiempos y para la onda que se dibuja.
    const paraWhisper = aTasaDeWhisper(wavPath);
    let result;
    try {
        result = await runWhisper(paraWhisper || wavPath, {
            language: params.language,
            onProgress: params.onProgress,
            signal: params.signal
        });
    } finally {
        tirar(paraWhisper);
    }

    // Whisper acierta los finales de palabra y adelanta los arranques después de
    // un silencio (le atribuye a la primera palabra el silencio que la precede).
    // Se corrige una sola vez, acá: lo que se guarda ya son los tiempos del
    // sonido, y de ellos viven el anclaje y los cortes.
    let audioAlign = null;
    const info = onset.wavInfo(wavPath);
    if (info) {
        const aligned = onset.alignWords({ file: wavPath, info }, result.words, {
            fps: params.fps || 30
        });
        result.words = aligned.words;
        result.segments = segmentsFromWords(aligned.words);
        audioAlign = aligned.stats;
    }

    // Dónde no se dice nada, que el visor lo muestra y así no vuelve a leer el
    // audio. Va acá y no en el visor porque necesita las palabras: el pico del
    // audio solo no distingue un silencio de la voz del director hablando lejos
    // del micrófono, que mide exactamente igual. Y va DESPUÉS de corregirlas,
    // para que las pausas se recorten contra los mismos tiempos que se guardan.
    // `rehacer` porque las palabras acaban de cambiar: el cache que hubiera miente.
    silencios.asegurar({ root, sequenceName, wavPath, palabras: result.words, rehacer: true });

    const transcript = {
        version: TRANSCRIPT_VERSION,
        createdAt: new Date().toISOString(),
        sequenceName,
        source,
        engine: {
            tool: 'whisper-cli',
            model: result.model,
            vad: false,
            language: result.language,
            audioAligned: Boolean(audioAlign),
            // Con qué grilla se pidió el DTW, o null si este modelo no tiene una
            // conocida. Se guarda para que abriendo el JSON se pueda distinguir
            // "esta clase se transcribió sin alineación" de "la alineación corrió
            // y no encontró nada", que se ven igual desde las palabras.
            dtw: result.dtwModel || null
        },
        language: result.language,
        wordCount: result.words.length,
        // Cuántas palabras quedaron con instante de DTW. Es la cuenta que dice si
        // el reloj del panel va a poder armarse: por debajo del casi-total, algo
        // apagó la alineación de nuevo.
        dtwWords: result.words.filter(w => w.dtw != null).length,
        loopsRemoved: result.loopsRemoved,
        // Cuánta puntuación de cierre quedó. Se guarda y no se recalcula al
        // vuelo porque es la medida que dice si este transcript sirve para
        // cortar, y quererla después obligaría a releer las palabras de las
        // trece clases cada vez que alguien compara dos corridas.
        puntuacion: speech.densidadDeCierres(result.words),
        audioAlign,
        words: result.words,
        segments: result.segments
    };

    // Recién acá se escribe: una transcripción cancelada o caída no puede dejar
    // una caché a medias que la próxima corrida daría por buena.
    workspace.writeJson(target, transcript);
    workspace.appendLog(workspace.artifact(root, sequenceName, 'log'),
        `transcript: ${transcript.wordCount} palabras · idioma ${transcript.language} · modelo ${transcript.engine.model}` +
        ` · ${(transcript.puntuacion.ratio * 100).toFixed(1)}% cierran frase (pozo de ${transcript.puntuacion.pozoSec}s)` +
        (audioAlign ? ` · ${audioAlign.movedStarts || 0} arranques corregidos contra el audio` : ' · SIN corregir contra el audio') +
        (transcript.engine.dtw
            ? ` · DTW en ${transcript.dtwWords} de ${transcript.wordCount} palabras`
            : ' · SIN alineación por DTW') +
        (transcript.loopsRemoved ? ` · ${transcript.loopsRemoved} repeticiones colapsadas` : ''));

    return { ...transcript, fromCache: false };
}

/**
 * Vuelve a guardar el transcript de una clase con otras palabras.
 *
 * Existe por `engine/rescate.js`, que relee los arranques de bloque donde la
 * pasada de la clase entera no escribió nada y devuelve las palabras con lo que
 * se oyó adentro. Esas palabras tienen que entrar al transcript GUARDADO, porque
 * de ahí las leen el panel del visor, los cortes y las mediciones; si se
 * quedaran en una variable del motor, el panel seguiría empezando tarde y la
 * medición seguiría informando cero conteos en un curso que tiene cuatro.
 *
 * Vive acá y no en `rescate.js` porque la forma del artefacto es de este módulo:
 * las cuentas derivadas —cuántas palabras, cuántas con DTW, cuánta puntuación de
 * cierre— se calculan al guardar y una segunda copia de ese cálculo terminaría
 * diciendo otra cosa. Y por lo mismo se rehacen las frases y los silencios: las
 * dos cosas se derivan de las palabras, y un cache de antes miente.
 *
 * La huella del audio NO cambia, y es a propósito: el Live-Mix es el mismo, así
 * que `isUsable` sigue dando por bueno este transcript y nadie vuelve a pagar
 * cuarenta minutos de Whisper por una clase que ya está leída. `audioAlign`
 * tampoco se toca: describe lo que midió la onda en la pasada larga, y las
 * palabras nuevas no pasaron por ella (por eso no traen la marca `onset`).
 *
 * @param {object} params { root, sequenceName, wavPath, transcript, words, rescate }
 * @returns {object} el transcript ya guardado
 */
function reescribir(params) {
    const { root, sequenceName, wavPath, transcript, words } = params;
    const guardado = {
        ...transcript,
        wordCount: words.length,
        dtwWords: words.filter(w => w.dtw != null).length,
        puntuacion: speech.densidadDeCierres(words),
        // Qué se releyó y qué se agregó, para que abriendo el JSON se pueda
        // distinguir una palabra que salió de la pasada larga de una que salió de
        // un pedazo suelto. Sin esto, un transcript rescatado y uno que nunca lo
        // necesitó se leen igual.
        rescate: params.rescate || null,
        words,
        segments: segmentsFromWords(words)
    };
    delete guardado.fromCache;

    if (wavPath) {
        silencios.asegurar({ root, sequenceName, wavPath, palabras: words, rehacer: true });
    }
    workspace.writeJson(workspace.artifact(root, sequenceName, 'transcript'), guardado);
    return guardado;
}

/** ¿Sirve el transcript guardado para este audio y este motor? */
function isUsable(cached, source) {
    if (!cached || !VERSIONES_QUE_SIRVEN.has(cached.version)) return false;
    if (!Array.isArray(cached.words) || !cached.words.length) return false;
    if (!cached.engine || cached.engine.vad !== false) return false;
    return workspace.sameFingerprint(cached.source, source);
}

module.exports = {
    transcribeClass,
    reescribir,
    runWhisper,
    collapseLoops,
    segmentsFromWords,
    wordsFromWhisperJson,
    isUsable,
    TranscribeError,
    TRANSCRIPT_VERSION,
    VERSIONES_QUE_SIRVEN,
    DTW_POR_MODELO,
    MAX_REPEATS
};
