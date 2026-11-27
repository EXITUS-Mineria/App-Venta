// ============================================================
// Brokers · piezas compartidas entre el portal del broker y el módulo interno
//  - Documentos del broker (mismos que al comprador) con estatus de validación por archivo.
//  - Resumen de una propuesta de inversión y descarga de sus créditos.
// Archivos en el bucket privado «documentos-venta», ruta BRK-<id>/<tipo>/<marca>_<nombre>.
// ============================================================
import { BUCKET, MAX_BYTES, TIPOS_OK, ACEPTA, tipoMime, limpio, peso, comprimir } from "../funnel/documentos.js";

export const DOCS_BROKER = [
  ["ine", "INE del representante"],
  ["comprobante_fiscal", "Constancia de situación fiscal"],
  ["comprobante_domicilio", "Comprobante de domicilio"],
  ["alta_comprador", "Formato de alta"],
  ["nda", "NDA (convenio de confidencialidad)"],
];
export const nombreDoc = (t) => (DOCS_BROKER.find(([k]) => k === t) || [t, t])[1];

export const ESTATUS_BROKER = {
  documentos: ["Documentos pendientes", "pend"],
  revision: ["En revisión", "proc"],
  validado: ["Validado", "ok"],
  rechazado: ["Rechazado", "no"],
  suspendido: ["Suspendido", "no"],
};
export const ESTATUS_DOC = { falta: ["Falta", "gris"], pendiente: ["En revisión", "proc"], aprobado: ["Aprobado", "ok"], rechazado: ["Rechazado", "no"] };
export const ESTATUS_PROP = { enviada: ["Enviada, en revisión", "proc"], aceptada: ["Aceptada", "ok"], rechazada: ["No aceptada", "no"], cancelada: ["Cancelada", "gris"] };

export const pildora = (h, mapa, s) => h("span", { class: `brk-pill ${(mapa[s] || [])[1] || ""}` }, (mapa[s] || [s])[0]);
export const cent = (v) => `$${Number(v || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Documentos del broker agrupados por tipo.
 * modo "broker": sube / borra lo no aprobado. modo "admin": aprueba / rechaza y también puede subir. "consulta": sólo ve.
 */
export function bloqueDocsBroker(ctx, { brokerId, modo, alCambiar }) {
  const { h, toast, confirmar, fecha, pedirTexto } = ctx.ui;
  const el = h("div", { class: "brk-docs" }, h("div", { class: "nota" }, "Cargando documentos…"));
  const raiz = () => `BRK-${brokerId}`;

  async function cargar() {
    let docs;
    try { docs = (await ctx.rpc("broker_documentos", { p_broker: modo === "broker" ? null : brokerId })) || []; }
    catch (e) { el.replaceChildren(h("div", { class: "nota" }, e.message)); return; }
    el.replaceChildren(...DOCS_BROKER.map(([tipo, titulo]) => seccion(tipo, titulo, docs.filter((d) => d.tipo === tipo))));
  }

  function seccion(tipo, titulo, docs) {
    const vigente = docs.find((d) => d.estatus === "aprobado") || docs[0];
    const est = vigente ? vigente.estatus : "falta";
    const input = h("input", { type: "file", accept: ACEPTA, hidden: true, onchange: () => subir(tipo, [...input.files], input) });
    const puedeSubir = modo === "admin" || (modo === "broker" && est !== "aprobado");
    return h("section", { class: `brk-doc s-${est}`, "data-tipo": tipo },
      h("div", { class: "brk-doc-enc" }, h("b", {}, titulo), pildora(h, ESTATUS_DOC, est)),
      vigente?.estatus === "rechazado" && vigente.comentario ? h("div", { class: "brk-motivo" }, `Motivo: ${vigente.comentario}`) : null,
      docs.length ? h("ul", { class: "doc-lista" }, ...docs.map((d) => h("li", {},
        h("a", { href: "#", title: "Abrir (liga temporal)", onclick: (e) => { e.preventDefault(); abrir(d); } }, d.nombre),
        h("small", {}, ` ${peso(d.bytes)} · ${fecha(d.fecha)} · `), pildora(h, ESTATUS_DOC, d.estatus),
        modo === "admin" ? h("span", { class: "brk-acc" },
          d.estatus !== "aprobado" ? h("button", { class: "btn btn-primario btn-chico", onclick: () => revisar(d, "aprobado") }, "Aprobar") : null,
          d.estatus !== "rechazado" ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => revisar(d, "rechazado") }, "Rechazar") : null) : null,
        (modo === "admin" || (modo === "broker" && d.estatus !== "aprobado")) ? h("button", { class: "btn btn-secundario btn-chico", title: "Borrar", onclick: () => borrar(d) }, "Borrar") : null)))
        : h("div", { class: "nota" }, "Sin archivo."),
      puedeSubir ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => input.click() }, docs.length ? "Subir otro" : "Subir archivo") : null,
      input);
  }

  async function abrir(d) {
    const ventana = window.open("", "_blank");
    const { data, error } = await ctx.sb.storage.from(BUCKET).createSignedUrl(d.ruta, 300);
    if (error || !data?.signedUrl) { ventana?.close(); toast(error?.message || "No se pudo abrir el archivo.", "mal"); return; }
    if (ventana) ventana.location = data.signedUrl; else window.location.href = data.signedUrl;
  }

  async function subir(tipo, files, input) {
    input.value = "";
    for (const file of files) {
      const mime = tipoMime(file);
      if (!TIPOS_OK[mime]) { toast(`${file.name}: sólo PDF, fotos, Word o Excel.`, "mal", 7000); continue; }
      const c = await comprimir(file, mime);
      if (c.blob.size > MAX_BYTES) { toast(`${file.name}: pesa ${peso(c.blob.size)}; el máximo es 10 MB.`, "mal", 7000); continue; }
      const ruta = `${raiz()}/${tipo}/${Date.now()}_${limpio(c.nombre)}`;
      const { error } = await ctx.sb.storage.from(BUCKET).upload(ruta, c.blob, { contentType: c.mime, upsert: false });
      if (error) { toast(`${file.name}: ${error.message}`, "mal", 8000); continue; }
      try {
        await ctx.rpc("broker_registrar_documento", { p_broker: modo === "admin" ? brokerId : null, p_tipo: tipo, p_nombre: c.nombre,
          p_ruta: ruta, p_mime: c.mime, p_bytes: c.blob.size });
        toast(`${nombreDoc(tipo)}: archivo cargado.`, "bien");
      } catch (e) {
        await ctx.sb.storage.from(BUCKET).remove([ruta]);
        toast(`${file.name}: ${e.message}`, "mal", 8000);
      }
    }
    await cargar(); alCambiar?.();
  }

  async function revisar(d, estatus) {
    let comentario = null;
    if (estatus === "rechazado") {
      comentario = await pedirTexto("Rechazar documento", `Motivo del rechazo de «${d.nombre}» (lo verá el broker):`);
      if (!comentario?.trim()) return;
    }
    try { await ctx.rpc("broker_revisar_documento", { p_id: d.id, p_estatus: estatus, p_comentario: comentario }); toast(`Documento ${estatus}.`, "bien"); }
    catch (e) { toast(e.message, "mal"); }
    await cargar(); alCambiar?.();
  }

  async function borrar(d) {
    if (!(await confirmar("Borrar archivo", `¿Borrar «${d.nombre}»?\nNo se puede deshacer.`, "Borrar"))) return;
    try {
      const ruta = await ctx.rpc("broker_borrar_documento", { p_id: d.id });
      const { error } = await ctx.sb.storage.from(BUCKET).remove([ruta]);
      toast(error ? `Se quitó del registro, pero el archivo no se pudo borrar: ${error.message}` : "Archivo borrado.", error ? "mal" : "bien");
    } catch (e) { toast(e.message, "mal"); }
    await cargar(); alCambiar?.();
  }

  cargar();
  return el;
}

/** Tabla resumen de una propuesta (lo que regresa broker_simular o el resumen guardado). */
export function tablaPropuesta(ctx, r) {
  const { h, dinero, numero } = ctx.ui;
  const tipos = (r.por_tipo || []).map((t) => h("div", { class: "kpi" }, h("div", { class: "t" }, t.tipo === "JyP" ? "JyP (individual)" : "Grupal"),
    h("div", { class: "v" }, dinero(t.monto)),
    h("div", { class: "s" }, `${numero(t.creditos)} créditos${t.tipo === "Grupal" ? ` · ${numero(t.grupos)} grupos` : ""} · capital ${dinero(t.capital)} · ${cent(t.centavos)} por peso`)));
  return h("div", { class: "brk-prop" },
    h("div", { class: "kpis" },
      h("div", { class: "kpi destacado" }, h("div", { class: "t" }, "Inversión total"), h("div", { class: "v" }, dinero(r.monto)),
        h("div", { class: "s" }, `${numero(r.creditos)} créditos · capital ${dinero(r.capital)} · mora prom. ${numero(r.dias)} días`)),
      ...tipos),
    h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
      h("thead", {}, h("tr", {}, ...["Tipo", "Estado", "Municipio", "Créditos", "Grupos", "Capital", "Mora prom.", "Inversión"].map((t, i) => h("th", { class: i >= 3 ? "num" : "" }, t)))),
      h("tbody", {}, ...(r.lineas || []).map((l) => h("tr", {}, h("td", {}, l.tipo), h("td", {}, l.estado), h("td", {}, l.municipio || "—"),
        h("td", { class: "num" }, numero(l.creditos)), h("td", { class: "num" }, l.tipo === "Grupal" ? numero(l.grupos) : "—"),
        h("td", { class: "num" }, dinero(l.capital)), h("td", { class: "num" }, `${numero(l.dias)} d`), h("td", { class: "num" }, dinero(l.monto))))))));
}

/** Descarga en CSV los créditos de una propuesta guardada. */
export async function descargarCreditos(ctx, p) {
  try {
    const filas = await ctx.rpc("broker_propuesta_creditos", { p_id: p.id });
    const cols = ["Folio", "Tipo", "vReference", "vGroupId", "Estado", "Municipio", "Dias atraso", "Capital", "Inversion"];
    ctx.ui.descargarCSV(`${p.folio}_creditos.csv`, cols, (filas || []).map((f) => ({ Folio: p.folio, Tipo: f.tipo, vReference: f.referencia,
      vGroupId: f.grupo || "", Estado: f.estado, Municipio: f.municipio, "Dias atraso": f.dias, Capital: f.capital, Inversion: f.precio })));
  } catch (e) { ctx.ui.toast(e.message, "mal"); }
}
