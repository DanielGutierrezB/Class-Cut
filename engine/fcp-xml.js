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

// Etiquetas de color de clip. Son los nombres nativos de Premiere; el orden es
// el que se le asigna a la 1ª, 2ª, 3ª… fuente de video, y como el Rodecaster
// numera igual en todas las clases, cada cámara conserva su color en el curso
// entero. Resolve ignora esta etiqueta al importar (ver resolve/README.md).
const CLIP_LABELS = [
    'Cerulean', 'Rose', 'Mango', 'Forest', 'Purple', 'Iris', 'Caribbean', 'Lavender'
];

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
        const label = source.label
            ? `<labels><label2>${xmlSafe(source.label)}</label2></labels>`
            : '';
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
            `${label}${fileXml}<media>${videoTrack}${audioTrack}</media></clip>\n`;
    }
}

/**
 * La geometría del recuadro del profesor, copiada de la regla
 * `.player-video.is-inset` de src/css/visor.css.
 *
 * Ahí se decidió cómo se ve, así que ahí está la fuente: si cambia el reproductor
 * se cambian estos tres números y el XML sale igual que la pantalla. Lo que la
 * regla dice con `aspect-ratio: 1` y `object-fit: cover` no son números sino la
 * forma —cuadrado— y de dónde se recorta —del centro—, y eso lo resuelve
 * `encuadreDelRecuadro()`.
 */
const RECUADRO = {
    alto: 0.30,     // height: 30%   → del alto del cuadro
    derecha: 0.025, // inset: auto 2.5% ...  → del ancho
    abajo: 0.044,   // ... 4.4% auto         → del alto
    /**
     * Qué tan ancho es el recuadro respecto de su alto.
     *
     * El reproductor lo muestra cuadrado (`object-fit: cover` sobre una caja
     * 1:1), pero el editor no lo quiere cuadrado: en su Premiere la forma la da
     * un Recorte redondeado con **Left 18 %, simétrico y sin tocar el alto**, que
     * de 1920×1080 deja 1229×1080. Se midió lo mismo en su monitor —1,13— así que
     * el número no sale de leerle el panel sino de dos lados que coinciden.
     *
     * Va como proporción y no como «recortá 18 % de los costados» porque son la
     * misma cosa solo mientras la cámara sea 16:9. Dicho así, una fuente con otro
     * formato da el mismo recuadro en vez de uno deformado.
     */
    proporcion: 0.64 * (16 / 9)
};

/**
 * Las dos formas de decir el recorte que puede llegar a entender Premiere.
 *
 * Premiere ESCRIBE `leftcrop`/`topcrop`/… adentro del propio Basic Motion —así
 * salió del export del editor— y por eso es la de fábrica: lo que él escribe es
 * lo que sabe leer. Pero su importador de FCP XML conoce además los nombres
 * canónicos del formato (`left`/`right`/`top`/`bottom` en un filtro `crop`
 * aparte), que son los que Adobe documenta como traducidos al importar. Cuál de
 * las dos gana no se puede saber sin importar, así que se deja elegir y el XML de
 * prueba lleva las dos (ver tools/probar-recuadro.js).
 */
const RECORTE_EN_BASIC = 'recorte-en-basic';
const RECORTE_APARTE = 'recorte-aparte';

/** Seis decimales, que es la precisión con la que Premiere escribe los suyos. */
function redondear(n) {
    return Number(Number(n).toFixed(6));
}

/**
 * Píxeles del cuadro → las unidades en las que Basic Motion escribe un punto.
 *
 * **Esta cuenta se hace acá y en ningún otro lado.** Es el único número dudoso de
 * todo el encuadre, así que si el editor reporta que el recuadro llega corrido, se
 * corrige este divisor y queda corregido en todas partes.
 *
 * Va dividido por el ancho y el alto ENTEROS del cuadro, con el origen en el
 * centro. No sale de la documentación, que se contradice: la de Apple dice que
 * para el Center «son valores de escala en el rango −100 a 100», que no es ni el
 * orden de magnitud de lo que escribe Premiere. Sale de medir archivos que
 * escribió Premiere:
 *
 *   · En una secuencia de 3840×2160, dos clips traen `center` −0,0742188 /
 *     −0,409259 y −0,303906 / 0,127778. Multiplicados por 3840 y 2160 dan −285,
 *     −884, −1167 y 276: los cuatro son píxeles enteros. Dividiendo por la MITAD
 *     del cuadro darían −142,5 y −583,5, y esas no son posiciones que se puedan
 *     tipear en el panel.
 *   · Y por el otro lado: un anclaje llevado a la esquina (0, 0) de una fuente de
 *     3200×1600 se escribió −0,5 / −0,5, o sea (0 − 1600)/3200 y (0 − 800)/1600.
 */
function aUnidadesDelCuadro(x, y, ancho, alto) {
    return {
        horiz: redondear((x - ancho / 2) / ancho),
        vert: redondear((y - alto / 2) / alto)
    };
}

/**
 * El encuadre del recuadro para un cuadro y una fuente dados.
 *
 * **Se calcula, no se copia**, y eso costó un error. El editor exportó desde su
 * Premiere un clip con el recuadro ya armado, y la tentación era copiar de ahí
 * los números: si Premiere lo escribió, Premiere lo lee. Pero su recuadro estaba
 * hecho con cuatro efectos y **Premiere solo traduce uno**: dejó dicho por
 * escrito, en el informe que guarda al lado del XML, que descartó Drop Shadow,
 * Rounded Crop y Transform. Lo que sobrevivió en Basic Motion no era su encuadre
 * sino el resto, y puesto en la línea de tiempo deja la caja por el MEDIO del
 * cuadro —centrada cerca de 1150 × 452— en vez de abajo a la derecha.
 *
 * Así que la posición sale de la geometría del reproductor, que es la que el
 * editor viene mirando, y la forma de su recorte, que sí se puede leer del panel
 * y además se midió en su monitor. Con eso lo que se previsualiza y lo que llega
 * son la misma cosa.
 *
 * La escala va contra la fuente ENTERA y no contra lo que queda del recorte:
 * para Premiere el clip sigue midiendo 1920×1080 aunque parte esté transparente.
 * Como no se recorta el alto, la escala es directamente cuánto del cuadro ocupa
 * el recuadro de alto.
 */
function encuadreDelRecuadro(medidas) {
    const m = medidas || {};
    const ancho = m.ancho || 1920;
    const alto = m.alto || 1080;
    // La fuente del recuadro es una de las cámaras, así que por defecto tiene el
    // mismo formato que la secuencia.
    const fuenteAncho = m.fuenteAncho || ancho;
    const fuenteAlto = m.fuenteAlto || alto;

    // Qué pedazo de la fuente sobrevive al recorte. Se saca del lado que sobra
    // para llegar a la proporción pedida: de una cámara más ancha que el recuadro
    // se sacan los costados, y de una más angosta, arriba y abajo. Siempre por
    // igual de los dos lados, porque el recorte de Premiere no reencuadra —solo
    // vuelve transparente lo que saca— y mientras sea simétrico el centro de lo
    // que se ve sigue siendo el centro del clip. Desparejo correría el recuadro.
    const sobraAncho = fuenteAncho / fuenteAlto > RECUADRO.proporcion;
    const visibleAncho = sobraAncho ? fuenteAlto * RECUADRO.proporcion : fuenteAncho;
    const visibleAlto = sobraAncho ? fuenteAlto : fuenteAncho / RECUADRO.proporcion;

    // Lo que se ve tiene que medir de alto lo que dice la regla del reproductor,
    // y la escala va contra la fuente ENTERA: para Premiere el clip sigue midiendo
    // lo que medía aunque parte esté transparente.
    const escala = RECUADRO.alto * alto / visibleAlto;
    const enPantallaAncho = visibleAncho * escala;
    const enPantallaAlto = RECUADRO.alto * alto;

    return {
        // Cuál de los dos dialectos del recorte se escribe. Por defecto, el que
        // Premiere se escribe a sí mismo.
        dialectoDelRecorte: m.dialectoDelRecorte || RECORTE_EN_BASIC,
        escala: redondear(100 * escala),
        // El centro de lo que se ve, pegado abajo a la derecha.
        centro: aUnidadesDelCuadro(
            ancho - RECUADRO.derecha * ancho - enPantallaAncho / 2,
            alto - RECUADRO.abajo * alto - enPantallaAlto / 2,
            ancho, alto),
        // El anclaje se queda en el centro de la fuente, que es su valor de
        // fábrica: moverlo obliga a compensar la posición, y son dos números para
        // decir uno solo.
        anclaje: { horiz: 0, vert: 0 },
        recorte: {
            izq: redondear(100 * (fuenteAncho - visibleAncho) / 2 / fuenteAncho),
            der: redondear(100 * (fuenteAncho - visibleAncho) / 2 / fuenteAncho),
            arriba: redondear(100 * (fuenteAlto - visibleAlto) / 2 / fuenteAlto),
            abajo: redondear(100 * (fuenteAlto - visibleAlto) / 2 / fuenteAlto)
        }
    };
}

/**
 * Un parámetro de Basic Motion, escrito como lo escribe Premiere.
 *
 * Los `valuemin`/`valuemax` no son adorno: van en el archivo que exporta Premiere
 * y se copian tal cual, porque lo que se importa bien es lo que él mismo escribe.
 */
function paramXml(id, name, value, min, max) {
    const rango = min == null ? ''
        : `<valuemin>${min}</valuemin><valuemax>${max}</valuemax>`;
    return '<parameter authoringApp="PremierePro">' +
        `<parameterid>${id}</parameterid><name>${name}</name>${rango}` +
        `<value>${value}</value></parameter>`;
}

function puntoXml(id, name, punto) {
    return '<parameter authoringApp="PremierePro">' +
        `<parameterid>${id}</parameterid><name>${name}</name>` +
        `<value><horiz>${punto.horiz}</horiz><vert>${punto.vert}</vert></value>` +
        '</parameter>';
}

/** Un parámetro del filtro `crop`, en el dialecto del formato y no de Premiere. */
function paramDeCropXml(id, value) {
    return '<parameter>' +
        `<parameterid>${id}</parameterid><name>${id}</name>` +
        `<valuemin>0</valuemin><valuemax>100</valuemax><value>${value}</value>` +
        '</parameter>';
}

/**
 * El encuadre de un clip: escala, posición y recorte, en filtros de `<clipitem>`.
 *
 * Basic Motion es lo único que se sabe que sobrevive el viaje, y no es una
 * suposición: el editor armó el recuadro a mano en Premiere con Recorte
 * redondeado, Sombra paralela y Transform, exportó a FCP7 XML, y Premiere dejó su
 * propio registro de lo que descartó —«Effect <Drop Shadow> … not translated», y
 * lo mismo con los otros dos—. En el XML quedó un solo `<filter>`: el de Basic
 * Motion.
 *
 * De ahí que el recuadro llegue con la forma, el tamaño y el lugar puestos, pero
 * con las **esquinas rectas y sin sombra**: para eso no hay parámetro en el
 * formato. Se aplican a mano en un bloque y se copian a los demás con pegar
 * atributos.
 */
function encuadreXml(encuadre) {
    if (!encuadre) return '';
    const aparte = encuadre.dialectoDelRecorte === RECORTE_APARTE;
    // En el dialecto de afuera los recortes de Basic Motion van en cero: si se
    // escribieran los dos, y Premiere entendiera los dos, recortaría dos veces.
    const enBasic = aparte
        ? { izq: 0, der: 0, arriba: 0, abajo: 0 }
        : encuadre.recorte;

    const basic = '<filter><effect>' +
        '<name>Basic Motion</name><effectid>basic</effectid>' +
        '<effectcategory>motion</effectcategory><effecttype>motion</effecttype>' +
        '<mediatype>video</mediatype><pproBypass>false</pproBypass>' +
        paramXml('scale', 'Scale', encuadre.escala, 0, 1000) +
        paramXml('rotation', 'Rotation', 0, -8640, 8640) +
        puntoXml('center', 'Center', encuadre.centro) +
        puntoXml('centerOffset', 'Anchor Point', encuadre.anclaje) +
        paramXml('antiflicker', 'Anti-flicker Filter', 0, '0.0', '1.0') +
        paramXml('leftcrop', 'Left', enBasic.izq, '0.0', '100.0') +
        paramXml('topcrop', 'Top', enBasic.arriba, '0.0', '100.0') +
        paramXml('rightcrop', 'Right', enBasic.der, '0.0', '100.0') +
        paramXml('bottomcrop', 'Bottom', enBasic.abajo, '0.0', '100.0') +
        '</effect></filter>';

    if (!aparte) return basic;

    return basic + '<filter><effect>' +
        '<name>Crop</name><effectid>crop</effectid>' +
        '<effectcategory>motion</effectcategory><effecttype>filter</effecttype>' +
        '<mediatype>video</mediatype>' +
        paramDeCropXml('left', encuadre.recorte.izq) +
        paramDeCropXml('right', encuadre.recorte.der) +
        paramDeCropXml('top', encuadre.recorte.arriba) +
        paramDeCropXml('bottom', encuadre.recorte.abajo) +
        '</effect></filter>';
}

function clipItemXml(params) {
    const { id, registry, source, startFrame, endFrame, inFrame, outFrame, enabled, fps, kind } = params;
    const entry = registry.register(source);
    const sourceDuration = toFrames(source.durationSec, fps);
    const fileXml = registry.fileXml(source);
    const sourceTrack = kind === 'audio'
        ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>'
        : '';
    // La etiqueta de color, para distinguir de un vistazo qué fuente es cada clip
    // en una secuencia con los dieciséis trozos de la clase.
    const label = source.label
        ? `<labels><label2>${xmlSafe(source.label)}</label2></labels>`
        : '';

    // El filtro va después del `<file>`, que es donde lo pone Premiere en el
    // archivo que exporta él mismo.
    return `        <clipitem id="${id}" frameBlend="FALSE">` +
        `<masterclipid>${entry.masterclip}</masterclipid>` +
        `<name>${xmlSafe(source.name || '')}</name>` +
        `<enabled>${enabled === false ? 'FALSE' : 'TRUE'}</enabled>` +
        `<duration>${sourceDuration}</duration>${rateXml(fps)}` +
        `<start>${startFrame}</start><end>${endFrame}</end>` +
        `<in>${inFrame}</in><out>${outFrame}</out>` +
        `${label}${fileXml}${encuadreXml(params.encuadre)}${sourceTrack}</clipitem>\n`;
}

/**
 * El color de un marcador, venga como nombre o como el entero de Premiere.
 *
 * `pproColor` es ARGB empaquetado: el `4281740498` que el Rodecaster le pone a
 * los marcadores PV es RGB(54, 44, 210). Se pasa a componentes de 16 bits (x257)
 * y el color llega idéntico al que eligió el director de contenido.
 */
/**
 * El color vino como el entero nativo de Premiere y no como nombre.
 *
 * Lo deciden dos sitios —los componentes RGB y el `pproColor`— y tienen que
 * decidir lo mismo: si discrepan se escribe un entero que no coincide con el RGB
 * de al lado, y Premiere y Resolve muestran colores distintos para el mismo
 * marcador. Que es exactamente lo que esto vino a evitar.
 */
function esEnteroDePremiere(color) {
    return typeof color === 'number' && isFinite(color);
}

function colorComponents(color) {
    if (esEnteroDePremiere(color)) {
        const red = (color >>> 16) & 255;
        const green = (color >>> 8) & 255;
        const blue = color & 255;
        return { alpha: 0, red: red * 257, green: green * 257, blue: blue * 257 };
    }
    return MARKER_COLORS[String(color || 'white').toLowerCase()] || MARKER_COLORS.white;
}

function markerXml(marker, fps) {
    const color = colorComponents(marker.color);
    const inFrame = toFrames(marker.startSec, fps);
    // Un marcador con duración lleva su `out`; los de punto usan -1, que es como
    // el formato dice "sin duración".
    const outFrame = marker.endSec != null && marker.endSec > marker.startSec
        ? toFrames(marker.endSec, fps)
        : -1;

    // El color va DOS veces, y no es redundancia:
    //
    // `pproColor` es el entero nativo de Premiere y es el mismo que trae el XML
    // del Rodecaster, así que el marcador vuelve con exactamente el color que le
    // puso el director de contenido. Sin él, Premiere lee los componentes RGB y
    // los ajusta al más parecido de su paleta indexada: el color cambia sin que
    // nadie lo haya pedido.
    //
    // `color` es el que entiende todo lo demás, Resolve incluido, que de
    // `pproColor` no sabe nada.
    const ppro = esEnteroDePremiere(marker.color)
        ? `<pproColor>${marker.color}</pproColor>`
        : '';

    return `    <marker><comment>${xmlSafe(marker.comment || '')}</comment>` +
        `<name>${xmlSafe(marker.name || '')}</name>` +
        `<in>${inFrame}</in><out>${outFrame}</out>${ppro}` +
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
        encuadre: clip.encuadre,
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
    markerXml,
    encuadreDelRecuadro,
    encuadreXml,
    aUnidadesDelCuadro,
    RECUADRO,
    RECORTE_EN_BASIC,
    RECORTE_APARTE,
    toFrames,
    framesToSeconds,
    rateFor,
    pathUrl,
    xmlSafe,
    colorComponents,
    MARKER_COLORS,
    CLIP_LABELS,
    FileRegistry
};
