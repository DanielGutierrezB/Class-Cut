'use strict';
/**
 * transcribe.js — El Live-Mix a palabras con tiempos, con whisper.cpp local.
 *
 * Dos decisiones que se tomaron midiendo, no leyendo documentación:
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

// 2: las palabras se guardan como {start, end, text} y ya vienen corregidas
//    contra el audio (`audio-onset.alignWords`).
// 3: sin VAD, que arruinaba los tiempos de cada palabra, y leyendo el audio ya
//    convertido a 16 kHz mono, que es como Whisper lo quiere.
const TRANSCRIPT_VERSION = 3;
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
 * que hablan los módulos de análisis (`marker-anchor`, `audio-onset`).
 */
function wordsFromWhisperJson(data) {
    const out = [];
    for (const segment of (data.transcription || [])) {
        const text = String(segment.text == null ? '' : segment.text).trim();
        if (!text) continue;
        const from = segment.offsets ? segment.offsets.from / 1000 : null;
        const to = segment.offsets ? segment.offsets.to / 1000 : null;
        if (from == null || to == null) continue;
        out.push({ start: round(from), end: round(Math.max(to, from)), text });
    }
    return out;
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
        '-pp'
    ];

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
            audioAligned: Boolean(audioAlign)
        },
        language: result.language,
        wordCount: result.words.length,
        loopsRemoved: result.loopsRemoved,
        audioAlign,
        words: result.words,
        segments: result.segments
    };

    // Recién acá se escribe: una transcripción cancelada o caída no puede dejar
    // una caché a medias que la próxima corrida daría por buena.
    workspace.writeJson(target, transcript);
    workspace.appendLog(workspace.artifact(root, sequenceName, 'log'),
        `transcript: ${transcript.wordCount} palabras · idioma ${transcript.language} · modelo ${transcript.engine.model}` +
        (audioAlign ? ` · ${audioAlign.movedStarts || 0} arranques corregidos contra el audio` : ' · SIN corregir contra el audio') +
        (transcript.loopsRemoved ? ` · ${transcript.loopsRemoved} repeticiones colapsadas` : ''));

    return { ...transcript, fromCache: false };
}

/** ¿Sirve el transcript guardado para este audio y este motor? */
function isUsable(cached, source) {
    if (!cached || cached.version !== TRANSCRIPT_VERSION) return false;
    if (!Array.isArray(cached.words) || !cached.words.length) return false;
    if (!cached.engine || cached.engine.vad !== false) return false;
    return workspace.sameFingerprint(cached.source, source);
}

module.exports = {
    transcribeClass,
    runWhisper,
    collapseLoops,
    segmentsFromWords,
    wordsFromWhisperJson,
    isUsable,
    TranscribeError,
    TRANSCRIPT_VERSION,
    MAX_REPEATS
};
