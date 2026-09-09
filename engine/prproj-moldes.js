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
 * Donde para el clonado de un corte ANIDADO, que es uno cuya fuente no es un
 * archivo sino otra secuencia.
 *
 * **Un corte anidado y uno de archivo son el mismo objeto.** Se midió: en un
 * proyecto del editor, el cierre de los dos da exactamente las mismas cuatro
 * clases de video (`VideoClipTrackItem`, `VideoComponentChain`, `SubClip`,
 * `VideoClip`) y las mismas seis de audio. Lo único que cambia es a dónde apunta
 * el `<Source>` del clip: a un `VideoMediaSource` en uno y a un
 * `VideoSequenceSource` en el otro. Por eso no hace falta un molde aparte para
 * anidar: alcanza con clonar el corte de siempre y repuntarle la fuente.
 *
 * Lo que sí hace falta es esta frontera, y por lo mismo que la otra: sin parar en
 * la fuente, clonar un corte anidado se llevaría puesta la secuencia entera que
 * hay del otro lado, con sus pistas y todos sus clips.
 */
const FRONTERA_DEL_ANIDADO = FRONTERA_DEL_CORTE.concat([
    'VideoSequenceSource', 'AudioSequenceSource'
]);

/** Cómo se llama en el formato el efecto de movimiento que trae todo clip. */
const MOVIMIENTO = 'AE.ADBE Motion';

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
 * donde el color va DOS veces: el nombre y el entero cacheado al lado. Son BGR
 * igual que `pproColor` (ver `componentesDePremiere` en `fcp-xml.js`): 14597935
 * es 0xDEBF2F, que leído al revés da RGB(47,191,222), un celeste; 10776567 es
 * 0xA46FF7, que da RGB(247,111,164), un rosa.
 *
 * **Los cinco que están salieron de barrer los proyectos del editor buscando el
 * nombre y el entero pegados**, que es como Premiere los escribe siempre juntos.
 * Los tres que faltan no aparecen en ninguno: nadie usó todavía un clip de ese
 * color, así que no hay de dónde leerlos. Se dejan sin `entero` a propósito y
 * `pintarCorte` no pinta lo que no puede pintar entero: un corte con el nombre
 * puesto y el número inventado se vería de un color en el panel y de otro en la
 * línea de tiempo, que es peor que quedarse gris porque parece que alguien lo
 * cambió a mano.
 */
const ETIQUETAS = {
    Violet: { indice: 0 },
    Iris: { indice: 1, entero: 13408882 },
    Caribbean: { indice: 2, entero: 10016297 },
    Lavender: { indice: 3 },
    Cerulean: { indice: 4, entero: 14597935 },
    Forest: { indice: 5, entero: 5814353 },
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
        efectoDeMovimiento: buscarMovimiento(p),
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
        corteVideo: 'un corte de video en alguna línea de tiempo',
        // Los dos tipos de audio, y los dos hacen falta: cada clase trae WAV de
        // los dos —las dos COMBO son mono y las otras ocho estéreo— así que una
        // plantilla a la que le falte uno alcanza para empezar y se cae a mitad
        // de camino. Es el caso del proyecto que el editor armó importando los
        // XML viejos: ahí Premiere metió TODO en mono, porque el XML pedía un
        // canal por clip, así que no tiene ni un estéreo del que copiar. Que se
        // sepa antes de tocar nada, y con qué hacer.
        corteMono: 'un corte de audio MONO en alguna línea de tiempo',
        corteEstereo: 'un corte de audio ESTÉREO en alguna línea de tiempo'
    };
    return Object.keys(imprescindibles)
        .filter(n => !moldes[n])
        .map(n => imprescindibles[n]);
}


/**
 * Una cadena de componentes con el movimiento tocado, para copiarle el recuadro.
 *
 * Se busca la CADENA y no el componente suelto porque la cadena lleva además
 * `DefaultOpacity` y `DefaultOpacityComponentID`, que Premiere escribe junto con
 * el efecto; clonar el componente solo y colgarlo de una cadena vacía sería armar
 * a mano una forma que Premiere nunca escribe.
 *
 * **Un clip sin efectos no sirve de molde, y eso no es evidente.** La tentación
 * es pensar que todo clip tiene Movimiento porque el panel de Premiere siempre lo
 * muestra: es un efecto «intrínseco», está en la interfaz aunque nadie lo haya
 * tocado. Pero en el archivo no está — se midió, y en un proyecto sin efectos las
 * siete cadenas de video están vacías. Recién cuando alguien mueve la escala o la
 * posición, Premiere escribe el componente con sus once parámetros.
 *
 * Por eso esto puede volver `null` sin que sea un error: la mayoría de las
 * plantillas no tienen ninguno. Quien lo necesita avisa (ver `armarLosNidos`).
 */
function buscarMovimiento(proyecto) {
    const p = proyecto;
    for (const cadena of p.porClase('VideoComponentChain')) {
        if (!/ObjectRef/.test(p.contenido(cadena))) continue;
        const piezas = p.cierre([cadena], {});
        const componente = piezas.find(k => p.clase(k) === 'VideoFilterComponent'
            && p.contenido(k).includes(`<MatchName>${MOVIMIENTO}</MatchName>`));
        if (!componente) continue;
        // Los once parámetros: posición, escala, rotación, anclaje, los cuatro
        // recortes. Uno con menos es de otra versión y le faltaría justo el que
        // se va a escribir, sin que nada se queje.
        const cuantos = (p.contenido(componente).match(/<Param Index="\d+"/g) || []).length;
        if (cuantos >= 11) return cadena;
    }
    return null;
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
    MOVIMIENTO,
    FRONTERA_DEL_CORTE,
    FRONTERA_DEL_ANIDADO,
    FRONTERA_DEL_MEDIO,
    ETIQUETAS,
    COLOR_DE,
    detectarMoldes,
    loQueFalta,
    elegir,
    canalesDeclarados,
    mayorIdDePanel
};
