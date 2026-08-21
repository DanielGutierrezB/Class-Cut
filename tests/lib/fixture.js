'use strict';
/**
 * tests/lib/fixture.js — El curso real y carpetas sintéticas.
 *
 * El curso de verdad (13 clases) es la única prueba que vale para el parser: los
 * casos raros que rompen el emparejamiento están ahí y no se inventan. Pero no
 * tiene clases sin Live-Mix ni números duplicados, así que esos se arman a mano en
 * una carpeta temporal.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const COURSE = '/Users/danielgutierrez/Movies/CUR/2026_curso-spec-driven-development';

function courseAvailable() {
    return fs.existsSync(COURSE);
}

/** XML mínimo del Rodecaster con los marcadores que se le pidan. */
function makeXml(sequenceName, markers, options) {
    const opts = options || {};
    const timebase = opts.timebase || 30;
    const body = (markers || []).map(m => [
        '        <marker>',
        `          <comment>${m.comment}</comment>`,
        `          <name>${m.name}</name>`,
        `          <in>${m.in}</in>`,
        `          <out>${m.out == null ? m.in : m.out}</out>`,
        '          <pproColor>4281740498</pproColor>',
        '        </marker>'
    ].join('\n')).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <duration>${opts.duration == null ? 216000 : opts.duration}</duration>
    <rate>
      <timebase>${timebase}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <name>${sequenceName}</name>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate>
              <timebase>29.97</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <codec>
              <name>h264</name>
            </codec>
            <width>1920</width>
            <height>1080</height>
          </samplecharacteristics>
        </format>
      </video>
    </media>
${body}
  </sequence>
</xmeml>`;
}

const CLAP_PAIR = [
    { comment: ' - Clapperboard', name: 'K', in: 300 },
    { comment: 'OUT: Clapperboard', name: 'K', in: 300 }
];

/** Un par IN/OUT normal: IN con 10 s de span, OUT en el fin real del bloque. */
function pair(startFrame, endFrame, view, note) {
    const label = note ? `${note} - ` : ' - ';
    return [
        { comment: `${label} 3, 2, 1. arranca el bloque de ${startFrame}`, name: view || 'PV', in: startFrame, out: startFrame + 300 },
        { comment: `OUT: termina el bloque de ${startFrame}`, name: view || 'PV', in: endFrame }
    ];
}

/**
 * Arma una carpeta de clase con la firma real (XML + Audio/ + Video/).
 * @param {object} spec { number, markers, videos, audios, liveMix, xmlCount, folderName }
 */
function makeClassFolder(parent, spec) {
    const s = spec || {};
    const number = s.number == null ? 1 : s.number;
    const stamp = s.stamp || `2026-08-18_${number}_1${number}-00-00`;
    const folderName = s.folderName || `Clase ${String(number).padStart(2, '0')} - Default_${stamp}`;
    const dir = path.join(parent, folderName);
    const sequenceName = s.sequenceName === undefined
        ? `${String(number).padStart(2, '0')}_2608_spec-driven-dev-1783694681_1059${10 + number}`
        : s.sequenceName;

    fs.mkdirSync(path.join(dir, 'Audio'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Video'), { recursive: true });

    if (s.xml !== false) {
        const markers = s.markers || CLAP_PAIR.concat(pair(600, 900), pair(1200, 1500));
        fs.writeFileSync(path.join(dir, `${sequenceName}.xml`), makeXml(sequenceName, markers));
        if (s.extraXml) {
            fs.writeFileSync(path.join(dir, `${s.extraXml}.xml`), makeXml(s.extraXml, markers));
        }
    }

    const videos = s.videos === undefined ? ['1_CAMERA 1.mp4', '2_CAMERA 2.mp4'] : s.videos;
    for (const name of videos) fs.writeFileSync(path.join(dir, 'Video', name), 'x');
    // Los AppleDouble que deja macOS: el escáner tiene que ignorarlos.
    fs.writeFileSync(path.join(dir, 'Video', '._1_CAMERA 1.mp4'), 'x');

    let audios = s.audios;
    if (audios === undefined) {
        audios = ['1_COMBO-1.wav', '2_COMBO-2.wav', '9_USB-2.wav'];
        if (s.liveMix !== false) audios.push('Live-Mix.wav');
    }
    for (const name of audios) fs.writeFileSync(path.join(dir, 'Audio', name), 'x');

    return { dir, folderName, sequenceName };
}

function tempRoot(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `classcut-${label || 'test'}-`));
}

function rimraf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* nada */ }
}

/** Todas las carpetas de clase del curso real, con su XML. */
function realClassFolders() {
    const out = [];
    for (const day of fs.readdirSync(COURSE)) {
        const dayDir = path.join(COURSE, day);
        if (!day.startsWith('Day_')) continue;
        for (const cls of fs.readdirSync(dayDir)) {
            const dir = path.join(dayDir, cls);
            if (!fs.existsSync(path.join(dir, 'Audio'))) continue;
            const xml = fs.readdirSync(dir).find(f => f.endsWith('.xml') && !f.startsWith('._'));
            if (xml) out.push({ dir, xmlPath: path.join(dir, xml), folderName: cls, dayName: day });
        }
    }
    return out;
}

module.exports = {
    COURSE,
    courseAvailable,
    realClassFolders,
    makeXml,
    makeClassFolder,
    pair,
    CLAP_PAIR,
    tempRoot,
    rimraf
};
