// ============================================================
// Compradores · 📊 Compras del año y 🛍️ Tienda de paquetes
//  📊 Cuánto nos ha comprado cada comprador (ventas «Vendida» del Funnel), mes a mes, a qué precio
//     y en qué zonas compra (estados y municipios por capital). Vendedor: sólo sus ventas.
//  🛍️ Paquetes pre-armados que el comprador ve en su portal (Tienda). La disponibilidad se calcula
//     al momento; pedir un paquete crea una solicitud de compra (no aparta nada).
// ============================================================
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const cent = (v) => (v == null ? "—" : `${(Number(v) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} ¢`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** Mini gráfica de barras de 12 meses (HTML, sin librerías). */
function barrasMes(h, meses, { grande = false, fmt } = {}) {
  const max = Math.max(1, ...meses.map(Number));
  return h("div", { class: `cmp-mes ${grande ? "grande" : ""}`, title: meses.map((v, i) => `${MESES[i]}: ${fmt ? fmt(v) : v}`).join(" · ") },
    ...meses.map((v, i) => h("div", { class: "cmp-mes-col" },
      grande && Number(v) ? h("small", {}, fmt ? fmt(v) : v) : null,
      h("span", { style: { height: `${Math.max(Number(v) ? 6 : 0, (Number(v) / max) * 100)}%` } }),
      grande ? h("i", {}, MESES[i]) : null)));
}

export async function comprasPorComprador(ctx, cuerpo, { irTienda, maestro } = {}) {
  const { h, tabla, kpi, dinero, numero, toast, descargarCSV } = ctx.ui;
  const anioActual = new Date().getFullYear();
  const selAnio = h("select", { class: "campo", style: { maxWidth: "140px" }, onchange: () => cargar() },
    h("option", { value: String(anioActual) }, String(anioActual)), h("option", { value: String(anioActual - 1) }, String(anioActual - 1)),
    h("option", { value: "" }, "Todos los años"));
  const buscar = h("input", { class: "campo", placeholder: "🔍 Comprador, estado o municipio", oninput: () => pintar() });
  const kC = kpi("Compradores"), kV = kpi("Ventas"), kM = kpi("Monto comprado"), kP = kpi("Precio promedio");
  const panel = h("div", { class: "tarjeta cmp-panel", hidden: true });
  let datos = [];
  const t = tabla([
    { clave: "comprador", titulo: "Comprador", formato: (v, f) => h("span", {}, h("b", {}, v),
        f.nivel ? h("span", { class: "cmp-est e-ATENDIDA", style: { marginLeft: "6px" } }, `🏅 ${f.nivel}`) : null,
        !f.registrado ? h("small", { class: "nota", title: "No está en el catálogo: dalo de alta (o agrégalo como alias) para su portal y lealtad" }, " · sin catálogo") : null) },
    { clave: "ventas", titulo: "Ventas", num: true, formato: (v) => numero(v) },
    { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
    { clave: "monto", titulo: "Monto", num: true, formato: (v) => dinero(v) },
    { clave: "centavos", titulo: "Precio", num: true, formato: (v) => cent(v) },
    { clave: "meses", titulo: "Mes a mes", formato: (v) => barrasMes(h, v || [], { fmt: dinero }) },
    { clave: "zonas", titulo: "Zonas recurrentes", formato: (_, f) => h("span", { class: "cmp-zonas" },
        ...(f.estados || []).slice(0, 2).map((e) => h("span", { class: "cmp-chip" }, `${e.estado} ${pct(e.capital, f.capitalZonas)}%`)),
        f.municipios?.[0] ? h("small", { class: "nota" }, ` · ${f.municipios[0].municipio}`) : null) },
    { clave: "tipo_principal", titulo: "Tipo" },
    { clave: "ultima", titulo: "Última compra" },
  ], { idFila: (f) => f.clave, vacio: "Sin ventas vendidas en el periodo" });
  t.el.addEventListener("click", (e) => { const f = t.filaDe(e.target.closest("tbody tr")); if (f) detalle(f); });

  cuerpo.replaceChildren(
    h("div", { class: "kpis" }, kC.el, kV.el, kM.el, kP.el),
    h("div", { class: "tarjeta" },
      h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "8px", flexWrap: "wrap" } },
        h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📊 Compras por comprador"), selAnio,
        h("div", { style: { flex: "1 1 220px" } }, buscar),
        h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => exportar() }, "⬇ Exportar"),
        h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
      h("div", { class: "nota", style: { marginBottom: "6px" } }, "Ventas «Vendida» del Funnel. Zonas por capital de los créditos vendidos. Clic en un comprador para ver su detalle."),
      t.el),
    panel);

  async function cargar() {
    try {
      datos = ((await ctx.rpc("compradores_resumen", { p_anio: selAnio.value ? Number(selAnio.value) : null })) || []).map((f) => ({
        ...f, ventas: Number(f.ventas), capital: Number(f.capital), monto: Number(f.monto), centavos: f.centavos == null ? null : Number(f.centavos),
        meses: (f.meses || []).map(Number), capitalZonas: (f.estados || []).reduce((s, e) => s + Number(e.capital || 0), 0) }));
    } catch (e) { toast(e.message, "mal"); return; }
    panel.hidden = true;
    pintar();
  }
  function filtrados() {
    const q = buscar.value.trim().toUpperCase();
    return !q ? datos : datos.filter((f) => [f.comprador, ...(f.estados || []).map((e) => e.estado), ...(f.municipios || []).map((m) => m.municipio)]
      .join(" ").toUpperCase().includes(q));
  }
  function pintar() {
    const v = filtrados();
    const monto = v.reduce((s, f) => s + f.monto, 0), cap = v.reduce((s, f) => s + (f.centavos != null ? f.capital : 0), 0);
    kC.set(numero(v.length), `${numero(v.filter((f) => f.ventas > 1).length)} recurrentes (2+ compras)`);
    kV.set(numero(v.reduce((s, f) => s + f.ventas, 0)), dinero(v.reduce((s, f) => s + f.capital, 0)) + " de capital");
    kM.set(dinero(monto), selAnio.value ? `en ${selAnio.value}` : "todos los años");
    kP.set(cent(cap ? monto / cap : null), "monto / capital");
    t.setFilas(v);
  }
  function detalle(f) {
    const total = f.capitalZonas || 1;
    const lista = (items, etiqueta) => h("div", { class: "cmp-barras" }, ...(items || []).map((x) => h("div", { class: "cmp-barra" },
      h("span", { class: "cmp-barra-txt" }, etiqueta(x)), h("span", { class: "cmp-barra-fondo" }, h("span", { style: { width: `${pct(x.capital, total)}%` } })),
      h("small", {}, `${pct(x.capital, total)}% · ${numero(x.creditos)} créd.`))));
    const est = (f.estados || [])[0];
    panel.hidden = false;
    panel.replaceChildren(
      h("div", { class: "fila", style: { justifyContent: "space-between" } },
        h("h3", { style: { margin: 0 } }, f.comprador, f.nivel ? ` · 🏅 ${f.nivel}` : ""),
        h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => { panel.hidden = true; } }, "✖")),
      h("div", { class: "nota" }, `${numero(f.ventas)} compra(s) · ${dinero(f.monto)} por ${dinero(f.capital)} de capital (${cent(f.centavos)}) · ` +
        `primera ${f.primera || "—"}, última ${f.ultima || "—"} · vendedor(es): ${f.vendedores || "—"}`),
      h("div", { class: "cmp-det-grid" },
        h("div", {}, h("h4", {}, "Mes a mes (monto)"), barrasMes(h, f.meses, { grande: true, fmt: (x) => (x >= 1000 ? `${Math.round(x / 1000)}k` : x) })),
        h("div", {}, h("h4", {}, "Estados donde compra"), lista(f.estados, (x) => x.estado)),
        h("div", {}, h("h4", {}, "Municipios recurrentes"), lista(f.municipios, (x) => `${x.municipio} (${x.estado})`))),
      h("h4", {}, "Sus compras"),
      h("ul", { class: "cmp-ventas" }, ...(f.detalle || []).map((d) => h("li", {}, h("b", {}, d.folio), ` · ${d.fecha || ""} · ${d.tipo || ""} · ${dinero(d.capital)} capital · ${dinero(d.monto)}${d.estado ? ` · ${d.estado}` : ""}`))),
      irTienda && (maestro || ctx.tieneRol("auxiliar")) && est ? h("div", { class: "fila", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: () => irTienda({
          titulo: `${f.tipo_principal === "Grupal" ? "Grupal" : "JyP"} ${est.estado}${f.municipios?.length ? " · " + f.municipios.slice(0, 2).map((m) => m.municipio).join(" y ") : ""}`,
          tipo: f.tipo_principal === "Grupal" ? "Grupal" : "JyP", estados: [est.estado],
          municipios: (f.municipios || []).filter((m) => m.estado === est.estado).slice(0, 6).map((m) => m.municipio),
          capital_objetivo: Math.round(f.capital / Math.max(1, f.ventas) / 1000) * 1000, centavos: f.centavos }) },
          "🛍️ Armar paquete con sus zonas")) : null);
    panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
  function exportar() {
    const v = filtrados();
    descargarCSV(`Compras_por_comprador_${selAnio.value || "todos"}.csv`,
      ["Comprador", "Ventas", "Capital", "Monto", "CentavosPorPeso", ...MESES, "Estados", "Municipios", "TipoPrincipal", "PrimeraCompra", "UltimaCompra", "Vendedores"],
      v.map((f) => ({ Comprador: f.comprador, Ventas: f.ventas, Capital: f.capital, Monto: f.monto, CentavosPorPeso: f.centavos ?? "",
        ...Object.fromEntries(MESES.map((m, i) => [m, f.meses[i] || 0])),
        Estados: (f.estados || []).map((e) => `${e.estado} ${pct(e.capital, f.capitalZonas)}%`).join("; "),
        Municipios: (f.municipios || []).map((m) => m.municipio).join("; "), TipoPrincipal: f.tipo_principal || "",
        PrimeraCompra: f.primera || "", UltimaCompra: f.ultima || "", Vendedores: f.vendedores || "" })));
  }
  await cargar();
}

export async function tiendaAdmin(ctx, cuerpo, maestro, prefill = null) {
  const { h, tabla, dinero, numero, toast, confirmar } = ctx.ui;
  const edita = maestro || ctx.tieneRol("auxiliar");
  let datos = [];
  const form = h("div", { class: "tarjeta cmp-panel", hidden: true });
  const t = tabla([
    { clave: "titulo", titulo: "Paquete", formato: (v, p) => h("span", {}, p.destacado ? "⭐ " : "", h("b", {}, v), !p.activo ? h("small", { class: "nota" }, " · inactivo") : null) },
    { clave: "tipo", titulo: "Tipo" },
    { clave: "estados", titulo: "Zona", formato: (v, p) => [(v || []).join(", ") || "Todo el país", (p.municipios || []).length ? ` · ${p.municipios.length} municipio(s)` : ""].join("") },
    { clave: "capital_objetivo", titulo: "Tamaño", num: true, formato: (v) => (v ? dinero(v) : "Todo") },
    { clave: "centavos", titulo: "Precio", num: true, formato: (v) => cent(v) },
    { clave: "disp", titulo: "Disponible hoy", num: true, formato: (_, p) => `${dinero(p.disponible?.capital)} · ${numero(p.disponible?.creditos)} créd.` },
    { clave: "pedidos", titulo: "Pedidos", num: true, formato: (v) => numero(v) },
  ], { vacio: "Aún no hay paquetes. Arma el primero." });
  if (edita) t.el.addEventListener("click", (e) => { const p = t.filaDe(e.target.closest("tbody tr")); if (p) editar(p); });

  cuerpo.replaceChildren(h("div", { class: "tarjeta" },
    h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "8px" } },
      h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "🛍️ Tienda del portal"),
      h("span", { class: "nota", style: { flex: "1 1 auto" } }, "Paquetes que ven los compradores en su Tienda, además de recomendaciones automáticas por sus compras anteriores. La disponibilidad se calcula al momento; nada se aparta."),
      edita ? h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: () => editar(null) }, "＋ Nuevo paquete") : null),
    t.el), form);

  async function cargar() {
    try { datos = (await ctx.rpc("paquetes_lista")) || []; t.setFilas(datos); } catch (e) { toast(e.message, "mal"); }
  }
  const lista = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  const titulo = (s) => String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

  function editar(p) {
    const v = p || prefill || {};
    const fT = h("input", { class: "campo", value: v.titulo || "", placeholder: "Ej. JyP Valle de México · 90+ días" });
    const fD = h("textarea", { class: "campo", rows: 2, placeholder: "Descripción para el comprador (opcional)" }, v.descripcion || "");
    const fTipo = h("select", { class: "campo" }, h("option", { value: "JyP" }, "Individual (JyP)"), h("option", { value: "Grupal" }, "Grupal"));
    fTipo.value = v.tipo || "JyP";
    const fE = h("input", { class: "campo", value: lista(v.estados).map(titulo).join(", "), placeholder: "Estados separados por coma (vacío = todo el país)" });
    const fM = h("input", { class: "campo", value: lista(v.municipios).map(titulo).join(", "), placeholder: "Municipios separados por coma (opcional)" });
    const fMin = h("input", { class: "campo", type: "number", min: 0, value: v.dias_min ?? "", placeholder: "Mín." });
    const fMax = h("input", { class: "campo", type: "number", min: 0, value: v.dias_max ?? "", placeholder: "Máx." });
    const fCap = h("input", { class: "campo", type: "number", min: 0, step: 10000, value: v.capital_objetivo ?? "", placeholder: "Vacío = todo lo disponible" });
    const fC = h("input", { class: "campo", type: "number", min: 1, max: 99, step: "0.1", value: v.centavos ? Number(v.centavos) * 100 : "", placeholder: "¢ por peso" });
    const fDest = h("input", { type: "checkbox", checked: !!v.destacado });
    const fAct = h("input", { type: "checkbox", checked: v.activo !== false });
    const prev = h("div", { class: "nota" });
    const datosForm = () => ({ id: p?.id ?? null, titulo: fT.value, descripcion: fD.value, tipo: fTipo.value, estados: lista(fE.value), municipios: lista(fM.value),
      dias_min: fMin.value, dias_max: fMax.value, capital_objetivo: fCap.value, centavos: fC.value ? Number(fC.value) / 100 : "",
      destacado: fDest.checked, activo: fAct.checked });
    const vista = async () => {
      prev.textContent = "Calculando…";
      try {
        const s = await ctx.rpc("paquete_vista_previa", { p: datosForm() });
        prev.textContent = `Disponible hoy con esos filtros: ${dinero(s?.capital)} · ${numero(s?.creditos)} créditos` +
          (s?.grupos ? ` en ${numero(s.grupos)} grupos` : "") + ` · ${numero(s?.municipios)} municipio(s) · mora prom. ${s?.dias ?? "—"} días`;
      } catch (e) { prev.textContent = e.message; }
    };
    form.hidden = false;
    form.replaceChildren(h("h3", {}, p ? "Editar paquete" : "＋ Nuevo paquete"),
      h("div", { class: "cmp-grid" },
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Título"), fT),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Descripción"), fD),
        h("label", {}, h("span", { class: "etiqueta" }, "Tipo"), fTipo),
        h("label", {}, h("span", { class: "etiqueta" }, "Capital del paquete"), fCap),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Estados"), fE),
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Municipios"), fM),
        h("label", {}, h("span", { class: "etiqueta" }, "Días de mora"), h("div", { class: "fila", style: { gap: "6px" } }, fMin, fMax)),
        h("label", {}, h("span", { class: "etiqueta" }, "Precio de lista (¢ por peso)"), fC),
        h("label", {}, fDest, " ⭐ Destacado"), h("label", {}, fAct, " Visible en la tienda")),
      prev,
      h("div", { class: "fila", style: { justifyContent: "flex-end", gap: "6px" } },
        p ? h("button", { class: "btn btn-secundario", onclick: async () => {
          if (!(await confirmar("Borrar paquete", `¿Borrar «${p.titulo}»? Las solicitudes ya hechas no se borran.`, "Borrar"))) return;
          try { await ctx.rpc("paquete_borrar", { p_id: p.id }); toast("Paquete borrado.", "bien"); form.hidden = true; cargar(); } catch (e) { toast(e.message, "mal"); }
        } }, "🗑 Borrar") : null,
        h("button", { class: "btn btn-secundario", onclick: vista }, "🔎 Ver disponible"),
        h("button", { class: "btn btn-secundario", onclick: () => { form.hidden = true; } }, "Cerrar"),
        h("button", { class: "btn btn-marca", onclick: async () => {
          try { await ctx.rpc("paquete_guardar", { p: datosForm() }); toast("Paquete guardado. Ya lo ven los compradores en su Tienda.", "bien"); form.hidden = true; cargar(); }
          catch (e) { toast(e.message, "mal", 8000); }
        } }, "💾 Guardar")));
    vista();
    form.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
  await cargar();
  if (prefill && edita) editar(null);
}
