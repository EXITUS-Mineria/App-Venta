// ============================================================
// Compradores · pestañas extra
//  💰 Ofertas: precio (centavos por peso de capital) que ofertan los compradores desde su portal.
//     Responde el vendedor de la propuesta, su ejecutivo o un validador / admin.
//  🏅 Lealtad: niveles por compras de los últimos 12 meses y sus beneficios (descuento, acceso anticipado…).
//  📰 Casos de éxito: noticias de demandas digitales que ven los compradores en su Inicio.
//  ⚙️ Portal: interruptores de lo que ve el comprador.
// ============================================================
const cent = (v) => (v == null ? "—" : `${(Number(v) * 100).toLocaleString("es-MX", { maximumFractionDigits: 2 })} ¢`);
const EST_OFERTA = { NUEVA: "Nueva", ACEPTADA: "Aceptada", RECHAZADA: "Rechazada", CONTRAOFERTA: "Contraoferta enviada" };

export async function ofertas(ctx, cuerpo) {
  const { h, tabla, toast, dinero, fecha } = ctx.ui;
  const verTodas = h("input", { type: "checkbox", onchange: () => cargar() });
  const panel = h("div", { class: "tarjeta cmp-panel", hidden: true });
  const t = tabla([
    { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
    { clave: "folio", titulo: "Propuesta" }, { clave: "comprador", titulo: "Comprador" }, { clave: "nivel", titulo: "Nivel" },
    { clave: "centavos", titulo: "Oferta", num: true, formato: (v) => cent(v) },
    { clave: "monto", titulo: "Monto ofertado", num: true, formato: (v) => dinero(v) },
    { clave: "centavos_propuesta", titulo: "Precio propuesta", num: true, formato: (v, o) => `${cent(v)}${o.precio_propuesta ? ` · ${dinero(o.precio_propuesta)}` : ""}` },
    { clave: "comentario", titulo: "Comentario" },
    { clave: "estatus", titulo: "Estatus", formato: (v, o) => h("span", { class: `cmp-est e-${v === "NUEVA" ? "NUEVA" : v === "ACEPTADA" ? "ATENDIDA" : "EN-PROCESO"}` },
        EST_OFERTA[v] || v, o.contra_centavos ? ` ${cent(o.contra_centavos)}` : "") },
    { clave: "respuesta", titulo: "Respuesta", formato: (v, o) => [v, o.respondida_por].filter(Boolean).join(" · ") },
  ], { vacio: "Sin ofertas por responder" });
  t.el.addEventListener("click", (e) => { const o = t.filaDe(e.target.closest("tbody tr")); if (o) responder(o); });
  cuerpo.replaceChildren(h("div", { class: "tarjeta" },
    h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "8px" } },
      h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "💰 Ofertas de precio"),
      h("label", { style: { flex: "0 0 auto" } }, verTodas, " Ver también las respondidas"),
      h("span", { class: "nota", style: { flex: "1 1 auto" } }, "El comprador oferta centavos por peso de capital desde «Mis propuestas». Da clic para responder; aceptar no cambia el precio: se autoriza en Revisión como siempre."),
      h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")), t.el), panel);

  async function cargar() {
    try { t.setFilas(await ctx.rpc("ofertas_lista", { p_todas: verTodas.checked })); } catch (e) { toast(e.message, "mal"); }
  }
  function responder(o) {
    const resp = h("input", { class: "campo", placeholder: "Mensaje para el comprador (opcional)" });
    const contra = h("input", { class: "campo", type: "number", min: 1, max: 99, step: "0.1", placeholder: "¢ por peso", style: { maxWidth: "120px" } });
    const enviar = async (estatus) => {
      const p = { p_id: o.id, p_estatus: estatus, p_respuesta: resp.value.trim(), p_contra: null };
      if (estatus === "CONTRAOFERTA") {
        const c = Number(contra.value);
        if (!(c > 0 && c < 100)) { toast("Escribe la contraoferta en centavos (1 a 99).", "mal"); return; }
        p.p_contra = c / 100;
      }
      try { await ctx.rpc("oferta_responder", p); toast(`Oferta de ${o.comprador} en ${o.folio}: ${EST_OFERTA[estatus]}. Se le avisó.`, "bien"); panel.hidden = true; cargar(); }
      catch (e) { toast(e.message, "mal", 8000); }
    };
    panel.hidden = false;
    panel.replaceChildren(h("h3", {}, `${o.folio} · ${o.comprador}${o.nivel ? ` (${o.nivel})` : ""}`),
      h("div", { class: "nota" }, `Ofrece ${cent(o.centavos)} por peso → ${dinero(o.monto)} sobre capital ${dinero(o.capital)}. ` +
        `Precio de la propuesta: ${cent(o.centavos_propuesta)}${o.precio_propuesta ? ` (${dinero(o.precio_propuesta)})` : ""}.` + (o.comentario ? ` «${o.comentario}»` : "")),
      h("div", { class: "cmp-grid" }, h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Respuesta"), resp)),
      h("div", { class: "fila", style: { justifyContent: "flex-end", gap: "6px", flexWrap: "wrap" } },
        h("button", { class: "btn btn-secundario", onclick: () => { panel.hidden = true; } }, "Cerrar"),
        h("button", { class: "btn btn-secundario", onclick: () => enviar("RECHAZADA") }, "👎 Rechazar"),
        contra, h("button", { class: "btn btn-secundario", onclick: () => enviar("CONTRAOFERTA") }, "💬 Contraofertar"),
        h("button", { class: "btn btn-marca", onclick: () => enviar("ACEPTADA") }, "👍 Aceptar")));
    panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
  await cargar();
}

export async function lealtad(ctx, cuerpo, maestro) {
  const { h, tabla, toast, dinero, numero } = ctx.ui;
  let niveles, compradores;
  try { [niveles, compradores] = await Promise.all([ctx.rpc("lealtad_lista"), ctx.rpc("lealtad_compradores")]); }
  catch (e) { toast(e.message, "mal"); return; }
  const campos = niveles.map((n) => ({ n,
    compras: h("input", { class: "campo", type: "number", min: 0, value: n.compras_min, disabled: !maestro || n.orden === 0, style: { width: "70px" } }),
    monto: h("input", { class: "campo", type: "number", min: 0, step: 1000, value: Number(n.monto_min), disabled: !maestro || n.orden === 0, style: { width: "110px" } }),
    desc: h("input", { class: "campo", type: "number", min: 0, max: 10, step: "0.1", value: Number(n.descuento_centavos) * 100, disabled: !maestro, style: { width: "70px" } }),
    dias: h("input", { class: "campo", type: "number", min: 0, max: 15, value: n.dias_anticipo, disabled: !maestro, style: { width: "60px" } }),
    ben: h("input", { class: "campo", value: n.beneficios || "", disabled: !maestro }) }));
  const tc = tabla([
    { clave: "comprador", titulo: "Comprador" },
    { clave: "nivel", titulo: "Nivel", formato: (v, c) => h("span", { class: "cmp-est", style: { background: c.color || "", color: "#fff" } }, v) },
    { clave: "compras_12m", titulo: "Compras 12 m", num: true, formato: (v) => numero(v) },
    { clave: "monto_12m", titulo: "Monto 12 m", num: true, formato: (v) => dinero(v) },
    { clave: "descuento_centavos", titulo: "Descuento", num: true, formato: (v) => cent(v) },
    { clave: "siguiente", titulo: "Siguiente nivel" },
  ], { vacio: "Sin compradores en el catálogo" });
  tc.setFilas(compradores);
  cuerpo.replaceChildren(
    h("div", { class: "tarjeta" },
      h("h3", { style: { margin: "0 0 4px" } }, "🏅 Programa de lealtad"),
      h("div", { class: "nota" }, "El nivel se calcula solo con las compras (Vendida) de los últimos 12 meses: se alcanza con el número de compras o con el monto. " +
        "El comprador ve su nivel, sus beneficios y cuánto le falta para el siguiente en su Inicio. El descuento es una guía para el vendedor al poner precio."),
      h("table", { class: "tabla", style: { marginTop: "8px" } },
        h("thead", {}, h("tr", {}, ...["Nivel", "Compras mín.", "o monto mín.", "Descuento ¢", "Días anticipo", "Beneficios", "Compradores"].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...campos.map((c) => h("tr", {},
          h("td", {}, h("b", { style: { color: c.n.color || "" } }, c.n.nivel)), h("td", {}, c.compras), h("td", {}, c.monto),
          h("td", {}, c.desc), h("td", {}, c.dias), h("td", {}, c.ben), h("td", { style: { textAlign: "right" } }, numero(c.n.compradores)))))),
      maestro ? h("div", { class: "fila", style: { justifyContent: "flex-end", marginTop: "8px" } }, h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: async () => {
        try {
          await ctx.rpc("lealtad_guardar", { p_niveles: campos.map((c) => ({ nivel: c.n.nivel, compras_min: Number(c.compras.value) || 0, monto_min: Number(c.monto.value) || 0,
            descuento_centavos: (Number(c.desc.value) || 0) / 100, dias_anticipo: Number(c.dias.value) || 0, beneficios: c.ben.value.trim() })) });
          toast("Niveles guardados.", "bien"); lealtad(ctx, cuerpo, maestro);
        } catch (e) { toast(e.message, "mal", 8000); }
      } }, "💾 Guardar niveles")) : null),
    h("div", { class: "tarjeta" }, h("h3", { style: { margin: "0 0 8px" } }, "Compradores por nivel"), tc.el));
}

export async function noticias(ctx, cuerpo, maestro) {
  const { h, toast, confirmar } = ctx.ui;
  let datos;
  try { datos = maestro ? await ctx.rpc("noticias_lista") : []; } catch (e) { toast(e.message, "mal"); return; }
  if (!maestro) { cuerpo.replaceChildren(h("div", { class: "tarjeta nota" }, "Las noticias del portal las publica el validador o un administrador.")); return; }
  const form = h("div", { class: "tarjeta cmp-panel", hidden: true });
  const lista = h("div", { class: "nt-lista" });
  const pintarLista = () => lista.replaceChildren(...(datos.length ? datos.map((n) => h("div", { class: "nt-item", style: { borderTop: "1px solid var(--linea)", padding: "8px 0", cursor: "pointer" }, onclick: () => editar(n) },
    h("div", {}, h("b", {}, n.titulo), " ", h("span", { class: `cmp-est ${n.publicado ? "e-ATENDIDA" : ""}` }, n.publicado ? "Publicada" : "Borrador"),
      h("span", { class: "nota" }, ` · ${n.categoria} · ${n.fecha}`)),
    n.resumen ? h("div", { class: "nota" }, n.resumen) : null)) : [h("div", { class: "nota" }, "Aún no hay noticias. Publica el primer caso de éxito.")]));
  function editar(n) {
    const campo = (v, ph) => h("input", { class: "campo", value: v || "", placeholder: ph });
    const fT = campo(n?.titulo, "Ej. Sentencia favorable en juicio ejecutivo mercantil digital"), fC = campo(n?.categoria || "Caso de éxito", "Categoría");
    const fF = h("input", { class: "campo", type: "date", value: n?.fecha || new Date().toISOString().slice(0, 10) });
    const fR = h("textarea", { class: "campo", rows: 2, placeholder: "Resumen corto que se ve en la tarjeta" }, n?.resumen || "");
    const fX = h("textarea", { class: "campo", rows: 6, placeholder: "Detalle del caso: tipo de cartera, monto recuperado, plazo, cómo ayudó la demanda digital… (sin datos personales del acreditado)" }, n?.contenido || "");
    const fE = campo(n?.enlace, "https://… (opcional)");
    const fP = h("input", { type: "checkbox", checked: n ? n.publicado : false });
    const guardar = async () => {
      try {
        await ctx.rpc("noticia_guardar", { p: { id: n?.id ?? null, titulo: fT.value, categoria: fC.value, fecha: fF.value, resumen: fR.value, contenido: fX.value, enlace: fE.value, publicado: fP.checked } });
        toast(fP.checked ? "Noticia publicada en el portal." : "Borrador guardado.", "bien"); noticias(ctx, cuerpo, maestro);
      } catch (e) { toast(e.message, "mal", 8000); }
    };
    form.hidden = false;
    form.replaceChildren(h("h3", {}, n ? "Editar noticia" : "＋ Nueva noticia"),
      h("div", { class: "cmp-grid" },
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Título"), fT),
        h("label", {}, h("span", { class: "etiqueta" }, "Categoría"), fC), h("label", {}, h("span", { class: "etiqueta" }, "Fecha"), fF),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Resumen"), fR),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Contenido"), fX),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Enlace"), fE),
        h("label", {}, fP, " Publicada (la ven los compradores)")),
      h("div", { class: "nota" }, "No incluyas nombres ni datos de acreditados: el portal lo ven todos los compradores."),
      h("div", { class: "fila", style: { justifyContent: "flex-end", gap: "6px" } },
        n ? h("button", { class: "btn btn-secundario", onclick: async () => {
          if (!(await confirmar("Borrar noticia", `¿Borrar «${n.titulo}»? No se puede deshacer.`, "Borrar"))) return;
          try { await ctx.rpc("noticia_borrar", { p_id: n.id }); toast("Noticia borrada.", "bien"); noticias(ctx, cuerpo, maestro); } catch (e) { toast(e.message, "mal"); }
        } }, "🗑 Borrar") : null,
        h("button", { class: "btn btn-secundario", onclick: () => { form.hidden = true; } }, "Cerrar"),
        h("button", { class: "btn btn-marca", onclick: guardar }, "💾 Guardar")));
    form.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
  cuerpo.replaceChildren(h("div", { class: "tarjeta" },
    h("div", { class: "fila", style: { justifyContent: "flex-start" } },
      h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📰 Casos de éxito de demandas digitales"),
      h("span", { class: "nota", style: { flex: "1 1 auto" } }, "Las publicadas aparecen en el Inicio del portal del comprador como noticias."),
      h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: () => editar(null) }, "＋ Nueva noticia")), lista), form);
  pintarLista();
}

const OPCIONES_PORTAL = [
  ["portal_ver_interes", "👀 Interés de otros compradores", "En cada propuesta por responder, el comprador ve cuántos otros compradores buscan cartera en los mismos estados (sin nombres)."],
  ["portal_ofertas", "💰 Ofertas de precio", "El comprador puede ofertar centavos por peso de capital en sus propuestas por responder."],
  ["portal_lealtad", "🏅 Nivel de lealtad", "El comprador ve su nivel, beneficios y lo que le falta para el siguiente."],
];
export async function ajustesPortal(ctx, cuerpo) {
  const { h, toast, fecha } = ctx.ui;
  let cfg;
  try { cfg = Object.fromEntries((await ctx.rpc("config_lista")).map((c) => [c.clave, c])); } catch (e) { toast(e.message, "mal"); return; }
  cuerpo.replaceChildren(h("div", { class: "tarjeta", style: { maxWidth: "760px" } },
    h("h3", { style: { margin: "0 0 6px" } }, "⚙️ Qué ve el comprador en su portal"),
    ...OPCIONES_PORTAL.map(([k, t, d]) => h("label", { class: "fila", style: { alignItems: "flex-start", gap: "10px", padding: "8px 0", borderTop: "1px solid var(--linea)", justifyContent: "flex-start" } },
      h("input", { type: "checkbox", "data-clave": k, checked: cfg[k]?.valor === true, style: { flex: "0 0 auto", marginTop: "4px" }, onchange: async (e) => {
        try { await ctx.rpc("config_guardar", { p_clave: k, p_valor: e.target.checked }); toast(`${t}: ${e.target.checked ? "activado" : "desactivado"}.`, "bien"); }
        catch (err) { e.target.checked = !e.target.checked; toast(err.message, "mal", 8000); }
      } }),
      h("div", { style: { flex: "1 1 auto" } }, h("b", {}, t), h("div", { class: "nota" }, d),
        cfg[k]?.actualizado_por ? h("div", { class: "nota" }, `Último cambio: ${cfg[k].actualizado_por} · ${fecha(cfg[k].actualizado)}`) : null))),
    h("div", { class: "nota" }, "Las exclusiones de cartera (promesas, pagos, lista negra) se prenden en 🗂️ Bases.")));
}
