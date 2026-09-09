'use strict';
/**
 * saber-fallar.js — Revierte el arreglo de a un pedazo y mira las pruebas ponerse
 * rojas.
 *
 *   node tools/saber-fallar.js
 *
 * **Una prueba que no se vio fallar no prueba nada**, y es la trampa más barata
 * de esta suite: una aserción escrita después del arreglo puede estar mirando el
 * campo equivocado, o el estado que la app pone igual por otro camino, y pasa en
 * verde para siempre. La única forma de saberlo es deshacer el arreglo y ver el
 * rojo, y la única forma de que eso no se haga "cuando uno se acuerda" es tenerlo
 * escrito.
 *
 * Cada reversión es un cambio de texto sobre un archivo del motor o de la
 * ventana: se aplica, se corren las pruebas que tienen que caerse, se comprueba
 * que se cayeron las que se esperaban, y el archivo vuelve como estaba —pase lo
 * que pase, incluso si el corredor se muere en el medio—.
 *
 * Es una herramienta y no una prueba de la suite a propósito: escribe sobre
 * archivos del repo, y algo que reescribe `engine/transcribe.js` no puede correr
 * en la misma pasada en la que se está comprobando que el motor anda.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

/**
 * Las reversiones, cada una deshaciendo UNA decisión.
 *
 * `caen` es qué pruebas tienen que ponerse rojas, por un pedazo de su nombre. Se
 * pide la lista y no un número porque el número no dice nada: una reversión que
 * rompiera tres pruebas distintas de las que se esperaban daría el mismo total y
 * estaría probando otra cosa.
 */
const REVERSIONES = [
    {
        que: 'el error no cuenta cómo se murió el proceso (se tira el dato del `close`)',
        archivo: 'engine/transcribe.js',
        de: "                err.muerte = comoMurio(code, signal);\n",
        a: '',
        filtro: 'insistir',
        caen: [
            'matar el whisper-cli de verdad',
            'una señal y el segundo intento sale',
            'dos señales: baja de modelo',
            'un código baja de modelo en el acto',
            'si falla hasta el más chico',
            'sin ningún escalón se rinde en dos intentos'
        ]
    },
    {
        que: 'bajar de modelo va por la lista de preferencia y no por el peso',
        archivo: 'engine/paths.js',
        de: '    return (instalados || [])\n        .filter(m => m.bytes < suyo.bytes)\n        .sort((a, b) => b.bytes - a.bytes)[0] || null;',
        a: '    const i = MODEL_PREFERENCE.indexOf(suyo.name);\n'
            + '    return (instalados || []).find(m => MODEL_PREFERENCE.indexOf(m.name) > i && i >= 0) || null;',
        filtro: 'insistir',
        caen: ['el escalón de abajo va por PESO']
    },
    {
        que: 'un código de salida se reintenta igual que una señal',
        archivo: 'engine/insistir.js',
        de: "    if (p.muerte === 'senal' && p.conElBueno && !p.yaInsistio) {",
        a: '    if (p.conElBueno && !p.yaInsistio) {',
        filtro: 'insistir',
        caen: [
            'un código no se reintenta nunca',
            'un código baja de modelo en el acto'
        ]
    },
    {
        que: 'la espera es un número redondo en vez de salir del ciclo de señales',
        archivo: 'engine/insistir.js',
        de: 'const ESPERA_MS = CICLO_MS + PASADA_MS;',
        a: 'const ESPERA_MS = 1000;',
        filtro: 'insistir',
        caen: ['la espera sale del ciclo de señales']
    },
    {
        que: 'no hay política: una pasada que se muere deja la toma como estaba',
        archivo: 'engine/oir-toma.js',
        de: '            if (err && err.code === \'cancelado\') throw err;',
        a: '            if (err) throw err;',
        filtro: 'relectura',
        caen: [
            'queda marcada «sin-leer» en el sidecar',
            'leída con un modelo peor, queda marcada «degradada»',
            'regenerar limpia la marca',
            'una regeneración que tampoco pudo lo dice',
            'una señal se reintenta después de esperar'
        ]
    },
    {
        que: 'el texto descartable se mide como si fuera el bueno',
        archivo: 'engine/relecturas.js',
        de: '        if (!leido.palabras) {\n            espejo.fijar(sesion);\n            return;\n        }',
        a: '        if (!leido.palabras) espejo.fijar(sesion);',
        filtro: 'relectura',
        caen: ['el texto descartable no se mide']
    },
    {
        que: 'la marca vive en memoria y no llega al sidecar',
        archivo: 'engine/notas-xml.js',
        de: '            relectura: t.relectura || null,',
        a: '',
        filtro: 'relectura',
        caen: [
            'queda marcada «sin-leer» en el sidecar',
            'leída con un modelo peor, queda marcada «degradada»',
            'una regeneración que tampoco pudo lo dice'
        ]
    },
    {
        que: 'la tarjeta no dibuja ningún aviso de relectura',
        archivo: 'src/js/grabar/tomas.js',
        de: "    if (r && r.estado === 'degradada') lista.push({ texto: r.porque, clase: 'es-degradada' });\n"
            + "    if (r && r.estado === 'sin-leer') lista.push({ texto: r.porque, clase: 'es-sin-leer' });",
        a: '',
        filtro: 'relectura',
        caen: [
            'la degradada avisa sin ámbar',
            'la sin-leer avisa en el ámbar',
            'y el aviso convive con los que ya estaban'
        ]
    },
    {
        que: 'la degradada se pinta como una falla, en ámbar',
        archivo: 'src/js/grabar/tomas.js',
        de: "clase: 'es-degradada' });",
        a: "clase: 'es-falla' });",
        filtro: 'relectura',
        caen: ['la degradada avisa sin ámbar']
    },
    {
        que: 'el cabezal pliega también cuando el clic cayó en uno de sus botones',
        archivo: 'src/js/grabar/plegado.js',
        de: '    if (!d.enCabezal || d.enControl) return false;',
        a: '    if (!d.enCabezal) return false;',
        filtro: 'plegado',
        caen: ['un clic en un control del cabezal NO pliega']
    },
    {
        que: 'pliega cualquier clic en la tarjeta y no solo el del cabezal',
        archivo: 'src/js/grabar/plegado.js',
        de: '    if (!d.enCabezal || d.enControl) return false;',
        a: '    if (d.enControl) return false;',
        filtro: 'plegado',
        caen: [
            'un clic en el cuerpo de la tarjeta tampoco',
            'sin saber dónde cayó, no pliega'
        ]
    },
    {
        que: 'el cabezal pliega sin preguntar si esa toma se puede plegar',
        archivo: 'src/js/grabar/plegado.js',
        de: '    return Boolean(toma) && sePuedePlegar(toma);',
        a: '    return true;',
        filtro: 'plegado',
        caen: [
            'el cabezal de la que está grabando no pliega',
            'el de una descartada tampoco',
            'sin toma en el estado no se pliega nada'
        ]
    },
    {
        que: 'regenerar no limpia la marca de la toma que arregla',
        archivo: 'engine/clases-grabadas.js',
        de: '            if (leido) Object.assign(toma, leido);',
        a: '            if (leido) Object.assign(toma, { ...leido, relectura: toma.relectura || leido.relectura });',
        filtro: 'relectura',
        caen: ['regenerar limpia la marca']
    },
    {
        que: 'la maqueta se queda con el motor que cargó al arrancar',
        archivo: 'tools/maqueta.js',
        de: '    const guardado = olvidarElMotor();',
        a: '    const guardado = {};',
        filtro: 'maqueta',
        caen: [
            'lo que se inyecta sale del disco y no del caché de módulos',
            'y deja el caché de módulos exactamente como estaba'
        ]
    },
    {
        que: 'suelta solo las cinco hojas y deja el tronco del motor en el caché',
        archivo: 'tools/maqueta.js',
        de: '        if (clave.startsWith(MOTOR + path.sep)) {',
        a: "        const hojas = ['notas-vivo.js', 'lengua.js', 'grabacion.js', 'empalme.js', 'workspace.js'];\n"
            + '        if (hojas.includes(path.basename(clave))) {',
        filtro: 'maqueta',
        caen: ['lo que se inyecta sale del disco y no del caché de módulos']
    },
    {
        que: 'la copia recién leída del motor se queda en el caché de módulos',
        archivo: 'tools/maqueta.js',
        de: '        olvidarElMotor();\n        Object.assign(require.cache, guardado);\n',
        a: '',
        filtro: 'maqueta',
        caen: ['y deja el caché de módulos exactamente como estaba']
    },
    {
        que: 'la huella del disco no mira el disco',
        archivo: 'tools/maqueta.js',
        de: "    return suma.digest('hex').slice(0, 12);",
        a: "    return 'siempre-igual';",
        filtro: 'maqueta',
        caen: ['la huella cambia cuando cambia un archivo, y no cuando no']
    },
    {
        que: 'el material de relleno se da por bueno sin mirar con qué plan se armó',
        archivo: 'tools/maqueta.js',
        de: "    const alDia = fs.existsSync(marca) && fs.readFileSync(marca, 'utf8') === sello;",
        a: '    const alDia = true;',
        filtro: 'maqueta',
        caen: [
            'con el plan cambiado se rehace todo',
            'sin sello se rehace: es material de antes de que esto se sellara'
        ]
    },
    {
        que: 'el índice de la maqueta no carga el vigía',
        archivo: 'tools/maqueta.js',
        de: "        '<script src=\"maqueta/vigia.js\"></script>\\n' +\n",
        a: '',
        filtro: 'maqueta',
        caen: ['el índice carga el vigía, detrás de las vistas y delante de la app']
    }
];

function pruebasQueCayeron(filtro) {
    const r = spawnSync(process.execPath, ['tests/run.js', filtro], { cwd: RAIZ, encoding: 'utf8' });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    return {
        salida,
        rojas: [...salida.matchAll(/^ {2}✗ (.+)$/gm)].map(m => m[1].trim()),
        seCayo: r.status !== 0
    };
}

function correr() {
    let malas = 0;

    for (const rev of REVERSIONES) {
        const completo = path.join(RAIZ, rev.archivo);
        const original = fs.readFileSync(completo, 'utf8');
        if (!original.includes(rev.de)) {
            console.log(`  ✗ ${rev.que}\n      no encontré qué revertir en ${rev.archivo}`);
            malas++;
            continue;
        }

        try {
            fs.writeFileSync(completo, original.replace(rev.de, rev.a));
            const { rojas, seCayo } = pruebasQueCayeron(rev.filtro);
            const faltan = rev.caen.filter(esperada => !rojas.some(roja => roja.includes(esperada)));

            if (!seCayo) {
                console.log(`  ✗ ${rev.que}\n      la suite siguió en verde con el arreglo deshecho`);
                malas++;
            } else if (faltan.length) {
                console.log(`  ✗ ${rev.que}\n      no se cayeron: ${faltan.join(' · ')}`
                    + `\n      se cayeron: ${rojas.join(' · ') || 'ninguna'}`);
                malas++;
            } else {
                console.log(`  ✓ ${rev.que}\n      ${rojas.length} en rojo: ${rojas.join(' · ')}`);
            }
        } finally {
            // Vuelve como estaba pase lo que pase: dejar el motor revertido es
            // mucho peor que no haber corrido esto.
            fs.writeFileSync(completo, original);
        }
    }

    console.log(`\n${REVERSIONES.length - malas} de ${REVERSIONES.length} reversiones se vieron en rojo.`);
    return malas;
}

console.log('\nDeshaciendo el arreglo de a un pedazo:\n');
process.exit(correr() ? 1 : 0);
