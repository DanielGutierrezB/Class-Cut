'use strict';
/**
 * prproj.js — Leer, mutar y escribir un proyecto de Premiere, sin saber nada de
 * Class Cut.
 *
 * Un `.prproj` es un XML comprimido con gzip que serializa un grafo de objetos.
 * Cada objeto de nivel raíz abre a UNA tabulación y se identifica de una de dos
 * maneras: con un `ObjectID` numérico —descartable, Premiere lo renumera en cada
 * guardado— o con un `ObjectUID`, que es un GUID y es la única identidad estable
 * del archivo. Solo ocho clases usan UID (`CLASES_CON_UID`), y están medidos:
 * los mil y pico que hay en los proyectos del editor son UUID versión 4, el
 * mismo archivo importado tres veces recibe tres UID distintos, y un UID aparece
 * únicamente en su definición y en sus `ObjectURef`. O sea que **se inventan**,
 * siempre que se reescriban todas las referencias del subgrafo que se copia.
 *
 * **Acá no se construye nada desde cero, se clona.** El molde trae correctas las
 * versiones de esquema de las cincuenta y cuatro clases, la configuración de
 * color, el espacio de color de salida, los cuadros por segundo y una docena de
 * campos que no le aportan nada a Class Cut pero que escritos mal rompen el
 * archivo. Construir sería hacerse dueño de todo eso a cambio de nada, y encima
 * el esquema cambia entre versiones de Premiere: se midieron 24 clases de 81
 * que cambiaron de `Version` entre 2024 y 2026. Clonando, arreglar eso es que el
 * editor vuelva a guardar el molde.
 *
 * Tres trampas del formato que este módulo da por sabidas, porque cada una ya
 * hizo fallar un intento:
 *
 * 1. **Hay un segundo espacio de `ObjectID`** y vive solo adentro del objeto
 *    raíz `<Project>` (el subgrafo del panel de proyecto y los `ExportSettings`).
 *    Un `<Column ObjectRef="54"/>` de ahí adentro no habla del mismo 54 que el
 *    resto del archivo. El criterio por indentación —"me salteo las líneas de
 *    cuatro tabulaciones o más"— es INCORRECTO: `<Second ObjectRef="279"/>`
 *    está justo a cuatro y es del espacio global, y saltearlo dejó tres
 *    referencias colgando que el verificador no vio. Acá el criterio es la clase
 *    del objeto raíz que las contiene, que es la regla medida.
 *
 * 2. **Hay GUID que no son `ObjectUID`**: los campos `<ID>` y `<ClipID>`. El
 *    clonado no los toca, así que quedarían repetidos entre el original y la
 *    copia, y hay que renovarlos aparte (`renovarGuidSueltos`). Pero
 *    `<DefMappingID>` NO se renueva: es el mapeo de canales por defecto, una
 *    constante compartida que aparece idéntica en los doce clips maestros del
 *    proyecto del editor. Renovarlo sería inventar una identidad donde no hay.
 *
 * 3. **El orden de definición no manda.** El 84,8 % de las referencias del
 *    proyecto del editor apuntan a objetos definidos más abajo en el archivo,
 *    así que Premiere no puede estar exigiendo definir antes de usar. Por eso lo
 *    que se agrega va siempre al final, que es lo único que no obliga a
 *    recalcular los rangos de todo lo que hay arriba.
 *
 * Lo que separa un archivo que abre de uno que Premiere declara dañado es una
 * sola cosa, medida en la prueba C: **una referencia a un objeto que no está**.
 * De ahí que `guardar` verifique y se niegue a escribir, y que no haya una
 * manera de saltearlo. Un `.prproj` roto no avisa en el momento: avisa cuando
 * el editor lo abre, y para entonces el que lo generó ya se fue a otra cosa.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Un objeto de nivel raíz abre a UNA tabulación. La restricción es lo que hace
 * que el índice no vea nunca los objetos anidados del `<Project>`, que son los
 * del segundo espacio de numeración (trampa 1).
 */
const ABRE = /^\t<([A-Za-z0-9_.]+) Object(ID|UID)="([^"]+)"/;

/** `ObjectRef="12"` y `ObjectURef="f0a8…"`, que son las dos formas de referenciar. */
const REF = /Object(U?)Ref="([^"]+)"/g;

/** Las listas del formato numeran con `Index=` desde cero y sin huecos. */
const CON_INDICE = /<([A-Za-z0-9_.]+) (?:Version="\d+" )?Index="(\d+)"/;

/** Los campos GUID que sí son identidad y hay que renovar al clonar (trampa 2). */
const GUID_SUELTO = /<(ID|ClipID)>([^<]*)<\/(?:ID|ClipID)>/g;

const ES_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * El único objeto raíz que tiene adentro su propio espacio de `ObjectID`. Se
 * excluye al resolver referencias y al renumerar.
 */
const CLASE_CON_ESPACIO_PROPIO = 'Project';

/**
 * Las clases que se identifican con GUID. No se usa para decidir nada —el índice
 * lee el atributo que hay— pero deja dicho cuáles son: si un molde nuevo trajera
 * una novena, conviene mirarla antes de clonarla.
 */
const CLASES_CON_UID = [
    'RootProjectItem', 'BinProjectItem', 'ClipProjectItem', 'MasterClip',
    'Sequence', 'Media', 'VideoClipTrack', 'AudioClipTrack'
];

/**
 * Ticks por segundo. Es la unidad de tiempo de Premiere y es exacta: 254016000000
 * se divide entero por 24, 25, 30, 48, 50 y 60, así que un cuadro de cualquiera
 * de esos formatos cae en un tick redondo y no hay redondeo que se acumule.
 */
const TICKS = 254016000000;

/**
 * El byte de sistema operativo que escribe Premiere en la cabecera gzip.
 *
 * Se replica la cabecera entera —`MTIME=0`, `FLG=0`, `XFL=0`, `OS=0x13`— y no
 * porque esté comprobado que Premiere la exija, sino porque no hay motivo para
 * averiguarlo por las malas: el gzip de macOS pone `OS=0x03` y el de Python
 * `0xff`, y un archivo que se rechaza en la puerta no deja ninguna pista de por
 * qué. De paso, MTIME en cero es lo que hace que dos corridas del generador con
 * los mismos datos den el mismo archivo byte a byte, que es lo que permite
 * comparar dos salidas con un `sha256` en vez de leyéndolas.
 */
const OS_DE_PREMIERE = 0x13;

/** Bytes de la cabecera gzip que hay que forzar: MTIME (4-7), XFL (8) y OS (9). */
const CABECERA_ESPERADA = '1f8b0800000000000013';


// ─── El gzip, con la cabecera exacta ──────────────────────────────────

function descomprimir(buffer) {
    return zlib.gunzipSync(buffer).toString('utf8');
}

/**
 * Texto → gzip con la cabecera de Premiere.
 *
 * Se comprime con `gzipSync` y se pisan los tres campos de la cabecera en vez de
 * armarla a mano con `deflateRawSync` y un CRC calculado aparte: el resultado es
 * byte a byte el mismo —está comprobado— y el CRC lo pone zlib, que es un lugar
 * menos donde equivocarse.
 *
 * De los tres, hoy **el único que cambia algo es el `XFL`**: el zlib de este Node
 * ya escribe `MTIME=0` y `OS=0x13`, y `level 9` deja `XFL=0x02`, que es el byte
 * que hay que bajar a cero. Los otros dos se pisan igual y no por costumbre: el
 * byte de sistema operativo lo elige el zlib con el que se compiló Node —el
 * `gzip` de macOS pone `0x03` y el de Python `0xff`— y que este ponga justo el de
 * Premiere es suerte, no una garantía. Dos líneas que no cuestan nada compran no
 * depender de con qué se compiló Node, que es de las cosas que cambian sin avisar
 * y dejan un archivo rechazado en la puerta sin ninguna pista de por qué.
 */
function comprimir(texto) {
    const gz = zlib.gzipSync(Buffer.from(texto, 'utf8'), { level: 9 });
    gz.writeUInt32LE(0, 4);
    gz[8] = 0;
    gz[9] = OS_DE_PREMIERE;
    return gz;
}

/** Los diez bytes de cabecera de un archivo ya escrito, en hexa. Para las pruebas. */
function cabeceraDe(buffer) {
    return buffer.slice(0, 10).toString('hex');
}


// ─── GUID inventados, pero reproducibles ─────────────────────────────

/**
 * Generador de UUID v4 con semilla propia.
 *
 * Con semilla y no con `crypto.randomUUID` para que dos corridas del generador
 * sobre la misma carpeta den el mismo `.prproj`. Sin eso, cada corrida cambia
 * seiscientos GUID y no hay manera de ver qué cambió de verdad entre dos
 * salidas: toda comparación da "cambió todo". Los GUID no significan nada, así
 * que el azar solo tiene que evitar colisiones, y para eso alcanza.
 */
function generadorDeUid(semilla) {
    let estado = (Number(semilla) || 0) >>> 0;
    // mulberry32: doce líneas, distribución buena de sobra para esto, y da lo
    // mismo en cualquier máquina, que es el punto de tener semilla.
    const siguiente = () => {
        estado = (estado + 0x6d2b79f5) >>> 0;
        let t = estado;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const byte = () => Math.floor(siguiente() * 256);

    return function uid() {
        const b = [];
        for (let i = 0; i < 16; i++) b.push(byte());
        // La versión (4) y la variante (RFC 4122), que es lo que los hace pasar
        // por lo que Premiere escribe: los 1034 UID medidos en el material del
        // editor son todos v4.
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const hex = b.map(x => x.toString(16).padStart(2, '0'));
        return [
            hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''),
            hex.slice(8, 10).join(''), hex.slice(10, 16).join('')
        ].join('-');
    };
}


// ─── El proyecto: índice vivo sobre los objetos de nivel raíz ────────

/**
 * Un proyecto abierto, partido en cabecera + bloques de objeto + cola.
 *
 * **El índice se mantiene al día en cada escritura**, y eso es la diferencia con
 * hacerlo a lo bruto. La versión Python de esto reindexaba el archivo entero
 * después de cada clonado, que con las dos o tres decenas de objetos de una
 * prueba no se nota; un curso de trece clases son unos diez mil objetos y varios
 * miles de clonados, y reindexar en cada uno es tiempo cuadrático sobre un
 * archivo de megabytes. Acá los bloques se guardan como listas de líneas
 * sueltas, sin posiciones absolutas, así que agregar al final no invalida nada.
 */
class Proyecto {
    constructor(texto) {
        this.cabecera = [];
        this.cola = [];
        this.bloques = [];
        this.indice = new Map();
        this._maxId = 0;

        let actual = null;
        for (const linea of String(texto).split('\n')) {
            if (linea.startsWith('</PremiereData>')) {
                actual = null;
                this.cola.push(linea);
                continue;
            }
            if (this.cola.length) {
                this.cola.push(linea);
                continue;
            }
            const m = ABRE.exec(linea);
            if (m) {
                actual = { clase: m[1], tipo: m[2], clave: m[3], lineas: [linea] };
                this._anotar(actual);
                continue;
            }
            (actual ? actual.lineas : this.cabecera).push(linea);
        }
    }

    static leer(ruta) {
        return new Proyecto(descomprimir(fs.readFileSync(ruta)));
    }

    _anotar(bloque) {
        this.bloques.push(bloque);
        this.indice.set(clave(bloque.tipo, bloque.clave), bloque);
        if (bloque.tipo === 'ID') {
            const n = parseInt(bloque.clave, 10);
            if (isFinite(n) && n > this._maxId) this._maxId = n;
        }
    }


    // ── lectura ──

    texto() {
        const partes = [...this.cabecera];
        for (const b of this.bloques) for (const l of b.lineas) partes.push(l);
        return partes.concat(this.cola).join('\n');
    }

    tiene(k) {
        return this.indice.has(k);
    }

    bloque(k) {
        const b = this.indice.get(k);
        if (!b) throw new Error(`no hay ningún objeto ${k} en el proyecto`);
        return b;
    }

    clase(k) {
        return this.bloque(k).clase;
    }

    /** El texto de un objeto, para leerlo o para copiarlo. */
    contenido(k) {
        return this.bloque(k).lineas.join('\n');
    }

    claves() {
        return this.bloques.map(b => clave(b.tipo, b.clave));
    }

    porClase(clase) {
        return this.bloques.filter(b => b.clase === clase).map(b => clave(b.tipo, b.clave));
    }

    /** El `<Name>` de un objeto, que es como se lo busca por lo que el editor ve. */
    nombre(k) {
        const m = /<Name>([^<]*)<\/Name>/.exec(this.contenido(k));
        return m ? m[1] : null;
    }

    porNombre(clase, nombre) {
        return this.porClase(clase).find(k => this.nombre(k) === nombre) || null;
    }

    /**
     * Las referencias que salen de un objeto, del espacio global.
     *
     * El `<Project>` se devuelve vacío entero: todo lo que hay adentro es del
     * segundo espacio de numeración y resolverlo contra el global da referencias
     * colgando que no existen (trampa 1).
     */
    /**
     * A qué objetos apunta este, cada uno una vez.
     *
     * Se deduplica porque la pregunta es a quién apunta y no cuántas veces: un
     * objeto puede nombrar al mismo hijo desde un campo suelto y desde una lista
     * —le pasa a casi todos— y quien pide las referencias las quiere para
     * recorrer el grafo o para filtrarlas por clase, no para contarlas.
     */
    refsDe(k) {
        const b = this.bloque(k);
        if (b.clase === CLASE_CON_ESPACIO_PROPIO) return [];
        return [...new Set(refsEnTexto(b.lineas.join('\n')))];
    }

    quienReferencia(k) {
        return this.claves().filter(otra => this.refsDe(otra).some(r => r === k));
    }

    maxId() {
        return this._maxId;
    }


    // ── escritura ──


    /** Reemplaza el texto de un objeto. La clave y la clase no pueden cambiar. */
    escribir(k, texto) {
        this.bloque(k).lineas = String(texto).split('\n');
    }

    /**
     * Cambia un pedazo de texto adentro de un objeto y **falla si no estaba**.
     *
     * Que falle es el punto: una sustitución que no encuentra su aguja deja el
     * archivo verosímil y silenciosamente equivocado —la secuencia clonada
     * seguiría llamándose como el molde, el clip seguiría apuntando al medio de
     * al lado— y eso recién se descubre con Premiere abierto.
     */
    cambiar(k, viejo, nuevo, veces) {
        const antes = this.contenido(k);
        if (!antes.includes(viejo)) {
            throw new Error(`no está ${JSON.stringify(viejo)} en ${this.clase(k)} ${k}`);
        }
        this.escribir(k, veces === 1 ? antes.replace(viejo, nuevo) : antes.split(viejo).join(nuevo));
    }

    /** Agrega objetos de nivel raíz al final, que es donde es seguro (trampa 3). */
    agregar(texto) {
        let actual = null;
        for (const linea of String(texto).split('\n')) {
            const m = ABRE.exec(linea);
            if (m) {
                actual = { clase: m[1], tipo: m[2], clave: m[3], lineas: [linea] };
                this._anotar(actual);
            } else if (actual) {
                actual.lineas.push(linea);
            }
        }
    }

    borrar(k) {
        const b = this.bloque(k);
        this.bloques.splice(this.bloques.indexOf(b), 1);
        this.indice.delete(k);
        return b;
    }


    // ── clonado ──

    /**
     * El cierre transitivo hacia abajo desde `raices`, parando en la frontera.
     *
     * **La frontera es lo que hace que esto sirva.** Un subgrafo de secuencia no
     * está cerrado como el de un efecto: baja hasta los medios del disco y hasta
     * los clips maestros. Sin frontera, clonar una secuencia para poner un corte
     * más duplicaría el archivo de video en el panel de proyecto. Con frontera,
     * los objetos que el subgrafo referencia pero que hay que REUSAR se nombran
     * y el recorrido no entra ni los copia: el corte nuevo apunta al mismo
     * archivo del disco que el viejo.
     *
     * Las raíces nunca son frontera de sí mismas, así que se puede pedir "cloná
     * esta pista de audio y parate en cualquier otra pista de audio".
     */
    cierre(raices, opciones) {
        const op = opciones || {};
        const porClase = new Set(op.claseFrontera || []);
        const porObjeto = new Set(op.objFrontera || []);
        const raiz = new Set(raices);

        const salida = [];
        const visto = new Set();
        const cola = [...raices];
        while (cola.length) {
            const k = cola.shift();
            if (visto.has(k) || !this.tiene(k)) continue;
            visto.add(k);
            if (porObjeto.has(k)) continue;
            if (porClase.has(this.clase(k)) && !raiz.has(k)) continue;
            salida.push(k);
            for (const r of this.refsDe(k)) {
                if (this.tiene(r) && !visto.has(r)) cola.push(r);
            }
        }
        return salida;
    }

    /**
     * Copia un subgrafo con `ObjectID` y `ObjectUID` nuevos.
     *
     * Las referencias internas se repuntan a las copias; las que salen a la
     * frontera se dejan como estaban, que es justamente para lo que existe la
     * frontera. Los `ObjectUID` se reemplazan por texto en todo el bloque, que
     * cubre de una la definición y los `ObjectURef` que lo nombran — se puede
     * porque un UID aparece únicamente en esos dos lugares, y eso está medido.
     *
     * @returns {{mapaId: Map, mapaUid: Map, clonados: string[]}} `clonados` son
     *   las claves NUEVAS, en el mismo orden que las viejas.
     */
    clonar(raices, opciones) {
        const op = opciones || {};
        const uid = op.uid;
        if (typeof uid !== 'function') throw new Error('clonar necesita un generador de UID');

        const piezas = this.cierre(raices, op);
        const mapaId = new Map();
        const mapaUid = new Map();
        let siguiente = this.maxId() + 1;
        for (const k of piezas) {
            const [tipo, valor] = parte(k);
            if (tipo === 'ID') mapaId.set(valor, String(siguiente++));
            else mapaUid.set(valor, uid());
        }

        const nuevos = [];
        for (const k of piezas) {
            const [tipo, valor] = parte(k);
            let t = this.contenido(k);
            if (tipo === 'ID') {
                t = t.replace(`ObjectID="${valor}"`, `ObjectID="${mapaId.get(valor)}"`);
            }
            t = t.replace(/ObjectRef="(\d+)"/g,
                (todo, n) => (mapaId.has(n) ? `ObjectRef="${mapaId.get(n)}"` : todo));
            for (const [viejo, nuevo] of mapaUid) t = t.split(viejo).join(nuevo);
            nuevos.push(t);
            this.agregar(t);
        }

        const clonados = piezas.map(k => {
            const [tipo, valor] = parte(k);
            return tipo === 'ID' ? clave('ID', mapaId.get(valor)) : clave('UID', mapaUid.get(valor));
        });
        return { mapaId, mapaUid, clonados };
    }

    /**
     * Renueva los GUID de `<ID>` y `<ClipID>` de los objetos que se acaban de
     * clonar (trampa 2).
     *
     * Se pide la lista de claves en vez de barrer el proyecto porque lo que hay
     * que renovar es exactamente lo recién copiado: pasar por arriba de todo
     * cambiaría los GUID de los objetos que el molde ya tenía, que es lo único
     * que no hay que tocar.
     *
     * @returns {number} cuántos se renovaron
     */
    renovarGuidSueltos(claves, uid) {
        let n = 0;
        for (const k of claves) {
            const antes = this.contenido(k);
            const despues = antes.replace(GUID_SUELTO, (todo, etiqueta, valor) => {
                if (!ES_GUID.test(valor)) return todo;
                n++;
                return `<${etiqueta}>${uid()}</${etiqueta}>`;
            });
            if (despues !== antes) this.escribir(k, despues);
        }
        return n;
    }


    // ── verificación ──

    /**
     * Todo lo que hace que Premiere no abra un archivo, buscado antes de escribir.
     *
     * Son tres cosas y las tres son de grafo, no de contenido: una referencia a
     * un objeto que no está (la que hundió la prueba C), una lista con los
     * `Index` salteados, y un GUID repetido. Ninguna se nota leyendo el archivo
     * y las tres son baratas de encontrar acá.
     *
     * @returns {{colgadas: object[], indices: object[], repetidos: object[], ok: boolean}}
     */
    verificar() {
        const colgadas = [];
        // La cabecera trae `<Project ObjectRef="1"/>`, la única referencia que no
        // sale de ningún objeto. Se verifica igual: si se podara el `<Project>`,
        // esa línea quedaría apuntando al vacío y nadie la estaría mirando.
        for (const r of refsEnTexto(this.cabecera.join('\n'))) {
            if (!this.tiene(r)) colgadas.push({ desde: '(cabecera)', clase: '(cabecera)', a: r });
        }
        for (const k of this.claves()) {
            for (const r of this.refsDe(k)) {
                if (!this.tiene(r)) colgadas.push({ desde: k, clase: this.clase(k), a: r });
            }
        }

        const indices = [];
        for (const k of this.claves()) {
            if (this.clase(k) === CLASE_CON_ESPACIO_PROPIO) continue;
            // Se agrupa por etiqueta Y por indentación: un mismo nombre de
            // etiqueta a dos profundidades son dos listas distintas, y mezcladas
            // dan un falso positivo en cualquier objeto con listas anidadas.
            const grupos = new Map();
            for (const linea of this.bloque(k).lineas) {
                const m = CON_INDICE.exec(linea);
                if (!m) continue;
                const sangria = linea.length - linea.replace(/^\t+/, '').length;
                const g = `${m[1]}@${sangria}`;
                if (!grupos.has(g)) grupos.set(g, []);
                grupos.get(g).push(parseInt(m[2], 10));
            }
            for (const [g, vs] of grupos) {
                if (vs.some((v, i) => v !== i)) {
                    indices.push({ objeto: k, clase: this.clase(k), lista: g, valores: vs.slice(0, 12) });
                }
            }
        }

        const repetidos = [];
        const vistos = new Map();
        for (const k of this.claves()) {
            if (this.clase(k) === CLASE_CON_ESPACIO_PROPIO) continue;
            const [tipo, valor] = parte(k);
            if (tipo === 'UID') anotarGuid(vistos, valor, k, 'ObjectUID');
            let m;
            const re = new RegExp(GUID_SUELTO.source, 'g');
            const t = this.contenido(k);
            while ((m = re.exec(t)) !== null) {
                if (ES_GUID.test(m[2])) anotarGuid(vistos, m[2], k, `<${m[1]}>`);
            }
        }
        for (const [guid, donde] of vistos) {
            if (donde.length > 1) repetidos.push({ guid, donde: donde.slice(0, 4) });
        }

        return {
            colgadas,
            indices,
            repetidos,
            ok: !colgadas.length && !indices.length && !repetidos.length
        };
    }

    /**
     * Escribe el proyecto, y solo si el grafo cierra.
     *
     * No hay manera de saltear la verificación a propósito. Un `.prproj` roto no
     * falla acá: falla en la máquina del editor, media hora después, con un
     * "project file is damaged" que no dice cuál de los diez mil objetos es el
     * que falta.
     *
     * Se escribe a un temporal y se renombra, igual que todo lo que escribe la
     * app (`workspace.writeAtomic`): si esto se corta a la mitad, lo que queda en
     * disco es lo de antes y no medio proyecto que el editor abriría sin
     * sospechar nada.
     */
    guardar(ruta) {
        const revision = this.verificar();
        if (!revision.ok) throw new Error(`el grafo no cierra: ${comoSeLee(revision)}`);
        const texto = this.texto();
        const carpeta = path.dirname(ruta);
        const tmp = `${ruta}.tmp-${process.pid}-${Date.now()}`;
        // La carpeta puede no existir todavía: el proyecto va en un `Proyecto/`
        // propio y la primera vez hay que crearlo. Se anota si lo creamos
        // nosotros para poder deshacerlo — un fallo a mitad de la escritura que
        // deja una carpeta vacía manda al editor a buscar adentro un archivo
        // que nunca se escribió.
        const laCreamos = !fs.existsSync(carpeta);
        if (laCreamos) fs.mkdirSync(carpeta, { recursive: true });
        try {
            fs.writeFileSync(tmp, comprimir(texto));
            fs.renameSync(tmp, ruta);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (e2) { /* puede no haber llegado a existir */ }
            if (laCreamos) {
                // Solo si quedó vacía: si alguien más metió algo adentro mientras
                // tanto, borrarla sería llevarse puesto lo ajeno.
                try { fs.rmdirSync(carpeta); } catch (e2) { /* con algo adentro, se queda */ }
            }
            throw e;
        }
        return { ruta, bytesXml: Buffer.byteLength(texto, 'utf8'), objetos: this.bloques.length };
    }
}


// ─── Utilidades ──────────────────────────────────────────────────────

/** La clave de un objeto: `"ID:244"` o `"UID:f0a80180-…"`. */
function clave(tipo, valor) {
    return `${tipo}:${valor}`;
}

function parte(k) {
    const corte = k.indexOf(':');
    return [k.slice(0, corte), k.slice(corte + 1)];
}

function refsEnTexto(texto) {
    const salida = [];
    const re = new RegExp(REF.source, 'g');
    let m;
    while ((m = re.exec(texto)) !== null) {
        salida.push(clave(m[1] === 'U' ? 'UID' : 'ID', m[2]));
    }
    return salida;
}

function anotarGuid(vistos, guid, donde, campo) {
    if (!vistos.has(guid)) vistos.set(guid, []);
    vistos.get(guid).push(`${donde} ${campo}`);
}

/** El informe de `verificar` como una línea, para que quepa en un mensaje de error. */
function comoSeLee(revision) {
    const partes = [];
    if (revision.colgadas.length) {
        const c = revision.colgadas[0];
        partes.push(`${revision.colgadas.length} referencia(s) colgando (${c.clase} ${c.desde} → ${c.a})`);
    }
    if (revision.indices.length) {
        const i = revision.indices[0];
        partes.push(`${revision.indices.length} lista(s) con Index salteado (${i.clase} ${i.lista}: ${i.valores})`);
    }
    if (revision.repetidos.length) {
        const r = revision.repetidos[0];
        partes.push(`${revision.repetidos.length} GUID repetido(s) (${r.guid} en ${r.donde.join(' y ')})`);
    }
    return partes.join('; ') || 'sin novedad';
}

/** Segundos → ticks, redondeado. Es la única traducción de tiempo del formato. */
function aTicks(segundos) {
    return Math.round((Number(segundos) || 0) * TICKS);
}

function aSegundos(ticks) {
    return (Number(ticks) || 0) / TICKS;
}

module.exports = {
    ABRE,
    TICKS,
    CABECERA_ESPERADA,
    OS_DE_PREMIERE,
    CLASES_CON_UID,
    CLASE_CON_ESPACIO_PROPIO,
    ES_GUID,
    Proyecto,
    descomprimir,
    comprimir,
    cabeceraDe,
    generadorDeUid,
    clave,
    parte,
    refsEnTexto,
    aTicks,
    aSegundos,
    comoSeLee
};
