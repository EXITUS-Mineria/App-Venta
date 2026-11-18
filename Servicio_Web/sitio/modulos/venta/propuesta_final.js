// ============================================================
// PROPUESTA FINAL (validador / admin)
// Se sube el archivo (CSV o Excel) con las cuentas que SÍ se venden. Lo que no venga en el archivo sale
// de la propuesta y regresa a la base como disponible. Columnas reconocidas: vReference / Referencia y
// vGroupId / Grupo; si no hay encabezado se toma la primera columna. En Grupal basta un integrante para
// conservar su grupo completo.
// ============================================================
const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";

/** Filas (arreglos de texto) de un CSV: detecta separador , ; o tabulador y respeta comillas. */
export function leerCSV(texto) {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lineas.length) return [];
  const sep = [",", ";", "\t"].sort((a, b) => lineas[0].split(b).length - lineas[0].split(a).length)[0];
  return lineas.map((l) => {
    const celdas = []; let actual = "", comillas = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (comillas && l[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas; }
      else if (c === sep && !comillas) { celdas.push(actual); actual = ""; }
      else actual += c;
    }
    celdas.push(actual);
    return celdas.map((x) => x.trim());
  });
}

/** Saca las referencias y grupos de las filas del archivo. */
export function extraerCuentas(filas) {
  if (!filas.length) return { refs: [], grupos: [] };
  const enc = filas[0].map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
  const iRef = enc.findIndex((c) => ["vreference", "referencia", "reference", "vref"].includes(c));
  const iGrp = enc.findIndex((c) => ["vgroupid", "grupo", "groupid", "idgrupo"].includes(c));
  const conEncabezado = iRef >= 0 || iGrp >= 0;
  const datos = conEncabezado ? filas.slice(1) : filas;
  const limpio = (v) => String(v ?? "").trim();
  const refs = new Set(), grupos = new Set();
  for (const f of datos) {
    if (conEncabezado) {
      if (iRef >= 0 && limpio(f[iRef])) refs.add(limpio(f[iRef]));
      if (iGrp >= 0 && limpio(f[iGrp])) grupos.add(limpio(f[iGrp]));
    } else if (limpio(f[0])) refs.add(limpio(f[0]));   // sin encabezado: cualquier clave en la 1a columna
  }
  return { refs: [...refs], grupos: [...grupos] };
}

async function leerArchivo(archivo) {
  if (/\.xlsx?$/i.test(archivo.name)) {
    const XLSX = await import(XLSX_CDN);
    const libro = XLSX.read(await archivo.arrayBuffer(), { type: "array" });
    const hoja = libro.Sheets[libro.SheetNames[0]];
    return XLSX.utils.sheet_to_json(hoja, { header: 1, raw: false, defval: "" }).map((f) => f.map((c) => String(c).trim()));
  }
  const buf = await archivo.arrayBuffer();
  let texto = new TextDecoder("utf-8").decode(buf);
  if (texto.includes("�")) texto = new TextDecoder("latin1").decode(buf);   // CSV de Excel en Latin-1
  return leerCSV(texto);
}

/**
 * Botón «📄 Subir propuesta final» para una propuesta. alTerminar() se llama después de aplicarla.
 */
export function botonPropuestaFinal(ctx, p, alTerminar) {
  const { h, toast, confirmar, numero, dinero } = ctx.ui;
  const input = h("input", { type: "file", accept: ".csv,.txt,.xlsx,.xls", hidden: true, onchange: () => aplicar(input.files[0]) });
  const btn = h("button", { class: "btn btn-secundario", title: "Archivo con las cuentas que SÍ se venden; lo demás se libera",
    onclick: () => input.click() }, "📄 Subir propuesta final");

  async function aplicar(archivo) {
    input.value = "";
    if (!archivo) return;
    let cuentas;
    try { cuentas = extraerCuentas(await leerArchivo(archivo)); }
    catch (e) { toast(`No se pudo leer ${archivo.name}: ${e.message}`, "mal", 8000); return; }
    if (!cuentas.refs.length && !cuentas.grupos.length) { toast("El archivo no trae vReference ni vGroupId.", "mal", 8000); return; }
    // cuentas de la propuesta: en Grupal, un integrante listado conserva su grupo
    let creditos;
    try { creditos = await ctx.rpc("creditos_propuesta", { p_id: p.id_propuesta }); } catch (e) { toast(e.message, "mal"); return; }
    const enArchivo = new Set([...cuentas.refs, ...cuentas.grupos]);
    const refs = new Set(), grupos = new Set();
    for (const c of creditos) {
      if (c.tipo === "Grupal") { if (enArchivo.has(c.vgroupid) || enArchivo.has(c.vreference)) grupos.add(c.vgroupid); }
      else if (enArchivo.has(c.vreference)) refs.add(c.vreference);
    }
    const partidas = new Set(creditos.map((c) => (c.tipo === "Grupal" ? `G:${c.vgroupid}` : `J:${c.vreference}`))).size;
    const quedan = refs.size + grupos.size;
    if (!quedan) { toast(`Ninguna cuenta de ${archivo.name} pertenece a ${p.id_propuesta}.`, "mal", 9000); return; }
    const conocidas = new Set(creditos.flatMap((c) => [c.vreference, c.vgroupid].filter(Boolean)));
    const ajenas = [...enArchivo].filter((x) => !conocidas.has(x));
    if (!(await confirmar("Propuesta final", `${p.id_propuesta} · ${archivo.name}\n\n` +
      `Se quedan ${numero(quedan)} de ${numero(partidas)} partidas.\n` +
      `${numero(partidas - quedan)} partidas se quitan y regresan a la base como DISPONIBLES.` +
      (ajenas.length ? `\n\n⚠ ${numero(ajenas.length)} cuentas del archivo no son de esta propuesta (no se agregan): ${ajenas.slice(0, 5).join(", ")}${ajenas.length > 5 ? "…" : ""}` : "") +
      "\n\nNo se puede deshacer.", "Aplicar"))) return;
    btn.disabled = true;
    try {
      const r = await ctx.rpc("propuesta_final", { p_id: p.id_propuesta, p_refs: [...refs], p_grupos: [...grupos] });
      toast(`${p.id_propuesta}: quedan ${numero(r.quedan)} partidas (capital ${dinero(r.capital)}); ${numero(r.quitadas)} regresaron a disponibles.`, "bien", 9000);
      alTerminar?.();
    } catch (e) { toast(e.message, "mal", 9000); }
    btn.disabled = false;
  }
  return h("span", { style: { display: "contents" } }, btn, input);
}
