'use strict';
/**
 * notas-xml.js — Las notas de rodaje, escritas como las lee Premiere.
 *
 * Del otro lado de la pared está `notas-vivo.js`, que decide qué es una toma
 * escuchando al profesor. Acá no se decide nada de eso: se toma ese estado y se
 * lo convierte en el archivo que el resto de la app ya sabe leer. Están
 * separados porque cambian por motivos distintos —uno cuando el profesor cambia
 * cómo abre una toma, el otro cuando cambia el formato— y porque conviene que
 * las convenciones del formato estén todas juntas y en un solo sitio.
 *
 * **Dos relojes, y acá se cruzan.** El estado lleva la HORA DEL DÍA de todo, que
 * es lo que permite parar de escuchar y seguir sin que nada se corra. El XML va
 * en CUADROS desde el cero, que es el momento de "Iniciar grabación" — el mismo
 * botón con el que se pone a grabar el Rodecaster. Esta es la única traducción
 * entre los dos, y por eso también se escribe el sidecar: ahí queda la hora del
 * día de cada palabra, que es lo que deja depurar una duda de sincronía con
 * números en vez de con memoria.
 *
 * No se usa el cero en la claqueta aunque sea la referencia física, y el motivo
 * está medido del otro lado: `align.js` corrige el desfase de la clase comparando
 * la claqueta del XML con la que oye en el Live-Mix, y si el cero fuera la
 * claqueta, el desfase sería "cuánto tardó el profesor en aplaudir" —entre siete
 * y veinte segundos en el curso, y puede ser más—. Con el cero en el botón, el
 * desfase es la demora entre apretar dos botones.
 */

const vivo = require('./notas-vivo');
const { xmlSafe } = require('./fcp-xml');

/**
 * La secuencia que se declara: la de la herramienta del director de contenido.
 *
 * Son constantes y no datos de la sesión porque nadie las elige: el Rodecaster
 * graba a 30 cuadros y el XML del CD declara 1920×1080 siempre, y `align.js`
 * compara cuadros de los dos lados. Un XML de notas a otra tasa sería un XML de
 * otra herramienta.
 */
const FPS = 30;
const ANCHO = 1920;
const ALTO = 1080;

/** Blanco, el de la claqueta y el de los comentarios sobre el texto. */
const BLANCO = 4294967295;

/** Cuánto dura el marcador de entrada, que es lo que lo distingue del de salida. */
const CUADROS_DEL_MARCADOR_IN = 300;

/**
 * La firma que dice de dónde salió este XML.
 *
 * Va como comentario y no como etiqueta para no inventar nada en un formato que
 * no es nuestro: Premiere y Resolve la ignoran, y el parser la lee. Sirve para
 * una cosa concreta en post — el desfase de una clase con notas en vivo es la
 * demora entre apretar dos botones y viene bien medido, así que `align.js` le da
 * más margen antes de pedir confirmación (ver `MAX_OFFSET_EN_VIVO` allá).
 *
 * Y viaja con el archivo, que es el punto: si alguien copia el XML a la carpeta
 * de la clase, la firma va con él.
 */
const FIRMA = '<!-- class-cut: notas-en-vivo v1 -->';

/**
 * Hora del día → cuadro del XML.
 *
 * Se redondea y nunca baja de cero: una palabra dicha antes de apretar "Iniciar"
 * —la claqueta suele estar ahí— iría a un cuadro negativo, que el parser lee
 * como marcador sin posición y descarta.
 */
function aCuadros(paredMs, ceroMs, fps) {
    const seg = (Number(paredMs) - Number(ceroMs)) / 1000;
    return Math.max(0, Math.round(seg * (fps || FPS)));
}

/**
 * De qué color va el marcador de esta vista en Premiere.
 *
 * El del MARCADOR, que no es el que la vista tiene en la pantalla: una toma de
 * `R` se ve rosa mientras se graba y llega naranja a la secuencia, a propósito
 * (el por qué está en `VISTAS`, en `notas-vivo.js`). Acá se escribe el XML, así
 * que acá va el de Premiere.
 */
function colorDeVista(nombre) {
    const v = vivo.VISTAS.find(x => x.nombre === nombre);
    return v ? v.colorDeMarcador : vivo.VISTAS[0].colorDeMarcador;
}

/**
 * Los marcadores del XML, en orden y ya en cuadros.
 *
 * Van en pares y el par se decide POR DURACIÓN, no por el texto: el de entrada
 * dura 300 cuadros y el de salida no dura nada. Es lo que mira `rodecaster-xml`
 * para clasificarlos, y escribirlo al revés partiría cada bloque en dos.
 *
 * La claqueta son dos marcadores en el mismo cuadro y sin duración; por la regla
 * de duración los dos parecerían salidas, así que el parser la reconoce antes por
 * el texto del comentario. De ahí que diga "Clapperboard": es la palabra que
 * `CLAP_TEXT` busca.
 */
function marcadores(estado) {
    const cero = estado.ceroMs;
    if (cero == null) return [];
    const cuadro = ms => aCuadros(ms, cero, FPS);
    const salida = [];

    if (estado.claqueta && estado.claqueta.ms != null) {
        const f = cuadro(estado.claqueta.ms);
        salida.push({ nombre: 'K', comentario: ' - Clapperboard', in: f, out: f, color: BLANCO });
        salida.push({ nombre: 'K', comentario: 'OUT: Clapperboard', in: f, out: f, color: BLANCO });
    }

    for (const toma of vivo.tomasQueQuedan(estado)) {
        const vista = vivo.vistaLeida(toma.vista) || vivo.VISTA_POR_DEFECTO;
        const color = colorDeVista(vista);
        const entra = cuadro(toma.inMs);
        const sale = cuadro(toma.outMs);

        salida.push({
            nombre: vista,
            comentario: vivo.comentarioDeEntrada(toma),
            in: entra,
            out: entra + CUADROS_DEL_MARCADOR_IN,
            color
        });
        salida.push({
            nombre: vista,
            comentario: `OUT: ${vivo.cueDeSalida(toma)}`,
            in: sale,
            out: sale,
            color
        });

        // Los comentarios sobre un pedazo del texto, en blanco para distinguirlos
        // de los del CD, igual que en el visor de cortes.
        for (const c of toma.comentarios || []) {
            if (c.desdeMs == null) continue;
            const desde = cuadro(c.desdeMs);
            const hasta = c.hastaMs != null ? cuadro(c.hastaMs) : desde;
            salida.push({
                nombre: 'Nota',
                comentario: vivo.limpio(c.comentario),
                in: desde,
                out: Math.max(desde, hasta),
                color: BLANCO
            });
        }
    }

    salida.sort((a, b) => a.in - b.in);
    return salida;
}

/**
 * Hasta dónde llega la secuencia.
 *
 * El XML declara una duración y el parser no la usa, pero Premiere sí: una
 * secuencia más corta que su último marcador lo muestra fuera de la línea de
 * tiempo. Se toma el final de lo último que pasó, con un minuto de cola.
 */
function duracionEnCuadros(marcas) {
    const ultimo = marcas.length ? marcas[marcas.length - 1].out : 0;
    return ultimo + 60 * FPS;
}

/**
 * El XML de notas, con la forma que tiene el de la herramienta del CD.
 *
 * Se escribe acá y no con `fcp-xml.sequenceXml` por dos razones. Una: ese arma un
 * proyecto con bin y clips maestros, y un XML de notas no tiene material —es una
 * secuencia vacía con marcadores—. La otra es la que importa: `markerXml` escribe
 * `out` en -1 cuando el marcador no dura, y acá la salida tiene que llevar el
 * MISMO número que su `in`, que es lo que escribe la herramienta del CD. Las dos
 * formas las lee igual el parser, pero la que ya está probada contra Premiere y
 * Resolve es esta.
 *
 * Lo que sí se comparte es el escape (`xmlSafe`): además de los cinco signos,
 * quita los caracteres de control, que un comentario pegado desde otro lado
 * puede traer — y acá los comentarios los tipea o pega el editor.
 */
function xmlDeNotas(estado) {
    const marcas = marcadores(estado);
    const nombre = xmlSafe(estado.secuencia || 'notas');

    const cuerpo = marcas.map(m => [
        '    <marker>',
        `        <comment>${xmlSafe(m.comentario)}</comment>`,
        `        <name>${xmlSafe(m.nombre)}</name>`,
        `        <in>${m.in}</in>`,
        `        <out>${m.out}</out>`,
        `        <pproColor>${m.color}</pproColor>`,
        '    </marker>'
    ].join('\n')).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
${FIRMA}
<xmeml version="4">
<sequence id="sequence-1">
    <duration>${duracionEnCuadros(marcas)}</duration>
    <rate>
        <timebase>${FPS}</timebase>
        <ntsc>FALSE</ntsc>
    </rate>
    <name>${nombre}</name>
    <media>
        <video>
            <format>
                <samplecharacteristics>
                    <rate>
                        <timebase>${FPS}</timebase>
                        <ntsc>FALSE</ntsc>
                    </rate>
                    <width>${ANCHO}</width>
                    <height>${ALTO}</height>
                    <anamorphic>FALSE</anamorphic>
                    <pixelaspectratio>square</pixelaspectratio>
                    <fielddominance>none</fielddominance>
                </samplecharacteristics>
            </format>
        </video>
    </media>
${cuerpo}
</sequence>
</xmeml>
`;
}

/**
 * Lo que se guarda al lado del XML: la hora del día de todo.
 *
 * El XML lleva cuadros porque es lo que Premiere entiende, y los cuadros son
 * relativos al cero. Esto lleva la hora del día de cada palabra y de cada borde,
 * que es lo que hace imposible solapar dos tomas y lo que deja depurar cualquier
 * duda de sincronía con números en vez de con memoria.
 */
/** Una palabra como se guarda: la hora del día y lo que se dijo, nada más. */
function palabraDelArchivo(w) {
    return { t: w.t, texto: w.texto };
}

function sidecar(estado) {
    return {
        version: 1,
        secuencia: estado.secuencia || null,
        clase: estado.clase || null,
        parte: estado.parte || 1,
        curso: estado.curso || null,
        fps: FPS,
        ceroMs: estado.ceroMs || null,
        ceroISO: estado.ceroMs ? new Date(estado.ceroMs).toISOString() : null,
        claqueta: estado.claqueta || null,
        dispositivo: estado.dispositivo || null,
        // El temario del CD y la última cobertura medida. Va acá y no al XML
        // porque no es un marcador: Premiere no tiene dónde ponerlo, y lo que se
        // quiere es que la clase ya generada pueda decir contra qué se la midió.
        temario: estado.temario || null,
        sesiones: estado.sesiones || [],
        tomas: (estado.tomas || []).map(t => ({
            id: t.id,
            vista: t.vista,
            comentario: t.comentario || '',
            descartada: Boolean(t.descartada),
            cerradaSola: Boolean(t.cerradaSola),
            cuenta: t.cuenta || '',
            inMs: t.inMs,
            outMs: t.outMs,
            inISO: t.inMs ? new Date(t.inMs).toISOString() : null,
            outISO: t.outMs ? new Date(t.outMs).toISOString() : null,
            palabras: (t.palabras || []).map(palabraDelArchivo),
            // Cómo se habló en esta toma (`engine/lengua.js`). Va en la toma y no
            // en un resumen de la clase porque la toma se puede descartar, y el
            // agregado tiene que poder rehacerse sin volver a medir nada: lo que
            // cambia es cuáles cuentan, no lo que se midió de cada una.
            lengua: t.lengua || null,
            // Qué le pasó a la relectura de esta toma, cuando le pasó algo
            // (`engine/insistir.js`). Va al sidecar y no solo a la pantalla porque
            // es justamente el dato que se necesita DESPUÉS: la toma que quedó
            // leída con un modelo peor —o sin releer— es la que alguien va a
            // querer regenerar con calma, y viviendo solo en memoria se perdería
            // al cerrar la app, que es cuando termina un día de rodaje.
            relectura: t.relectura || null,
            // Cómo pega con la toma anterior (`engine/empalme.js`). De acá se
            // guarda lo poco que no se puede rehacer leyendo: lo que contestó el
            // modelo, que se pagó, y que el editor descartó el ajuste. La
            // sugerencia misma no se guarda —se rehace cada vez que se mira—
            // porque el texto de una toma cambia cuando se la relee o se le mueve
            // un borde, y una sugerencia vieja señalaría una palabra que ya no está.
            empalme: t.empalme || null,
            // Lo que se dijo pegado a cada borde. Se guarda para que mover un IN o
            // un OUT en una clase ya grabada se siga haciendo mirando el texto, sin
            // tener que releer el audio para saber qué hay del otro lado.
            antes: (t.antes || []).map(palabraDelArchivo),
            despues: (t.despues || []).map(palabraDelArchivo),
            comentarios: t.comentarios || []
        }))
    };
}

/**
 * Un sidecar recién leído del disco, hablado como se habla hoy.
 *
 * La puerta de entrada del formato es una sola, igual que la de salida, y por el
 * mismo motivo: si cada quien tradujera por su cuenta, listar una clase y
 * editarla darían nombres de vista distintos para la misma toma. Hoy lo único
 * que hay que traducir son las vistas que se renombraron (ver `vistaLeida` en
 * `notas-vivo.js`); el día que cambie otra cosa del archivo, cambia acá.
 */
function estadoLeido(estado) {
    if (!estado) return estado;
    return {
        ...estado,
        tomas: (estado.tomas || []).map(t => ({ ...t, vista: vivo.vistaLeida(t.vista) }))
    };
}

module.exports = {
    FPS,
    BLANCO,
    FIRMA,
    CUADROS_DEL_MARCADOR_IN,
    aCuadros,
    colorDeVista,
    marcadores,
    xmlDeNotas,
    sidecar,
    estadoLeido
};
