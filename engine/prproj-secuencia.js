'use strict';
/**
 * prproj-secuencia.js — Cirugía de secuencias sobre un proyecto de Premiere.
 *
 * Entre el motor de mutación (`prproj.js`, que solo sabe de objetos y
 * referencias) y la capa que sabe de Class Cut (`prproj-curso.js`) hace falta
 * esto: quien sabe que una secuencia se cuelga de un `VideoTrackGroup`, que las
 * pistas de audio se anotan en dos listas, y que el color de etiqueta vive en
 * dos lugares. Nada de acá menciona una clase ni un curso, así que se puede
 * probar contra el molde solo, sin material.
 *
 * **La idea de fondo es que no se escribe ningún objeto a mano: se clona el que
 * ya está.** El molde que le llega a este módulo trae, sin habérselo propuesto,
 * un ejemplar de cada cosa que Class Cut necesita: una secuencia chica, un corte
 * de video, un corte de audio estéreo, un corte de audio mono, un medio de video
 * y un medio de audio de cada tipo de canal. `detectarMoldes` los busca por su
 * forma —no por su nombre, que es del proyecto del editor y podría ser
 * cualquiera— y todo lo que sigue es copiar el ejemplar que corresponde y
 * cambiarle los pocos campos que importan.
 *
 * Eso resuelve gratis el punto que más estado cruzado tiene, que es el estéreo.
 * Un clip de audio dice cuántos canales tiene en cuatro clases distintas a la
 * vez —`AudioComponentChain`, `AudioClip`, `ClipChannelVectorSerializer` y un
 * `ClipChannelSerializer` por canal— y las cuatro tienen que coincidir. En vez
 * de escribir las cuatro y esperar no haberme equivocado, el mono sale del
 * ejemplar mono del molde y el estéreo del estéreo. El número de canales solo
 * elige de qué ejemplar copiar.
 */

const prproj = require('./prproj');
// Solo por la geometría del recuadro: es la misma que escribe el XML, dicha en
// las unidades de este formato. Ver `aUnidadesDePremiere`.
const fcp = require('./fcp-xml');

/**
 * Los GUID que nombran a los tres tipos de pista. Son constantes del formato:
 * aparecen idénticos en proyectos de 2024 y de 2026, y no son identidad de nada,
 * así que se copian tal cual y NO se renuevan al clonar.
 */
const {
    TIPO_VIDEO,
    CLASE_MARKERS,
    CLASE_MARKER,
    TIPO_AUDIO,
    FRONTERA_DEL_CORTE,
    FRONTERA_DEL_MEDIO,
    ETIQUETAS,
    COLOR_DE,
    MOVIMIENTO,
    FRONTERA_DEL_ANIDADO,
    detectarMoldes,
    loQueFalta,
    elegir,
    canalesDeclarados,
    mayorIdDePanel
} = require('./prproj-moldes');


const ANCHO_DE_LA_LINEA = 1070;


// ─── Listas con `Index` denso ────────────────────────────────────────

/**
 * Ubica una lista `<Etiqueta Version="N"> … </Etiqueta>` adentro de un texto.
 *
 * Hace falta porque los `Index` de toda lista del formato tienen que quedar
 * densos desde cero, y la única manera de garantizarlo es reescribir la lista
 * entera en vez de insertar una línea y confiar. Se guarda la sangría que se
 * encontró en vez de suponerla: las listas del formato viven a tres, cuatro y
 * cinco tabulaciones según de quién cuelguen.
 *
 * @returns {{ini:number, fin:number, sangria:string, entradas:string[]}|null}
 */
function ubicarLista(texto, etiqueta) {
    const abre = new RegExp(`\\n(\\t*)<${etiqueta} Version="\\d+">`);
    const m = abre.exec(texto);
    if (!m) return null;
    const ini = m.index + 1;
    const sangria = m[1];
    const cierra = `\n${sangria}</${etiqueta}>`;
    const donde = texto.indexOf(cierra, ini);
    if (donde === -1) return null;
    const cuerpo = texto.slice(ini + m[0].length - 1, donde);
    return {
        ini,
        fin: donde + cierra.length,
        sangria,
        entradas: cuerpo.split('\n').map(l => l.trim()).filter(Boolean)
    };
}

/**
 * Reescribe una lista de elementos de una sola línea, con los `Index` densos.
 *
 * `entradas` son los atributos de cada elemento sin el `Index`, que lo pone
 * esto: `['ObjectURef="f0a8…"', …]`.
 */
function ponerLista(proyecto, k, etiqueta, elemento, entradas) {
    const texto = proyecto.contenido(k);
    const lista = ubicarLista(texto, etiqueta);
    if (!lista) throw new Error(`${proyecto.clase(k)} ${k} no tiene una lista <${etiqueta}>`);
    proyecto.escribir(k, texto.slice(0, lista.ini) + armarLista(etiqueta, elemento, entradas, lista.sangria)
        + texto.slice(lista.fin));
}

function armarLista(etiqueta, elemento, entradas, sangria) {
    const lineas = [`${sangria}<${etiqueta} Version="1">`];
    entradas.forEach((attrs, i) => lineas.push(`${sangria}\t<${elemento} Index="${i}" ${attrs}/>`));
    lineas.push(`${sangria}</${etiqueta}>`);
    return lineas.join('\n');
}

/** Las referencias que ya tiene una lista, para agregarle una sin perder las otras. */
function entradasDeLista(proyecto, k, etiqueta) {
    const lista = ubicarLista(proyecto.contenido(k), etiqueta);
    if (!lista) return [];
    return lista.entradas
        .map(l => /(Object(?:U?)Ref="[^"]+")/.exec(l))
        .filter(Boolean)
        .map(m => m[1]);
}

/** Agrega una referencia al final de una lista que ya está, reindexando. */
function agregarALista(proyecto, k, etiqueta, elemento, attrs) {
    ponerLista(proyecto, k, etiqueta, elemento, entradasDeLista(proyecto, k, etiqueta).concat(attrs));
}

/** Saca de una lista las referencias que apunten a los objetos que se digan. */
function quitarDeLista(proyecto, k, etiqueta, elemento, aQuitar) {
    const fuera = new Set(aQuitar);
    const quedan = entradasDeLista(proyecto, k, etiqueta).filter(attrs => {
        const m = /Object(U?)Ref="([^"]+)"/.exec(attrs);
        return !m || !fuera.has(prproj.clave(m[1] === 'U' ? 'UID' : 'ID', m[2]));
    });
    ponerLista(proyecto, k, etiqueta, elemento, quedan);
}


// ─── Propiedades del `<Node>` ────────────────────────────────────────

/**
 * Escribe propiedades en el `<Node><Properties>` de un objeto, creándolo si no
 * está.
 *
 * Que haya que crearlo es la mitad interesante y no un caso raro: **cuando un
 * objeto no tiene ninguna propiedad, el nodo entero desaparece del archivo**. Es
 * una regla de serialización del formato, y es justo lo que pasa con el color de
 * etiqueta: los clips de la línea de tiempo no lo traen, lo heredan del clip
 * maestro. Pintar un corte no es editar un campo, es inventar el `<Node>`.
 *
 * El nodo va primero entre los hijos de su padre, que es donde lo pone Premiere.
 *
 * @param {string} ancla la etiqueta de apertura del padre, p. ej. `<Clip Version="18">`
 */
function ponerPropiedades(proyecto, k, ancla, propiedades) {
    const texto = proyecto.contenido(k);
    const donde = texto.indexOf(ancla);
    if (donde === -1) throw new Error(`no está ${ancla} en ${proyecto.clase(k)} ${k}`);

    const sangriaAncla = /(\t*)$/.exec(texto.slice(0, donde))[1];
    const s = `${sangriaAncla}\t`;
    const lineas = Object.entries(propiedades).map(([n, v]) => `${s}\t\t<${n}>${v}</${n}>`);

    const nodo = ubicarLista(texto, 'Node');
    if (nodo && nodo.ini > donde && nodo.ini < donde + ancla.length + 2 + s.length) {
        // Ya hay `<Node>` pegado al ancla: las propiedades se suman a las suyas.
        const props = ubicarLista(texto, 'Properties');
        const juntas = props.entradas
            .filter(l => !Object.keys(propiedades).some(n => l.startsWith(`<${n}>`)))
            .map(l => `${s}\t\t${l}`)
            .concat(lineas);
        proyecto.escribir(k, texto.slice(0, props.ini)
            + [`${s}\t<Properties Version="1">`, ...juntas, `${s}\t</Properties>`].join('\n')
            + texto.slice(props.fin));
        return;
    }

    const bloque = [
        `${s}<Node Version="1">`,
        `${s}\t<Properties Version="1">`,
        ...lineas,
        `${s}\t</Properties>`,
        `${s}</Node>`
    ].join('\n');
    const corte = donde + ancla.length;
    proyecto.escribir(k, `${texto.slice(0, corte)}\n${bloque}${texto.slice(corte)}`);
}


// ─── El taller ───────────────────────────────────────────────────────

/**
 * Un proyecto abierto más los ejemplares que se van a clonar.
 *
 * Se le pide el molde una vez, encuentra sus ejemplares, y de ahí en adelante
 * `importarMedio`, `crearSecuencia` y `colocarCorte` son copias de esos.
 */
class Taller {
    /**
     * @param {prproj.Proyecto} proyecto
     * @param {object} [opciones]
     * @param {number} [opciones.semilla] para que dos corridas den el mismo archivo
     */
    constructor(proyecto, opciones) {
        const op = opciones || {};
        this.proyecto = proyecto;
        this.uid = prproj.generadorDeUid(op.semilla == null ? 20260909 : op.semilla);
        this.moldes = detectarMoldes(proyecto);
        // El `<ID>` del panel de proyecto no es un GUID sino un entero que sube.
        // Se arranca por arriba de lo que haya para no pisar ninguno.
        this.proximoIdDePanel = mayorIdDePanel(proyecto) + 1;
    }

    /** Los `ObjectUID` nuevos de un clonado, por la clase que se pida. */
    _deClase(clonados, clase) {
        return clonados.filter(k => this.proyecto.clase(k) === clase);
    }

    /**
     * Clona un subgrafo y le renueva los GUID sueltos de una sola pasada.
     *
     * Las dos cosas van juntas siempre: un clonado sin renovar los `<ID>` y
     * `<ClipID>` deja GUID repetidos entre el original y la copia, y eso lo
     * detecta `verificar` recién al final, cuando ya no se sabe qué clonado
     * fue. Acá no se puede hacer una sin la otra.
     */
    _clonar(raices, opciones) {
        const { clonados, mapaId, mapaUid } = this.proyecto.clonar(raices, {
            ...(opciones || {}),
            uid: this.uid
        });
        this.proyecto.renovarGuidSueltos(clonados, this.uid);
        return { clonados, mapaId, mapaUid };
    }


    // ── medios ──

    /**
     * Mete un archivo del disco en el panel de proyecto.
     *
     * @param {object} ficha
     * @param {string} ficha.ruta       ruta absoluta del archivo
     * @param {string} ficha.nombre     cómo se ve en el panel
     * @param {number} ficha.duracionSeg
     * @param {number} ficha.canales    1 o 2, MEDIDO (elige de qué ejemplar copiar)
     * @param {boolean} ficha.conVideo
     * @param {string} [ficha.etiqueta] nombre de `ETIQUETAS`
     * @returns {object} las claves que hacen falta para colocarle cortes
     */
    importarMedio(ficha) {
        const modelo = ficha.conVideo
            ? this.moldes.medioVideo
            : (ficha.canales === 1 ? this.moldes.medioMono : this.moldes.medioEstereo);
        if (!modelo) {
            throw new Error(`el molde no tiene un medio de ejemplo ${ficha.conVideo ? 'con video'
                : (ficha.canales === 1 ? 'mono' : 'estéreo')} del que copiar`);
        }

        const { clonados } = this._clonar([modelo], { claseFrontera: FRONTERA_DEL_MEDIO });
        const cpi = this._deClase(clonados, 'ClipProjectItem')[0];
        const master = this._deClase(clonados, 'MasterClip')[0];
        const medio = this._deClase(clonados, 'Media')[0];
        const ticks = prproj.aTicks(ficha.duracionSeg);

        // La transcripción quedó afuera del clonado, así que la lista de clips
        // del clip maestro todavía nombra el `TranscriptClip` del ORIGINAL. Sin
        // sacarlo, los dos medios compartirían una transcripción que además
        // habla de otro archivo.
        quitarDeLista(this.proyecto, master, 'Clips', 'Clip',
            this.proyecto.refsDe(master).filter(k => this.proyecto.clase(k) === 'TranscriptClip'));

        for (const k of [cpi, master]) {
            this.proyecto.escribir(k, this.proyecto.contenido(k)
                .replace(/<Name>[^<]*<\/Name>/g, `<Name>${xmlSeguro(ficha.nombre)}</Name>`));
        }
        // El `<ID>` del panel es el orden en que el editor importó las cosas: no
        // es identidad y no lo renueva el clonado, pero repetido deja dos filas
        // del panel discutiendo cuál es cuál.
        this.proyecto.escribir(cpi, this.proyecto.contenido(cpi)
            .replace(/<ID>\d+<\/ID>/, `<ID>${this.proximoIdDePanel++}</ID>`));

        // Las tres rutas del medio, más el título. `RelativePath` se saca en vez
        // de calcularla: es relativa a dónde se guarde el proyecto, que este
        // módulo no sabe, y con `FilePath` absoluto Premiere encuentra el
        // archivo igual. Escribir una relativa mal apuntada es peor que no tener.
        let t = this.proyecto.contenido(medio)
            .replace(/<FilePath>[^<]*<\/FilePath>/, `<FilePath>${xmlSeguro(ficha.ruta)}</FilePath>`)
            .replace(/<ActualMediaFilePath>[^<]*<\/ActualMediaFilePath>/,
                `<ActualMediaFilePath>${xmlSeguro(ficha.ruta)}</ActualMediaFilePath>`)
            .replace(/<Title>[^<]*<\/Title>/, `<Title>${xmlSeguro(ficha.nombre)}</Title>`)
            .replace(/\n\t\t<RelativePath>[^<]*<\/RelativePath>/, '');
        // `ModificationState` y `ContentAndMetadataState` son huellas del
        // contenido del archivo de ORIGEN. Copiadas a otro archivo estarían
        // mintiendo; se sacan y que Premiere las recalcule, que es lo que hace
        // con cualquier medio que encuentra cambiado.
        t = t.replace(/\n\t\t<ModificationState[\s\S]*?<\/ModificationState>/g, '')
            .replace(/\n\t\t<ContentAndMetadataState[\s\S]*?<\/ContentAndMetadataState>/g, '')
            .replace(/\n\t\t<CCFileModTime>[^<]*<\/CCFileModTime>/g, '');
        this.proyecto.escribir(medio, t);

        // Las duraciones: la del medio y la de cada fuente. El molde dura media
        // hora y el archivo nuevo lo que dura, y una fuente que declara más de
        // lo que hay deja el clip con cola negra.
        for (const k of clonados) {
            const clase = this.proyecto.clase(k);
            if (clase === 'VideoStream' || clase === 'AudioStream') {
                this.proyecto.escribir(k, this.proyecto.contenido(k)
                    .replace(/<Duration>\d+<\/Duration>/g, `<Duration>${ticks}</Duration>`));
            }
        }

        // El color: el que pida la ficha y, si no pide, el que Premiere le pone
        // solo a un archivo de audio. Un medio sin color explícito se quedaría
        // con el del molde, que es el de otro archivo cualquiera.
        if (ficha.etiqueta) this.pintarItemDelPanel(cpi, ficha.etiqueta);
        else if (!ficha.conVideo) this.pintarItemDelPanel(cpi, COLOR_DE.audio);

        return {
            clipProjectItem: cpi,
            masterClip: master,
            medio,
            fuenteVideo: this._deClase(clonados, 'VideoMediaSource')[0] || null,
            fuenteAudio: this._deClase(clonados, 'AudioMediaSource')[0] || null,
            canales: ficha.canales,
            conVideo: Boolean(ficha.conVideo),
            nombre: ficha.nombre,
            duracionSeg: ficha.duracionSeg
        };
    }

    /** El color de la fila del panel de proyecto, que es un índice de la paleta. */
    pintarItemDelPanel(cpi, etiqueta) {
        const color = ETIQUETAS[etiqueta];
        if (!color) return false;
        ponerPropiedades(this.proyecto, cpi, '<ProjectItem Version="1">', {
            'Column.PropertyText.Label': `BE.Prefs.LabelColors.${color.indice}`
        });
        return true;
    }


    // ── secuencias ──

    /**
     * Crea una secuencia nueva con la cantidad de pistas que se pida.
     *
     * Son dos clonados y no uno: el esqueleto de la secuencia por un lado y su
     * ítem del panel de proyecto por el otro. Y el segundo no es opcional —
     * **Premiere le crea un ítem de bin a toda secuencia**, y ese ítem es además
     * lo que la vuelve anidable. O sea que crear la secuencia y habilitarla para
     * anidar es una sola operación, no dos.
     *
     * @param {object} pedido
     * @param {string} pedido.nombre
     * @param {number} pedido.pistasVideo
     * @param {number} pedido.pistasAudio
     * @param {number} [pedido.duracionSeg] para el zoom y el final del área de trabajo
     */
    crearSecuencia(pedido) {
        const p = this.proyecto;
        const modelo = this.moldes.secuencia;
        if (!modelo) throw new Error('el molde no tiene ninguna secuencia de la que copiar');
        if (!this.moldes.itemDeSecuencia) {
            throw new Error('la secuencia del molde no tiene ítem en el panel de proyecto: no se puede clonar');
        }

        // El esqueleto: la secuencia entera menos los cortes, que se colocan
        // después y de a uno.
        const { clonados } = this._clonar([modelo], {
            claseFrontera: ['VideoClipTrackItem', 'AudioClipTrackItem']
        });
        const seq = this._deClase(clonados, 'Sequence')[0];
        const grupoVideo = this._deClase(clonados, 'VideoTrackGroup')[0];
        const grupoAudio = this._deClase(clonados, 'AudioTrackGroup')[0];
        const inlet = this._deClase(clonados, 'AudioTrackInlet')[0];

        p.escribir(seq, p.contenido(seq)
            .replace(/<Name>[^<]*<\/Name>/, `<Name>${xmlSeguro(pedido.nombre)}</Name>`));
        this.encuadrarLaLinea(seq, pedido.duracionSeg);


        // Las pistas del modelo quedan vacías: si no, la secuencia nueva
        // compartiría los cortes con el molde, o sea que mover un clip en una
        // movería el de la otra.
        const pistasVideo = this._deClase(clonados, 'VideoClipTrack');
        const pistasAudio = this._deClase(clonados, 'AudioClipTrack');
        for (const k of pistasVideo.concat(pistasAudio)) this.vaciarPista(k);

        while (pistasVideo.length < Math.max(1, pedido.pistasVideo)) {
            pistasVideo.push(this.clonarPista(pistasVideo[0]));
        }
        while (pistasAudio.length < Math.max(1, pedido.pistasAudio)) {
            pistasAudio.push(this.clonarPista(pistasAudio[0]));
        }
        while (pistasVideo.length > Math.max(1, pedido.pistasVideo)) {
            this.borrarPista(pistasVideo.pop());
        }
        while (pistasAudio.length > Math.max(1, pedido.pistasAudio)) {
            this.borrarPista(pistasAudio.pop());
        }

        // Los `<ID>` internos de las pistas, que son únicos dentro de su grupo.
        // Los de audio arrancan en 2 porque el 1 se lo queda el `AudioMixTrack`,
        // que es una pista más para el formato aunque el editor no la vea.
        pistasVideo.forEach((k, i) => this.numerarPista(k, i + 1, i));
        pistasAudio.forEach((k, i) => this.numerarPista(k, i + 2, i));

        ponerLista(this.proyecto, grupoVideo, 'Tracks', 'Track',
            pistasVideo.map(k => `ObjectURef="${prproj.parte(k)[1]}"`));
        ponerLista(this.proyecto, grupoAudio, 'Tracks', 'Track',
            pistasAudio.map(k => `ObjectURef="${prproj.parte(k)[1]}"`));
        // **La segunda lista, la que es fácil olvidarse.** El `AudioTrackInlet`
        // es lo que junta todas las pistas hacia el máster, y una pista que está
        // en el grupo pero no acá queda coja.
        ponerLista(this.proyecto, inlet, 'Sources', 'Source',
            pistasAudio.map(k => `ObjectURef="${prproj.parte(k)[1]}"`));

        this.siguienteIdDePista(grupoVideo, pistasVideo.length + 1);
        this.siguienteIdDePista(grupoAudio, pistasAudio.length + 2);

        const panel = this.itemDeSecuencia(seq, pedido.nombre, pedido.duracionSeg || 0);
        return {
            secuencia: seq,
            pistasVideo,
            pistasAudio,
            nombre: pedido.nombre,
            itemDelPanel: panel.cpi,
            // La misma secuencia, dicha como se dice un archivo, para poder
            // ponerla de fuente de un corte sin que `colocarCorte` se entere de
            // que no es un archivo. Ver `comoFuente`.
            comoFuente: {
                masterClip: panel.masterClip,
                fuenteVideo: panel.fuenteVideo,
                fuenteAudio: panel.fuenteAudio,
                // Una secuencia suena en estéreo, así que el corte que la usa se
                // clona del mismo molde que un WAV de dos canales.
                canales: 2,
                conVideo: true,
                medio: null,
                nombre: pedido.nombre,
                duracionSeg: pedido.duracionSeg || 0
            }
        };
    }

    /**
     * El ítem del panel de proyecto de una secuencia: lo que la hace visible y
     * lo que la hace anidable.
     *
     * El clonado para en la secuencia del molde (`objFrontera`) y después se le
     * repuntan las dos fuentes a la secuencia nueva. Sin la frontera, clonar el
     * ítem se llevaría puesta la secuencia del molde entera.
     *
     * Devuelve las cuatro piezas y no solo la fila del panel porque las otras
     * tres son justamente lo que hace falta para anidarla: el clip maestro que
     * un corte nombra, y las dos fuentes —video y audio— a las que apunta.
     *
     * @returns {{cpi, masterClip, fuenteVideo, fuenteAudio}}
     */
    itemDeSecuencia(seq, nombre, duracionSeg) {
        const p = this.proyecto;
        const modelo = this.moldes.itemDeSecuencia;
        const { clonados } = this._clonar([modelo], { objFrontera: [this.moldes.secuencia] });

        const uidViejo = prproj.parte(this.moldes.secuencia)[1];
        const uidNuevo = prproj.parte(seq)[1];
        const tics = prproj.aTicks(duracionSeg);
        for (const k of clonados) {
            const clase = p.clase(k);
            if (clase === 'VideoSequenceSource' || clase === 'AudioSequenceSource') {
                p.cambiar(k, uidViejo, uidNuevo);
                // **Cuánto material hay que ver ahí adentro.** El molde trae la
                // duración de la secuencia de la que se clonó, y sin pisarla un
                // nido de nueve horas se presenta como uno de treinta y cinco
                // minutos: los cortes de la clase doce caen fuera de lo que
                // Premiere cree que existe.
                if (tics > 0) {
                    p.escribir(k, p.contenido(k).replace(
                        /<OriginalDuration>\d+<\/OriginalDuration>/,
                        `<OriginalDuration>${tics}</OriginalDuration>`));
                }
            }
            if (clase === 'ClipProjectItem' || clase === 'MasterClip') {
                p.escribir(k, p.contenido(k)
                    .replace(/<Name>[^<]*<\/Name>/g, `<Name>${xmlSeguro(nombre)}</Name>`));
            }
        }
        const cpi = this._deClase(clonados, 'ClipProjectItem')[0];
        p.escribir(cpi, p.contenido(cpi).replace(/<ID>\d+<\/ID>/, `<ID>${this.proximoIdDePanel++}</ID>`));
        // El verde de las secuencias se escribe siempre, sin heredarlo del molde:
        // el molde es una secuencia cualquiera y podría venir de cualquier color.
        this.pintarItemDelPanel(cpi, COLOR_DE.secuencia);
        return {
            cpi,
            masterClip: this._deClase(clonados, 'MasterClip')[0] || null,
            fuenteVideo: this._deClase(clonados, 'VideoSequenceSource')[0] || null,
            fuenteAudio: this._deClase(clonados, 'AudioSequenceSource')[0] || null
        };
    }

    /**
     * El zoom y el final del área de trabajo de una secuencia.
     *
     * `TL.SQTimePerPixel` son segundos por píxel. Heredado del molde, una
     * secuencia corta abre con los clips convertidos en una raya y el editor
     * piensa que no se generó nada. No es cosmético: es la diferencia entre que
     * el archivo se vea bien y que parezca roto.
     */
    encuadrarLaLinea(seq, duracionSeg) {
        const p = this.proyecto;
        const dur = Number(duracionSeg) > 0 ? Number(duracionSeg) : 60;
        p.escribir(seq, p.contenido(seq)
            .replace(/<TL.SQTimePerPixel>[^<]*<\/TL.SQTimePerPixel>/,
                `<TL.SQTimePerPixel>${(dur / ANCHO_DE_LA_LINEA).toFixed(10)}</TL.SQTimePerPixel>`)
            .replace(/<MZ.WorkOutPoint>[^<]*<\/MZ.WorkOutPoint>/,
                `<MZ.WorkOutPoint>${prproj.aTicks(dur)}</MZ.WorkOutPoint>`));
    }


    // ── pistas ──

    /**
     * Una pista más, igual a la que se le pase.
     *
     * Para video es un objeto y para audio son ocho —la pista, su cadena de
     * componentes, el fader, el medidor y sus parámetros—, y el clonado los
     * junta solo siguiendo las referencias. La frontera es la clase de la propia
     * pista, para que clonar la primera no arrastre a las hermanas.
     */
    clonarPista(modelo) {
        const clase = this.proyecto.clase(modelo);
        const { clonados } = this._clonar([modelo], { claseFrontera: [clase] });
        const nueva = this._deClase(clonados, clase)[0];
        this.vaciarPista(nueva);
        return nueva;
    }

    borrarPista(k) {
        for (const pieza of this.proyecto.cierre([k], { claseFrontera: [this.proyecto.clase(k)] })) {
            this.proyecto.borrar(pieza);
        }
    }

    /**
     * Le saca a una pista clonada la lista de cortes del original.
     *
     * Sin esto la pista nueva sigue nombrando los `TrackItem` de la pista de la
     * que se copió, o sea que las dos secuencias comparten el mismo clip.
     */
    vaciarPista(k) {
        this.proyecto.escribir(k, this.proyecto.contenido(k)
            .replace(/\n\t*<TrackItems Version="1">[\s\S]*?<\/TrackItems>/, ''));
    }

    /**
     * El `<ID>` numérico de una pista y sus tres `<Index>`.
     *
     * Los tres `<Index>` —el de la pista, el de sus clips y el de sus
     * transiciones— viven todos a cuatro tabulaciones y valen lo mismo, así que
     * se escriben juntos. El `<ID>` que se cambia es el primero a esa misma
     * profundidad: el otro `<ID>` de una pista de audio es un GUID, vive a tres
     * y es identidad, así que ese lo renueva el clonado y no se toca acá.
     */
    numerarPista(k, id, indice) {
        this.proyecto.escribir(k, this.proyecto.contenido(k)
            .replace(/\n\t\t\t\t<ID>\d+<\/ID>/, `\n\t\t\t\t<ID>${id}</ID>`)
            .replace(/\n\t\t\t\t<Index>\d+<\/Index>/g, `\n\t\t\t\t<Index>${indice}</Index>`));
    }

    siguienteIdDePista(grupo, valor) {
        this.proyecto.escribir(grupo, this.proyecto.contenido(grupo)
            .replace(/<NextTrackID>\d+<\/NextTrackID>/, `<NextTrackID>${valor}</NextTrackID>`));
    }


    // ── cortes ──

    /**
     * Coloca un corte en una pista.
     *
     * Son cuatro objetos de video o cinco/seis de audio, todos copiados del
     * ejemplar del molde con frontera en el medio: el corte nuevo apunta al
     * mismo archivo del disco, no se duplica nada.
     *
     * @param {object} corte
     * @param {string} corte.pista       la clave de la `VideoClipTrack`/`AudioClipTrack`
     * @param {object} corte.medio       lo que devolvió `importarMedio`
     * @param {number} corte.desdeSeg    dónde arranca en la línea de tiempo
     * @param {number} corte.hastaSeg    dónde termina en la línea de tiempo
     * @param {number} corte.entradaSeg  desde qué segundo del archivo
     * @param {string} [corte.etiqueta]  nombre de `ETIQUETAS`
     * @param {boolean} [corte.sonando]  si la pista de audio viene con el ojo prendido
     */
    colocarCorte(corte) {
        const p = this.proyecto;
        const esVideo = p.clase(corte.pista) === 'VideoClipTrack';
        const medio = corte.medio;
        const modelo = esVideo
            ? this.moldes.corteVideo
            : (medio.canales === 1 ? this.moldes.corteMono : this.moldes.corteEstereo);
        if (!modelo) throw new Error('el molde no tiene un corte de ejemplo del que copiar');

        // La frontera del anidado incluye la del archivo, así que sirve para los
        // dos casos: parar en un `Media` que no está y parar en una `Sequence`
        // que no está son la misma instrucción cuando la fuente es la otra.
        const { clonados } = this._clonar([modelo], { claseFrontera: FRONTERA_DEL_ANIDADO });
        const item = this._deClase(clonados, esVideo ? 'VideoClipTrackItem' : 'AudioClipTrackItem')[0];
        const clip = this._deClase(clonados, esVideo ? 'VideoClip' : 'AudioClip')[0];
        const sub = this._deClase(clonados, 'SubClip')[0];

        // Dónde cae en la línea de tiempo. `<Start>` se omite del archivo cuando
        // vale cero —es la regla de "los valores por defecto no se escriben"— así
        // que se saca el que pueda haber y se lo pone siempre delante del `<End>`.
        const desde = prproj.aTicks(corte.desdeSeg);
        const hasta = prproj.aTicks(corte.hastaSeg);
        p.escribir(item, p.contenido(item)
            .replace(/\n(\t*)<Start>\d+<\/Start>/, '')
            .replace(/(\n(\t*))<End>\d+<\/End>/,
                (todo, salto, sangria) => `${salto}<Start>${desde}</Start>${salto}<End>${hasta}</End>`));

        // Qué pedazo del archivo se ve. El largo se toma de la línea de tiempo y
        // no de restar los puntos de origen: si difirieran, el clip quedaría
        // pidiéndole a Premiere que estire el tiempo.
        const entrada = prproj.aTicks(corte.entradaSeg);
        p.escribir(clip, p.contenido(clip)
            .replace(/<InPoint>\d+<\/InPoint>/, `<InPoint>${entrada}</InPoint>`)
            .replace(/<OutPoint>\d+<\/OutPoint>/, `<OutPoint>${entrada + (hasta - desde)}</OutPoint>`));

        // Al medio nuevo: la fuente del clip, el clip maestro del subclip, y el
        // nombre que se ve en la línea de tiempo.
        const fuente = esVideo ? medio.fuenteVideo : medio.fuenteAudio;
        if (!fuente) throw new Error(`el medio ${medio.nombre} no tiene fuente de ${esVideo ? 'video' : 'audio'}`);
        this.repuntar(clip, 'Source', fuente);
        for (const k of clonados) {
            if (p.clase(k) === 'SecondaryContent') this.repuntar(k, 'Content', fuente);
        }
        p.escribir(sub, p.contenido(sub)
            .replace(/<MasterClip ObjectURef="[^"]+"\/>/,
                `<MasterClip ObjectURef="${prproj.parte(medio.masterClip)[1]}"/>`)
            .replace(/<Name>[^<]*<\/Name>/, `<Name>${xmlSeguro(medio.nombre)}</Name>`));
        // Los marcadores del clip son los del medio de ORIGEN: los del molde
        // hablan de otro archivo. Se repuntan a los del medio nuevo, que el
        // clonado del medio ya trajo vacíos. Una secuencia usada de fuente no
        // tiene `medio`, y ahí el clip maestro es el único lugar donde mirar.
        const marcasDelMedio = p.refsDe(medio.masterClip).find(k => p.clase(k) === 'Markers')
            || (medio.medio ? p.refsDe(medio.medio).find(k => p.clase(k) === 'Markers') : null);
        if (marcasDelMedio) this.repuntar(clip, 'Markers', marcasDelMedio);

        if (corte.etiqueta) this.pintarCorte(clip, corte.etiqueta);
        if (corte.sonando === false) this.silenciar(item);

        this.engancharEnLaPista(corte.pista, item);
        return item;
    }

    /**
     * Anota un corte en la lista de su pista, creando la lista si es el primero.
     *
     * Una pista vacía **no trae el contenedor `<TrackItems>`**: es la misma regla
     * de "los valores por defecto no se escriben" que hace desaparecer el
     * `<Node>` de un objeto sin propiedades. Y las pistas de una secuencia recién
     * creada están todas vacías, así que este es el caso normal y no el raro.
     */
    engancharEnLaPista(pista, item) {
        const p = this.proyecto;
        const attrs = `ObjectRef="${prproj.parte(item)[1]}"`;
        const texto = p.contenido(pista);
        if (ubicarLista(texto, 'TrackItems')) {
            agregarALista(p, pista, 'TrackItems', 'TrackItem', attrs);
            return;
        }
        const m = /\n(\t*)<ClipItems Version="\d+">/.exec(texto);
        if (!m) throw new Error(`${p.clase(pista)} ${pista} no tiene <ClipItems> donde colgar el corte`);
        const corte = m.index + m[0].length;
        p.escribir(pista, texto.slice(0, corte)
            + `\n${armarLista('TrackItems', 'TrackItem', [attrs], `${m[1]}\t`)}`
            + texto.slice(corte));
    }

    /** Cambia a dónde apunta una referencia con nombre adentro de un objeto. */
    repuntar(k, etiqueta, destino) {
        const [tipo, valor] = prproj.parte(destino);
        const attr = tipo === 'UID' ? 'ObjectURef' : 'ObjectRef';
        const texto = this.proyecto.contenido(k);
        const re = new RegExp(`<${etiqueta} Object(?:U?)Ref="[^"]+"/>`);
        if (!re.test(texto)) return false;
        this.proyecto.escribir(k, texto.replace(re, `<${etiqueta} ${attr}="${valor}"/>`));
        return true;
    }


    /**
     * El color de etiqueta de un corte, que son DOS campos: el índice de la
     * paleta y el entero cacheado al lado. Escribir solo uno deja el clip
     * pintado en el panel y gris en la línea de tiempo, o al revés.
     */
    pintarCorte(clip, etiqueta) {
        const color = ETIQUETAS[etiqueta];
        // Sin el entero medido no se pinta nada. Escribir solo el nombre dejaría
        // el clip de un color en el panel y de otro en la línea de tiempo, que
        // es peor que dejarlo gris: parecería que alguien lo cambió a mano.
        if (!color || color.entero == null) return false;
        ponerPropiedades(this.proyecto, clip, '<Clip Version="18">', {
            'asl.clip.label.name': `BE.Prefs.LabelColors.${color.indice}`,
            'asl.clip.label.color': color.entero
        });
        return true;
    }

    /**
     * Le pone a un corte de video el recuadro del profesor: escala, posición y
     * recorte, con la misma geometría que el XML escribe en Basic Motion.
     *
     * **Se reemplaza la cadena entera y no se le cuelga un componente.** Premiere
     * escribe el efecto junto con `DefaultOpacity` y `DefaultOpacityComponentID`
     * en la misma cadena; clonar el componente suelto y colgarlo de la cadena
     * vacía que trae el corte sería armar a mano una forma que Premiere nunca
     * escribe. Clonando la cadena del molde con todo adentro, lo que queda es una
     * copia de algo que su Premiere ya guardó.
     *
     * Contesta `false` cuando el molde no tiene de dónde copiar, que es el caso
     * normal: el efecto solo aparece en el archivo si alguien movió la escala o
     * la posición, así que la mayoría de las plantillas no lo tienen. Quien llama
     * decide si eso merece un aviso.
     *
     * @param {string} item la clave del `VideoClipTrackItem`
     * @param {object} encuadre lo que devuelve `fcp.encuadreDelRecuadro`
     */
    ponerEncuadre(item, encuadre) {
        const p = this.proyecto;
        if (!this.moldes.efectoDeMovimiento || !encuadre) return false;

        const vieja = p.refsDe(item).find(k => p.clase(k) === 'VideoComponentChain');
        if (!vieja) return false;

        const { clonados } = this._clonar([this.moldes.efectoDeMovimiento], {});
        const cadena = this._deClase(clonados, 'VideoComponentChain')[0];
        const componentes = this._deClase(clonados, 'VideoFilterComponent');
        const componente = componentes
            .find(k => p.contenido(k).includes(`<MatchName>${MOVIMIENTO}</MatchName>`));
        if (!cadena || !componente) return false;

        // **De la cadena copiada se queda solo el movimiento.** Una cadena de la
        // plantilla puede traer cualquier cosa colgada al lado —en la que se
        // midió venían además un Recorte redondeado y un Transform— y copiarla
        // entera sería aplicarle al recuadro efectos que nadie eligió. Acá suena
        // a poco: esos dos son justamente los que le faltan al recuadro para
        // tener las esquinas redondeadas. Pero la plantilla la elige la máquina
        // entre los proyectos del editor, así que lo que venga al lado del
        // movimiento es cualquier cosa: mañana es una corrección de color y el
        // profesor sale verde sin que nada lo explique.
        const sobran = componentes.filter(k => k !== componente);
        if (sobran.length) {
            quitarDeLista(p, cadena, 'Components', 'Component', sobran);
            for (const k of sobran) {
                for (const pieza of p.cierre([k], {})) p.borrar(pieza);
            }
        }

        const posicion = fcp.aUnidadesDePremiere(encuadre.centro);
        const anclaje = fcp.aUnidadesDePremiere(encuadre.anclaje);
        const porNombre = {
            Position: `${posicion.x}:${posicion.y}`,
            'Anchor Point': `${anclaje.x}:${anclaje.y}`,
            Scale: encuadre.escala,
            'Scale Width': encuadre.escala,
            'Crop Left': encuadre.recorte.izq,
            'Crop Right': encuadre.recorte.der,
            'Crop Top': encuadre.recorte.arriba,
            'Crop Bottom': encuadre.recorte.abajo
        };
        for (const k of p.cierre([componente], {})) {
            const texto = p.contenido(k);
            const nombre = (/<Name>([^<]*)<\/Name>/.exec(texto) || [])[1];
            if (!(nombre in porNombre)) continue;
            this.valorDelParametro(k, porNombre[nombre]);
        }

        this.repuntar(item, 'Components', cadena);
        for (const k of p.cierre([vieja], {})) p.borrar(k);
        return true;
    }

    /**
     * El valor de un parámetro de efecto, que va escrito DOS veces.
     *
     * `<StartKeyframe>` es el valor en el tiempo cero y `<CurrentValue>` es el
     * que muestra el panel. Premiere escribe los dos y hay que escribir los dos:
     * con uno solo, el efecto se ve aplicado en el programa pero el panel muestra
     * otro número, o al revés. El `CurrentValue` no siempre está —un parámetro
     * que nadie tocó no lo trae— y por eso se reemplaza si está y no se inventa
     * si no.
     *
     * El fotograma clave es una lista por comas donde el valor es el segundo
     * campo; el primero es el instante, y ese no se toca.
     */
    valorDelParametro(k, valor) {
        const p = this.proyecto;
        p.escribir(k, p.contenido(k)
            .replace(/<StartKeyframe>([^,]*),[^,]*,/, `<StartKeyframe>$1,${valor},`)
            .replace(/<CurrentValue>[^<]*<\/CurrentValue>/, `<CurrentValue>${valor}</CurrentValue>`));
    }

    /**
     * El ojo apagado de un corte, que es lo que llevan las nueve pistas de audio
     * que entran para tenerlas a mano y no para escucharlas todas a la vez.
     *
     * `<IsMuted>` va adentro del `<ClipTrackItem>`, pegado detrás del `<SubClip>`.
     * No lo deduje: aparece cien veces en los autoguardados del editor, escrito
     * por Premiere, y de ahí salió la posición.
     */
    silenciar(item) {
        const p = this.proyecto;
        const texto = p.contenido(item);
        if (/<IsMuted>/.test(texto)) return;
        const m = /\n(\t*)<SubClip ObjectRef="\d+"\/>/.exec(texto);
        if (!m) return;
        const corte = m.index + m[0].length;
        p.escribir(item, `${texto.slice(0, corte)}\n${m[1]}<IsMuted>true</IsMuted>${texto.slice(corte)}`);
    }


    // ── marcadores ──

    /**
     * Le cuelga a una secuencia su lista de marcadores.
     *
     * Dos cosas que no se adivinan. Una: **la lista va ordenada alfabéticamente
     * por GUID**, no por tiempo. El contenedor lo declara con
     * `<ByGUID>byGUID</ByGUID>` y los marcadores reales del editor están así,
     * verificados uno por uno. Dos: el color va como un entero adentro de un
     * JSON, que es lo que hace que este formato valga la pena — el XML de
     * intercambio degradaba el color al más parecido de once nombres fijos, y
     * acá viaja el número exacto. Quedó confirmado abriendo la PRUEBA-B: el
     * marcador salió del naranja pedido, o sea que el entero llega intacto.
     *
     * @param {{nombre:string, comentario:string, desdeSeg:number, hastaSeg:number, color:number}[]} marcadores
     */
    ponerMarcadores(seq, marcadores) {
        if (!marcadores || !marcadores.length) return null;
        const p = this.proyecto;
        const id = () => String(++this._ultimoId || (this._ultimoId = p.maxId() + 1));

        const piezas = marcadores.map(m => {
            const llave = this.uid();
            const cuerpo = {
                mComment: String(m.comentario == null ? '' : m.comentario),
                mCuePointList: [
                    { mKey: 'marker_guid', mValue: this.uid() },
                    { mKey: `keywordExtDVAv1_${this.uid()}`, mValue: JSON.stringify({ color: m.color >>> 0 }) }
                ],
                mDuration: { ticks: Math.max(0, prproj.aTicks(m.hastaSeg) - prproj.aTicks(m.desdeSeg)) },
                mName: String(m.nombre == null ? '' : m.nombre),
                mStartTime: { ticks: prproj.aTicks(m.desdeSeg) },
                mType: 'Comment'
            };
            return { llave, json: JSON.stringify({ DVAMarker: cuerpo }) };
        }).sort((a, b) => (a.llave < b.llave ? -1 : 1));

        const idContenedor = p.maxId() + 1;
        const cuerpos = piezas.map((pieza, i) => {
            const idMarcador = idContenedor + 1 + i;
            return { ...pieza, id: idMarcador };
        });

        const contenedor = [
            `\t<Markers ObjectID="${idContenedor}" ClassID="${CLASE_MARKERS}" Version="4">`,
            '\t\t<Markers Version="1">',
            ...cuerpos.flatMap((c, i) => ([
                `\t\t\t<Marker Version="1" Index="${i}">`,
                `\t\t\t\t<First>${c.llave}</First>`,
                `\t\t\t\t<Second ObjectRef="${c.id}"/>`,
                '\t\t\t</Marker>'
            ])),
            '\t\t</Markers>',
            '\t\t<ByGUID>byGUID</ByGUID>',
            '\t</Markers>',
            ...cuerpos.flatMap(c => ([
                `\t<Marker ObjectID="${c.id}" ClassID="${CLASE_MARKER}" Version="3">`,
                `\t\t<DVAMarker>${xmlSeguro(c.json)}</DVAMarker>`,
                '\t</Marker>'
            ]))
        ].join('\n');
        p.agregar(contenedor);

        // El `MarkerOwner` va pegado al cierre del `</Node>` de la secuencia, que
        // es donde lo pone Premiere (comprobado en la PRUEBA-B, que abrió bien).
        const texto = p.contenido(seq);
        if (/<MarkerOwner/.test(texto)) {
            this.repuntar(seq, 'Markers', prproj.clave('ID', String(idContenedor)));
        } else {
            const corte = texto.indexOf('\n\t\t</Node>') + '\n\t\t</Node>'.length;
            p.escribir(seq, texto.slice(0, corte)
                + `\n\t\t<MarkerOwner Version="1">\n\t\t\t<Markers ObjectRef="${idContenedor}"/>\n\t\t</MarkerOwner>`
                + texto.slice(corte));
        }
        return prproj.clave('ID', String(idContenedor));
    }


    // ── bins ──

    /**
     * Una carpeta del panel de proyecto.
     *
     * Se clona del bin del molde y se le vacía la lista, que es más seguro que
     * escribirlo: un `BinProjectItem` trae propiedades de estado de interfaz
     * —el orden de la vista de iconos, si está desplegado— que copiadas andan y
     * escritas a mano son adivinar.
     */
    crearBin(nombre, opciones) {
        const p = this.proyecto;
        const op = opciones || {};
        if (!this.moldes.bin) throw new Error('el molde no tiene ningún bin del que copiar');
        const { clonados } = this._clonar([this.moldes.bin], { claseFrontera: ['ClipProjectItem', 'BinProjectItem'] });
        const bin = this._deClase(clonados, 'BinProjectItem')[0];
        p.escribir(bin, p.contenido(bin)
            .replace(/<Name>[^<]*<\/Name>/, `<Name>${xmlSeguro(nombre)}</Name>`)
            .replace(/<ID>\d+<\/ID>/, `<ID>${this.proximoIdDePanel++}</ID>`));
        // Un bin recién creado no hereda los hijos del que se copió. Y la lista
        // se saca entera en vez de dejarla vacía porque **un bin sin nada no
        // trae `<Items>`**: es la regla de que los valores por defecto no se
        // escriben, la misma que hace desaparecer el `<Node>` de un objeto sin
        // propiedades y el `<TrackItems>` de una pista vacía.
        p.escribir(bin, p.contenido(bin).replace(/\n\t*<Items Version="\d+">[\s\S]*?<\/Items>/, ''));

        const props = { 'Column.PropertyText.Label': `BE.Prefs.LabelColors.${ETIQUETAS[COLOR_DE.bin].indice}` };
        // El orden en la vista de iconos, que es lo que decide dónde cae cada bin
        // cuando el editor mira el panel en cuadrícula en vez de en lista.
        if (op.orden != null) props['project.icon.view.grid.order'] = op.orden;
        ponerPropiedades(p, bin, '<ProjectItem Version="1">', props);
        return bin;
    }


    /**
     * Mete un ítem del panel adentro de un bin (o de la raíz).
     *
     * Crea la lista si el ítem es el primero, por lo mismo que `crearBin` la
     * saca: un contenedor vacío no la tiene. El orden de la lista es el orden que
     * se ve en pantalla, así que se agrega al final y no se reordena nada.
     */
    guardarEn(contenedor, item) {
        const p = this.proyecto;
        const attrs = `ObjectURef="${prproj.parte(item)[1]}"`;
        if (ubicarLista(p.contenido(contenedor), 'Items')) {
            agregarALista(p, contenedor, 'Items', 'Item', attrs);
            return;
        }
        const texto = p.contenido(contenedor);
        const m = /\n(\t*)<ProjectItemContainer Version="\d+">/.exec(texto);
        if (!m) throw new Error(`${p.clase(contenedor)} no tiene <ProjectItemContainer> donde guardar`);
        const corte = m.index + m[0].length;
        p.escribir(contenedor, texto.slice(0, corte)
            + `\n${armarLista('Items', 'Item', [attrs], `${m[1]}\t`)}`
            + texto.slice(corte));
    }


    /**
     * Descuelga del panel de proyecto todo lo que traía la plantilla.
     *
     * **Es lo que convierte a la plantilla en un catálogo de piezas en vez de en
     * un proyecto que viaja de polizón en la entrega.** Sin esto, armar el curso
     * con la plantilla del editor deja adentro también las secuencias y los
     * medios del editor, y quien abre el archivo ve lo suyo mezclado con lo que
     * generó Class Cut.
     *
     * Acá solo se descuelga: se vacía la lista de la raíz y nada más. Los objetos
     * siguen en el archivo, que es justo lo que hace falta, porque **de ellos se
     * clona todo lo demás**. Borrarlos ahora sería quedarse sin moldes en el
     * segundo paso. Los borra `podarLaPlantilla`, al final, cuando ya no se los
     * necesita.
     *
     * Que descolgar alcance para que no se vean no es una corazonada: en el
     * proyecto que el editor armó a mano se midió que **la ventana de proyecto
     * cuelga del `RootProjectItem` y de nada más**. A cada ítem lo nombra solo su
     * bin, y lo único que el `<Project>` nombra es la raíz.
     */
    vaciarElPanel() {
        const p = this.proyecto;
        const raiz = this.raizDelPanel();
        if (!raiz) return 0;
        this._deLaPlantilla = new Set(p.cierre([raiz], {}).filter(k => k !== raiz));
        p.escribir(raiz, p.contenido(raiz)
            .replace(/\n(\t*)<Items Version="\d+">[\s\S]*?<\/Items>/, ''));
        return this._deLaPlantilla.size;
    }

    /**
     * Borra los objetos de la plantilla que ya no cuelgan de ningún lado.
     *
     * Va AL FINAL, después de haber clonado todo, y es lo que evita el estado
     * incómodo del medio: un objeto que no se ve en el panel pero sigue en el
     * archivo. Se calcula qué alcanza hoy la raíz y se borra lo que estaba antes
     * y ya no está, o sea los moldes y su descendencia, que a esta altura
     * cumplieron.
     *
     * **La poda es segura porque el motor verifica, no porque yo esté seguro.**
     * Si algo de lo generado hubiera quedado apuntando a un objeto de la
     * plantilla —una frontera mal puesta, un repunte que no encontró su campo—,
     * `verificar` lo encuentra y `guardar` se niega a escribir el archivo. El
     * error aparece al generar, no cuando el editor abre el proyecto.
     */
    podarLaPlantilla() {
        const p = this.proyecto;
        const raiz = this.raizDelPanel();
        if (!raiz || !this._deLaPlantilla) return 0;
        const vivos = new Set(p.cierre([raiz], {}));
        let podados = 0;
        for (const k of this._deLaPlantilla) {
            if (!vivos.has(k) && p.tiene(k)) { p.borrar(k); podados++; }
        }
        this._deLaPlantilla = null;
        return podados;
    }

    raizDelPanel() {
        return this.proyecto.porClase('RootProjectItem')[0];
    }
}






/**
 * Los cinco signos del XML, escapados.
 *
 * Los nombres de clase y las rutas los arma el editor y traen de todo: comillas,
 * ampersands y tildes. Un `&` sin escapar en una ruta rompe el XML entero, y
 * Premiere no dice qué línea.
 */
function xmlSeguro(texto) {
    return String(texto == null ? '' : texto)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}


module.exports = {
    Taller,
    ETIQUETAS,
    TIPO_VIDEO,
    TIPO_AUDIO,
    FRONTERA_DEL_CORTE,
    FRONTERA_DEL_MEDIO,
    ANCHO_DE_LA_LINEA,
    detectarMoldes,
    loQueFalta,
    COLOR_DE,
    canalesDeclarados,
    ubicarLista,
    ponerLista,
    entradasDeLista,
    agregarALista,
    quitarDeLista,
    ponerPropiedades,
    xmlSeguro
};
