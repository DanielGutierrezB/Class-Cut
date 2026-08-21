'use strict';
/**
 * fcp-xml.js — Escribe el XML (xmeml v4 / FCP7) que importan Premiere y Resolve.
 *
 * Es el formato de intercambio más portable que hay, con dos condiciones que se
 * respetan acá: **plano** (nada de secuencias anidadas, que es donde Resolve se
 * pierde) y con las rutas absolutas bien escapadas.
 *
 * La cuenta de frames se hace con fracciones exactas. Con 29.97 (30000/1001)
 * redondear el frame rate hace que un marcador y su clip se separen un frame cada
 * pocos minutos, y en una clase de una hora eso ya se ve. El material de este
 * curso resultó ser 30 exactos —el XML del Rodecaster declara 29.97 en el formato,
 * pero ffprobe dice 30/1— así que el frame rate sale siempre del material medido,
 * nunca del XML de origen.
 *
 * La estructura sigue la del generador de Sync, que ya está probado importando en
 * los dos editores.
 */

// Premiere guarda los colores de marcador como enteros; el XML de intercambio los
// quiere como componentes de 16 bits. Este es el mapa que entienden los dos NLE.
const MARKER_COLORS = {
    red: { alpha: 0, red: 65535, green: 0, blue: 0 },
    green: { alpha: 0, red: 0, green: 65535, blue: 0 },
    blue: { alpha: 0, red: 0, green: 0, blue: 65535 },
    cyan: { alpha: 0, red: 0, green: 65535, blue: 65535 },
    magenta: { alpha: 0, red: 65535, green: 0, blue: 65535 },
    yellow: { alpha: 0, red: 65535, green: 65535, blue: 0 },
    white: { alpha: 0, red: 65535, green: 65535, blue: 65535 },
    orange: { alpha: 0, red: 65535, green: 42662, blue: 0 }
};

const NTSC_RATES = [
    { nominal: 23.976, timebase: 24, num: 24000, den: 1001 },
    { nominal: 29.97, timebase: 30, num: 30000, den: 1001 },
    { nominal: 59.94, timebase: 60, num: 60000, den: 1001 }
];

function rateFor(fps) {
    const value = Number(fps) || 30;
    for (const rate of NTSC_RATES) {
        if (Math.abs(value - rate.nominal) < 0.01) {
            return { timebase: rate.timebase, ntsc: true, num: rate.num, den: rate.den };
        }
    }
    const timebase = Math.round(value);
    return { timebase, ntsc: false, num: timebase, den: 1 };
}

/** Segundos → frames, con la fracción exacta del formato. */
function toFrames(seconds, fps) {
    const rate = rateFor(fps);
    return Math.round((Number(seconds) || 0) * rate.num / rate.den);
}

function framesToSeconds(frames, fps) {
    const rate = rateFor(fps);
    return (Number(frames) || 0) * rate.den / rate.num;
}

function xmlSafe(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        // Los caracteres de control no son válidos en XML 1.0 y un comentario
        // pegado desde otro lado puede traerlos.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Ruta absoluta → `file://localhost/...` con cada segmento escapado. Sin esto,
 * un espacio o una tilde ("Nicolás", "Clase 04 -Default") deja el clip offline.
 */
function pathUrl(absolutePath) {
    const parts = String(absolutePath).split('/').map(segment => encodeURIComponent(segment));
    return `file://localhost${parts.join('/')}`;
}

function rateXml(fps) {
    const rate = rateFor(fps);
    return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function timecodeXml(fps) {
    const rate = rateFor(fps);
    const sep = rate.ntsc ? ';' : ':';
    return `<timecode>${rateXml(fps)}<string>00${sep}00${sep}00${sep}00</string>` +
        `<frame>0</frame><displayformat>${rate.ntsc ? 'DF' : 'NDF'}</displayformat></timecode>`;
}

function videoCharacteristics(fps, width, height) {
    return `<samplecharacteristics>${rateXml(fps)}` +
        `<width>${width || 1920}</width><height>${height || 1080}</height>` +
        '<anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio>' +
        '<fielddominance>none</fielddominance></samplecharacteristics>';
}

/**
 * Registro de archivos: cada media se define UNA vez —en el bin, que va antes que
 * la secuencia— y todo lo demás la referencia por id. Repetir la definición hace
 * que Premiere importe el mismo archivo varias veces y el proyecto termine con
 * diez copias del mismo clip.
 *
 * El `masterclipid` es lo que ata todos los pedazos de una cámara al mismo clip
 * maestro. De eso depende que un Lumetri puesto en el maestro caiga sobre los
 * dieciséis trozos de la clase, que es como se ajusta todo junto ahora que no
 * hay anidaciones.
 */
class FileRegistry {
    constructor(fps) {
        this.fps = fps;
        this.byPath = new Map();
        this.next = 1;
    }

    register(source) {
        const key = source.path;
        if (!this.byPath.has(key)) {
            this.byPath.set(key, {
                id: `file-${this.next}`,
                masterclip: `masterclip-${this.next}`,
                defined: false,
                source
            });
            this.next++;
        }
        return this.byPath.get(key);
    }

    sources() {
        return [...this.byPath.values()];
    }

    fileXml(source) {
        const entry = this.register(source);
        if (entry.defined) return `<file id="${entry.id}"/>`;
        entry.defined = true;

        const isAudio = Boolean(source.audioOnly);
        const name = xmlSafe(source.name || source.path.split('/').pop());
        const media = isAudio
            ? `<audio><samplecharacteristics><depth>${source.bits || 16}</depth>` +
              `<samplerate>${source.sampleRate || 48000}</samplerate></samplecharacteristics>` +
              `<channelcount>${source.channels || 2}</channelcount></audio>`
            : `<video>${videoCharacteristics(this.fps, source.width, source.height)}</video>` +
              '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>' +
              '</samplecharacteristics><channelcount>2</channelcount></audio>';

        return `<file id="${entry.id}"><name>${name}</name>` +
            `<pathurl>${pathUrl(source.path)}</pathurl>` +
            `${rateXml(this.fps)}<duration>${toFrames(source.durationSec, this.fps)}</duration>` +
            `${timecodeXml(this.fps)}<media>${media}</media></file>`;
    }

    /** El clip maestro del bin: define el archivo y le da nombre al conjunto. */
    binClipXml(source) {
        const entry = this.register(source);
        const name = xmlSafe(source.name || source.path.split('/').pop());
        const duration = toFrames(source.durationSec, this.fps);
        const fileXml = this.fileXml(source);
        const videoTrack = source.audioOnly ? '' :
            `<video><track><clipitem id="bin-v-${entry.id}"><name>${name}</name>` +
            `<file id="${entry.id}"/></clipitem></track></video>`;
        const audioTrack =
            `<audio><track><clipitem id="bin-a-${entry.id}"><name>${name}</name>` +
            `<file id="${entry.id}"/>` +
            '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' +
            '</clipitem></track></audio>';

        return `        <clip id="masterclip-bin-${entry.id}">` +
            `<masterclipid>${entry.masterclip}</masterclipid>` +
            `<name>${name}</name><duration>${duration}</duration>${rateXml(this.fps)}` +
            `${fileXml}<media>${videoTrack}${audioTrack}</media></clip>\n`;
    }
}

function clipItemXml(params) {
    const { id, registry, source, startFrame, endFrame, inFrame, outFrame, enabled, fps, kind } = params;
    const entry = registry.register(source);
    const sourceDuration = toFrames(source.durationSec, fps);
    const fileXml = registry.fileXml(source);
    const sourceTrack = kind === 'audio'
        ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>'
        : '';

    return `        <clipitem id="${id}" frameBlend="FALSE">` +
        `<masterclipid>${entry.masterclip}</masterclipid>` +
        `<name>${xmlSafe(source.name || '')}</name>` +
        `<enabled>${enabled === false ? 'FALSE' : 'TRUE'}</enabled>` +
        `<duration>${sourceDuration}</duration>${rateXml(fps)}` +
        `<start>${startFrame}</start><end>${endFrame}</end>` +
        `<in>${inFrame}</in><out>${outFrame}</out>` +
        `${fileXml}${sourceTrack}</clipitem>\n`;
}

function markerXml(marker, fps) {
    const color = MARKER_COLORS[String(marker.color || 'white').toLowerCase()] || MARKER_COLORS.white;
    const inFrame = toFrames(marker.startSec, fps);
    // Un marcador con duración lleva su `out`; los de punto usan -1, que es como
    // el formato dice "sin duración".
    const outFrame = marker.endSec != null && marker.endSec > marker.startSec
        ? toFrames(marker.endSec, fps)
        : -1;
    return `    <marker><comment>${xmlSafe(marker.comment || '')}</comment>` +
        `<name>${xmlSafe(marker.name || '')}</name>` +
        `<in>${inFrame}</in><out>${outFrame}</out>` +
        `<color><alpha>${color.alpha}</alpha><red>${color.red}</red>` +
        `<green>${color.green}</green><blue>${color.blue}</blue></color></marker>\n`;
}

/**
 * Arma el proyecto completo: un bin con los clips maestros y la secuencia.
 *
 * El orden importa y no es estético: el bin va PRIMERO porque es quien define
 * cada archivo, y así todo lo que viene después lo referencia por id en vez de
 * volver a describirlo (que es como el mismo video termina importado diez veces).
 *
 * @param {object} params
 *   name          nombre de la secuencia
 *   fps           frame rate REAL del material
 *   width/height  formato
 *   videoTracks   [[{source, startSec, endSec, sourceInSec, enabled}]]
 *   audioTracks   ídem
 *   markers       [{name, comment, startSec, endSec, color}]
 *   durationSec   duración total
 *   binName       nombre del bin (por defecto, el de la secuencia)
 */
function sequenceXml(params) {
    const {
        name, fps = 30, width = 1920, height = 1080,
        videoTracks = [], audioTracks = [], markers = [], durationSec = 0
    } = params || {};
    const binName = params.binName || name;

    const registry = new FileRegistry(fps);
    let clipId = 0;
    const nextId = () => `clipitem-${++clipId}`;

    // Los clips maestros se emiten antes que nada, en el orden en que aparece el
    // material, para que el bin quede legible: cámaras primero, después audios.
    const binOrder = [];
    for (const clips of videoTracks.concat(audioTracks)) {
        for (const clip of clips) {
            if (!binOrder.some(s => s.path === clip.source.path)) binOrder.push(clip.source);
        }
    }
    const binXml = binOrder.map(source => registry.binClipXml(source)).join('');

    const buildTrack = (clips, kind) => clips.map(clip => clipItemXml({
        id: nextId(),
        registry,
        source: clip.source,
        startFrame: toFrames(clip.startSec, fps),
        endFrame: toFrames(clip.endSec, fps),
        inFrame: toFrames(clip.sourceInSec || 0, fps),
        outFrame: toFrames((clip.sourceInSec || 0) + (clip.endSec - clip.startSec), fps),
        enabled: clip.enabled,
        fps,
        kind
    })).join('');

    const videoXml = videoTracks.map(clips =>
        '      <track TL.SQTrackShy="0" TL.SQTrackExpandedHeight="25">\n' +
        buildTrack(clips, 'video') +
        '        <enabled>TRUE</enabled><locked>FALSE</locked></track>\n'
    ).join('');

    let outputChannel = 1;
    const audioXml = audioTracks.map(clips => {
        const items = buildTrack(clips, 'audio');
        const track = '      <track TL.SQTrackAudioKeyframeStyle="0" TL.SQTrackShy="0" ' +
            'TL.SQTrackExpandedHeight="25" currentExplodedTrackIndex="0" ' +
            'totalExplodedTrackCount="1" premiereTrackType="Stereo">\n' +
            items +
            '        <enabled>TRUE</enabled><locked>FALSE</locked>' +
            `<outputchannelindex>${outputChannel}</outputchannelindex></track>\n`;
        outputChannel += 2;
        return track;
    }).join('');

    const markersXml = markers.map(marker => markerXml(marker, fps)).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project>
    <name>${xmlSafe(name)}</name>
    <children>
      <bin>
        <name>${xmlSafe(binName)}</name>
        <children>
${binXml}        </children>
      </bin>
      <sequence id="sequence-1">
        <name>${xmlSafe(name)}</name>
        <duration>${toFrames(durationSec, fps)}</duration>
        ${rateXml(fps)}
        ${timecodeXml(fps)}
        <media>
          <video>
            <format>${videoCharacteristics(fps, width, height)}</format>
${videoXml}          </video>
          <audio>
            <numOutputChannels>2</numOutputChannels>
            <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
${audioXml}          </audio>
        </media>
${markersXml}      </sequence>
    </children>
  </project>
</xmeml>
`;
}

module.exports = {
    sequenceXml,
    toFrames,
    framesToSeconds,
    rateFor,
    pathUrl,
    xmlSafe,
    MARKER_COLORS,
    FileRegistry
};
