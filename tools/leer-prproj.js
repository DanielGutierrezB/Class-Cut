'use strict';
/**
 * leer-prproj.js — Contar qué hay adentro de un proyecto de Premiere.
 *
 *   node tools/leer-prproj.js /ruta/al/Proyecto.prproj
 *   node tools/leer-prproj.js /ruta/al/Proyecto.prproj --clases
 *   node tools/leer-prproj.js /ruta/al/Proyecto.prproj --objeto=42
 *   node tools/leer-prproj.js /ruta/al/Proyecto.prproj --clase=VideoClipTrackItem --cuantos=3
 *
 * Para qué. Un `.prproj` es XML comprimido de catorce megas donde una sola línea
 * puede tener tres millones de caracteres —los transcripts van enteros ahí— así
 * que abrirlo en un editor o grepearlo no sirve para entenderlo. Esto lo lee como
 * lo que es, un grafo de objetos numerados, y contesta las preguntas con las que
 * se empieza siempre: qué objetos hay, qué cuelga de qué, y qué dice uno.
 *
 * Es una herramienta de mirar, no de la app: nada de `engine/` la importa. Está
 * acá y no en un rato de consola porque cada vez que se toca el generador hay que
 * volver a mirar un proyecto de verdad, y rehacer el recorrido del grafo cada vez
 * es donde se cuelan las conclusiones equivocadas. La primera versión de esto
 * suponía que los objetos eran planos y daba respuestas convincentes y falsas:
 * le atribuía a un padre el nombre de un nieto.
 *
 * Lo que NO hace: validar, ni escribir. Si el proyecto está roto, esto lo cuenta
 * igual. Quien decide si un proyecto sirve es Premiere abriéndolo.
 */

const fs = require('fs');
const zlib = require('zlib');
const cli = require('./lib/cli');

/**
 * El grafo, recorriendo las etiquetas con una pila.
 *
 * Los objetos se anidan —un `Sequence` tiene adentro sus `TrackGroup`, que tienen
 * adentro sus `TrackItem`— así que «desde este `ObjectID` hasta el siguiente» no
 * es un objeto: es un objeto y parte de su descendencia. Lo que distingue a uno
 * es dónde cierra su etiqueta, y para saberlo hay que llevar la cuenta.
 *
 * De cada objeto quedan sus campos PROPIOS, que son los que están directamente
 * adentro y no dentro de un objeto anidado. Es la diferencia entre «esta
 * secuencia se llama X» y «algo allá abajo se llama X».
 *
 * **Hay DOS sistemas de direcciones y hay que leer los dos.** Unos objetos se
 * identifican con `ObjectID` numérico y se apuntan con `ObjectRef`; otros —los
 * bins, los clips del proyecto, las secuencias— con `ObjectUID`, que es un GUID,
 * y se apuntan con `ObjectURef`. Un lector que solo mire los numéricos encuentra
 * diecinueve mil objetos y ni un solo bin, y concluye que el proyecto no tiene
 * carpetas. El árbol que se ve en la ventana de proyecto está del lado de los
 * GUID.
 *
 * @returns {{porId: Map<number, obj>, porUid: Map<string, obj>}}
 */
function leerGrafo(xml) {
    const porId = new Map();
    const porUid = new Map();
    const pila = [];
    // Etiquetas y texto. El `[^>]*` alcanza porque los valores de atributo del
    // formato no traen `>`; si algún día lo trajeran, esto contaría de más y se
    // notaría enseguida como objetos que no cierran.
    const re = /<(\/?)([A-Za-z0-9_.]+)([^>]*?)(\/?)>([^<]*)/g;
    let m;
    while ((m = re.exec(xml))) {
        const [, cierra, etiqueta, attrs, solo, texto] = m;
        const arriba = pila[pila.length - 1];

        if (cierra) {
            if (arriba && arriba.etiqueta === etiqueta) {
                const fue = pila.pop();
                if (fue.obj) fue.obj.hasta = m.index + m[0].length - texto.length;
            }
            // El texto que sigue a un cierre pertenece al padre, no al que cerró.
            const ahora = pila[pila.length - 1];
            if (ahora && ahora.obj && texto.trim()) ahora.obj.suelto.push(texto.trim());
            continue;
        }

        const idM = attrs.match(/ObjectID="(\d+)"/);
        const uidM = attrs.match(/ObjectUID="([0-9a-f-]+)"/);
        if ((idM || uidM) && !solo) {
            const dueño = pila.filter(p => p.obj).pop();
            const obj = {
                clase: etiqueta,
                id: idM ? Number(idM[1]) : null,
                uid: uidM ? uidM[1] : null,
                claseUid: (attrs.match(/ClassID="([^"]+)"/) || [])[1] || null,
                version: (attrs.match(/Version="(\d+)"/) || [])[1] || null,
                padre: dueño ? dueño.obj : null,
                hijos: [],
                campos: new Map(),
                refs: [],
                suelto: [],
                desde: m.index,
                hasta: -1
            };
            if (dueño) dueño.obj.hijos.push(obj);
            if (obj.id != null) porId.set(obj.id, obj);
            if (obj.uid) porUid.set(obj.uid, obj);
            pila.push({ etiqueta, obj });
            continue;
        }

        // Una referencia. Cuenta para el objeto que la contiene, que es de quien
        // sale la arista. Las hay de las dos clases: `ObjectRef` a un numérico y
        // `ObjectURef` a un GUID.
        const refM = attrs.match(/Object(U?)Ref="([^"]+)"/);
        const mío = pila.filter(p => p.obj).pop();
        if (refM && mío) mío.obj.refs.push({ campo: etiqueta, a: refM[1] ? refM[2] : Number(refM[2]), porUid: !!refM[1] });

        if (!solo) pila.push({ etiqueta, obj: null });
        // Un campo propio: `<Name>algo</Name>`. Se guarda contra el objeto que lo
        // contiene, no contra el de más arriba.
        if (mío && texto.length && !refM) {
            if (!mío.obj.campos.has(etiqueta)) mío.obj.campos.set(etiqueta, texto);
        }
    }
    return { porId, porUid };
}

const campo = (o, n) => (o && o.campos.get(n)) || null;
const nombre = o => campo(o, 'Name');
const como = o => `${o.clase}${o.id != null ? `#${o.id}` : ''}${o.uid ? `@${o.uid.slice(0, 8)}` : ''}` +
    (nombre(o) ? `«${nombre(o)}»` : '');

/** El camino hasta la raíz, para saber dónde vive un objeto. */
function camino(o) {
    const partes = [];
    while (o) { partes.unshift(como(o)); o = o.padre; }
    return partes.join(' / ');
}

/**
 * El árbol que el editor ve en la ventana de proyecto.
 *
 * Se arma siguiendo los `ObjectURef` de cada `ProjectItemContainer`, que es la
 * lista de lo que hay adentro de un bin. No coincide con el anidamiento del XML:
 * los bins están todos al mismo nivel del archivo y quién cuelga de quién lo dice
 * esa lista, no la sangría.
 */
function arbolDeBins(porUid) {
    const hijosDe = new Map();
    for (const o of porUid.values()) {
        const míos = o.refs.filter(r => r.porUid && r.campo === 'Item').map(r => r.a);
        if (míos.length) hijosDe.set(o.uid, míos);
    }
    const colgados = new Set([...hijosDe.values()].flat());
    const raíces = [...porUid.values()].filter(o => !colgados.has(o.uid));
    const líneas = [];
    const bajar = (o, hondo) => {
        líneas.push(`${'    '.repeat(hondo)}${nombre(o) || '(sin nombre)'}   ·   ${o.clase}`);
        for (const uid of hijosDe.get(o.uid) || []) {
            const h = porUid.get(uid);
            if (h) bajar(h, hondo + 1); else líneas.push(`${'    '.repeat(hondo + 1)}(falta ${uid})`);
        }
    };
    for (const r of raíces) bajar(r, 0);
    return líneas;
}

function main() {
    const ruta = process.argv[2];
    if (!ruta || ruta.startsWith('--')) {
        console.error('Uso: node tools/leer-prproj.js <archivo.prproj> [--clases] [--objeto=N] [--clase=X]');
        process.exit(2);
    }
    const crudo = fs.readFileSync(ruta);
    const xml = (crudo[0] === 0x1f && crudo[1] === 0x8b ? zlib.gunzipSync(crudo) : crudo).toString('utf8');
    const { porId, porUid } = leerGrafo(xml);
    const todos = [...new Set([...porId.values(), ...porUid.values()])];
    console.log(`${ruta}`);
    console.log(`  ${(crudo.length / 1e6).toFixed(2)} MB comprimido · ${(xml.length / 1e6).toFixed(2)} MB de XML`);
    console.log(`  ${todos.length} objetos · ${porId.size} con ObjectID numérico · ${porUid.size} con ObjectUID (GUID)`);

    const busca = clave => (typeof clave === 'string' && clave.includes('-') ? porUid : porId).get(clave);

    const unoSolo = cli.arg('objeto', null);
    if (unoSolo != null) {
        const o = busca(String(unoSolo).includes('-') ? String(unoSolo) : Number(unoSolo));
        if (!o) { console.error(`No hay objeto ${unoSolo}`); process.exit(1); }
        console.log(`\n─── ${camino(o)} ───`);
        console.log(`  ClassID ${o.claseUid} · Version ${o.version} · ${o.hijos.length} hijos anidados`);
        console.log('  campos propios:');
        for (const [k, v] of o.campos) console.log(`    ${k} = ${v.length > 110 ? v.slice(0, 110) + '…' : v}`);
        console.log('  apunta a:');
        for (const r of o.refs.slice(0, Number(cli.arg('refs', 40)))) {
            const d = busca(r.a);
            console.log(`    ${r.campo} → ${r.a}${d ? `  (${como(d)})` : '  (¡no está!)'}`);
        }
        if (cli.arg('crudo', null) != null) {
            console.log(`\n  crudo:\n${xml.slice(o.desde, Math.min(o.hasta, o.desde + Number(cli.arg('largo', 4000))))}`);
        }
        return;
    }

    const soloClase = cli.arg('clase', null);
    if (soloClase) {
        const suyos = todos.filter(o => o.clase === soloClase);
        console.log(`\n─── ${suyos.length} ${soloClase} ───`);
        for (const o of suyos.slice(0, Number(cli.arg('cuantos', 10)))) {
            console.log(`\n  ${como(o)} en ${o.padre ? camino(o.padre) : '(raíz)'}`);
            for (const [k, v] of o.campos) console.log(`    ${k} = ${v.length > 110 ? v.slice(0, 110) + '…' : v}`);
            for (const r of o.refs.slice(0, Number(cli.arg('refs', 12)))) {
                const d = busca(r.a);
                console.log(`    → ${r.campo} ${r.a}${d ? `  (${como(d)})` : ''}`);
            }
        }
        return;
    }

    const porClase = new Map();
    for (const o of todos) porClase.set(o.clase, (porClase.get(o.clase) || 0) + 1);
    const orden = [...porClase].sort((a, b) => b[1] - a[1]);
    console.log(`\n─── ${orden.length} clases distintas ───`);
    for (const [clase, n] of (cli.arg('clases', null) ? orden : orden.slice(0, 25))) {
        const ej = todos.find(o => o.clase === clase && nombre(o));
        console.log(`  ${String(n).padStart(5)}  ${clase.padEnd(30)}${ej ? ` p.ej. «${nombre(ej)}»` : ''}`);
    }

    console.log('\n─── la ventana de proyecto ───');
    for (const l of arbolDeBins(porUid)) console.log(`  ${l}`);
}

if (require.main === module) main();
module.exports = { leerGrafo, campo, nombre, camino };
