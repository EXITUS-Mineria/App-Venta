// ============================================================
// Propuesta en el PORTAL DEL COMPRADOR
// El vendedor dueño (o auxiliar / maestros) publica la propuesta; el comprador la ve en su portal
// (créditos en pantalla) y la acepta o rechaza. Ya no se manda Excel por correo: sólo un aviso con la liga
// (Edge Function "enviar-propuesta", acción "avisar", si Microsoft 365 está configurado).
// «⬇ Excel» queda como descarga interna.
// ============================================================
let catalogo = null;   // compradores activos (se carga una vez por sesión del módulo)

export async function llamar(ctx, body) {
  const { data, error } = await ctx.sb.functions.invoke("enviar-propuesta", { body });
  if (!error) return data;
  let d = null;
  try { d = await error.context.json(); } catch { /* sin cuerpo */ }
  const e = new Error(d?.error || error.message || "No se pudo contactar el servicio de correo");
  e.sinConfigurar = !!d?.sin_configurar;
  e.sinCorreo = !!d?.sin_correo;
  throw e;
}

export function bajar(nombre, base64) {
  const bin = atob(base64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([u8], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function bloqueEnvio(ctx, f, { editable, alEnviar }) {
  const { h, toast, confirmar, fecha } = ctx.ui;
  const cerrada = ["LIBERADA", "RECHAZADA"].includes(f.estatus_propuesta) || f.estatus_venta === "Cancelada";
  const vendida = f.estatus_venta === "Vendida";
  const selComp = h("select", { class: "campo" }, h("option", { value: "" }, "Cargando compradores…"));
  const btnPub = h("button", { class: "btn btn-marca", onclick: () => publicar() }, f.publicada_en ? "↻ Volver a publicar" : "🌐 Publicar al comprador");
  const btnRet = h("button", { class: "btn btn-secundario", onclick: () => retirar() }, "Retirar del portal");
  const btnExcel = h("button", { class: "btn btn-secundario", title: `${f.folio}_Propuesta.xlsx (uso interno)`, onclick: () => descargar() }, "⬇ Excel");

  const estado = f.publicada_en
    ? [`🌐 Publicada ${fecha(f.publicada_en)} · ${f.publicada_por || ""}`,
       f.vistas ? `👁 La abrió ${f.vistas} vez(es), última ${fecha(f.ultima_vista)}` : "👁 El comprador aún no la abre",
       f.respuesta ? `${f.respuesta === "ACEPTADA" ? "👍 ACEPTADA" : "👎 RECHAZADA"} por ${f.respuesta_por || "el comprador"} ${fecha(f.respuesta_en)}` +
         (f.respuesta_comentario ? ` · «${f.respuesta_comentario}»` : "") : "⏳ Esperando respuesta del comprador"]
    : ["Aún no se publica en el portal del comprador."];

  async function cargarCatalogo() {
    try { catalogo = catalogo || (await ctx.rpc("compradores_lista")).filter((c) => c.activo); }
    catch (e) { selComp.replaceChildren(h("option", { value: "" }, e.message)); return; }
    selComp.replaceChildren(h("option", { value: "" }, "— elige el comprador del catálogo —"),
      ...catalogo.map((c) => h("option", { value: c.id }, `${c.nombre}${c.accesos.some((u) => u.activo) ? "" : " (sin acceso al portal)"}`)));
  }

  async function descargar() {
    btnExcel.disabled = true;
    try { const d = await llamar(ctx, { accion: "descargar", folio: f.folio }); bajar(d.archivo, d.base64); toast(`${d.archivo}: ${d.registros} créditos.`, "bien"); }
    catch (e) { toast(e.message, "mal", 8000); }
    btnExcel.disabled = false;
  }

  async function publicar() {
    const idComp = f.comprador_id || Number(selComp.value) || null;
    if (!idComp) { toast("Elige el comprador del catálogo.", "mal"); selComp.focus(); return; }
    const nombre = f.comprador_cat || catalogo?.find((c) => c.id === idComp)?.nombre || "";
    const extra = f.estatus_propuesta === "EN REVISIÓN" ? "\n\nLa propuesta sigue EN REVISIÓN: el comprador verá los créditos; el precio aparece cuando el validador la apruebe." : "";
    const re = f.respuesta ? `\n\nYa había respondido (${f.respuesta}); al volver a publicar se le pide respuesta de nuevo.` : "";
    if (!(await confirmar("Publicar al comprador", `¿Publicar ${f.folio} en el portal de ${nombre}?${extra}${re}`, "Publicar"))) return;
    btnPub.disabled = true;
    try {
      const r = await ctx.rpc("funnel_publicar", { p_folio: f.folio, p_comprador: f.comprador_id ? null : idComp });
      if (!r.correos.length) {
        toast(`${f.folio} publicada, pero ${r.comprador} aún no tiene acceso al portal. Pide al validador que se lo dé en 🏢 Compradores.`, "", 10000);
      } else {
        try {
          const d = await llamar(ctx, { accion: "avisar", folio: f.folio, sitio: location.origin });
          toast(`${f.folio} publicada. Aviso por correo a ${d.para.join(", ")}.`, "bien", 7000);
        } catch (e) {
          toast(`${f.folio} publicada; ${r.comprador} la verá en su portal (🔔).` +
            (e.sinConfigurar ? " El aviso por correo aún no está configurado." : ` No se pudo mandar el correo: ${e.message}`), e.sinConfigurar ? "bien" : "", 9000);
        }
      }
      catalogo = null;
      alEnviar?.();
    } catch (e) { toast(e.message, "mal", 9000); }
    btnPub.disabled = false;
  }

  async function retirar() {
    if (!(await confirmar("Retirar del portal", `¿Quitar ${f.folio} del portal del comprador? Ya no podrá verla ni responderla.`, "Retirar"))) return;
    try { await ctx.rpc("funnel_retirar", { p_folio: f.folio }); toast(`${f.folio} retirada del portal.`, "bien"); alEnviar?.(); }
    catch (e) { toast(e.message, "mal"); }
  }

  const ligado = f.comprador_id
    ? h("div", { class: "nota" }, `🏢 Comprador del catálogo: `, h("b", {}, f.comprador_cat))
    : editable && !cerrada && !vendida ? h("label", {}, h("span", { class: "etiqueta" }, `«${f.comprador || "sin nombre"}» no está en el catálogo. Lígalo:`), selComp) : null;
  if (!f.comprador_id && editable && !cerrada && !vendida) cargarCatalogo();

  return h("div", { class: `doc-bloque env-bloque ${f.respuesta === "ACEPTADA" ? "env-ok" : f.respuesta === "RECHAZADA" ? "env-no" : ""}` },
    h("div", { class: "doc-enc" }, h("b", {}, "🌐 Portal del comprador"),
      h("span", { class: "nota" }, "El comprador ve los créditos en su portal y acepta o rechaza")),
    ligado,
    ...estado.map((t) => h("div", { class: "nota env-linea" }, t)),
    cerrada ? h("div", { class: "nota" }, `La propuesta está ${f.estatus_propuesta === "LIBERADA" || f.estatus_propuesta === "RECHAZADA" ? f.estatus_propuesta : "cancelada"}; ya no se puede publicar.`)
      : editable ? h("div", { class: "fila", style: { gap: "6px", justifyContent: "flex-start", marginTop: "6px" } },
          vendida ? null : btnPub, f.publicada_en && !vendida ? btnRet : null, btnExcel)
        : null);
}
