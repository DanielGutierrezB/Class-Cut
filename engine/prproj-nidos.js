'use strict';
/**
 * prproj-nidos.js — Las anidaciones del curso: una sola cámara para las trece
 * clases, un solo grabador de pantalla, un solo audio.
 *
 * **Por qué existe.** Antes cada secuencia de clase apuntaba directo a los
 * archivos, así que un curso de trece clases dejaba dos mil cortes de cámara
 * sueltos. Cambiarles algo a todos —una corrección de color, un reencuadre, un
 * efecto— era ir corte por corte, y no hay manera de hacer eso trece veces sin
 * equivocarse. Con las anidaciones, los dos mil cortes son dos mil ventanas a la
 * MISMA línea de tiempo: se entra a `CAM`, se toca una vez, y cambió en todas.
 *
 * **Cómo se acomodan.** Las cámaras de las trece clases van una detrás de otra
 * en una sola línea de tiempo, sin cortar y con cinco minutos de aire entre
 * clase y clase. El aire no es decorativo: sin él, arrastrar el final de una
 * clase para recuperar dos segundos se comería el principio de la siguiente, y
 * en una anidación eso no se ve hasta que alguien mira el resultado.
 *
 * **Las cinco comparten el mismo mapa de franjas, y eso es lo que las hace
 * servir.** Si `CAM` y `SR` no arrancaran cada clase en el mismo segundo,
 * `SLIDE` no podría ser dos clips de punta a punta —habría que picarlo clase por
 * clase— y un corte tendría que calcular una entrada distinta para cada nido.
 * Con un solo mapa, un corte que en el XML entraba en el segundo 300 de la clase
 * seis entra en `franja(6) + 300` en cualquiera de las cinco.
 *
 * Las franjas se miden con la fuente MÁS LARGA de cada clase y no con la cámara:
 * el Live-Mix suele durar unas centésimas más que el video, y una franja cortada
 * a la medida del video dejaría el final del audio pisando el aire de la
 * siguiente. El aire está justamente para que eso no importe, pero una franja
 * que miente sobre lo que contiene es una cuenta que hay que volver a hacer.
 */

const fcp = require('./fcp-xml');

/**
 * Cuánto aire va entre una clase y la siguiente adentro de una anidación.
 *
 * Lo pidió el editor, y el número es suyo. Sirve para dos cosas: separar a
 * simple vista dónde termina una clase, y dejar lugar para estirar un clip sin
 * comerse el material de la de al lado.
 */
const AIRE_SEG = 5 * 60;

/** Cómo se llama cada anidación en el panel, y el bin que las junta. */
const NOMBRES = {
    raiz: 'Nidos',
    camara: 'CAM',
    pantalla: 'SR',
    audio: 'AUDIO',
    slide: 'SLIDE',
    mini: 'MINI'
};

/**
 * El color de cada anidación.
 *
 * Son los mismos que ya llevan los clips de cada pista —cerúleo la cámara, rosa
 * el grabador de pantalla, caribe el audio— para que el nido y lo que hay
 * adentro digan lo mismo. El editor los pidió así y ya los viene mirando en la
 * línea de tiempo.
 *
 * **Se pintan en dos lados y hacen falta los dos.** El color del corte manda en
 * la línea de tiempo; el del ítem del panel manda en el panel de proyecto Y es
 * el que hereda cualquier corte que se agregue después a mano. Pintando solo el
 * corte, `CAM` sigue siendo una secuencia verde más entre cincuenta y siete en
 * el panel, que es justo donde el editor la va a ir a buscar.
 *
 * `SLIDE` no está: es la pantalla apoyada sobre la cámara, o sea las dos cosas,
 * y no hay un color que diga eso. Se queda con el verde de secuencia.
 */
const ETIQUETA_DE_CAMARA = 'Cerulean';
const ETIQUETA_DE_PANTALLA = 'Rose';
const ETIQUETA_DE_AUDIO = 'Caribbean';


/**
 * Dónde cae cada clase adentro de las anidaciones.
 *
 * @param {object[]} clases lo que devolvió `leerArchivo`, en orden de clase
 * @returns {{franjas: Map<object, {desdeSeg, largoSeg}>, largoSeg: number}}
 */
function franjasDe(clases) {
    const franjas = new Map();
    let reloj = 0;
    for (const clase of clases) {
        const largoSeg = largoDe(clase);
        franjas.set(clase, { desdeSeg: reloj, largoSeg });
        reloj += largoSeg + AIRE_SEG;
    }
    // El aire de después de la última no cuenta: la anidación termina donde
    // termina el material, no cinco minutos más tarde en negro.
    return { franjas, largoSeg: Math.max(0, reloj - AIRE_SEG) };
}

/** Lo que dura la fuente más larga de una clase. */
function largoDe(clase) {
    let largo = 0;
    for (const [, archivo] of clase.archivos) {
        largo = Math.max(largo, archivo.duracionSeg || 0);
    }
    return largo;
}

/** El archivo que usa una pista, que es el mismo en todos sus cortes. */
function archivoDe(pista) {
    return pista && pista.cortes.length ? pista.cortes[0].archivo : null;
}

/**
 * La cámara del profesor y el grabador de pantalla de una clase.
 *
 * Salen de la POSICIÓN de la pista y no del nombre del archivo: `export.js`
 * escribe siempre la cámara en la uno y la pantalla en la dos, y el nombre lo
 * pone el aparato que grabó, que puede llamarlas como quiera. La tercera pista,
 * cuando está, es la cámara otra vez en chiquito; de ahí no sale nada porque es
 * la misma fuente que la primera.
 */
function fuentesDeVideo(clase) {
    return {
        camara: archivoDe(clase.pistas.video[0]),
        pantalla: archivoDe(clase.pistas.video[1])
    };
}

/**
 * La pista del Live-Mix, que es la mezcla que el aparato ya dejó lista.
 *
 * Se la reconoce por el ojo prendido y no por su posición ni por el nombre del
 * archivo: `course-scan` la deja última hoy, pero eso es un orden que puede
 * cambiar, y el nombre lo pone el Rodecaster. Lo que la define es que de las
 * diez es la única que se escucha, y eso lo decidió el corte y viaja en el XML.
 *
 * Devuelve `null` cuando hay más de una sonando o ninguna, que son los dos casos
 * en que no hay UNA mezcla: elegir igual sería señalar una pista cualquiera y
 * llamarla el respaldo del editor.
 */
function pistaDelLiveMix(clase) {
    const suenan = clase.pistas.audio.filter(p => p.cortes.some(c => c.sonando));
    return suenan.length === 1 ? suenan[0] : null;
}


/**
 * Arma las cinco anidaciones del curso y las deja colgadas del bin que se pida.
 *
 * El orden importa: `CAM` y `SR` se arman primero porque `SLIDE` y `MINI` las
 * usan de fuente. Es la única dependencia entre ellas.
 *
 * @param {object} taller
 * @param {object} pedido
 * @param {object[]} pedido.clases        las clases leídas, en orden
 * @param {Map} pedido.mediosPorClase     clase → (id de archivo → medio importado)
 * @param {string} pedido.bin             dónde colgar las cinco
 * @param {string[]} pedido.avisos
 * @returns {{franjas, largoSeg, camara, pantalla, audio, slide, mini, cortes}}
 */
function armarLosNidos(taller, pedido) {
    const { clases, mediosPorClase, bin, avisos } = pedido;
    const { franjas, largoSeg } = franjasDe(clases);
    let cortes = 0;

    const medioDe = (clase, archivo) => {
        if (!archivo) return null;
        const suyos = mediosPorClase.get(clase);
        return suyos ? suyos.get(archivo.id) || null : null;
    };

    // ── Las dos de imagen, que son una pista y un clip por clase ──
    const deImagen = (nombre, cual, etiqueta) => {
        const nido = taller.crearSecuencia({
            nombre, pistasVideo: 1, pistasAudio: 1, duracionSeg: largoSeg
        });
        taller.guardarEn(bin, nido.itemDelPanel);
        taller.pintarItemDelPanel(nido.itemDelPanel, etiqueta);
        for (const clase of clases) {
            const archivo = fuentesDeVideo(clase)[cual];
            const medio = medioDe(clase, archivo);
            if (!medio) continue;
            const franja = franjas.get(clase);
            taller.colocarCorte({
                pista: nido.pistasVideo[0],
                medio,
                desdeSeg: franja.desdeSeg,
                hastaSeg: franja.desdeSeg + (archivo.duracionSeg || franja.largoSeg),
                entradaSeg: 0,
                etiqueta
            });
            cortes++;
        }
        return nido;
    };

    const camara = deImagen(NOMBRES.camara, 'camara', ETIQUETA_DE_CAMARA);
    const pantalla = deImagen(NOMBRES.pantalla, 'pantalla', ETIQUETA_DE_PANTALLA);

    // ── El audio: una pista por canal del aparato ──
    //
    // Cuántas pistas es el máximo entre las clases y no el de la primera: una
    // clase grabada con un canal menos dejaría a las demás sin dónde poner el
    // suyo. La pista `i` es el mismo canal en todas porque `course-scan` los
    // ordena igual siempre y deja el Live-Mix último.
    const cuantosCanales = clases.reduce((n, c) => Math.max(n, c.pistas.audio.length), 0);
    const audio = taller.crearSecuencia({
        nombre: NOMBRES.audio,
        pistasVideo: 1,
        pistasAudio: Math.max(1, cuantosCanales),
        duracionSeg: largoSeg
    });
    taller.guardarEn(bin, audio.itemDelPanel);
    taller.pintarItemDelPanel(audio.itemDelPanel, ETIQUETA_DE_AUDIO);
    for (const clase of clases) {
        const franja = franjas.get(clase);
        clase.pistas.audio.forEach((pista, i) => {
            const archivo = archivoDe(pista);
            const medio = medioDe(clase, archivo);
            if (!medio || !audio.pistasAudio[i]) return;
            taller.colocarCorte({
                pista: audio.pistasAudio[i],
                medio,
                desdeSeg: franja.desdeSeg,
                hastaSeg: franja.desdeSeg + (archivo.duracionSeg || franja.largoSeg),
                entradaSeg: 0,
                // El ojo prendido de cada canal se hereda del XML, que ya decidió
                // que solo suene el Live-Mix. Decidirlo otra vez acá sería tener
                // la misma regla en dos sitios esperando a que se separen.
                sonando: pista.cortes.length ? pista.cortes[0].sonando : false
            });
            cortes++;
        });
    }

    // ── El slide: la pantalla encima de la cámara, sin componer ──
    //
    // Dos clips de punta a punta y nada más. No se le pone escala ni posición a
    // propósito: el editor quiere decidir él cómo se apoya la pantalla sobre el
    // profesor, y esto es el andamio para que lo haga una vez y valga para las
    // trece clases.
    const slide = taller.crearSecuencia({
        nombre: NOMBRES.slide, pistasVideo: 2, pistasAudio: 1, duracionSeg: largoSeg
    });
    taller.guardarEn(bin, slide.itemDelPanel);
    [camara, pantalla].forEach((fuente, i) => {
        taller.colocarCorte({
            pista: slide.pistasVideo[i],
            medio: fuente.comoFuente,
            desdeSeg: 0,
            hastaSeg: largoSeg,
            entradaSeg: 0
        });
        cortes++;
    });

    // ── El recuadro del profesor, aplicado UNA vez ──
    const mini = taller.crearSecuencia({
        nombre: NOMBRES.mini, pistasVideo: 1, pistasAudio: 1, duracionSeg: largoSeg
    });
    taller.guardarEn(bin, mini.itemDelPanel);
    taller.pintarItemDelPanel(mini.itemDelPanel, ETIQUETA_DE_CAMARA);
    const suElCorte = taller.colocarCorte({
        pista: mini.pistasVideo[0],
        medio: camara.comoFuente,
        desdeSeg: 0,
        hastaSeg: largoSeg,
        entradaSeg: 0,
        etiqueta: ETIQUETA_DE_CAMARA
    });
    cortes++;
    const puesto = taller.ponerEncuadre(suElCorte, fcp.encuadreDelRecuadro(medidasDe(clases)));
    if (!puesto) {
        avisos.push(`«${NOMBRES.mini}» entró sin el recuadro: la plantilla no tiene ningún clip`
            + ' con la escala o la posición movidas del que copiarlo. El profesor va a ocupar'
            + ' todo el cuadro hasta que se lo achique a mano, una sola vez, adentro de esa'
            + ' secuencia.');
    }

    return { franjas, largoSeg, camara, pantalla, audio, slide, mini, cortes };
}

/**
 * El cuadro contra el que se calcula el recuadro.
 *
 * Sale del material y no de un 1920×1080 escrito acá, por lo mismo que la escala
 * se calcula en vez de copiarse: una cámara con otro formato daría un recuadro
 * deformado. Si ninguna clase lo dice, `encuadreDelRecuadro` pone el suyo.
 */
function medidasDe(clases) {
    for (const clase of clases) {
        const camara = fuentesDeVideo(clase).camara;
        if (camara && camara.ancho && camara.alto) {
            return {
                ancho: camara.ancho,
                alto: camara.alto,
                fuenteAncho: camara.ancho,
                fuenteAlto: camara.alto
            };
        }
    }
    return {};
}

module.exports = {
    AIRE_SEG,
    NOMBRES,
    ETIQUETA_DE_CAMARA,
    ETIQUETA_DE_PANTALLA,
    ETIQUETA_DE_AUDIO,
    franjasDe,
    largoDe,
    fuentesDeVideo,
    pistaDelLiveMix,
    armarLosNidos
};
