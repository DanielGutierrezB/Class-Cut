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
        que: 'las clases del nido se pegan una tras otra, sin el aire de cinco minutos',
        archivo: 'engine/prproj-nidos.js',
        de: '        reloj += largoSeg + AIRE_SEG;',
        a: '        reloj += largoSeg;',
        filtro: 'prproj-nidos',
        caen: ['cada clase arranca después de la anterior más el aire']
    },
    {
        que: 'la franja se mide con la primera fuente en vez de con la más larga',
        archivo: 'engine/prproj-nidos.js',
        de: '        largo = Math.max(largo, archivo.duracionSeg || 0);',
        a: '        if (!largo) largo = archivo.duracionSeg || 0;',
        filtro: 'prproj-nidos',
        caen: ['la franja la marca la fuente más larga, no la primera']
    },
    {
        que: 'los cortes entran al nido sin correrse por la franja de su clase',
        archivo: 'engine/prproj-curso.js',
        de: '            entradaSeg: franja.desdeSeg + corte.entradaSeg,',
        a: '            entradaSeg: corte.entradaSeg,',
        filtro: 'prproj-curso',
        caen: ['un corte entra en el nido corrido por la franja de su clase']
    },
    {
        que: 'el recuadro vuelve a ser una anidación aparte en vez de la misma CAM',
        archivo: 'engine/prproj-curso.js',
        de: '            const recuadro = poner(pista.mini, nidos.camara, corte, true, nidos.etiquetaDeCamara);',
        a: '            const recuadro = poner(pista.mini, nidos.slide, corte, true, nidos.etiquetaDeCamara);',
        filtro: 'prproj-curso',
        caen: ['el recuadro es la misma «CAM», no una anidación aparte',
            'con una S la clase lleva cuatro, y el recuadro queda arriba de todo']
    },
    {
        que: 'el respaldo de audio vuelve a ser una segunda copia del mismo nido',
        archivo: 'engine/prproj-curso.js',
        de: '                pista: secuencia.pistasAudio[1],\n'
            + '                medio,',
        a: '                pista: secuencia.pistasAudio[1],\n'
            + '                medio: nidos.audio.comoFuente,',
        filtro: 'prproj-curso',
        caen: ['arriba el nido de audio y abajo el Live-Mix crudo, muteado']
    },
    {
        que: 'la mezcla se busca por posición y no por cuál quedó sonando',
        archivo: 'engine/prproj-nidos.js',
        de: '    const suenan = clase.pistas.audio.filter(p => p.cortes.some(c => c.sonando));\n'
            + '    return suenan.length === 1 ? suenan[0] : null;',
        a: '    return clase.pistas.audio[clase.pistas.audio.length - 1] || null;',
        filtro: 'prproj-nidos',
        caen: ['la mezcla es la única que suena, esté donde esté',
            'con dos sonando no hay una mezcla, así que no se elige ninguna']
    },
    {
        que: 'los nidos vuelven a quedar verdes en el panel, como cualquier otra secuencia',
        archivo: 'engine/prproj-nidos.js',
        de: '        taller.pintarItemDelPanel(nido.itemDelPanel, etiqueta);',
        a: '',
        filtro: 'prproj-curso',
        caen: ['cada nido llega del color de su pista, también en el panel']
    },
    {
        que: 'un nido hereda del molde cuánto material dice tener',
        archivo: 'engine/prproj-secuencia.js',
        de: '                if (tics > 0) {',
        a: '                if (false) {',
        filtro: 'prproj-curso',
        caen: ['un nido dice que dura lo que dura, y no lo que duraba el molde']
    },
    {
        que: 'con slides no se agrega la pista, y el recuadro queda tapado',
        archivo: 'engine/prproj-curso.js',
        de: '    const pistasVideo = hayS ? 4 : 3;',
        a: '    const pistasVideo = 3;',
        filtro: 'prproj-curso',
        caen: ['con una S la clase lleva cuatro, y el recuadro queda arriba de todo']
    },
    {
        que: 'el recuadro se copia con todo lo que venga colgado al lado en la plantilla',
        archivo: 'engine/prproj-secuencia.js',
        de: '        const sobran = componentes.filter(k => k !== componente);',
        a: '        const sobran = [];',
        filtro: 'prproj-curso',
        caen: ['el recuadro sale con la geometría medida en el Premiere del editor']
    },
    {
        que: 'el corte sin anidar deja de anexarse al proyecto',
        archivo: 'engine/prproj-curso.js',
        de: 'const PASOS = PASOS_PREVIOS.concat([PASO_SIN_ANIDAR]);',
        a: 'const PASOS = PASOS_PREVIOS;',
        filtro: 'prproj-curso',
        caen: ['sin nada en Backup, «Pre» igual trae el corte sin anidar',
            'los pasos previos entran en «Pre», un bin por paso y adentro cada clase']
    },
    {
        que: 'MG y X2 vuelven a quedarse sin marcador cuando nadie escribió una nota',
        archivo: 'engine/export.js',
        de: "        if (!texto && !SE_MARCAN_SIEMPRE.has(segment.view)) continue;",
        a: '        if (!texto) continue;',
        filtro: 'export',
        caen: ['MG y X2 dejan marcador aunque nadie haya escrito nada']
    },
    {
        que: 'un error espera al temporizador para volcarse, como cualquier línea',
        archivo: 'engine/registro.js',
        de: '        if (HUELE_A_PROBLEMA.test(linea.evento)) volcar();\n        else programarVolcado();',
        a: '        programarVolcado();',
        filtro: 'registro',
        caen: ['un error se vuelca en el acto, sin esperar al temporizador']
    },
    {
        que: 'la descarga vuelve a mirar solo la memoria y pierde las corridas de antes',
        archivo: 'engine/registro.js',
        de: '    const cuales = guardadas.length ? guardadas : lineas;',
        a: '    const cuales = lineas;',
        filtro: 'registro',
        caen: ['la descarga junta las corridas de antes, no solo la de ahora']
    },
    {
        que: 'una línea rota en el diario se lleva puesto el resto del archivo',
        archivo: 'engine/registro.js',
        de: '        try {\n            salida.push(JSON.parse(renglon));\n        } catch (err) {',
        a: '        try {\n            salida.push(JSON.parse(renglon));\n        } catch (err) {\n            throw err;',
        filtro: 'registro',
        caen: ['una línea cortada por la mitad no se lleva puesto el resto']
    },
    {
        que: 'el recuadro no se aplica, y el proyecto se calla que falta',
        archivo: 'engine/prproj-curso.js',
        de: '            if (recuadro && !taller.ponerEncuadre(recuadro, nidos.encuadre)) sinRecuadro++;',
        a: '',
        filtro: 'prproj-curso',
        caen: ['el recuadro sale con la geometría medida en el Premiere del editor']
    },
    {
        que: 'la cuenta de lo que entró vuelve a ser un aviso y tapa a los de verdad',
        archivo: 'engine/prproj-curso.js',
        de: "    cuenta.push(`${armadas.length} secuencia(s), ${cortes} corte(s), ${marcas} marcador(es)`",
        a: "    avisos.push(`${armadas.length} secuencia(s), ${cortes} corte(s), ${marcas} marcador(es)`",
        filtro: 'prproj-curso',
        caen: ['un aviso de una sola clase no queda tapado por la narración']
    },
    {
        que: 'la búsqueda de plantilla toma la primera que encuentra, sin ordenar por fecha',
        archivo: 'ipc/prproj.js',
        de: '    return encontrados.sort((a, b) => b.cuando - a.cuando).map(c => c.ruta);',
        a: '    return encontrados.map(c => c.ruta);',
        filtro: 'prproj-plantilla',
        caen: ['del más nuevo al más viejo']
    },
    {
        que: 'un proyecto nuestro se reconoce con que tenga UN bin de los seis',
        archivo: 'ipc/prproj.js',
        de: 'return NUESTROS_BINS.every(b => xml.includes(`<Name>${b}</Name>`));',
        a: 'return NUESTROS_BINS.some(b => xml.includes(`<Name>${b}</Name>`));',
        filtro: 'prproj-plantilla',
        caen: ['y con cinco de los seis, no']
    },
    {
        que: 'los GUID de los marcadores se pierden en un segundo module.exports',
        archivo: 'engine/prproj-moldes.js',
        de: '    CLASE_MARKERS,\n    CLASE_MARKER,\n',
        a: '',
        filtro: 'desestructurar',
        caen: ['todo lo desestructurado existe del otro lado']
    },
    {
        que: 'generar un proyecto pisa el que ya estaba, con la tarde de edición adentro',
        archivo: 'ipc/prproj.js',
        de: '        const otro = path.join(dir, `${base} ${n}${ext}`);\n        if (!fs.existsSync(otro)) return otro;',
        a: '        return path.join(dir, `${base}${ext}`);',
        filtro: 'prproj-destino',
        caen: [
            'con el nombre ocupado, el de al lado es el 2 y no pisa al 1',
            'y sigue contando mientras encuentre ocupado'
        ]
    },
    {
        que: 'el proyecto se llama como se nos ocurra y no como la carpeta del curso',
        archivo: 'ipc/prproj.js',
        de: "return path.join(carpeta, 'Proyecto', `${path.basename(carpeta)}.prproj`);",
        a: "return path.join(carpeta, 'Proyecto', 'Curso.prproj');",
        filtro: 'prproj-destino',
        caen: [
            'el proyecto se llama como la carpeta del curso',
            'una carpeta con espacios o puntos no rompe el nombre',
            'una barra al final no deja el nombre vacío'
        ]
    },
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
        que: 'lo pegado sin sesión se tira, como antes de que hubiera dónde pegarlo',
        archivo: 'engine/grabacion.js',
        de: '    if (!sesion) return { temario: temarioSesion.ponerEnElCurso(dir, texto) };',
        a: '    if (!sesion) return { temario: null };',
        filtro: 'temario',
        // Las dos que NO se caen, y por qué. "Pegar una lista vacía saca el
        // archivo" pasa en verde porque sin nada pegado el archivo no llegó a
        // existir: es una prueba que este cambio deja sin sujeto, y la cuida su
        // propia reversión, la de más abajo. Y "lo que se lee es lo de la sesión"
        // pasa porque la sesión sí guarda: ahí el pegado no es el de antes de
        // grabar. Anotarlas como caídas era pedirle a esta reversión que probara
        // algo que no está probando.
        caen: [
            'sin sesión, lo pegado queda escrito en la carpeta',
            'y de ahí la lee la pantalla, sin ninguna clase de por medio',
            'la clase que arranca después nace con esa lista',
            'y le gana a la de la clase anterior, que es la que puede estar vieja',
            'pegar a mano la lista que llegó sola no tira la cobertura ya medida'
        ]
    },
    {
        que: 'la clase nueva solo mira el sidecar de la anterior y no la lista de la carpeta',
        archivo: 'engine/temario-sesion.js',
        de: '    return leerDelCurso(dir) || deLaClaseAnterior(dir);',
        a: '    return deLaClaseAnterior(dir);',
        filtro: 'temario',
        caen: [
            'la clase que arranca después nace con esa lista',
            'y le gana a la de la clase anterior, que es la que puede estar vieja',
            'pegar a mano la lista que llegó sola no tira la cobertura ya medida'
        ]
    },
    {
        que: 'lo pegado con la clase empezada se queda solo en el sidecar de esa clase',
        archivo: 'engine/temario-sesion.js',
        de: '    guardarEnElCurso(sesion.dir, texto);\n',
        a: '',
        filtro: 'temario',
        caen: ['lo pegado con la clase ya empezada también queda para el curso']
    },
    {
        que: 'la lista recién pegada se contesta a sí misma que llegó sola',
        archivo: 'engine/temario-sesion.js',
        de: "    return puesta && { ...puesta, origen: 'pegado' };",
        a: '    return puesta;',
        filtro: 'temario',
        caen: ['lo que vuelve de pegarla dice «pegado», aunque en la carpeta quede «guardado»']
    },
    {
        que: 'una lista vacía deja el archivo del curso donde estaba',
        archivo: 'engine/temario-sesion.js',
        de: "        try { fs.unlinkSync(archivo); } catch (e) { /* si no estaba, ya está sacada */ }",
        a: '',
        filtro: 'temario',
        caen: ['pegar una lista vacía saca el archivo, no lo deja vacío']
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
    },
    {
        que: 'las últimas carpetas crecen sin tope',
        archivo: 'engine/ajustes.js',
        de: '[...new Set(recientes)].slice(0, RECIENTES)',
        a: '[...new Set(recientes)]',
        filtro: 'recientes',
        caen: [
            'el tope lo pone el saneado, así que nadie lo puede pasar por arriba',
            'pasado el tope se cae la que hace más que nadie abre'
        ]
    },
    {
        que: 'la lista se ordena por cuándo se agregó y no por el último uso',
        archivo: 'engine/ajustes.js',
        de: 'carpetasRecientes: [ruta].concat(antes.carpetasRecientes.filter(d => d !== ruta))',
        a: 'carpetasRecientes: antes.carpetasRecientes.filter(d => d !== ruta).concat(ruta)',
        filtro: 'recientes',
        caen: [
            'la última abierta va primera',
            'volver a abrir una que ya estaba la sube, no la duplica',
            'pasado el tope se cae la que hace más que nadie abre'
        ]
    },
    {
        que: 'recordar una carpeta se lleva puesto el resto de los ajustes',
        archivo: 'engine/ajustes.js',
        de: '    return guardar({\n        ...antes,\n        carpetasRecientes:',
        a: '    return guardar({\n        carpetasRecientes:',
        filtro: 'recientes',
        caen: ['recordar una carpeta no toca lo demás de los ajustes']
    },
    {
        que: 'la ruta se muestra entera y que la corte el navegador por donde caiga',
        archivo: 'src/js/formato.js',
        de: "    return raiz + [...partes.slice(0, cabeza), '…', ...partes.slice(-cola)].join('/');",
        a: '    return raiz + partes.join(\'/\');',
        filtro: 'recientes',
        caen: [
            'se pliega por el medio, que es donde no dice nada',
            'plegada mide menos que entera: si no, no sirvió de nada',
            'no inventa una barra donde no había'
        ]
    },

    // ── El proyecto de Premiere ──

    {
        que: 'el gzip sale con el XFL que le deja el nivel 9 y no el que escribe Premiere',
        archivo: 'engine/prproj.js',
        de: '    gz[8] = 0;\n',
        a: '',
        filtro: 'prproj.test',
        caen: [
            'la cabecera sale con los cuatro campos forzados',
            'guardar un proyecto sano deja un archivo que se puede releer'
        ]
    },
    {
        que: 'un objeto raíz se reconoce a cualquier profundidad (se pierde la regla de la tabulación)',
        archivo: 'engine/prproj.js',
        de: "const ABRE = /^\\t<([A-Za-z0-9_.]+) Object(ID|UID)=\"([^\"]+)\"/;",
        a: "const ABRE = /^\\s*<([A-Za-z0-9_.]+) Object(ID|UID)=\"([^\"]+)\"/;",
        filtro: 'prproj.test',
        caen: ['lo que cuelga del <Project> no entra al índice']
    },
    {
        que: 'al clonar se renueva también el <DefMappingID>, que es una constante y no una identidad',
        archivo: 'engine/prproj.js',
        de: 'const GUID_SUELTO = /<(ID|ClipID)>([^<]*)<\\/(?:ID|ClipID)>/g;',
        a: 'const GUID_SUELTO = /<(ID|ClipID|DefMappingID)>([^<]*)<\\/(?:ID|ClipID|DefMappingID)>/g;',
        filtro: 'prproj.test',
        caen: ['<ID> y <ClipID> se renuevan; <DefMappingID> no']
    },
    {
        que: 'guardar escribe sin verificar que el grafo cierre',
        archivo: 'engine/prproj.js',
        de: '        if (!revision.ok) throw new Error(`el grafo no cierra: ${comoSeLee(revision)}`);\n',
        a: '',
        filtro: 'prproj.test',
        caen: ['guardar se niega a escribir un proyecto roto, y no deja el archivo']
    },
    {
        que: 'un bin recién creado se queda con la lista de ítems vacía en vez de sin lista',
        archivo: 'engine/prproj-secuencia.js',
        de: "        p.escribir(bin, p.contenido(bin).replace(/\\n\\t*<Items Version=\"\\d+\">[\\s\\S]*?<\\/Items>/, ''));",
        a: "        ponerLista(p, bin, 'Items', 'Item', []);",
        filtro: 'prproj-panel',
        caen: ['un bin recién creado no lleva lista de ítems']
    },
    {
        que: 'el color de un bin se hereda del molde en vez de escribirse',
        archivo: 'engine/prproj-secuencia.js',
        de: "        const props = { 'Column.PropertyText.Label': `BE.Prefs.LabelColors.${ETIQUETAS[COLOR_DE.bin].indice}` };",
        a: '        const props = {};',
        filtro: 'prproj-panel',
        caen: ['un bin sale mango, sin importar de qué color era el que se copió']
    },
    {
        que: 'la poda borra los moldes al descolgar, antes de haber clonado nada',
        archivo: 'engine/prproj-secuencia.js',
        de: '        this._deLaPlantilla = new Set(p.cierre([raiz], {}).filter(k => k !== raiz));',
        a: '        this._deLaPlantilla = new Set(p.cierre([raiz], {}).filter(k => k !== raiz));\n'
            + '        for (const k of this._deLaPlantilla) p.borrar(k);',
        filtro: 'prproj-panel',
        caen: ['pero no borra nada todavía, porque de ahí se clona']
    },
    {
        que: 'la poda mira lo que había antes en vez de lo que la raíz alcanza hoy',
        archivo: 'engine/prproj-secuencia.js',
        de: '            if (!vivos.has(k) && p.tiene(k)) { p.borrar(k); podados++; }',
        a: '            if (p.tiene(k)) { p.borrar(k); podados++; }',
        filtro: 'prproj-panel',
        caen: [
            'y no toca lo que el curso volvió a colgar',
            'y el archivo queda sano después de podar'
        ]
    },
    {
        que: 'guardar el primer ítem de un bin da por hecho que la lista ya está',
        archivo: 'engine/prproj-secuencia.js',
        de: "        if (ubicarLista(p.contenido(contenedor), 'Items')) {\n"
            + "            agregarALista(p, contenedor, 'Items', 'Item', attrs);\n"
            + '            return;\n'
            + '        }',
        a: "        agregarALista(p, contenedor, 'Items', 'Item', attrs);\n"
            + '        if (true) return;',
        filtro: 'prproj-panel',
        caen: ['guardar el primer ítem crea la lista que no estaba']
    },
    {
        que: 'la ruta del clip se toma de la URL sin desescaparla',
        archivo: 'engine/clase-del-xml.js',
        de: '    return limpia.split(\'/\').map(seg => {\n'
            + '        try { return decodeURIComponent(seg); } catch (e) { return seg; }\n'
            + '    }).join(\'/\');',
        a: '    return limpia;',
        filtro: 'prproj-clase',
        caen: [
            'la ruta vuelve desescapada',
            'un nombre con acentos y espacios sobrevive la ida y la vuelta'
        ]
    },
    {
        que: 'los canales se suponen estéreo en vez de leer lo que midió ffprobe',
        archivo: 'engine/clase-del-xml.js',
        de: '            canales: canales == null ? 2 : Math.min(2, Math.max(1, Math.round(canales))),',
        a: '            canales: 2,',
        filtro: 'prproj-clase',
        caen: ['el recuento de canales es el que midió ffprobe, no una suposición']
    },
    {
        que: 'las pistas explotadas por canal no se vuelven a juntar (el estéreo queda partido en dos)',
        archivo: 'engine/clase-del-xml.js',
        de: '    const salida = [];\n'
            + '    for (const pista of pistas) {\n'
            + '        const antes = salida[salida.length - 1];\n'
            + '        if (antes && mismoMaterial(antes, pista)) continue;\n'
            + '        salida.push(pista);\n'
            + '    }\n'
            + '    return salida;',
        a: '    return pistas;',
        filtro: 'prproj-clase',
        caen: ['un par explotado vuelve a ser una pista']
    },
    {
        que: 'dos pistas se juntan por tener el mismo archivo, sin mirar si traen los mismos cortes',
        archivo: 'engine/clase-del-xml.js',
        de: '    return a.cortes.every((c, i) =>\n'
            + '        c.desdeSeg === b.cortes[i].desdeSeg && c.hastaSeg === b.cortes[i].hastaSeg\n'
            + '        && c.entradaSeg === b.cortes[i].entradaSeg);',
        a: '    return true;',
        filtro: 'prproj-clase',
        caen: ['el mismo archivo en dos pistas con cortes distintos NO se junta']
    },
    {
        que: 'el bloque de audio se busca desde el <media> y lo caza el de una definición de archivo',
        archivo: 'engine/clase-del-xml.js',
        de: "    return { cuerpo, video: video.texto, audio: bloqueDe(cuerpo, 'audio', video.fin).texto };",
        a: "    return { cuerpo, video: video.texto, audio: bloqueDe(cuerpo, 'audio', media).texto };",
        filtro: 'prproj-clase',
        caen: [
            'un <enabled>FALSE</enabled> es una pista que entra apagada',
            'un par explotado vuelve a ser una pista',
            'diez fuentes distintas quedan en diez pistas'
        ]
    },
    {
        que: 'las notas en vivo le ganan a las clases procesadas (se elige la fuente pobre)',
        archivo: 'engine/prproj-curso.js',
        de: "    const cortes = xmlsDe(dirCortes);\n"
            + "    if (cortes.length) return { ok: true, tipo: 'cortes', dir: dirCortes, xmls: cortes };\n"
            + '\n'
            + '    const notas = xmlsDe(dirNotas);\n'
            + "    if (notas.length) return { ok: true, tipo: 'notas', dir: dirNotas, xmls: notas };",
        a: "    const notas = xmlsDe(dirNotas);\n"
            + "    if (notas.length) return { ok: true, tipo: 'notas', dir: dirNotas, xmls: notas };\n"
            + '\n'
            + '    const cortes = xmlsDe(dirCortes);\n'
            + "    if (cortes.length) return { ok: true, tipo: 'cortes', dir: dirCortes, xmls: cortes };",
        filtro: 'prproj-curso',
        caen: ['con clases procesadas manda The Cutter']
    },
    {
        que: 'el motor arranca sin que le digan dónde escribir, y después inventa',
        archivo: 'engine/prproj-curso.js',
        de: "    if (!op.destino) return { ...vacio, error: 'No me dijeron dónde escribir el proyecto.' };\n",
        a: '',
        filtro: 'prproj-curso',
        caen: ['sin destino no se arranca, aunque todo lo demás esté']
    },
    {
        que: 'una escritura fallida deja la carpeta del destino recién creada y vacía',
        archivo: 'engine/prproj.js',
        de: '            if (laCreamos) {\n'
            + '                // Solo si quedó vacía: si alguien más metió algo adentro mientras\n'
            + '                // tanto, borrarla sería llevarse puesto lo ajeno.\n'
            + '                try { fs.rmdirSync(carpeta); } catch (e2) { /* con algo adentro, se queda */ }\n'
            + '            }\n',
        a: '',
        filtro: 'prproj.test',
        caen: ['y si la escritura falla, no queda una carpeta vacía']
    },
    {
        que: 'al fallar se borra la carpeta del destino aunque ya estuviera de antes',
        archivo: 'engine/prproj.js',
        de: '        const laCreamos = !fs.existsSync(carpeta);',
        a: '        const laCreamos = true;',
        filtro: 'prproj.test',
        caen: ['pero una carpeta que ya estaba no se toca']
    },
    {
        que: 'los intermedios del pipeline entran como si fueran clases',
        archivo: 'engine/prproj-curso.js',
        de: '        .filter(e => e.isFile() && /\\.xml$/i.test(e.name)\n'
            + '            && !INTERMEDIOS.test(e.name) && e.name !== MAESTRO)',
        a: '        .filter(e => e.isFile() && /\\.xml$/i.test(e.name))',
        filtro: 'prproj-curso',
        caen: ['los intermedios del pipeline no se confunden con la entrega']
    },
    {
        que: 'el bin de cada paso previo se llama como se nos ocurra y no como el archivo del Backup',
        archivo: 'engine/prproj-curso.js',
        de: "    nombre: path.basename(workspace.FILES[artefacto], '.xml')",
        a: '    nombre: artefacto',
        filtro: 'prproj-curso',
        caen: [
            'los pasos previos entran en «Pre», un bin por paso y adentro cada clase',
            'a una clase le puede faltar un paso: se saltea y se cuenta, no se rompe'
        ]
    },
    // Acá vivía «Pre se crea vacío cuando no hay ningún paso guardado». Se sacó
    // al anexar el corte sin anidar: ese paso es el XML del que se leyó la clase,
    // así que existe siempre y `Pre` ya no puede quedar vacío mientras haya
    // clases. La guarda sigue en el código —protege el caso de que alguien borre
    // los XML mientras se genera— pero ninguna prueba puede llegar hasta ahí, y
    // una reversión que no se ve en rojo no dice nada.
    {
        que: 'los pasos previos vuelven a importar el material, que ya estaba en el panel',
        archivo: 'engine/prproj-curso.js',
        de: '                medios = importarMaterial(taller, leida, registro,\n'
            + '                    binDeMaterial(clase, indice), suyos);',
        a: '                medios = importarMaterial(taller, leida, new Map(),\n'
            + '                    binDeMaterial(clase, indice), suyos);',
        filtro: 'prproj-curso',
        caen: ['el material de los pasos previos es el mismo, no una segunda copia']
    },
    {
        que: 'un paso que falta no se cuenta, así que nadie se entera de que no está',
        archivo: 'engine/prproj-curso.js',
        de: '            if (!ruta || !fs.existsSync(ruta)) { faltan++; continue; }',
        a: '            if (!ruta || !fs.existsSync(ruta)) continue;',
        filtro: 'prproj-curso',
        caen: [
            'a una clase le puede faltar un paso: se saltea y se cuenta, no se rompe',
            'sin nada en Backup, «Pre» igual trae el corte sin anidar'
        ]
    },
    {
        que: 'el aviso de una clase se repite una vez por paso previo',
        archivo: 'engine/prproj-curso.js',
        de: '        if (dichos.has(aviso)) continue;\n',
        a: '',
        filtro: 'prproj-curso',
        caen: ['el aviso de una clase no se repite una vez por paso']
    },
    {
        que: 'a las notas en vivo se les buscan pasos previos en la carpeta del otro flujo',
        archivo: 'engine/prproj-curso.js',
        de: "            carpeta: fuente.tipo === 'cortes' ? op.carpeta : null",
        a: '            carpeta: op.carpeta',
        filtro: 'prproj-curso',
        caen: ['las notas en vivo no tienen pasos previos que mostrar']
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
