'use strict';
/**
 * media-probe.js — Cuánto dura de verdad el material, medido con ffprobe.
 *
 * El XML del Rodecaster declara 2 horas exactas en todas las clases (216000
 * frames), y ninguna dura eso: en el curso real van de 20 a 45 minutos. Si el XML
 * de salida se armara con ese número, cada clase saldría con una hora y media de
 * negro al final y los marcadores del final caerían fuera del material.
 *
 * De acá sale también el frame rate REAL, que es el que manda en el XML de salida:
 * la secuencia del Rodecaster dice timebase 30 pero el media viene a 29.97.
 */

const { execFile } = require('child_process');
const paths = require('./paths');

const CONCURRENCY = 4;
// Dos capturas de la misma clase no arrancan y paran en el mismo milisegundo, pero
// más de un frame de diferencia ya no es redondeo: es material distinto.
const DURATION_TOLERANCE_SEC = 1 / 24;

function run(bin, args) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            // ffprobe escribe el motivo en stderr y a veces cierra con 0 igual, así
            // que se miran los dos lados antes de decidir que falló.
            if (err) return reject(new Error((stderr || err.message || '').trim()));
            resolve(stdout);
        });
    });
}

function parseRate(text) {
    if (!text) return null;
    const [num, den] = String(text).split('/');
    const n = parseFloat(num);
    const d = den == null ? 1 : parseFloat(den);
    if (!n || !d) return null;
    return { num: n, den: d, value: n / d };
}

/** Un archivo → duración, fps y formato. Nunca lanza: el fallo viaja en `error`. */
async function probeFile(filePath) {
    const tool = paths.ffprobe();
    if (!tool.path) {
        return { path: filePath, ok: false, error: 'Falta ffprobe (mirá Diagnóstico).' };
    }
    let raw;
    try {
        raw = await run(tool.path, [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ]);
    } catch (e) {
        return { path: filePath, ok: false, error: e.message || 'ffprobe no pudo leer el archivo.' };
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return { path: filePath, ok: false, error: 'ffprobe devolvió algo que no se pudo leer.' };
    }

    const streams = data.streams || [];
    const video = streams.find(s => s.codec_type === 'video') || null;
    const audio = streams.find(s => s.codec_type === 'audio') || null;

    const formatDuration = data.format && data.format.duration ? parseFloat(data.format.duration) : null;
    const streamDuration = video && video.duration ? parseFloat(video.duration)
        : (audio && audio.duration ? parseFloat(audio.duration) : null);
    const durationSec = formatDuration || streamDuration || null;

    const rate = video ? (parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate)) : null;

    return {
        path: filePath,
        ok: durationSec != null,
        error: durationSec == null ? 'El archivo no declara duración: puede estar copiándose todavía.' : null,
        durationSec,
        fps: rate ? rate.value : null,
        fpsExact: rate ? { num: rate.num, den: rate.den } : null,
        width: video ? video.width : null,
        height: video ? video.height : null,
        videoCodec: video ? video.codec_name : null,
        audioCodec: audio ? audio.codec_name : null,
        channels: audio ? audio.channels : null,
        sampleRate: audio ? parseInt(audio.sample_rate, 10) || null : null
    };
}

async function mapLimited(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Mide una clase: duración de referencia, fps real y avisos de material que no
 * cuadra. Muta la clase (es el objeto que ya viaja a la UI) y la devuelve.
 */
async function probeClass(cls) {
    const files = [...(cls.videos || []), ...(cls.audios || [])];
    if (!files.length) return cls;

    const probes = await mapLimited(files, CONCURRENCY, f => probeFile(f.path));
    const byPath = new Map(probes.map(p => [p.path, p]));

    const broken = probes.filter(p => !p.ok);
    for (const bad of broken) {
        cls.problems.push({
            code: 'media_incompleta',
            message: `No pude leer "${basename(bad.path)}": ${bad.error}`
        });
    }

    for (const list of [cls.videos, cls.audios]) {
        for (const item of list || []) {
            const p = byPath.get(item.path);
            if (!p || !p.ok) continue;
            item.durationSec = p.durationSec;
            item.fps = p.fps;
            item.channels = p.channels;
            item.sampleRate = p.sampleRate;
        }
    }

    const videoProbes = (cls.videos || []).map(v => byPath.get(v.path)).filter(p => p && p.ok);
    const audioProbes = (cls.audios || []).map(a => byPath.get(a.path)).filter(p => p && p.ok);

    // La duración de la clase es la de las cámaras (es lo que se coloca en video).
    // Si no hay cámaras legibles se cae al audio para no dejar la fila muda.
    const reference = videoProbes.length ? videoProbes : audioProbes;
    if (reference.length) {
        cls.durationSec = Math.max(...reference.map(p => p.durationSec));
        cls.durationSpreadSec = cls.durationSec - Math.min(...reference.map(p => p.durationSec));
    }

    const withFps = videoProbes.filter(p => p.fps);
    if (withFps.length) {
        cls.fps = withFps[0].fps;
        cls.fpsExact = withFps[0].fpsExact;
        cls.width = withFps[0].width;
        cls.height = withFps[0].height;
        const distintos = withFps.filter(p => Math.abs(p.fps - cls.fps) > 0.001);
        if (distintos.length) {
            cls.warnings.push({
                code: 'fps_mezclado',
                message: `Las cámaras no tienen el mismo frame rate (${withFps.map(p => p.fps.toFixed(3)).join(' vs ')}).`
            });
        }
    }

    if (videoProbes.length > 1 && cls.durationSpreadSec > DURATION_TOLERANCE_SEC) {
        cls.warnings.push({
            code: 'duracion_dispar',
            message: `Las cámaras no duran lo mismo (${cls.durationSpreadSec.toFixed(2)} s de diferencia): revisá el final de la clase.`
        });
    }

    const liveMixProbe = cls.liveMixPath ? byPath.get(cls.liveMixPath) : null;
    if (liveMixProbe && liveMixProbe.ok) {
        cls.liveMixDurationSec = liveMixProbe.durationSec;
        cls.liveMixSampleRate = liveMixProbe.sampleRate;
        cls.liveMixChannels = liveMixProbe.channels;
        if (cls.durationSec && Math.abs(liveMixProbe.durationSec - cls.durationSec) > 1) {
            cls.warnings.push({
                code: 'live_mix_desfasado',
                message: `El Live-Mix dura ${fmtDur(liveMixProbe.durationSec)} y las cámaras ${fmtDur(cls.durationSec)}.`
            });
        }
    }

    // Los marcadores se escribieron sobre las 2 h nominales del XML; uno que caiga
    // más allá del material real quedaría colgando en el vacío dentro del NLE.
    if (cls.durationSec != null && cls.lastBlockEndSec != null &&
        cls.lastBlockEndSec > cls.durationSec + 1) {
        cls.warnings.push({
            code: 'marcadores_fuera_del_media',
            message: `Hay marcadores en ${fmtDur(cls.lastBlockEndSec)}, más allá del final del material (${fmtDur(cls.durationSec)}): se van a recortar.`
        });
    }

    cls.processable = cls.problems.length === 0;
    return cls;
}

async function probeClasses(classes, onProgress) {
    let done = 0;
    for (const cls of classes) {
        await probeClass(cls);
        done++;
        if (onProgress) onProgress(done, classes.length, cls);
    }
    return classes;
}

function basename(p) {
    return String(p).split('/').pop();
}

function fmtDur(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

module.exports = { probeFile, probeClass, probeClasses, fmtDur, DURATION_TOLERANCE_SEC };
