'use strict';
/**
 * Las piezas de un proyecto de Premiere: cómo se llaman y cómo se reconocen.
 *
 * Acá vive el saber declarativo —qué GUID identifica una pista de video, qué
 * número de la paleta es el cerúleo, dónde termina un corte y empieza el medio
 * que usa— y la búsqueda que encuentra en un proyecto cualquiera un ejemplar de
 * cada cosa que después hay que clonar.
 *
 * **Está separado de `prproj-secuencia.js` porque son dos oficios distintos.**
 * Reconocer una pista de audio estéreo en un archivo ajeno es leer; agrandarla a
 * doce pistas es escribir. Lo primero cambia cuando Adobe cambia el formato; lo
 * segundo, cuando cambia lo que queremos hacer. Mezclarlos hacía un archivo de
 * mil doscientas líneas donde no se sabía cuál de las dos cosas se estaba
 * tocando.
 *
 * Casi todos los números de acá salieron de medir archivos reales: los de las
 * etiquetas, del proyecto que el editor armó a mano importando un curso; los
 * GUID de tipo de pista, de las secuencias de su plantilla.
 */

const prproj = require('./prproj');

const TIPO_VIDEO = '228cda18-3625-4d2d-951e-348879e4ed93';
const TIPO_AUDIO = '80b8e3d5-6dca-4195-aefb-cb5f407ab009';

/** Los `ClassID` de los dos objetos de marcador. También constantes por clase. */
const CLASE_MARKERS = 'bee50706-b524-416c-9f03-b596ce5f6866';
const CLASE_MARKER = 'a45508e0-3ff7-4d04-90a7-2e0dfff4c910';

/**
 * Las clases donde para el clonado de un corte, porque hay que REUSAR y no
 * copiar: el clip maestro, el medio y sus fuentes son del archivo del disco, y
 * copiarlos metería el mismo video doce veces en el panel de proyecto.
 */
const FRONTERA_DEL_CORTE = [
    'MasterClip', 'Markers', 'VideoMediaSource', 'AudioMediaSource', 'Media'
];

/**
 * Donde para el clonado de un medio.
 *
 * `TranscriptClip` está acá para que la transcripción NO viaje, y esa decisión
 * vale una explicación porque es la única poda del módulo. La transcripción de
 * un solo medio del molde pesa 328 KB de los 337 que pesa el medio entero: el
 * 97,6 %. Arrastrarla en un curso de trece clases con doce archivos cada una
 * daría cincuenta megas de XML de texto que nadie pidió.
 *
 * Y no es una poda arriesgada, que era la duda: **un medio sin transcripción es
 * una forma que Premiere escribe todo el tiempo.** En los autoguardados del
 * editor hay clips maestros con la lista `VideoClip,AudioClip` y nada más, que
 * es exactamente lo que queda acá. Un archivo recién importado no tiene
 * transcripción hasta que alguien le pasa el reconocimiento de voz.
 */
const FRONTERA_DEL_MEDIO = ['TranscriptClip'];

/**
 * La paleta de etiquetas de Premiere, con el índice de cada color.
 *
 * **Los ocho índices están medidos, no supuestos**, y salieron del proyecto que
 * el editor armó a mano importando el curso: ahí `1_CAMERA 1.mp4` quedó con el
 * índice 4 y `2_CAMERA 2.mp4` con el 6, que es exactamente lo que Class Cut les
 * pidió por el XML —cerúleo a la cámara del profesor, rosa al grabador de
 * pantalla—. Con esos dos anclados, el resto de la paleta cae en su orden y
 * cuadra con lo que el mismo archivo le puso solo a cada tipo de cosa: el 2 a
 * los WAV, el 5 a las secuencias y el 7 a los bins.
 *
 * **Ojo con no confundir esta tabla con `CLIP_LABELS` de `fcp-xml.js`**, que se
 * parece pero es otra cosa: aquella es el orden en que Class Cut reparte colores
 * entre las fuentes de video (la primera cerúlea, la segunda rosa) y no tiene
 * nada que ver con la posición en las preferencias de Premiere. Son dos listas
 * de nombres de color que significan cosas distintas, y mezclarlas pintaría todo
 * de un color cualquiera sin que nada se queje.
 *
 * El `entero` es la otra cara del dato y solo hace falta en la línea de tiempo,
 * donde el color va DOS veces: el nombre y el entero cacheado al lado. Están los
 * dos que se midieron; son BGR igual que `pproColor` (ver `componentesDePremiere`
 * en `fcp-xml.js`): 14597935 es 0xDEBF2F, que leído al revés da RGB(47,191,222),
 * un celeste; 10776567 es 0xA46FF7, que da RGB(247,111,164), un rosa. Los otros
 * seis no lo traen porque no los medí, y un corte con el nombre puesto y el
 * entero inventado se vería de un color en el panel y de otro en la línea.
 */
const ETIQUETAS = {
    Violet: { indice: 0 },
    Iris: { indice: 1 },
    Caribbean: { indice: 2 },
    Lavender: { indice: 3 },
    Cerulean: { indice: 4, entero: 14597935 },
    Forest: { indice: 5 },
    Rose: { indice: 6, entero: 10776567 },
    Mango: { indice: 7 }
};

/**
 * Los colores que el editor espera en cada tipo de cosa del panel de proyecto.
 *
 * Salen de contar los del proyecto armado a mano: 130 WAV en caribe, 13
 * secuencias en bosque y los 19 bins en mango. No los eligió a mano uno por uno
 * —son los que Premiere le pone solo a cada tipo— pero el generador tiene que
 * escribirlos igual: lo que se clona hereda el color del ejemplar del que salió,
 * que puede ser cualquiera.
 */
const COLOR_DE = {
    audio: 'Caribbean',
    secuencia: 'Forest',
    bin: 'Mango'
};

/**
 * Cuántos píxeles de ancho tiene la línea de tiempo del editor, para calcular el
 * zoom con el que abre una secuencia nueva.
 *
 * Se hereda el zoom del molde si no se toca, y el molde dura media hora: una
 * secuencia de cuarenta segundos abriría con los clips de veinte píxeles y
 * pareciendo vacía. El número sale de medir el molde: 2082 segundos a 1,9465
 * segundos por píxel son 1070 píxeles útiles.
 */
// ─── Encontrar los ejemplares del molde ──────────────────────────────

/**
 * Busca en el molde un ejemplar de cada cosa que hay que clonar.
 *
 * **Se busca por forma y no por nombre.** El molde sale del Premiere del editor
 * y sus secuencias se llaman como él quiso; atarse a "CAM" sería atarse a un
 * proyecto. Lo que sí es estable es la forma: una secuencia es la que tiene
 * menos pistas (la más barata de clonar y de agrandar), un corte de audio mono
 * es el que declara un canal, y así.
 *
 * **Lo que no aparece vuelve en `null` en vez de tirar.** Detectar no es
 * validar: qué moldes hacen falta depende de lo que se vaya a hacer, y un
 * proyecto con bins pero sin secuencias sirve perfectamente para armar bins. La
 * queja la pone cada operación cuando le falta el suyo, con el nombre de lo que
 * falta; quien quiera revisar todo antes de empezar tiene `loQueFalta`.
 */
function detectarMoldes(proyecto) {
    const p = proyecto;

    const secuencias = p.porClase('Sequence').map(k => {
        const esqueleto = p.cierre([k], { claseFrontera: ['VideoClipTrackItem', 'AudioClipTrackItem'] });
        return {
            k,
            video: esqueleto.filter(x => p.clase(x) === 'VideoClipTrack').length,
            audio: esqueleto.filter(x => p.clase(x) === 'AudioClipTrack').length
        };
    }).filter(s => s.video >= 1 && s.audio >= 1);
    secuencias.sort((a, b) => (a.video + a.audio) - (b.video + b.audio));
    const secuencia = secuencias.length ? secuencias[0].k : null;

    // El ítem del panel de esa secuencia: el `ClipProjectItem` que llega a ella
    // por las dos fuentes de secuencia. Se busca hacia abajo desde cada ítem, que
    // es más corto que buscar quién referencia a la secuencia.
    const itemDeSecuencia = secuencia
        ? p.porClase('ClipProjectItem').find(k => p.cierre([k], {}).includes(secuencia))
        : null;

    // Los cortes, clasificados por cuántos canales declara su clip de audio.
    const cortesAudio = p.porClase('AudioClipTrackItem').map(k => {
        const piezas = p.cierre([k], { claseFrontera: FRONTERA_DEL_CORTE });
        const clip = piezas.find(x => p.clase(x) === 'AudioClip');
        return { k, piezas: piezas.length, canales: canalesDeclarados(p, clip) };
    });
    // El corte más chico de cada tipo: el que no arrastra ni una secuencia
    // anidada ni una cadena de efectos que nadie pidió.
    const masChico = lista => lista.sort((a, b) => a.piezas - b.piezas)[0];
    const corteMono = masChico(cortesAudio.filter(c => c.canales === 1));
    const corteEstereo = masChico(cortesAudio.filter(c => c.canales === 2));

    const cortesVideo = p.porClase('VideoClipTrackItem').map(k => ({
        k,
        piezas: p.cierre([k], { claseFrontera: FRONTERA_DEL_CORTE }).length,
        // Un anidado apunta a una secuencia y no a un medio: no sirve de ejemplar
        // para un corte de archivo.
        anidado: p.cierre([k], { claseFrontera: FRONTERA_DEL_CORTE })
            .some(x => /SequenceSource$/.test(p.clase(x)))
    })).filter(c => !c.anidado);
    const corteVideo = masChico(cortesVideo);

    // Los medios, por si tienen video y por cuántos canales declaran.
    const medios = p.porClase('ClipProjectItem').map(k => {
        const piezas = p.cierre([k], { claseFrontera: FRONTERA_DEL_MEDIO });
        const medio = piezas.find(x => p.clase(x) === 'Media');
        return {
            k,
            piezas: piezas.length,
            esArchivo: Boolean(medio) && /<FilePath>\//.test(p.contenido(medio)),
            conVideo: piezas.some(x => p.clase(x) === 'VideoStream'),
            canales: canalesDeclarados(p, piezas.find(x => p.clase(x) === 'AudioClip'))
        };
    }).filter(m => m.esArchivo);

    return {
        secuencia,
        itemDeSecuencia,
        corteVideo: corteVideo ? corteVideo.k : null,
        corteMono: corteMono ? corteMono.k : null,
        corteEstereo: corteEstereo ? corteEstereo.k : null,
        medioVideo: elegir(medios, m => m.conVideo),
        medioMono: elegir(medios, m => !m.conVideo && m.canales === 1),
        medioEstereo: elegir(medios, m => !m.conVideo && m.canales === 2),
        bin: p.porClase('BinProjectItem')[0] || null,
        pistasDeLaSecuencia: secuencias.length
            ? { video: secuencias[0].video, audio: secuencias[0].audio }
            : { video: 0, audio: 0 }
    };
}

/**
 * Los moldes imprescindibles que un proyecto NO presta, para avisar temprano.
 *
 * Sirve para revisar antes de empezar y fallar con el nombre de lo que falta,
 * en vez de a mitad del armado y con el archivo a medio hacer. La lista es la de
 * lo que hace falta sí o sí para armar un curso; lo demás —el corte estéreo, por
 * ejemplo— se pide recién cuando aparece un archivo que lo necesita.
 */
function loQueFalta(moldes) {
    const imprescindibles = {
        secuencia: 'una secuencia con al menos una pista de video y una de audio',
        itemDeSecuencia: 'el ítem de panel de esa secuencia',
        bin: 'un bin',
        corteVideo: 'un corte de video en alguna línea de tiempo'
    };
    return Object.keys(imprescindibles)
        .filter(n => !moldes[n])
        .map(n => imprescindibles[n]);
}


function elegir(medios, cumple) {
    const encontrado = medios.filter(cumple).sort((a, b) => a.piezas - b.piezas)[0];
    return encontrado ? encontrado.k : null;
}

/**
 * Cuántos canales declara un clip de audio, leído de su disposición de canales.
 *
 * `[{"channellabel":0}]` es mono y `[{"channellabel":100},{"channellabel":101}]`
 * es el par izquierda/derecha. Se cuenta la disposición en vez de leer
 * `ChannelType` porque la disposición está en el propio clip, y `ChannelType`
 * vive en otro objeto.
 */
function canalesDeclarados(proyecto, clip) {
    if (!clip) return 0;
    const m = /<AudioChannelLayout>([^<]*)<\/AudioChannelLayout>/.exec(proyecto.contenido(clip));
    if (!m) return 0;
    return (m[1].match(/channellabel/g) || []).length;
}

/**
 * El `<ID>` más alto del panel de proyecto, que es un entero y no un GUID.
 *
 * Sube con cada cosa que el editor importa. Se mira solo adentro de los ítems del
 * panel: el `<ID>` de una pista también es un entero y no tiene nada que ver.
 */
function mayorIdDePanel(proyecto) {
    let mayor = 0;
    for (const clase of ['ClipProjectItem', 'BinProjectItem', 'RootProjectItem']) {
        for (const k of proyecto.porClase(clase)) {
            const m = /<ID>(\d+)<\/ID>/.exec(proyecto.contenido(k));
            if (m) mayor = Math.max(mayor, parseInt(m[1], 10));
        }
    }
    return mayor;
}
module.exports = {
    TIPO_VIDEO,
    CLASE_MARKERS,
    CLASE_MARKER,
    TIPO_AUDIO,
    FRONTERA_DEL_CORTE,
    FRONTERA_DEL_MEDIO,
    ETIQUETAS,
    COLOR_DE,
    detectarMoldes,
    loQueFalta,
    elegir,
    canalesDeclarados,
    mayorIdDePanel
};module.exports = {
    TIPO_VIDEO,
    TIPO_AUDIO,
    FRONTERA_DEL_CORTE,
    FRONTERA_DEL_MEDIO,
    ETIQUETAS,
    COLOR_DE,
    detectarMoldes,
    loQueFalta,
    elegir,
    canalesDeclarados,
    mayorIdDePanel
};
