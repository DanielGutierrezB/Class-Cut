'use strict';
/**
 * waveform.js — El dibujo del audio para el visor de revisión.
 *
 * Un Live-Mix de una hora son 1,1 GB de PCM a 24 bits: leerlo entero para
 * dibujarlo es un segundo largo de disco y medio giga de RAM, y para una tira de
 * cuatro mil píxeles no hace falta nada de eso. Se lee **una muestra por píxel**:
 * un saltito por cada cubo y un pedacito de cada uno, que en un SSD es
 * instantáneo y da la misma silueta.
 *
 * Lo que se dibuja es el pico de cada cubo, no el promedio: el promedio aplana
 * los ataques y en la silueta desaparecen justo las fronteras entre tomas, que es
 * lo único que el editor mira acá.
 */

const fs = require('fs');
const onset = require('./vendor/audio-onset');

// Cuántos frames de audio se miran por píxel. Con más, la silueta no cambia y se
// leen decenas de MB de más.
const FRAMES_PER_BUCKET = 6144;

function sampleValue(buffer, offset, bits, format) {
    if (format === 3 && bits === 32) return Math.abs(buffer.readFloatLE(offset));
    if (bits === 16) return Math.abs(buffer.readInt16LE(offset)) / 32768;
    if (bits === 24) {
        const v = buffer[offset] | (buffer[offset + 1] << 8) | ((buffer[offset + 2] << 24) >> 8);
        return Math.abs(v) / 8388608;
    }
    if (bits === 32) return Math.abs(buffer.readInt32LE(offset)) / 2147483648;
    if (bits === 8) return Math.abs(buffer[offset] - 128) / 128;
    return 0;
}

/**
 * @param {string} wavPath
 * @param {number} buckets cuántos puntos tiene la tira
 * @param {object} [range] {fromSec, toSec} para mirar de cerca un tramo
 * @returns {{peaks:number[], durationSec:number, fromSec:number, toSec:number}|null}
 */
function peaks(wavPath, buckets, range) {
    const info = onset.wavInfo(wavPath);
    if (!info) return null;

    const count = Math.max(64, Math.min(20000, buckets || 3000));
    const bytesPerSample = info.bits / 8;
    const frameBytes = bytesPerSample * info.channels;
    const totalFrames = Math.floor(info.dataBytes / frameBytes);
    if (!totalFrames) return null;

    // Un tramo de veinte segundos dibujado con los cubos de una clase de una hora
    // son doce puntos: se ve una línea con escalones y no un audio. Cuando el
    // visor se acerca, se vuelve a leer solo ese tramo.
    const fromSec = range && range.fromSec != null ? Math.max(0, range.fromSec) : 0;
    const toSec = range && range.toSec != null
        ? Math.min(info.durationSec, range.toSec)
        : info.durationSec;

    const firstFrame = Math.floor(fromSec * info.sampleRate);
    const lastFrame = Math.min(totalFrames, Math.ceil(toSec * info.sampleRate));
    const windowFrames = Math.max(1, lastFrame - firstFrame);
    const framesPerBucket = windowFrames / count;
    const readFrames = Math.min(FRAMES_PER_BUCKET, Math.max(1, Math.ceil(framesPerBucket)));
    const buffer = Buffer.alloc(readFrames * frameBytes);
    const out = new Array(count).fill(0);

    let fd = null;
    try {
        fd = fs.openSync(wavPath, 'r');
        for (let i = 0; i < count; i++) {
            const startFrame = firstFrame + Math.floor(i * framesPerBucket);
            const position = info.dataOffset + startFrame * frameBytes;
            const wanted = Math.min(buffer.length, info.dataBytes - startFrame * frameBytes);
            if (wanted <= 0) break;

            const read = fs.readSync(fd, buffer, 0, wanted, position);
            let peak = 0;
            for (let offset = 0; offset + frameBytes <= read; offset += frameBytes) {
                for (let channel = 0; channel < info.channels; channel++) {
                    const value = sampleValue(buffer, offset + channel * bytesPerSample, info.bits, info.format);
                    if (value > peak) peak = value;
                }
            }
            out[i] = Math.round(peak * 1000) / 1000;
        }
    } catch (e) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* nada */ } }
    }

    return {
        peaks: out,
        durationSec: info.durationSec,
        fromSec,
        toSec,
        sampleRate: info.sampleRate,
        channels: info.channels
    };
}

module.exports = { peaks, FRAMES_PER_BUCKET };
