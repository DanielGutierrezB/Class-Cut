/**
 * marker-anchor.js — Módulo PURO: dónde va el corte SEGÚN LA NOTA DEL CD.
 *
 * El dato que nadie estaba usando: el marcador ya dice con qué frase abre y con
 * qué frase cierra el bloque. La convención del CD es
 *
 *   IN  → comentario "<nota del editor> -  Del lado cualitativo podemos tener, qué"
 *   OUT → comentario "OUT: de un tipo de evidencia la que vamos a considerar."
 *
 * (los textos vienen recortados a ~50 caracteres: al IN le falta el final de la
 * última palabra, al OUT le falta el principio de la primera).
 *
 * Con eso el corte deja de ser una adivinanza. En vez de preguntarle al LLM
 * "¿cuál de estas 12 pausas es la buena?" —que es donde se equivoca, porque una
 * clase repite la misma frase cinco veces— aquí se BUSCA esa frase en el
 * transcript y el corte cae en su primera/última palabra.
 *
 * El emparejamiento es difuso a propósito: el CD escribe de oído y el STT
 * transcribe a su manera ("tendencia"/"tendencias", "supreguntas", tildes). Se
 * comparan palabras normalizadas permitiendo huecos, prefijos y una letra de
 * diferencia.
 *
 * Cuando la frase aparece varias veces (tomas repetidas) se resuelve por
 * cercanía al marcador, y si hay dos candidatas cerca se marca `ambiguous`: ahí
 * sí vale gastar una consulta al LLM, pero ya no para elegir una pausa cualquiera
 * sino para decidir cuál toma es la buena.
 *
 * Doble export: window.EPMarkerAnchor + module.exports (Node).
 */
(function(global) {
    "use strict";

    var DEFAULTS = {
        headTokens: 7,        // palabras de la cabeza del cue que se emparejan (IN)
        tailTokens: 7,        // palabras de la cola (OUT)
        minTokens: 3,         // menos que esto no identifica una frase
        minScore: 0.6,        // por debajo no se considera coincidencia
        autoScore: 0.85,      // desde aquí se aplica sin preguntarle al LLM
        slack: 2,             // palabras extra de la ventana del transcript
        scoreBand: 0.08,      // dos coincidencias así de parejas compiten entre sí
        rivalSec: 30,         // rival tan cerca del marcador → hay que decidir
        maxShiftSec: 90,      // mover más que esto pide confirmación humana/LLM
        senseToleranceSec: 0.6, // cuánto puede alejarse el borde del ancla sin cantar
        // Con la frase grabada varias veces no se puede decir cuál toma es la buena,
        // pero sí que el borde tiene que caer EN alguna. Este margen es más ancho: la
        // toma elegida puede empezar un par de palabras antes de la frase escrita.
        senseTakeToleranceSec: 2.0,
        truncatedLen: 45,     // a partir de aquí el texto del CD viene recortado
        fps: 25,
        padFrames: 10
    };

    function opt(opts, key) {
        if (opts && opts[key] !== undefined && opts[key] !== null) return opts[key];
        return DEFAULTS[key];
    }

    // ─── Palabras y normalización ────────────────────────────

    function wordText(w) {
        if (!w) return "";
        var t = (w.text != null) ? w.text : w.word;
        return t == null ? "" : String(t);
    }

    function spokenWords(words) {
        var out = [];
        for (var i = 0; i < (words || []).length; i++) {
            var w = words[i];
            if (!w) continue;
            if (w.type && w.type !== "word") continue;
            if (typeof w.start !== "number" || typeof w.end !== "number") continue;
            if (!wordText(w)) continue;
            out.push(w);
        }
        out.sort(function(a, b) { return a.start - b.start; });
        return out;
    }

    function normToken(text) {
        var t = String(text || "").toLowerCase();
        try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
        return t.replace(/[^a-z0-9ñü]/g, "");
    }

    function tokenize(text) {
        var parts = String(text || "").split(/\s+/);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var t = normToken(parts[i]);
            if (t) out.push(t);
        }
        return out;
    }

    /** Distancia de edición acotada a 1: más allá no interesa. */
    function within1Edit(a, b) {
        var la = a.length, lb = b.length;
        if (Math.abs(la - lb) > 1) return false;
        var i = 0, j = 0, diff = 0;
        while (i < la && j < lb) {
            if (a.charAt(i) === b.charAt(j)) { i++; j++; continue; }
            if (++diff > 1) return false;
            if (la === lb) { i++; j++; }
            else if (la > lb) i++;
            else j++;
        }
        if (i < la || j < lb) diff++;
        return diff <= 1;
    }

    /**
     * Dos palabras "son la misma" si coinciden, si una es prefijo de la otra
     * (recortes del CD, plurales) o si se diferencian en una letra (erratas del
     * CD y del STT). Todo con un mínimo de longitud para no casar "de" con "del".
     */
    function tokenEq(a, b) {
        if (a === b) return true;
        var min = Math.min(a.length, b.length);
        if (min >= 4 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return true;
        if (min >= 5 && within1Edit(a, b)) return true;
        return false;
    }

    // ─── Texto de referencia del marcador ────────────────────

    // Comandos al editor que el CD deja pegados al final del texto del OUT.
    var TRAILING_CUES = {
        pausa: 1, pausita: 1, corte: 1, corta: 1, cortale: 1, cortala: 1,
        alto: 1, ok: 1, va: 1, vale: 1, listo: 1
    };

    // El CD a veces no escribe la frase del borde, sino qué hacer con él, y lo escribe
    // en el marcador que tiene a mano: `out antes de "ya que está esa cadena," -  Ahora
    // lo que vamos a hacer…` en el marcador **IN** del bloque. Es la instrucción más
    // directa que existe —dice el borde, el lado y la frase—, y hasta la v2.19.0 se
    // tiraba entera: en la clase 15 el profesor arrancó dos veces con "ya que está esa
    // cadena" y sin leer esto el OUT cerraba después de la primera, dejando la idea
    // repetida a los dos lados del corte. La frase **entre comillas** es lo que la
    // convierte en instrucción; sin comillas no se sabe dónde acaba y se ignora.
    var DIRECTIVE_RE = /\b(in|out)\b[^"“'\n]{0,30}?\b(antes|despu[eé]s)\b[^"“'\n]{0,20}?["“']([^"”'\n]{3,160})["”']/gi;

    /**
     * Instrucciones del CD encontradas en un comentario.
     * @returns {Array} [{kind:"IN"|"OUT", side:"before"|"after", phrase, text}]
     */
    function directivesFrom(raw) {
        var text = String(raw == null ? "" : raw);
        var out = [], m;
        DIRECTIVE_RE.lastIndex = 0;
        while ((m = DIRECTIVE_RE.exec(text)) !== null) {
            out.push({
                kind: m[1].toUpperCase(),
                side: /^antes/i.test(m[2]) ? "before" : "after",
                phrase: m[3].trim(),
                text: m[0].trim()
            });
        }
        return out;
    }

    /** Las instrucciones de un marcador (comentario y, si está vacío, nombre). */
    function directivesFor(marker) {
        if (!marker) return [];
        var comment = marker.comments != null ? String(marker.comments) : "";
        return directivesFrom(comment.replace(/^\s+|\s+$/g, "") ? comment : String(marker.name || ""));
    }

    // La otra forma de escribir lo mismo, y sin comillas: el CD apunta en el IN del
    // bloque DESDE DÓNDE se retomó ("retomamos desde donde dice tal cosa"). Habla del
    // cierre del bloque ANTERIOR: si el profesor volvió a empezar en esa frase, lo que
    // el bloque de antes dijo desde ahí sobra.
    //
    // Aquí no hacen falta comillas porque no se busca dentro de una frase larga: esto
    // se aplica sobre el RECADO (`noteFromText`), que ya viene sin la frase del bloque,
    // así que lo que sigue a "desde" es la frase hasta el final del recado.
    var RETAKE_RE = /\b(retom\w*|volv\w*|empez\w*|empiez\w*|arranc\w*)\b[^\n]{0,24}?\bdesde\b\s*(?:donde\s+(?:dice|dijo|digo|decia|dec[ií]a)\s*)?(.{4,160})$/i;

    /**
     * La instrucción de retoma escrita sin comillas, si el recado la trae.
     * @returns {object|null} {kind:"OUT", side:"before", phrase, text}
     */
    function retakeDirectiveFrom(note) {
        var text = String(note == null ? "" : note).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        if (!text) return null;
        var m = text.match(RETAKE_RE);
        if (!m) return null;
        var phrase = m[2].replace(/^["“'¿¡\s]+|["”'.,;:\s]+$/g, "");
        if (phrase.length < 4) return null;
        return { kind: "OUT", side: "before", phrase: phrase, text: text };
    }

    /** La instrucción de retoma de un marcador, leída de su recado. */
    function retakeDirectiveFor(marker, kind) {
        return retakeDirectiveFrom(noteFor(marker, kind || "IN"));
    }

    // Etiquetas de vista y de toma con las que el CD abre el comentario: no son recados.
    var TAG_RE = /^(pv|r|re|cam|pc|rec|toma|v\d*|\d+)$/i;

    // Qué borde señala el recado. "revisar out", "out antes de …", "sobra el cierre":
    // el CD escribe con sus palabras, así que se busca la MENCIÓN del borde, no una
    // fórmula. Sin mención no es un recado sobre el corte (p.ej. "sin WAV").
    //
    // "retomamos desde …" señala el CIERRE aunque no nombre el OUT: decir por dónde se
    // volvió a empezar es decir que lo de antes sobra.
    var BOUNDARY_RE = {
        OUT: /\bouts?\b|\bcierre\b|\bcierra\b|\bfinal\b|\bretom\w*\b/i,
        IN: /\bins?\b|\bapertura\b|\babre\b|\barranque\b|\binicio\b/i
    };

    /**
     * El recado del editor: lo que el CD escribió que NO es la frase del bloque.
     *
     * Convenciones del CD: el IN lleva "<recado> -  <primeras palabras del bloque>" y el
     * OUT "OUT: <últimas palabras>". Lo que sobra tras quitar la frase y las etiquetas de
     * vista es lo que el editor quiso decir sobre este corte.
     */
    function noteFromText(raw, kind) {
        var text = String(raw == null ? "" : raw).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        if (!text) return "";

        var idx = text.lastIndexOf(" - ");
        if (idx !== -1) {
            text = text.substring(0, idx);
        } else {
            // Sin separador: solo hay recado si va delante del "OUT:" de la convención.
            var out = text.match(/out\s*:/i);
            text = (out && out.index > 0) ? text.substring(0, out.index) : "";
        }

        // Las etiquetas van delante; el resto se deja tal cual, que puede ser una
        // instrucción con su frase entre comillas.
        var parts = text.split(" "), i = 0;
        while (i < parts.length &&
               (!parts[i] || TAG_RE.test(parts[i].replace(/[^0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "")))) i++;
        return parts.slice(i).join(" ").replace(/^[\s\-:]+|[\s\-:]+$/g, "");
    }

    /** El recado del editor en un marcador (comentario y, si está vacío, nombre). */
    function noteFor(marker, kind) {
        if (!marker) return "";
        var comment = marker.comments != null ? String(marker.comments) : "";
        var raw = comment.replace(/^\s+|\s+$/g, "") ? comment : String(marker.name || "");
        return noteFromText(raw, kind);
    }

    /** ¿El recado habla de este borde? */
    function flagsBoundary(note, kind) {
        if (!note) return false;
        var re = BOUNDARY_RE[kind];
        return !!(re && re.test(note));
    }

    /** El texto sin las instrucciones: lo que queda es frase hablada, si queda algo. */
    function stripDirectives(text) {
        return String(text == null ? "" : text).replace(DIRECTIVE_RE, " ")
            // La coma final puede ser parte de la frase (el CD recorta a media frase):
            // solo se limpia lo que era separador de la instrucción.
            .replace(/\s+/g, " ").replace(/^[\s\-:,;]+/, "").replace(/[\s\-:]+$/, "");
    }

    /**
     * Dónde cae el borde según una instrucción del CD. "antes de X" mira el ARRANQUE de
     * X y deja el corte en la frontera anterior; "después de X", su FINAL. El punto que
     * devuelve es una frontera de palabra sin colchón: el colchón lo pone
     * `marker-precision`, igual que con el ancla de la frase.
     *
     * @param {object} directive lo que devuelve `directivesFrom`
     * @param {string} kind el borde que se está decidiendo ("IN" | "OUT")
     * @returns {{ok, time?, snippet?, score?, ambiguous?, reason}}
     */
    function directiveAnchor(words, directive, kind, currentTime, opts) {
        var spoken = spokenWords(words);
        // "antes de X" necesita saber dónde EMPIEZA X; "después de X", dónde acaba.
        var probe = directive.side === "before" ? "IN" : "OUT";
        var matches = withinBlock(findMatches(words, directive.phrase, probe, opts), opts);
        if (matches.length === 0) {
            return { ok: false, reason: "la frase de la instrucción no aparece en el bloque" };
        }

        var best = 0, i;
        for (i = 0; i < matches.length; i++) if (matches[i].score > best) best = matches[i].score;
        if (best < opt(opts, "autoScore")) {
            return { ok: false, reason: "la frase de la instrucción coincide solo al " +
                Math.round(best * 100) + "%" };
        }

        var band = best - opt(opts, "scoreBand"), strong = [];
        for (i = 0; i < matches.length; i++) if (matches[i].score >= band) strong.push(matches[i]);
        strong.sort(function(a, b) {
            return Math.abs(a.time - currentTime) - Math.abs(b.time - currentTime);
        });
        var pick = strong[0];

        // De la palabra del borde a la frontera donde va el corte.
        var idx = pick.wordIdx, edge = idx;
        if (kind === "OUT" && directive.side === "before") edge = idx - 1;
        if (kind === "IN" && directive.side === "after") edge = idx + 1;
        if (edge < 0 || edge >= spoken.length) {
            return { ok: false, reason: "la frase de la instrucción está en el borde del transcript" };
        }

        return {
            ok: true,
            time: Math.round((kind === "IN" ? spoken[edge].start : spoken[edge].end) * 1000) / 1000,
            snippet: snippetOf(spoken, edge, kind, 8),
            score: pick.score,
            ambiguous: strong.length > 1,
            reason: "la instrucción del CD ubica el corte"
        };
    }

    /**
     * Extrae del comentario del marcador la frase de referencia.
     * @param {string} raw comentario (o nombre) del marcador
     * @param {string} kind "IN" | "OUT"
     */
    function cueFromText(raw, kind) {
        var text = stripDirectives(raw);
        if (!text) return "";

        var out = text.match(/out\s*:/i);
        if (kind === "OUT") {
            // Un OUT sin "OUT:" no trae frase: lo que hay es el nombre del marcador.
            return out ? text.substring(out.index + out[0].length).trim() : "";
        }

        // IN: "<nota del editor> -  <primeras palabras del bloque>". La nota puede
        // venir vacía (" - texto") y el separador con espacios de más. Se busca el
        // ÚLTIMO separador y **antes** de descartar por el "out:" del principio: el
        // recado del CD puede hablar del OUT del bloque y traer detrás la frase de
        // apertura ("out: cortar antes que diga \"nos vemos\" -  Y ah"). Descartar
        // ese comentario entero dejaba al LLM sin saber con qué abría el bloque.
        var idx = text.lastIndexOf(" - ");
        if (idx !== -1) return text.substring(idx + 3).trim();
        if (text.indexOf("- ") === 0) return text.substring(2).trim();
        // Sin separador, un comentario que empieza por "OUT:" es la frase de cierre
        // de un bloque, no la de apertura de este.
        if (out && out.index === 0) return "";
        return text;
    }

    /**
     * ¿La frase da para buscarla en el transcript? El CD recorta los comentarios a
     * ~50 caracteres y a veces del texto del bloque solo sobrevive "Y ah": no se
     * puede emparejar (medio transcript coincidiría), pero sí sirve como pista para
     * el LLM.
     */
    function cueSearchable(cueText, kind, opts) {
        return cueTokens(cueText, kind, opts).length > 0;
    }

    function cueTextFor(marker, kind) {
        if (!marker) return "";
        var comment = marker.comments != null ? String(marker.comments) : "";
        var raw = comment.replace(/^\s+|\s+$/g, "") ? comment : String(marker.name || "");
        return cueFromText(raw, kind);
    }

    /**
     * Palabras del cue que se van a emparejar: el borde que importa (cabeza para
     * el IN, cola para el OUT), sin los comandos al editor y sin la palabra que
     * el recorte del CD dejó a medias.
     * @returns {Array<string>} tokens normalizados
     */
    function cueTokens(cueText, kind, opts) {
        var tokens = tokenize(cueText);
        var min = opt(opts, "minTokens");
        if (tokens.length < min) return [];
        var truncated = String(cueText || "").length >= opt(opts, "truncatedLen");

        if (kind === "OUT") {
            while (tokens.length > min && TRAILING_CUES[tokens[tokens.length - 1]]) tokens.pop();
            // Al OUT le falta el principio de su primera palabra.
            if (tokens.length > min && (truncated || tokens[0].length < 4)) tokens.shift();
            var tail = opt(opts, "tailTokens");
            if (tokens.length > tail) tokens = tokens.slice(tokens.length - tail);
        } else {
            // Al IN le falta el final de su última palabra.
            var last = tokens[tokens.length - 1];
            if (tokens.length > min && (truncated || last.length < 4)) tokens.pop();
            var head = opt(opts, "headTokens");
            if (tokens.length > head) tokens = tokens.slice(0, head);
        }
        return tokens.length >= min ? tokens : [];
    }

    // ─── Emparejamiento difuso ───────────────────────────────

    /**
     * LCS con reconstrucción: qué palabras del cue casaron con qué palabras del
     * transcript. Se necesita el detalle (no solo el largo) para saber dónde cae
     * exactamente el borde: la primera palabra del cue para el IN, la última para
     * el OUT.
     * @returns {{len:number, pairs:Array}} pairs = [[cueIdx, winIdx], ...]
     */
    function align(cue, win, grid) {
        var n = cue.length, m = win.length, i, j;
        for (i = 0; i <= n; i++) {
            var row = grid[i];
            for (j = 0; j <= m; j++) row[j] = 0;
        }
        for (i = 1; i <= n; i++) {
            for (j = 1; j <= m; j++) {
                if (tokenEq(cue[i - 1], win[j - 1])) grid[i][j] = grid[i - 1][j - 1] + 1;
                else grid[i][j] = grid[i - 1][j] >= grid[i][j - 1] ? grid[i - 1][j] : grid[i][j - 1];
            }
        }
        var pairs = [];
        i = n; j = m;
        while (i > 0 && j > 0) {
            if (tokenEq(cue[i - 1], win[j - 1]) && grid[i][j] === grid[i - 1][j - 1] + 1) {
                pairs.unshift([i - 1, j - 1]);
                i--; j--;
            } else if (grid[i - 1][j] >= grid[i][j - 1]) i--;
            else j--;
        }
        return { len: grid[n][m], pairs: pairs };
    }

    function makeGrid(n, m) {
        var grid = [];
        for (var i = 0; i <= n; i++) {
            var row = [];
            for (var j = 0; j <= m; j++) row.push(0);
            grid.push(row);
        }
        return grid;
    }

    /**
     * Índice de la palabra del transcript donde cae el borde.
     *   IN:  la palabra que casó con la PRIMERA del cue (o su equivalente por
     *        desplazamiento si esa no casó)
     *   OUT: la que casó con la ÚLTIMA
     */
    function edgeIndex(match, cueLen, kind, start, total) {
        var pairs = match.pairs;
        if (pairs.length === 0) return start;
        var idx;
        if (kind === "IN") {
            var first = pairs[0];
            idx = first[0] === 0 ? (start + first[1]) : (start + first[1] - first[0]);
        } else {
            var lastPair = pairs[pairs.length - 1];
            idx = lastPair[0] === cueLen - 1
                ? (start + lastPair[1])
                : (start + lastPair[1] + (cueLen - 1 - lastPair[0]));
        }
        if (idx < 0) idx = 0;
        if (idx > total - 1) idx = total - 1;
        return idx;
    }

    function snippetOf(spoken, idx, kind, count) {
        var from, to;
        if (kind === "IN") { from = idx; to = Math.min(spoken.length, idx + count); }
        else { from = Math.max(0, idx - count + 1); to = idx + 1; }
        var parts = [];
        for (var i = from; i < to; i++) parts.push(wordText(spoken[i]));
        return parts.join(" ");
    }

    /**
     * Todas las apariciones de la frase del CD en el transcript.
     * @returns {Array} [{time, wordIdx, score, snippet, gapSec}] ordenadas por tiempo
     */
    function findMatches(words, cueText, kind, opts) {
        var spoken = spokenWords(words);
        var cue = cueTokens(cueText, kind, opts);
        if (spoken.length === 0 || cue.length === 0) return [];

        var trans = [];
        for (var i = 0; i < spoken.length; i++) trans.push(normToken(wordText(spoken[i])));

        var winLen = cue.length + opt(opts, "slack");
        var grid = makeGrid(cue.length, winLen);
        var minScore = opt(opts, "minScore");
        var raw = [];

        for (var s = 0; s + cue.length <= trans.length; s++) {
            var win = trans.slice(s, Math.min(trans.length, s + winLen));
            var m = align(cue, win, grid);
            var score = m.len / cue.length;
            if (score < minScore) continue;
            raw.push({ start: s, score: score, match: m });
        }
        if (raw.length === 0) return [];

        // Una misma aparición produce varias ventanas con puntaje parecido: se
        // queda la mejor de cada zona.
        raw.sort(function(a, b) { return b.score - a.score || a.start - b.start; });
        var accepted = [];
        for (var r = 0; r < raw.length; r++) {
            var clash = false;
            for (var a = 0; a < accepted.length; a++) {
                if (Math.abs(accepted[a].start - raw[r].start) < cue.length) { clash = true; break; }
            }
            if (!clash) accepted.push(raw[r]);
        }

        var out = [];
        for (var k = 0; k < accepted.length; k++) {
            var acc = accepted[k];
            var idx = edgeIndex(acc.match, cue.length, kind, acc.start, spoken.length);
            var w = spoken[idx];
            var gap;
            if (kind === "IN") gap = idx > 0 ? Math.max(0, w.start - spoken[idx - 1].end) : 999;
            else gap = idx < spoken.length - 1 ? Math.max(0, spoken[idx + 1].start - w.end) : 999;
            out.push({
                time: Math.round((kind === "IN" ? w.start : w.end) * 1000) / 1000,
                wordIdx: idx,
                score: Math.round(acc.score * 1000) / 1000,
                gapSec: Math.round(gap * 1000) / 1000,
                snippet: snippetOf(spoken, idx, kind, 8)
            });
        }
        out.sort(function(a, b) { return a.time - b.time; });
        return out;
    }

    /**
     * El territorio de un borde: desde el bloque anterior hasta el siguiente. Un IN no
     * puede anclarse en el bloque de antes ni un OUT en el de después.
     * @returns {{minTime, maxTime}}
     */
    function blockLimits(blocks, idx, kind) {
        var prev = blocks[idx - 1], next = blocks[idx + 1], blk = blocks[idx] || {};
        if (kind === "IN") {
            return { minTime: prev ? prev.outTime : null, maxTime: blk.outTime };
        }
        return { minTime: blk.inTime, maxTime: next ? next.inTime : null };
    }

    /** Copia de las opciones con los límites del bloque puestos. */
    function withLimits(opts, limits) {
        var o = {};
        if (opts) for (var k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
        if (limits) {
            if (limits.minTime != null) o.minTime = limits.minTime;
            if (limits.maxTime != null) o.maxTime = limits.maxTime;
        }
        return o;
    }

    /** Las apariciones que caen en el territorio del bloque (ver `anchorFor`). */
    function withinBlock(matches, opts) {
        var lo = opts && opts.minTime != null ? Number(opts.minTime) : -Infinity;
        var hi = opts && opts.maxTime != null ? Number(opts.maxTime) : Infinity;
        if (lo === -Infinity && hi === Infinity) return matches;
        var out = [];
        for (var i = 0; i < matches.length; i++) {
            if (matches[i].time >= lo && matches[i].time <= hi) out.push(matches[i]);
        }
        return out;
    }

    /**
     * Dónde debería caer el borde según la nota del CD.
     *
     * @param {Array} words words[] del STT
     * @param {string} cueText frase del marcador (cueTextFor)
     * @param {string} kind "IN" | "OUT"
     * @param {number} currentTime dónde está el marcador ahora
     * @param {object} [opts] `minTime`/`maxTime` acotan el **territorio del bloque**:
     *   las apariciones de la frase que caen en el bloque vecino no son opciones. Con
     *   una toma repetida a caballo de dos bloques —el profesor rehace la frase y el
     *   bloque siguiente abre con la retoma— sin esto el OUT se va a la retoma, o sea
     *   dentro del bloque de al lado (clase 15, bloque 4: el OUT acabó 3.4 s pasado el
     *   IN siguiente). Filtrando antes de decidir, la toma buena suele quedarse sola y
     *   el borde se resuelve sin preguntarle a nadie.
     * @returns {{ok, time?, score?, confident, ambiguous, shiftSec?, matches, rivals?,
     *            snippet?, reason}}
     *   confident = se puede aplicar sin preguntar; ambiguous = hay otra toma igual
     *   de buena cerca y conviene que el LLM decida.
     */
    function anchorFor(words, cueText, kind, currentTime, opts) {
        var all = findMatches(words, cueText, kind, opts);
        var matches = withinBlock(all, opts);
        if (matches.length === 0) {
            return { ok: false, confident: false, ambiguous: false, matches: [],
                reason: all.length
                    ? "la frase solo aparece dentro del bloque vecino"
                    : "la frase del marcador no aparece en el transcript" };
        }

        var best = 0;
        for (var i = 0; i < matches.length; i++) if (matches[i].score > best) best = matches[i].score;
        var band = Math.max(opt(opts, "minScore"), best - opt(opts, "scoreBand"));

        var strong = [];
        for (var s = 0; s < matches.length; s++) if (matches[s].score >= band) strong.push(matches[s]);
        strong.sort(function(a, b) {
            return Math.abs(a.time - currentTime) - Math.abs(b.time - currentTime);
        });

        var pick = strong[0];
        var rivals = [];
        for (var r = 1; r < strong.length; r++) {
            if (Math.abs(strong[r].time - currentTime) <= opt(opts, "rivalSec")) rivals.push(strong[r]);
        }

        var shift = pick.time - currentTime;
        var ambiguous = rivals.length > 0;
        var tooFar = Math.abs(shift) > opt(opts, "maxShiftSec");
        var confident = pick.score >= opt(opts, "autoScore") && !ambiguous && !tooFar;

        var reason;
        if (confident) reason = "la frase del CD aparece una sola vez por aquí";
        else if (ambiguous) reason = "la frase se dice " + (rivals.length + 1) + " veces cerca del marcador";
        else if (tooFar) reason = "la coincidencia queda a " + Math.round(Math.abs(shift)) + "s del marcador";
        else reason = "la coincidencia es parcial (" + Math.round(pick.score * 100) + "%)";

        return {
            ok: true,
            time: pick.time,
            score: pick.score,
            wordIdx: pick.wordIdx,
            gapSec: pick.gapSec,
            snippet: pick.snippet,
            shiftSec: Math.round(shift * 1000) / 1000,
            confident: confident,
            ambiguous: ambiguous,
            tooFar: tooFar,
            matches: matches,
            rivals: rivals,
            reason: reason
        };
    }

    // ─── ¿El corte cae donde dice la nota? ───────────────────

    // Qué palabras entran al bloque se decide por el FINAL de cada palabra, nunca
    // por su principio: de los tiempos de Whisper, los finales son fiables y los
    // principios no. En los bordes de toma estira la primera palabra medio segundo
    // hacia el silencio y pega el "pausa" que el profesor dice al editor al final de
    // la última frase. Los dos falsos que salían de ahí (un IN que parecía saltarse
    // su primera palabra, un OUT que parecía llevarse el cue) se caen mirando finales.
    function midOf(w) { return ((+w.start || 0) + (+w.end || 0)) / 2; }

    // El bloque abre con la primera palabra que todavía suena después del corte.
    function nextWordStart(spoken, t) {
        for (var i = 0; i < spoken.length; i++) {
            if (spoken[i].end > t + 0.001) return spoken[i];
        }
        return null;
    }

    // Y cierra con la última que acabó antes (con un frame de tolerancia, porque el
    // colchón se recorta al silencio disponible y puede quedarse justo).
    function prevWordEnd(spoken, t) {
        var best = null;
        for (var i = 0; i < spoken.length; i++) {
            if (spoken[i].end <= t + 0.05) best = spoken[i];
            else break;
        }
        return best;
    }

    /**
     * La palabra con la que el bloque abre/cierra tal como está puesto el
     * marcador. Se compara ESTO contra el ancla, no el tiempo del marcador: el
     * colchón de aire desplaza el tiempo pero no cambia qué palabras entran.
     *
     * Acepta words[] crudo o ya filtrado: filtra de nuevo por dentro (el filtro
     * conserva los objetos, así que la palabra que devuelve sigue sirviendo para
     * buscarla por identidad).
     * @returns {{word, time}|null}
     */
    function frontierAt(words, time, kind) {
        var spoken = spokenWords(words);
        var w = kind === "IN" ? nextWordStart(spoken, time) : prevWordEnd(spoken, time);
        if (!w) return null;
        return { word: w, time: kind === "IN" ? w.start : w.end };
    }

    /**
     * La palabra dentro de la cual cae un tiempo, si cae dentro de alguna.
     *
     * Un corte no debería caer a mitad de palabra, pero el audio manda sobre el
     * transcript y a veces lo deja ahí: cuando el STT alarga la última palabra sobre
     * el silencio, el cierre correcto queda dentro de ella según la rejilla del
     * transcript. Quien mida ese borde después necesita saberlo, o buscará el sonido
     * en la ventana de la palabra anterior y no lo encontrará.
     * @returns {Object|null} la palabra del words[] original
     */
    function holdingWord(words, time) {
        var spoken = spokenWords(words);
        for (var i = 0; i < spoken.length; i++) {
            var w = spoken[i];
            if (time > (+w.start || 0) && time < (+w.end || 0)) return w;
            if ((+w.start || 0) > time) break;
        }
        return null;
    }

    /**
     * Hasta dónde puede moverse el corte sin llevarse la palabra vecina. Es el límite
     * que se le da al audio para que ajuste el frame sin añadir contenido — un cue al
     * editor pegado a la última frase, por ejemplo.
     *
     * Cada lado usa el dato que sí es de fiar:
     *   · IN: el **final** de la palabra anterior. El corte nunca retrocede hasta
     *     dentro de ella, así que tampoco puede pasar a contarla como del bloque.
     *   · OUT: el **punto medio** de la siguiente. Su principio no sirve de límite —
     *     Whisper llega a poner el "pausa" empezando 2 centésimas antes de que la
     *     frase termine de sonar, y con ese techo el OUT no podía ni salir de su
     *     propia última palabra. El punto medio deja sitio al colchón y sigue
     *     frenando el caso que importa: el cue pegado, sin silencio que lo separe.
     * @returns {number|null}
     */
    function outerBound(words, time, kind) {
        var spoken = spokenWords(words);
        var front = frontierAt(spoken, time, kind);
        if (!front) return null;
        for (var i = 0; i < spoken.length; i++) {
            if (spoken[i] !== front.word) continue;
            if (kind === "IN") return i > 0 ? (+spoken[i - 1].end || 0) : null;
            return i < spoken.length - 1 ? midOf(spoken[i + 1]) : null;
        }
        return null;
    }

    function fmtT(t) {
        var m = Math.floor(t / 60), s = t - m * 60;
        return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
    }

    /**
     * Revisión de SENTIDO: ¿el bloque abre y cierra con las frases que pide la
     * nota del CD? Solo habla cuando puede afirmarlo sin dudar (coincidencia
     * fuerte y única); si la frase no aparece o hay varias tomas, se calla y deja
     * la decisión al flujo normal.
     *
     * @param {Array} words words[] del STT
     * @param {Array} blocks [{inTime, outTime, inCue, outCue}] tiempos REALES
     * @returns {Array} verdicts al estilo de marker-verify:
     *   {pairIdx, kind, time, ok:false, code, severity, message, targetTime}
     */
    function senseVerdicts(words, blocks, opts) {
        var spoken = spokenWords(words);
        var out = [];
        if (spoken.length === 0) return out;
        var tol = opt(opts, "senseToleranceSec");

        for (var b = 0; b < (blocks || []).length; b++) {
            var blk = blocks[b] || {};
            if (!(blk.outTime > blk.inTime)) continue;

            check(b, "IN", blk.inCue, blk.inTime, blockLimits(blocks, b, "IN"));
            check(b, "OUT", blk.outCue, blk.outTime, blockLimits(blocks, b, "OUT"));
        }

        function check(pairIdx, kind, cue, time, limits) {
            if (!cue) return;
            var anchor = anchorFor(words, cue, kind, time, withLimits(opts, limits));
            if (!anchor.ok) return;

            var front = frontierAt(spoken, time, kind);
            if (!front) return;

            // Con una sola aparición clara, el borde va donde ella diga.
            var target = anchor.time;
            var limit = tol;
            if (!anchor.confident) {
                // Con la frase grabada varias veces no se puede afirmar cuál toma es
                // la buena, pero sí que el borde tiene que caer en alguna: si está
                // lejos de todas, el bloque no abre ni cierra con lo que el CD
                // escribió. Caso real: la frase estaba en 1:21 y en 1:38 y el borde
                // acabó en 1:41, ya en la frase siguiente.
                if (!anchor.ambiguous) return;
                limit = opt(opts, "senseTakeToleranceSec");
                target = nearestTake(anchor, front.time);
                if (target == null) return;
            }
            if (Math.abs(front.time - target) <= limit) return;

            var late = kind === "IN" ? front.time > target : front.time < target;
            var missing = kind === "IN"
                ? "se está comiendo el arranque"
                : "está cortando la frase antes de que cierre";
            var extra = kind === "IN"
                ? "arranca antes de la frase, con contenido que sobra"
                : "se pasa de la frase y arrastra contenido que sobra";

            out.push({
                pairIdx: pairIdx,
                kind: kind,
                time: time,
                ok: false,
                code: kind === "IN" ? "sense-in" : "sense-out",
                severity: "block",
                message: "El bloque debe " + (kind === "IN" ? "abrir" : "cerrar") +
                    " con \"" + anchor.snippet + "\" (" + fmtT(target) + ") y " +
                    (kind === "IN" ? "abre" : "cierra") + " en \"" + wordText(front.word) +
                    "\" (" + fmtT(front.time) + "): " + (late ? missing : extra) + ".",
                targetTime: target,
                anchorScore: anchor.score,
                deltaSec: Math.round((target - front.time) * 1000) / 1000
            });
        }

        /** La aparición de la frase más cercana al borde, entre las que compiten. */
        function nearestTake(anchor, time) {
            var takes = [{ time: anchor.time }].concat(anchor.rivals || []);
            var best = null;
            for (var i = 0; i < takes.length; i++) {
                if (best == null || Math.abs(takes[i].time - time) < Math.abs(best - time)) {
                    best = takes[i].time;
                }
            }
            return best;
        }

        return out;
    }

    /**
     * ¿El tiempo nuevo pone el borde donde dice la nota? Se acepta con la holgura
     * del colchón, que es lo que marker-precision resta/suma al aplicar.
     */
    function resolvesSense(verdict, newTime, opts) {
        if (!verdict || verdict.targetTime == null) return true;
        var fps = Number(opt(opts, "fps")) || DEFAULTS.fps;
        var pad = (Number(opt(opts, "padFrames")) || 0) / fps;
        return Math.abs(newTime - verdict.targetTime) <= pad + 2 / fps;
    }

    var EPMarkerAnchor = {
        DEFAULTS: DEFAULTS,
        cueTextFor: cueTextFor,
        cueFromText: cueFromText,
        cueTokens: cueTokens,
        cueSearchable: cueSearchable,
        directivesFrom: directivesFrom,
        directivesFor: directivesFor,
        retakeDirectiveFrom: retakeDirectiveFrom,
        retakeDirectiveFor: retakeDirectiveFor,
        noteFromText: noteFromText,
        noteFor: noteFor,
        flagsBoundary: flagsBoundary,
        directiveAnchor: directiveAnchor,
        stripDirectives: stripDirectives,
        blockLimits: blockLimits,
        withLimits: withLimits,
        findMatches: findMatches,
        anchorFor: anchorFor,
        senseVerdicts: senseVerdicts,
        resolvesSense: resolvesSense,
        frontierAt: frontierAt,
        holdingWord: holdingWord,
        outerBound: outerBound,
        tokenEq: tokenEq
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = EPMarkerAnchor;
    }
    if (global) {
        global.EPMarkerAnchor = EPMarkerAnchor;
    }

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
