// ============================================================
// 📁 CARPETA DEL CLIENTE de una venta (Funnel)
//  Documentos que se suben (bucket privado "documentos-venta"):
//    INE · Constancia de situación fiscal · Comprobante de domicilio · Formato de alta del comprador ·
//    Comprobante de pago · NDA (+ otros documentos del comprador)
//  Documentos que se GENERAN al descargar (no se guardan):
//    Layout para solicitud de expedientes (Excel) · Base final (CSV Latin-1)
//  «⬇ Descargar carpeta (ZIP)» arma todo en el navegador: <folio>_<comprador>/01_INE/…
//  📧 Aviso a expedientes: al pasar a Vendida se manda solo (si Microsoft 365 y el correo están configurados);
//     también se puede mandar o reenviar con el botón. Si el correo no está configurado se ofrece Outlook.
// ============================================================
import { bloqueDocumentos, BUCKET } from "./documentos.js";
import { llamar, bajar } from "./envio.js";
import { armarLayout } from "../venta/layout.js";

export const JSZIP_CDN = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
export const DOCS_CARPETA = [
  ["ine", "INE", "01_INE"],
  ["comprobante_fiscal", "Constancia de situación fiscal", "02_Comprobante_fiscal"],
  ["comprobante_domicilio", "Comprobante de domicilio", "03_Comprobante_domicilio"],
  ["alta_comprador", "Formato de alta del comprador", "04_Formato_alta_comprador"],
  ["comprobante_pago", "Comprobante de pago", "05_Pago"],
  ["nda", "NDA", "06_NDA"],
];
const limpio = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9.\-]+/g, "_").replace(/^_+|_+$/g, "");
export const nombreCarpeta = (f) => [f.folio, limpio(f.comprador).slice(0, 50)].filter(Boolean).join("_");
const base64ABytes = (b64) => { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

/** Manda (o reenvía) el aviso a expedientes. silencioso: sin ventanas si no está configurado. */
export async function avisarExpedientes(ctx, f, { silencioso = false } = {}) {
  const { toast, confirmar, avisar } = ctx.ui;
  try {
    const r = await llamar(ctx, { accion: "expedientes", folio: f.folio });
    toast(`📧 Aviso a expedientes enviado a ${r.para.join(", ")} con el layout de ${r.registros} créditos.`, "bien", 7000);
    return true;
  } catch (e) {
    if (silencioso) { toast(`${f.folio} vendida: el aviso a expedientes quedó pendiente (${e.message})`, "", 8000); return false; }
    if (e.sinCorreo) { await avisar("Aviso a expedientes", "Falta el correo de expedientes.\nCaptúralo en Compradores › ⚙️ Portal (Aviso a expedientes)."); return false; }
    if (e.sinConfigurar) {
      const ok = await confirmar("Aviso a expedientes",
        `${e.message}\n\nPuedes mandarlo desde tu Outlook: descargo el layout de solicitud de expedientes y abro el correo ya redactado; sólo adjunta el archivo.`,
        "Abrir en Outlook");
      if (ok) await correoManual(ctx, f);
      return false;
    }
    toast(e.message, "mal", 9000);
    return false;
  }
}

async function correoManual(ctx, f) {
  let d = {};
  try { d = (await ctx.rpc("expedientes_aviso_datos", { p_folio: f.folio })) || {}; } catch { /* sin datos */ }
  try { const x = await llamar(ctx, { accion: "layout_expedientes", folio: f.folio }); bajar(x.archivo, x.base64); }
  catch (e) { ctx.ui.toast(e.message, "mal", 8000); }
  const asunto = `Solicitud de expedientes · venta ${f.folio}${f.comprador ? ` · ${f.comprador}` : ""}`;
  const cuerpo = `${d.saludo || "Hola"}, buen día:\n\nSe concretó la venta ${f.folio}${f.comprador ? ` al comprador ${f.comprador}` : ""}.\n` +
    "Te pido por favor tu apoyo con el envío de los expedientes. Adjunto el layout para la solicitud de expedientes.\n\nSaludos,\n" +
    `${d.yo_nombre || ctx.perfil.nombre || ""}\nExitus Credit`;
  const para = (d.para || []).join(",");
  window.location.href = `mailto:${encodeURIComponent(para).replace(/%40/g, "@").replace(/%2C/g, ",")}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}

/** Descarga la carpeta completa en ZIP. */
export async function descargarCarpeta(ctx, f, alAvance = () => {}) {
  const { construirCSV, textoALatin1 } = ctx.ui;
  const JSZip = (await import(JSZIP_CDN)).default;
  const zip = new JSZip();
  const raiz = nombreCarpeta(f);
  const faltan = [];
  const { data: docs, error } = await ctx.sb.from("funnel_documentos").select("*").eq("folio", f.folio).order("fecha");
  if (error) throw new Error(error.message);
  const carpetaDe = Object.fromEntries([...DOCS_CARPETA.map(([k, , c]) => [k, c]), ["comprador", "09_Otros_documentos"]]);
  let i = 0;
  for (const d of docs || []) {
    alAvance(`Descargando ${++i} de ${docs.length}: ${d.nombre}`);
    const { data: blob, error: e } = await ctx.sb.storage.from(BUCKET).download(d.ruta);
    if (e || !blob) { faltan.push(`${d.nombre}: ${e?.message || "no se pudo descargar"}`); continue; }
    zip.file(`${raiz}/${carpetaDe[d.tipo] || "09_Otros_documentos"}/${d.nombre}`, blob);
  }
  for (const [k, titulo] of DOCS_CARPETA) if (!(docs || []).some((d) => d.tipo === k)) faltan.push(`${titulo}: no se ha cargado`);

  alAvance("Generando layout de solicitud de expedientes…");
  try {
    const x = await llamar(ctx, { accion: "layout_expedientes", folio: f.folio });
    zip.file(`${raiz}/07_Layout_solicitud_expedientes/${x.archivo}`, base64ABytes(x.base64));
  } catch (e) { faltan.push(`Layout de solicitud de expedientes: ${e.message}`); }

  alAvance("Generando base final…");
  try {
    if (f.id_propuesta) {
      const { data: p, error: ep } = await ctx.sb.from("propuestas").select("*").eq("id_propuesta", f.id_propuesta).single();
      if (ep) throw new Error(ep.message);
      const b = await armarLayout(ctx, p);
      zip.file(`${raiz}/08_Base_final/${b.nombre}`, textoALatin1(construirCSV(b.columnas, b.filas)));
    } else {
      const filas = (await ctx.rpc("expedientes_layout", { p_folio: f.folio })) || [];
      if (!filas.length) throw new Error("la venta no tiene créditos cargados en el histórico");
      const cols = ["folio", "comprador", "tipo", "vgroupid", "grupo", "vreference", "icredid", "nombre", "estado", "municipio", "sucursal", "capital"];
      zip.file(`${raiz}/08_Base_final/${f.folio}_BaseFinal_historico.csv`, textoALatin1(construirCSV(cols, filas)));
    }
  } catch (e) { faltan.push(`Base final: ${e.message}`); }

  const adj = Array.isArray(f.adjuntos) ? f.adjuntos : [];
  const ligas = [...adj.map((a) => `${a.nombre}\t${a.url}`),
    ...[["Base final", f.base_final], ["Propuesta", f.propuesta_url], ["Comprobante de pago", f.comprobante_pago], ["Base completa", f.base_completa_venta]]
      .filter(([, u]) => u && /^https?:\/\//.test(u)).map(([t, u]) => `${t}\t${u}`)];
  if (ligas.length) zip.file(`${raiz}/Ligas_SharePoint.txt`, `Archivos de ${f.folio} que viven en SharePoint (ábrelos con tu cuenta):\r\n\r\n${ligas.join("\r\n")}\r\n`);
  if (faltan.length) zip.file(`${raiz}/PENDIENTES.txt`, `Pendientes de la carpeta ${f.folio}:\r\n\r\n- ${faltan.join("\r\n- ")}\r\n`);

  alAvance("Comprimiendo…");
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `${raiz}.zip` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { archivos: Object.keys(zip.files).filter((n) => !zip.files[n].dir).length, faltan };
}

/** Sección «📁 Carpeta del cliente» del detalle de la venta. */
export function bloqueCarpeta(ctx, f, { editable, alConteo }) {
  const { h, toast, fecha } = ctx.ui;
  const conteo = {};
  const progreso = h("span", { class: "car-prog" });
  const estadoAviso = h("div", { class: "nota car-aviso" });
  const avance = h("span", { class: "nota" });
  const pintarProgreso = () => {
    const listos = DOCS_CARPETA.filter(([k]) => conteo[k] > 0).length;
    progreso.textContent = `${listos} de ${DOCS_CARPETA.length} documentos`;
    progreso.className = `car-prog ${listos === DOCS_CARPETA.length ? "ok" : ""}`;
  };
  const filas = DOCS_CARPETA.map(([k, titulo]) => {
    const marca = h("span", { class: "car-marca" }, "⬜");
    const bloque = bloqueDocumentos(ctx, { folio: f.folio, tipo: k, editable, titulo, compacto: true,
      alConteo: (n) => { conteo[k] = n; marca.textContent = n ? "✅" : "⬜"; pintarProgreso();
        if (k === "comprobante_pago") alConteo?.("comprobantes", n); } });
    return h("div", { class: "car-item" }, marca, bloque);
  });
  const btnZip = h("button", { class: "btn btn-marca", onclick: async () => {
    btnZip.disabled = true;
    try {
      const r = await descargarCarpeta(ctx, f, (t) => { avance.textContent = t; });
      toast(`📁 ${nombreCarpeta(f)}.zip · ${r.archivos} archivos` + (r.faltan.length ? `. Pendientes: ${r.faltan.length} (ver PENDIENTES.txt)` : ""),
        r.faltan.length ? "" : "bien", 8000);
    } catch (e) { toast(`No se pudo armar la carpeta: ${e.message}`, "mal", 9000); }
    avance.textContent = ""; btnZip.disabled = false;
  } }, "⬇ Descargar carpeta (ZIP)");
  const btnLayout = h("button", { class: "btn btn-secundario", onclick: async () => {
    try { const x = await llamar(ctx, { accion: "layout_expedientes", folio: f.folio }); bajar(x.archivo, x.base64); }
    catch (e) { toast(e.message, "mal", 8000); }
  } }, "⬇ Layout de expedientes");
  const btnAviso = h("button", { class: "btn btn-secundario", hidden: !editable, onclick: async () => {
    btnAviso.disabled = true; await avisarExpedientes(ctx, f); btnAviso.disabled = false; pintarAviso();
  } }, "📧 Avisar a expedientes");

  async function pintarAviso() {
    if (!editable) return;
    try {
      const d = await ctx.rpc("expedientes_aviso_datos", { p_folio: f.folio });
      const a = d?.aviso;
      estadoAviso.textContent = a?.enviado_en ? `📧 Aviso a expedientes enviado ${fecha(a.enviado_en)} a ${a.enviado_a}${a.enviado_por ? ` (${a.enviado_por})` : ""}.`
        : a?.error ? `⚠ Aviso a expedientes pendiente: ${a.error}`
        : a ? "⏳ Aviso a expedientes pendiente de enviar."
        : f.estatus_venta === "Vendida" ? "Aún no se avisa a expedientes." : "Se avisa a expedientes cuando la venta pase a Vendida.";
      btnAviso.textContent = a?.enviado_en ? "📧 Reenviar a expedientes" : "📧 Avisar a expedientes";
    } catch { estadoAviso.textContent = ""; }
  }
  pintarProgreso(); pintarAviso();

  return h("section", { class: "fun-sec car" },
    h("div", { class: "car-enc" }, h("h4", {}, "📁 Carpeta del cliente"), progreso),
    h("div", { class: "nota" }, "Sube cada documento en su apartado. El layout para solicitud de expedientes y la base final se generan al descargar."),
    h("div", { class: "car-lista" }, ...filas,
      h("div", { class: "car-item car-gen" }, h("span", { class: "car-marca" }, "⚙️"), h("div", {}, h("b", {}, "Layout para solicitud de expedientes"), h("div", { class: "nota" }, "Excel con los créditos de la venta (se genera)"))),
      h("div", { class: "car-item car-gen" }, h("span", { class: "car-marca" }, "⚙️"), h("div", {}, h("b", {}, "Base final"), h("div", { class: "nota" }, f.id_propuesta ? "CSV layout Funnel (se genera)" : "CSV del archivo de la venta (histórico) + liga de SharePoint")))),
    bloqueDocumentos(ctx, { folio: f.folio, tipo: "comprador", editable, titulo: "📂 Otros documentos del comprador",
      ayuda: "Acta constitutiva, poderes, contrato firmado… (PDF, fotos, Word o Excel).", alConteo: (n) => alConteo?.("documentos", n) }),
    estadoAviso,
    h("div", { class: "fila car-acc" }, btnZip, btnLayout, btnAviso, avance));
}
