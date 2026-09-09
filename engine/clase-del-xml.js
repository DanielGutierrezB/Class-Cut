'use strict';
/**
 * clase-del-xml.js — Lee de vuelta los XML que escribe Class Cut.
 *
 * La app escribe dos clases de XML y este módulo entiende las dos, devolviendo
 * el mismo modelo para que quien lo use no tenga que preguntar de cuál vino:
 *
 *   - los **cortados**, que salen de procesar una clase en «Clases» y caen en
 *     `<raíz>/The Cutter/<secuencia>.xml` (`workspace.finalXml`). Traen los
 *     clips con sus rutas, los cortes con sus tiempos, las pistas, los colores
 *     de etiqueta y los marcadores. Es el caso rico.
 *   - los de **notas en vivo**, de la pestaña «Grabar», en `<carpeta>/xml/`
 *     (`workspace.notasArchivos`). Son una secuencia vacía con marcadores: no
 *     hay material ni cortes. Es el caso pobre, y se nota en el modelo — `pistas`
 *     viene vacío.
 *
 * **Por qué leer el XML y no los JSON del pipeline.** Los intermedios de
 * `The Cutter/Backup/` (`cutplan.json`, `align.json`) y los sidecar de
 * `xml/Datos/` son la fuente de la que sale el XML, y el argumento a favor de
 * ellos es que son datos y no un artefacto derivado. Se eligió igual el XML por
 * tres razones que pesan más:
 *
 * 1. **Es lo único que los dos flujos tienen en común.** El sidecar existe solo
 *    para notas en vivo y el `cutplan` solo para el corte; leer las fuentes
 *    obligaría a dos lectores distintos y a mantener el acuerdo entre los dos.
 * 2. **Garantiza que el `.prproj` y el XML digan lo mismo.** Son dos entregas de
 *    un mismo botón, y si el editor importa las dos y no coinciden, la app
 *    perdió toda su credibilidad de una sola vez. Leyendo el XML eso no puede
 *    pasar por construcción.
 * 3. **El XML ya trae medido lo que no se puede suponer.** El recuento de
 *    canales de cada archivo está en `<channelcount>`, y lo puso ffprobe
 *    cuando se generó el XML (`canalesDe` en `fcp-xml.js`). Volver a los JSON
 *    obligaría a volver a medir con ffprobe, que es lento y puede dar otra cosa
 *    si el archivo se movió.
 *
 * El costo de la decisión es que un XML mal escrito se propaga al `.prproj`. Se
 * paga avisando: lo que no cuadra viaja en `avisos` y no se inventa.
 */

const fs = require('fs');
const path = require('path');

const fcp = require('./fcp-xml');
const { decodeEntities } = require('./rodecaster-xml');

/** La firma que deja la toma de notas en vivo (ver `FIRMA` en `notas-xml.js`). */
const FIRMA_EN_VIVO = /class-cut:\s*notas-en-vivo/i;


// ─── Migas de XML ────────────────────────────────────────────────────

function valor(bloque, etiqueta) {
    const m = new RegExp(`<${etiqueta}>([\\s\\S]*?)</${etiqueta}>`).exec(bloque);
    return m ? decodeEntities(m[1]) : null;
}

function numero(bloque, etiqueta) {
    const v = valor(bloque, etiqueta);
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

/**
 * `file://localhost/…` de vuelta a una ruta absoluta.
 *
 * Es la inversa exacta de `pathUrl` en `fcp-xml.js`: allá cada segmento se
 * escapa con `encodeURIComponent`, así que acá cada segmento se desescapa. Sin
 * esto, "Clase 04 - Default" vuelve con los `%20` puestos y el clip queda
 * apuntando a un archivo que no existe.
 */
function rutaDeUrl(url) {
    const limpia = String(url || '').replace(/^file:\/\/(localhost)?/, '');
    return limpia.split('/').map(seg => {
        try { return decodeURIComponent(seg); } catch (e) { return seg; }
    }).join('/');
}

/**
 * Los cuadros por segundo nominales de un bloque `<rate>`.
 *
 * Se devuelve el nominal (29,97 y no 30) porque es lo que espera `rateFor` de
 * `fcp-xml.js`, y de ahí sale la fracción exacta. Convertir cuadros a segundos
 * con el entero redondeado separa un marcador de su clip un cuadro cada pocos
 * minutos, que en una clase de una hora ya se ve.
 */
function fpsDe(bloque) {
    const timebase = numero(bloque, 'timebase') || 30;
    return /<ntsc>\s*TRUE\s*<\/ntsc>/i.test(bloque || '') ? (timebase * 1000) / 1001 : timebase;
}

/** Cada `<track …> … </track>` de un bloque. Las pistas no se anidan. */
function pistasDe(bloque) {
    return [...String(bloque || '').matchAll(/<track\b[^>]*>([\s\S]*?)<\/track>/g)].map(m => m[1]);
}

function clipitemsDe(bloque) {
    return [...String(bloque || '').matchAll(/<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g)].map(m => m[1]);
}

/**
 * El contenido de una etiqueta, contando la profundidad para cerrar en la que
 * corresponde.
 *
 * **Buscar el primer `</video>` no sirve, y esto es el porqué.** El formato
 * permite definir un archivo adentro del primer clip que lo usa, y la definición
 * de un archivo de video trae su propio `<media><video>`. Si eso pasa, el
 * primer `</video>` es el de la definición y no el de la pista: el bloque queda
 * cortado a la mitad y la secuencia pierde pistas **sin decir nada**. Hoy
 * `export.js` define todos los archivos antes de la `<sequence>` y no ocurre,
 * pero es un detalle de cómo escribe, no una garantía del formato, y un fallo
 * silencioso no es algo que convenga dejar dependiendo de eso.
 */
function bloqueDe(texto, etiqueta, desde) {
    const re = new RegExp(`<(/)?${etiqueta}(?:\\s[^>]*)?>`, 'g');
    re.lastIndex = desde || 0;
    let profundidad = 0;
    let ini = -1;
    let m;
    while ((m = re.exec(texto)) !== null) {
        if (m[1]) {
            profundidad--;
            if (profundidad === 0) return { texto: texto.slice(ini, m.index), fin: re.lastIndex };
        } else {
            if (profundidad === 0) ini = m.index + m[0].length;
            profundidad++;
        }
    }
    return { texto: '', fin: desde || 0 };
}

/**
 * El cuerpo de la `<sequence>` y, adentro, sus bloques de video y de audio.
 *
 * Hay que recortar con cuidado: los clips maestros del bin también traen
 * `<media><video><track>` adentro, y buscar `<track>` en el archivo entero
 * devolvería las pistas del bin mezcladas con las de la secuencia. Todo lo de
 * acá se busca a partir del `<media>` de la secuencia y no antes.
 */
function cuerpoDeLaSecuencia(texto) {
    const abre = texto.search(/<sequence\b/);
    if (abre === -1) return null;
    const cuerpo = texto.slice(abre);
    const media = cuerpo.indexOf('<media>');
    if (media === -1) return { cuerpo, video: '', audio: '' };
    // El audio se busca DESPUÉS de donde cerró el video, no desde el `<media>`:
    // la definición de un archivo de audio trae su propio `<audio>` con el
    // recuento de canales, y si cayera adentro del bloque de video, buscar desde
    // el principio daría esa en vez de la lista de pistas.
    const video = bloqueDe(cuerpo, 'video', media);
    return { cuerpo, video: video.texto, audio: bloqueDe(cuerpo, 'audio', video.fin).texto };
}


// ─── El modelo de una clase ──────────────────────────────────────────

/**
 * Un XML generado → lo que hace falta para armarle una secuencia de Premiere.
 *
 * @param {string} texto el XML entero
 * @param {string} [rutaXml] de dónde salió, para los avisos
 * @returns {object} `{ok, nombre, fps, ancho, alto, duracionSeg, archivos, pistas,
 *   marcadores, deNotasEnVivo, conEfectos, avisos}` o `{ok:false, error}`
 */
function leerXml(texto, rutaXml) {
    const src = String(texto == null ? '' : texto);
    const avisos = [];
    const partes = cuerpoDeLaSecuencia(src);
    if (!partes) {
        return { ok: false, error: 'el archivo no tiene una <sequence>: no parece un XML de Class Cut' };
    }

    // El `<name>` de la secuencia es el primero del cuerpo. Adentro de `<media>`
    // hay otros —el codec se llama "h264"— así que se corta antes.
    const cabeza = partes.cuerpo.split('<media>')[0];
    const nombre = valor(cabeza, 'name');
    if (!nombre) return { ok: false, error: 'el XML no declara el nombre de la secuencia' };

    const fps = fpsDe(cabeza);
    const formato = (partes.cuerpo.match(/<samplecharacteristics>[\s\S]*?<\/samplecharacteristics>/) || [''])[0];
    const archivos = archivosDe(src, avisos, rutaXml);

    const pistasVideo = pistasDe(partes.video).map(p => cortesDe(p, archivos, fps, 'video', avisos));
    const pistasAudio = juntarCanales(pistasDe(partes.audio).map(p => cortesDe(p, archivos, fps, 'audio', avisos)));

    const marcadores = marcadoresDe(partes.cuerpo, fps);
    const conEfectos = pistasVideo.reduce((n, p) => n + p.cortes.filter(c => c.conEfecto).length, 0);

    const finales = [...pistasVideo, ...pistasAudio]
        .flatMap(p => p.cortes.map(c => c.hastaSeg));
    const nominal = numero(cabeza, 'duration');
    const duracionSeg = finales.length
        ? Math.max(...finales)
        : (nominal == null ? 0 : fcp.framesToSeconds(nominal, fps));

    return {
        ok: true,
        nombre,
        rutaXml: rutaXml || null,
        fps,
        ancho: numero(formato, 'width') || 1920,
        alto: numero(formato, 'height') || 1080,
        duracionSeg,
        archivos,
        pistas: { video: pistasVideo, audio: pistasAudio },
        marcadores,
        // Cambia el margen de la alineación en post y sirve para saber de qué
        // pestaña salió la clase (ver `deNotasEnVivo` en `rodecaster-xml.js`).
        deNotasEnVivo: FIRMA_EN_VIVO.test(src),
        // Cuántos cortes traen el recuadro puesto. No se aplica todavía; se
        // cuenta para poder decirlo en vez de que el editor lo descubra.
        conEfectos,
        avisos
    };
}

/**
 * Las definiciones `<file id="…">` del bin, que son donde vive todo lo que se
 * sabe de cada archivo.
 *
 * Se definen una sola vez y el resto del XML las referencia por id
 * (`FileRegistry` en `fcp-xml.js`), así que una sola pasada por el archivo
 * entero las junta todas. Las referencias vacías `<file id="file-1"/>` se
 * ignoran acá: no traen nada que no esté en la definición.
 */
function archivosDe(texto, avisos, rutaXml) {
    const salida = new Map();
    for (const m of texto.matchAll(/<file id="([^"]+)">([\s\S]*?)<\/file>/g)) {
        const [, id, cuerpo] = m;
        if (salida.has(id)) continue;
        const url = valor(cuerpo, 'pathurl');
        if (!url) {
            avisos.push(`${etiquetaDeAviso(rutaXml)}: el archivo ${id} no declara ruta y se saltea`);
            continue;
        }
        const ruta = rutaDeUrl(url);
        const fps = fpsDe(cuerpo);
        // `<channelcount>` es lo que midió ffprobe cuando se escribió el XML.
        // De los diez WAV del Rodecaster hay dos mono —los COMBO, que son
        // micrófonos— y ocho estéreo, y de acá sale esa distinción sin volver a
        // medir nada. Se topa en 2, igual que `canalesDe` en `fcp-xml.js`.
        const canales = numero(cuerpo, 'channelcount');
        salida.set(id, {
            id,
            ruta,
            nombre: valor(cuerpo, 'name') || path.basename(ruta),
            conVideo: /<video>/.test(cuerpo),
            canales: canales == null ? 2 : Math.min(2, Math.max(1, Math.round(canales))),
            duracionSeg: fcp.framesToSeconds(numero(cuerpo, 'duration') || 0, fps),
            existe: fs.existsSync(ruta)
        });
    }
    return salida;
}

/**
 * Los cortes de una pista, con el archivo de cada uno ya resuelto.
 *
 * El `<start>` se omite cuando vale cero en algunos escritores, así que se cae a
 * cero en vez de descartar el corte.
 */
function cortesDe(pista, archivos, fps, tipo, avisos) {
    const cortes = [];
    for (const cuerpo of clipitemsDe(pista)) {
        const idArchivo = (/<file id="([^"]+)"/.exec(cuerpo) || [])[1];
        const archivo = idArchivo ? archivos.get(idArchivo) : null;
        if (!archivo) {
            avisos.push(`un corte de ${tipo} nombra el archivo ${idArchivo || '(ninguno)'}, que no está definido: se saltea`);
            continue;
        }
        const desde = numero(cuerpo, 'start');
        const hasta = numero(cuerpo, 'end');
        if (hasta == null) {
            avisos.push(`un corte de ${archivo.nombre} no dice dónde termina: se saltea`);
            continue;
        }
        const entrada = numero(cuerpo, 'in');
        cortes.push({
            archivo,
            desdeSeg: fcp.framesToSeconds(desde == null ? 0 : desde, fps),
            hastaSeg: fcp.framesToSeconds(hasta, fps),
            entradaSeg: fcp.framesToSeconds(entrada == null ? 0 : entrada, fps),
            // La etiqueta de color se LEE del XML en vez de recalcularse. La
            // regla —cerúleo a la primera fuente de video, rosa a la segunda—
            // vive en `CLIP_LABELS` de `fcp-xml.js` y la aplicó `export.js`
            // cuando escribió esto; volver a decidirla acá sería tener la
            // misma regla en dos sitios, esperando a que se separen.
            etiqueta: valor(cuerpo, 'label2'),
            sonando: !/<enabled>\s*FALSE\s*<\/enabled>/i.test(cuerpo),
            // El recuadro del profesor, que por ahora viaja sin aplicarse.
            conEfecto: /<filter>/.test(cuerpo),
            // Qué canal del origen pide este clip. Sirve para reconocer los
            // pares explotados de un estéreo (ver `juntarCanales`).
            canalDeOrigen: numero(cuerpo, 'trackindex') || 1
        });
    }
    return { cortes, archivos: [...new Set(cortes.map(c => c.archivo.id))] };
}

/**
 * Vuelve a juntar las pistas de audio que el XML tiene explotadas por canal.
 *
 * **Acá está la ganancia grande del `.prproj` y conviene entenderla.** En el XML
 * de intercambio una pista de audio lleva UN canal, así que un clip estéreo son
 * dos `clipitem` en dos pistas que el editor vuelve a juntar al importar (es lo
 * que arregló el commit 88327d4). En un `.prproj` no hace falta ese baile: el
 * estéreo se DECLARA, y un clip estéreo es un clip en una pista. Así que las
 * pistas explotadas se colapsan de vuelta antes de armar la secuencia, y el
 * defecto que el XML tuvo que rodear no puede volver a existir.
 *
 * Se juntan dos pistas solo si son CONSECUTIVAS, del mismo archivo, y con los
 * mismos cortes en los mismos tiempos. Las tres condiciones hacen falta: una
 * clase podría tener el mismo archivo en dos pistas a propósito —el molde del
 * editor tiene el Live-Mix dos veces— y juntarlas perdería cortes.
 */
function juntarCanales(pistas) {
    const salida = [];
    for (const pista of pistas) {
        const antes = salida[salida.length - 1];
        if (antes && mismoMaterial(antes, pista)) continue;
        salida.push(pista);
    }
    return salida;
}

function mismoMaterial(a, b) {
    if (a.archivos.length !== 1 || b.archivos.length !== 1) return false;
    if (a.archivos[0] !== b.archivos[0]) return false;
    if (a.cortes.length !== b.cortes.length) return false;
    return a.cortes.every((c, i) =>
        c.desdeSeg === b.cortes[i].desdeSeg && c.hastaSeg === b.cortes[i].hastaSeg
        && c.entradaSeg === b.cortes[i].entradaSeg);
}

/**
 * Los marcadores, tal cual, con su comentario y su entero de color.
 *
 * El entero es el punto: `pproColor` es el color nativo de Premiere y en el
 * `.prproj` viaja como número, sin pasar por los once nombres fijos a los que el
 * XML de intercambio lo degradaba. El comentario no se toca nunca — es de quien
 * escribió la nota.
 */
function marcadoresDe(cuerpo, fps) {
    const salida = [];
    for (const m of cuerpo.matchAll(/<marker>([\s\S]*?)<\/marker>/g)) {
        const b = m[1];
        const entra = numero(b, 'in');
        if (entra == null || entra < 0) continue;
        const sale = numero(b, 'out');
        salida.push({
            nombre: valor(b, 'name') || '',
            comentario: valor(b, 'comment') || '',
            desdeSeg: fcp.framesToSeconds(entra, fps),
            // Un `out` de -1 es como el formato dice "sin duración"
            // (`markerXml` en `fcp-xml.js`), y un marcador de punto arranca y
            // termina en el mismo cuadro.
            hastaSeg: fcp.framesToSeconds(sale == null || sale < entra ? entra : sale, fps),
            color: numero(b, 'pproColor')
        });
    }
    return salida;
}

function etiquetaDeAviso(rutaXml) {
    return rutaXml ? path.basename(rutaXml) : 'el XML';
}

function leerArchivo(rutaXml) {
    let texto;
    try {
        texto = fs.readFileSync(rutaXml, 'utf8');
    } catch (e) {
        return { ok: false, error: `no se pudo leer ${path.basename(rutaXml)}: ${e.message}` };
    }
    return leerXml(texto, rutaXml);
}

module.exports = {
    leerXml,
    leerArchivo,
    rutaDeUrl,
    fpsDe,
    juntarCanales,
    marcadoresDe,
    archivosDe
};
