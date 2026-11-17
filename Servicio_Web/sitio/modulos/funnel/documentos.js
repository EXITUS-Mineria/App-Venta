// ============================================================
// Documentos del Funnel (Supabase Storage, bucket privado "documentos-venta")
//  - tipo "comprobante_pago": comprobante del pago de la venta.
//  - tipo "comprador": documentos del comprador (PDF, fotos, Word).
// Las fotos se comprimen en el navegador (máx. 1800 px, JPEG) para ocupar poco espacio.
// Para ver un archivo se crea una liga temporal de 5 minutos; no hay ligas públicas.
// ============================================================
export const BUCKET = "documentos-venta";
const MAX_BYTES = 10 * 1024 * 1024;
const TIPOS_OK = {
  "application/pdf": "PDF", "image/jpeg": "Foto", "image/png": "Foto", "image/webp": "Foto", "image/heic": "Foto", "image/heif": "Foto",
  "application/msword": "Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};
const ACEPTA = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.doc,.docx,application/pdf,image/*,application/msword," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function tipoMime(file) {
  if (file.type && TIPOS_OK[file.type]) return file.type;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
    heif: "image/heif", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] || file.type || "";
}

const limpio = (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_").slice(-90);
const peso = (b) => (b == null ? "" : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** Fotos JPG/PNG/WEBP: reduce a 1800 px y JPEG 82 % si así pesa menos. HEIC, PDF y Word se suben tal cual. */
async function comprimir(file, mime) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime) || file.size < 350 * 1024) return { blob: file, mime, nombre: file.name };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
    if (blob && blob.size < file.size) return { blob, mime: "image/jpeg", nombre: file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg" };
  } catch { /* si el navegador no puede, se sube el original */ }
  return { blob: file, mime, nombre: file.name };
}

/**
 * Bloque de documentos de una venta.
 * ctx, folio, tipo ("comprobante_pago" | "comprador"), editable, titulo, alConteo(n) tras subir o borrar
 */
export function bloqueDocumentos(ctx, { folio, tipo, editable, titulo, ayuda, alConteo }) {
  const { h, toast, confirmar, fecha } = ctx.ui;
  const lista = h("ul", { class: "doc-lista" }, h("li", { class: "doc-vacio" }, "Cargando…"));
  const input = h("input", { type: "file", accept: ACEPTA, multiple: true, hidden: true, onchange: () => subir([...input.files]) });
  const estado = h("span", { class: "nota" });
  const zona = editable ? h("div", { class: "doc-zona", tabIndex: 0,
    onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } },
    ondragover: (e) => { e.preventDefault(); zona.classList.add("sobre"); },
    ondragleave: () => zona.classList.remove("sobre"),
    ondrop: (e) => { e.preventDefault(); zona.classList.remove("sobre"); subir([...e.dataTransfer.files]); } },
    h("b", {}, "⬆ Cargar archivos"), h("span", {}, " · arrastra aquí o da clic · PDF, fotos o Word (máx. 10 MB)")) : null;

  const el = h("div", { class: "doc-bloque" },
    h("div", { class: "doc-enc" }, h("b", {}, titulo), estado), ayuda ? h("div", { class: "nota" }, ayuda) : null,
    lista, zona, input);

  let iniciado = false;
  async function cargar() {
    const { data, error } = await ctx.sb.from("funnel_documentos").select("*").eq("folio", folio).eq("tipo", tipo).order("fecha");
    if (error) { lista.replaceChildren(h("li", { class: "doc-vacio" }, error.message)); return; }
    estado.textContent = data.length ? `${data.length} archivo${data.length === 1 ? "" : "s"}` : "";
    if (iniciado) alConteo?.(data.length);
    iniciado = true;
    lista.replaceChildren(...(data.length ? data.map((d) => h("li", {},
      h("span", { class: "doc-ico" }, d.mime === "application/pdf" ? "📄" : (d.mime || "").startsWith("image/") ? "🖼" : "📝"),
      h("a", { href: "#", title: "Abrir (liga temporal)", onclick: (e) => { e.preventDefault(); abrir(d); } }, d.nombre),
      h("small", {}, ` ${peso(d.bytes)} · ${d.subido_por || ""} · ${fecha(d.fecha)}`),
      editable ? h("button", { class: "btn btn-secundario btn-chico", title: "Borrar", onclick: () => borrar(d) }, "🗑") : null))
      : [h("li", { class: "doc-vacio" }, editable ? "Sin archivos todavía." : "Sin archivos.")]));
  }

  async function abrir(d) {
    const ventana = window.open("", "_blank");
    const { data, error } = await ctx.sb.storage.from(BUCKET).createSignedUrl(d.ruta, 300);
    if (error || !data?.signedUrl) { ventana?.close(); toast(error?.message || "No se pudo abrir el archivo.", "mal"); return; }
    if (ventana) ventana.location = data.signedUrl; else window.location.href = data.signedUrl;
  }

  async function subir(files) {
    input.value = "";
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
      const mime = tipoMime(file);
      if (!TIPOS_OK[mime]) { toast(`${file.name}: sólo PDF, fotos (JPG/PNG/WEBP/HEIC) o Word.`, "mal", 7000); continue; }
      estado.textContent = `Subiendo ${file.name}…`;
      const c = await comprimir(file, mime);
      if (c.blob.size > MAX_BYTES) { toast(`${file.name}: pesa ${peso(c.blob.size)}; el máximo es 10 MB.`, "mal", 7000); continue; }
      const ruta = `${folio}/${tipo}/${Date.now()}_${limpio(c.nombre)}`;
      const { error } = await ctx.sb.storage.from(BUCKET).upload(ruta, c.blob, { contentType: c.mime, upsert: false });
      if (error) { toast(`${file.name}: ${error.message}`, "mal", 8000); continue; }
      try {
        await ctx.rpc("funnel_registrar_documento", { p_folio: folio, p_tipo: tipo, p_nombre: c.nombre, p_ruta: ruta,
          p_mime: c.mime, p_bytes: c.blob.size });
        ok++;
      } catch (e) {
        await ctx.sb.storage.from(BUCKET).remove([ruta]);
        toast(`${file.name}: ${e.message}`, "mal", 8000);
      }
    }
    if (ok) toast(`${ok} archivo${ok === 1 ? "" : "s"} cargado${ok === 1 ? "" : "s"} en ${folio}.`, "bien");
    await cargar();
  }

  async function borrar(d) {
    if (!(await confirmar("Borrar archivo", `¿Borrar «${d.nombre}» de ${folio}?\nNo se puede deshacer.`, "Borrar"))) return;
    try {
      const ruta = await ctx.rpc("funnel_borrar_documento", { p_id: d.id });
      const { error } = await ctx.sb.storage.from(BUCKET).remove([ruta]);
      if (error) toast(`Se quitó del registro, pero el archivo no se pudo borrar: ${error.message}`, "mal", 8000);
      else toast("Archivo borrado.", "bien");
    } catch (e) { toast(e.message, "mal"); }
    await cargar();
  }

  cargar();
  return el;
}
