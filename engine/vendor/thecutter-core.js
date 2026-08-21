/**
 * thecutter-core.js — Módulo PURO (testeable en Node) con la lógica de datos de
 * The Cutter: el orquestador que encadena transcript → validar marcadores →
 * cortar → vistas → limpiar marcadores → transcript del corte → sugerencias.
 *
 * Aquí vive todo lo que se puede calcular sin Premiere ni DOM:
 *  - blocksFromPairs: pares IN/OUT (EPMarkerReviewer.parsePairs) → bloques con
 *    el comentario del director de contenido (CD) ya parseado.
 *  - buildRemoveZones: zonas a extraer (misma convención que Cortes Automáticos).
 *  - computeBlockDurations + matchPostCutMarkers: duración del bloque IN→OUT que
 *    hay que asignarle al marcador con comentario que sobrevivió al corte.
 *  - buildViewPayload: payload de activateViews (mapping + segmentos).
 *  - buildTimedFromWords: transcript con tiempos para el LLM de sugerencias.
 *  - buildCdNotesContext: notas del CD como contexto extra del prompt.
 *
 * Doble export: window.EPTheCutterCore + module.exports (Node).
 */
(function(global) {
    "use strict";

    function round(x) { return Math.round(x * 1000) / 1000; }

    function numOr(v, def) {
        var n = (typeof v === "number") ? v : parseFloat(v);
        return isNaN(n) ? def : n;
    }

    function wordText(w) {
        if (!w) return "";
        var t = (w.text != null) ? w.text : w.word;
        return t == null ? "" : String(t);
    }

    // ─── Comentarios de marcadores IN ────────────────────────

    /**
     * Convención del Cutter: "Nota del editor - transcripción" tiene comentario
     * del CD; "- transcripción" o texto suelto no lo tiene.
     */
    function parseInComment(raw) {
        var trimmed = String(raw == null ? "" : raw).trim();
        var dashIdx = trimmed.indexOf(" - ");
        if (dashIdx === -1 && trimmed.indexOf("- ") === 0) {
            return { note: "", transcript: trimmed.substring(2).trim(), hasComment: false };
        }
        if (dashIdx > 0) {
            return {
                note: trimmed.substring(0, dashIdx).trim(),
                transcript: trimmed.substring(dashIdx + 3).trim(),
                hasComment: true
            };
        }
        return { note: "", transcript: trimmed, hasComment: false };
    }

    /**
     * pairs de EPMarkerReviewer.parsePairs → bloques normalizados.
     * @returns {Array} [{inTime, outTime, duration, inComment, editorNote, transcript, hasComment, inName}]
     */
    function blocksFromPairs(pairs) {
        var out = [];
        if (!pairs) return out;
        for (var i = 0; i < pairs.length; i++) {
            var p = pairs[i];
            if (!p || !p.inMarker || !p.outMarker) continue;
            var inTime = numOr(p.inMarker.startSeconds, null);
            var outTime = numOr(p.outMarker.startSeconds, null);
            if (inTime == null || outTime == null || !(outTime > inTime)) continue;
            var raw = p.inMarker.comments || p.inMarker.name || "";
            var parsed = parseInComment(raw);
            out.push({
                inTime: round(inTime),
                outTime: round(outTime),
                duration: round(outTime - inTime),
                inComment: String(raw).trim(),
                editorNote: parsed.note,
                transcript: parsed.transcript,
                hasComment: parsed.hasComment,
                inName: p.inMarker.name || ""
            });
        }
        out.sort(function(a, b) { return a.inTime - b.inTime; });
        return out;
    }

    // ─── Zonas a eliminar ────────────────────────────────────

    /**
     * Todo lo que NO está entre un IN y su OUT se elimina.
     * @param {Array} blocks bloques de blocksFromPairs
     * @param {number} duration duración de la secuencia (0 = desconocida)
     * @returns {Array} [{start, end, label}]
     */
    function buildRemoveZones(blocks, duration) {
        var zones = [];
        if (!blocks || blocks.length === 0) return zones;
        var dur = numOr(duration, 0);

        if (blocks[0].inTime > 0.1) {
            zones.push({ start: 0, end: round(blocks[0].inTime), label: "Pre-inicio" });
        }
        for (var k = 0; k < blocks.length - 1; k++) {
            var gapStart = blocks[k].outTime;
            var gapEnd = blocks[k + 1].inTime;
            if (gapEnd - gapStart > 0.05) {
                zones.push({ start: round(gapStart), end: round(gapEnd), label: "Brecha " + (k + 1) });
            }
        }
        var lastOut = blocks[blocks.length - 1].outTime;
        if (dur > 0 && dur - lastOut > 0.1) {
            zones.push({ start: round(lastOut), end: round(dur), label: "Post-final" });
        }
        return zones;
    }

    /** Segundos totales que se eliminan. */
    function totalRemoved(zones) {
        var t = 0;
        for (var i = 0; i < (zones || []).length; i++) {
            t += (numOr(zones[i].end, 0) - numOr(zones[i].start, 0));
        }
        return round(t);
    }

    // ─── Duración de los marcadores con comentario ───────────

    /**
     * Duración que debe quedar en cada marcador con comentario del CD: la del
     * bloque IN→OUT al que hace referencia.
     * @returns {Array} [{comment, editorNote, duration}]
     */
    function computeBlockDurations(blocks) {
        var out = [];
        for (var i = 0; i < (blocks || []).length; i++) {
            var b = blocks[i];
            if (!b.hasComment) continue;
            out.push({ comment: b.inComment, editorNote: b.editorNote, duration: b.duration });
        }
        return out;
    }

    function normComment(s) {
        return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
    }

    /**
     * Empareja los marcadores que quedaron tras el corte con la duración de su
     * bloque original (match por comentario; cada bloque se consume una vez, así
     * que comentarios repetidos se asignan en orden).
     * @param {Array} postMarkers de getPostCutMarkers()
     * @param {Array} blockDurations de computeBlockDurations()
     * @returns {{items: Array, unmatched: Array}} items para setMarkerDurations
     */
    function matchPostCutMarkers(postMarkers, blockDurations) {
        var items = [];
        var unmatched = [];
        var pool = (blockDurations || []).slice(0);
        var used = {};

        for (var i = 0; i < (postMarkers || []).length; i++) {
            var mk = postMarkers[i];
            if (!mk || mk.isOut || !mk.hasComment) continue;
            var start = numOr(mk.startSeconds, null);
            if (start == null) continue;

            var raw = normComment(mk.comments);
            var note = normComment(mk.editorNote);
            var found = -1;

            for (var p = 0; p < pool.length; p++) {
                if (used[p]) continue;
                if (normComment(pool[p].comment) === raw) { found = p; break; }
            }
            if (found === -1 && note) {
                for (var q = 0; q < pool.length; q++) {
                    if (used[q]) continue;
                    if (normComment(pool[q].editorNote) === note) { found = q; break; }
                }
            }

            if (found === -1) {
                unmatched.push({ start: round(start), comments: mk.comments || "" });
                continue;
            }
            used[found] = true;
            items.push({
                start: round(start),
                endTime: round(start + pool[found].duration),
                comment: mk.comments || ""
            });
        }
        return { items: items, unmatched: unmatched };
    }

    // ─── Vistas ──────────────────────────────────────────────

    var DEFAULT_MARKER_NAMES = [
        "marker", "marcador", "chapter marker", "marcador de capítulo",
        "subclip marker", "marcador de subclip", "comment marker",
        "marcador de comentario", "segmentation"
    ];

    /** La claqueta es solo referencia de sincronía: no es una vista de cámara. */
    function isClapperboardName(text) {
        var t = String(text || "").toLowerCase();
        if (!t) return false;
        return t.indexOf("claqueta") !== -1 || t.indexOf("clapper") !== -1 ||
            t.indexOf("claquete") !== -1 || t.indexOf("slate") !== -1 || t === "k";
    }

    /**
     * Nombre de vista de un marcador. No generan segmento de vista: los nombres
     * genéricos de Premiere ("Marcador 1", "marker"...) porque no identifican una
     * cámara, ni la claqueta porque es solo una referencia de sincronía.
     */
    function viewNameOf(mk) {
        var n = String((mk && mk.name) || "").trim();
        if (isClapperboardName(n) || isClapperboardName((mk && mk.editorNote) || "")) return "";

        var isDefault = false;
        if (n) {
            var nLower = n.toLowerCase();
            for (var di = 0; di < DEFAULT_MARKER_NAMES.length; di++) {
                if (nLower === DEFAULT_MARKER_NAMES[di] || nLower.indexOf(DEFAULT_MARKER_NAMES[di] + " ") === 0) {
                    isDefault = true;
                    break;
                }
            }
            if (!isDefault) return n;
        }
        if (mk && mk.editorNote) {
            var note = String(mk.editorNote).trim();
            if (note && note.length <= 20) return note;
        }
        return "";
    }

    /**
     * Payload de activateViews: cada marcador IN con nombre de vista cubre desde
     * su tiempo hasta el siguiente (o el fin de la secuencia).
     * @returns {{mapping: object, segments: Array}}
     */
    function buildViewPayload(mapping, postMarkers, duration) {
        var filtered = [];
        for (var i = 0; i < (postMarkers || []).length; i++) {
            var mk = postMarkers[i];
            if (!mk || mk.isOut) continue;
            var n = viewNameOf(mk);
            var t = numOr(mk.startSeconds, null);
            // Un nombre sin pistas asignadas NO genera segmento: activateViews
            // apaga todo clip dentro de un segmento cuyo nombre no mapea a su
            // pista, así que un marcador de nota ("⚠ Sin WAV") dejaría la zona
            // en negro hasta el marcador siguiente.
            if (n && t != null && hasMappedTracks(mapping, n)) filtered.push({ time: round(t), name: n });
        }
        filtered.sort(function(a, b) { return a.time - b.time; });

        var dur = numOr(duration, 0);
        var segments = [];
        for (var s = 0; s < filtered.length; s++) {
            var end = (s < filtered.length - 1)
                ? filtered[s + 1].time
                : (dur > filtered[s].time ? round(dur) : round(filtered[s].time + 3600));
            segments.push({ start: filtered[s].time, end: end, name: filtered[s].name });
        }
        return { mapping: mapping || {}, segments: segments };
    }

    /** ¿Ese nombre de vista tiene al menos una pista asignada en el preset? */
    function hasMappedTracks(mapping, name) {
        var tracks = mapping && mapping[name];
        if (!tracks) return false;
        if (typeof tracks === "string") return tracks !== "";
        return tracks.length > 0;
    }

    /** Nombres de vista únicos presentes en los marcadores. */
    function viewNamesOf(postMarkers) {
        var seen = {}, out = [];
        for (var i = 0; i < (postMarkers || []).length; i++) {
            var mk = postMarkers[i];
            if (!mk || mk.isOut) continue;
            var n = viewNameOf(mk);
            if (n && !seen[n]) { seen[n] = true; out.push(n); }
        }
        out.sort();
        return out;
    }

    // ─── Transcript con tiempos para el LLM ──────────────────

    /**
     * words[] → líneas "[12.3s - 18.1s] texto", agrupando por fin de oración o
     * pausa (mismo formato que buildTimedTranscript de la card de Transcripción).
     */
    function buildTimedFromWords(words, opts) {
        opts = opts || {};
        var GAP = numOr(opts.gap, 0.7);
        var MAX = numOr(opts.maxWords, 20);
        var lines = [];
        var cur = null;
        var prevEnd = null, prevTxt = "";

        for (var i = 0; i < (words || []).length; i++) {
            var w = words[i];
            if (w && w.type && w.type !== "word") continue;
            var txt = wordText(w).trim();
            if (!txt) continue;
            var start = numOr(w.start, null);

            if (cur) {
                var endsSentence = /[.?!…]["'”’)\]]?$/.test(prevTxt);
                var gap = (start != null && prevEnd != null) ? (start - prevEnd) : 0;
                if (endsSentence || gap >= GAP || cur.words.length >= MAX) {
                    lines.push(cur);
                    cur = null;
                }
            }
            if (!cur) cur = { start: numOr(start, 0), end: numOr(start, 0), words: [] };
            cur.words.push(txt);
            var e = numOr(w.end, null);
            if (e != null) cur.end = e;
            prevEnd = e != null ? e : prevEnd;
            prevTxt = txt;
        }
        if (cur && cur.words.length) lines.push(cur);

        var out = [];
        for (var L = 0; L < lines.length; L++) {
            out.push("[" + lines[L].start.toFixed(1) + "s - " + lines[L].end.toFixed(1) + "s] " + lines[L].words.join(" "));
        }
        return out.join("\n");
    }

    /**
     * Notas del CD como contexto extra del prompt de sugerencias. Usa los tiempos
     * POST-corte si se pasan (marcadores que sobrevivieron); si no, los del bloque.
     */
    function buildCdNotesContext(blocks, postMarkers) {
        var notes = [];

        if (postMarkers && postMarkers.length) {
            for (var i = 0; i < postMarkers.length; i++) {
                var mk = postMarkers[i];
                if (!mk || mk.isOut || !mk.hasComment) continue;
                var t = numOr(mk.startSeconds, null);
                var noteTxt = String(mk.editorNote || "").trim();
                if (!noteTxt) continue;
                notes.push("- [" + (t != null ? t.toFixed(1) : "?") + "s] " + noteTxt);
            }
        }
        if (notes.length === 0) {
            for (var b = 0; b < (blocks || []).length; b++) {
                if (!blocks[b].hasComment) continue;
                var n = String(blocks[b].editorNote || "").trim();
                if (!n) continue;
                notes.push("- [" + blocks[b].inTime.toFixed(1) + "s] " + n);
            }
        }
        if (notes.length === 0) return "";

        return "NOTAS DEL DIRECTOR DE CONTENIDO (comentarios dejados en los marcadores de la secuencia; "
            + "tenlas en cuenta al sugerir la edición, indican intención o pendientes en ese punto):\n"
            + notes.join("\n");
    }

    var EPTheCutterCore = {
        parseInComment: parseInComment,
        blocksFromPairs: blocksFromPairs,
        buildRemoveZones: buildRemoveZones,
        totalRemoved: totalRemoved,
        computeBlockDurations: computeBlockDurations,
        matchPostCutMarkers: matchPostCutMarkers,
        viewNameOf: viewNameOf,
        viewNamesOf: viewNamesOf,
        buildViewPayload: buildViewPayload,
        buildTimedFromWords: buildTimedFromWords,
        buildCdNotesContext: buildCdNotesContext
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = EPTheCutterCore;
    }
    if (global) {
        global.EPTheCutterCore = EPTheCutterCore;
    }

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
