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

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths');
const workspace = require('./workspace');
const onset = require('./vendor/audio-onset');

// 2: las palabras se guardan como {start, end, text} y ya vienen corregidas
// contra el audio (`audio-onset.alignWords`).
const TRANSCRIPT_VERSION = 2;
// Una frase repetida idéntica más veces que esto es un bucle de whisper en un
// silencio, no algo que alguien dijo.
const MAX_REPEATS = 3;

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
    const vad = paths.vadModel();
    if (!vad.path) {
        throw new TranscribeError(
            'No encontré el modelo de VAD. Sin él los tiempos de las palabras no sirven para alinear.',
            'sin_vad');
    }
    return { cli: cli.path, model: model.path, vad: vad.path, modelName: model.name };
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
 * Whisper entra en bucle en los silencios y repite la misma palabra o frase
 * decenas de veces. Se dejan las primeras y se tiran las demás: como cada
 * repetición ocupa tiempo, dejarlas correría el resto del transcript.
 */
function collapseLoops(words) {
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
 * Corre whisper-cli sobre un WAV. Devuelve el transcript ya normalizado.
 * @param {object} options { language, onProgress, signal }
 */
function runWhisper(wavPath, options) {
    const opts = options || {};
    const tools = checkTools();
    const outBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-stt-')), 'out');

    const args = [
        '-m', tools.model,
        '-f', wavPath,
        '-l', opts.language || 'auto',
        '-oj',
        '-ml', '1',
        '-sow',
        '--vad',
        '-vm', tools.vad,
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

    const result = await runWhisper(wavPath, {
        language: params.language,
        onProgress: params.onProgress,
        signal: params.signal
    });

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

    const transcript = {
        version: TRANSCRIPT_VERSION,
        createdAt: new Date().toISOString(),
        sequenceName,
        source,
        engine: {
            tool: 'whisper-cli',
            model: result.model,
            vad: true,
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
    if (!cached.engine || cached.engine.vad !== true) return false;
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
