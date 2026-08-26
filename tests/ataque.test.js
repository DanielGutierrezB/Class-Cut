'use strict';
/**
 * El ataque que la onda midió, y el que no.
 *
 * `alignWords` corrige los arranques del STT contra el WAV, pero no siempre puede:
 * cuando el que habla está lejos del micrófono el sonido no aparece en la ventana
 * de búsqueda y la palabra se queda con el tiempo crudo. Los dos casos terminan
 * pareciéndose demasiado —una palabra que no se movió puede ser una que la onda
 * confirmó al milisegundo o una que la onda nunca vio—, y de esa confusión salió un
 * defecto real: el reloj de los cortes y del panel (`engine/reloj.js`) prefería el arranque "de
 * la onda" por sobre el DTW también en las tiradas donde la onda no había medido
 * nada. En la clase 1 eran 30 de 244, con el DTW a más de un segundo en 25.
 *
 * Así que acá se prueba que la marca distingue las dos cosas, que es lo único que
 * el reloj necesita para no volver a equivocarse.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const onset = require('../engine/vendor/audio-onset');

const TASA = 16000;

/**
 * Un WAV de verdad en el disco: `probe` lee el archivo con `fs`, así que esto no se
 * puede simular con una envolvente a mano como en `aire.test.js`.
 *
 * El silencio no es cero sino un ruido bajísimo, como una sala real: con cero
 * exacto el umbral de `stats` también da cero y cualquier muestra lo cruza.
 */
function wavConSonidoEn(tramos, duracionSec) {
    const total = Math.round(duracionSec * TASA);
    const datos = Buffer.alloc(total * 2);
    for (let i = 0; i < total; i++) {
        const seg = i / TASA;
        let v = (i % 2 ? 40 : -40);
        for (const [a, b, alto] of tramos) {
            if (seg >= a && seg < b) {
                v = Math.round((alto == null ? 13000 : alto) * Math.sin(2 * Math.PI * 200 * seg));
            }
        }
        datos.writeInt16LE(v, i * 2);
    }

    const cabecera = Buffer.alloc(44);
    cabecera.write('RIFF', 0);
    cabecera.writeUInt32LE(36 + datos.length, 4);
    cabecera.write('WAVE', 8);
    cabecera.write('fmt ', 12);
    cabecera.writeUInt32LE(16, 16);
    cabecera.writeUInt16LE(1, 20);
    cabecera.writeUInt16LE(1, 22);
    cabecera.writeUInt32LE(TASA, 24);
    cabecera.writeUInt32LE(TASA * 2, 28);
    cabecera.writeUInt16LE(2, 32);
    cabecera.writeUInt16LE(16, 34);
    cabecera.write('data', 36);
    cabecera.writeUInt32LE(datos.length, 40);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ataque-'));
    const file = path.join(dir, 'mix.wav');
    fs.writeFileSync(file, Buffer.concat([cabecera, datos]));
    return { file, info: onset.wavInfo(file) };
}

module.exports = function (t) {
    t.group('audio-onset · la marca del ataque medido');

    // Dos tramos de sonido y una palabra que el STT puso lejísimo del segundo:
    // 5,0 s cuando el sonido está en 9,0. La ventana de búsqueda son ±2 s, así
    // que ahí no hay ningún ataque que medir — es el caso del director hablando
    // desde el fondo de la sala, que en la clase 1 deja al STT ocho segundos
    // antes del habla.
    const wav = wavConSonidoEn([[2, 2.6], [9, 9.6]], 12);

    t.test('el WAV de prueba se puede leer', () => {
        t.ok(wav.info, 'sin cabecera legible no se prueba nada de lo de abajo');
        t.near(wav.info.durationSec, 12, 0.1);
    });

    t.test('donde hay ataque, la palabra queda marcada y en el sonido', () => {
        const r = onset.alignWords(wav, [{ start: 2.3, end: 2.55, text: 'Uno' }], { fps: 30 });
        t.eq(r.words[0].onset, true);
        t.near(r.words[0].start, 2.0, 0.1, 'y el arranque se fue al borde del sonido');
        t.eq(r.stats.measuredStarts, 1);
    });

    t.test('donde no hay ataque que medir, no hay marca y el tiempo queda crudo', () => {
        const r = onset.alignWords(wav, [{ start: 5.0, end: 5.4, text: 'Ok.' }], { fps: 30 });
        t.eq(r.words[0].onset, undefined, 'la marca dice "lo medí", no "lo intenté"');
        t.eq(r.words[0].start, 5.0, 'el arranque es el que trajo el STT, sin corregir');
        t.eq(r.stats.measuredStarts, 0);
        t.eq(r.stats.movedStarts, 0);
    });

    t.test('en la misma clase conviven las dos, y se distinguen', () => {
        // Es lo que pasa de verdad: el profesor al micrófono y el director de
        // lejos, en el mismo Live-Mix. Sin la marca, las dos tiradas se leen igual.
        const r = onset.alignWords(wav, [
            { start: 2.3, end: 2.55, text: 'Uno' },
            { start: 5.0, end: 5.4, text: 'Ok.' }
        ], { fps: 30 });
        t.eq(r.words[0].onset, true);
        t.eq(r.words[1].onset, undefined);
        t.eq(r.stats.runs, 2);
        t.eq(r.stats.measuredStarts, 1);
    });

    t.test('un ataque que no llega al habla de la clase no cuenta como medido', () => {
        // El caso que hizo falta arreglar dos veces. En el arranque de la clase 1
        // `edgeAt` contesta 0,65 con desplazamiento cero —o sea "el tiempo del STT
        // está bien"— sobre una frase que se dice en 8,56: el umbral sale de la
        // propia ventana, y en una ventana de puro ruido de sala se apoya en el
        // ruido. Preguntar solo "¿devolvió algo?" deja el defecto entero.
        //
        // Doce palabras al micrófono para que haya de dónde sacar el nivel de la
        // clase, y una dicha desde el fondo de la sala a 1/40 de ese nivel.
        const tramos = [];
        for (let k = 0; k < 12; k++) tramos.push([2 + k * 2, 2.4 + k * 2]);
        tramos.push([30, 30.4, 320]);
        const lejano = wavConSonidoEn(tramos, 34);

        const words = [];
        for (let k = 0; k < 12; k++) words.push({ start: 2.1 + k * 2, end: 2.38 + k * 2, text: `p${k}` });
        words.push({ start: 30.1, end: 30.38, text: 'Ok.' });

        const r = onset.alignWords(lejano, words, { fps: 30 });
        t.eq(r.words[0].onset, true, 'la del micrófono sí');
        t.eq(r.words[12].onset, undefined, 'la del fondo de la sala no');
        t.eq(r.stats.measuredStarts, 12, 'las doce del micrófono y ninguna más');
    });

    t.test('la marca va en la palabra que abre la tirada, que es la que se movió', () => {
        // Las de adentro no las mide nadie: `applyRun` las deja donde estaban o las
        // reparte proporcionalmente. Marcarlas diría que la onda midió algo que no
        // midió.
        const r = onset.alignWords(wav, [
            { start: 2.3, end: 2.4, text: 'Uno' },
            { start: 2.4, end: 2.5, text: 'dos' },
            { start: 2.5, end: 2.58, text: 'tres' }
        ], { fps: 30 });
        t.eq(r.words[0].onset, true);
        t.eq(r.words[1].onset, undefined);
        t.eq(r.words[2].onset, undefined);
    });
};
