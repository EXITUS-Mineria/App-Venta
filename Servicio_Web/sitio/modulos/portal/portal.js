// ============================================================
// PORTAL DEL COMPRADOR (rol "comprador")
// Lo carga el núcleo en lugar de modulos.json. Sólo usa funciones portal_* de la base,
// que devuelven únicamente los datos del comprador con sesión.
//   🏠 Inicio · 🛒 Solicitar nueva compra · 📋 Mis propuestas · ✅ Mis compras
// ============================================================
const BUCKET = "documentos-venta";
const css = (ctx) => ctx.ui.cargarCSS(new URL("./portal.css", import.meta.url).href);
const fechaCorta = (d) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }) : "");
const SITUACION = {
  PENDIENTE: ["Por responder", "pend"], ACEPTADA: ["Aceptada", "ok"], RECHAZADA: ["Rechazada", "no"],
  COMPRADA: ["Comprada", "ok"], "NO DISPONIBLE": ["Ya no disponible", "gris"],
  NUEVA: ["Recibida", "pend"], "EN PROCESO": ["En proceso", "proc"], ATENDIDA: ["Atendida", "ok"], CANCELADA: ["Cancelada", "gris"],
};
const pastilla = (h, s) => h("span", { class: `pt-pill ${(SITUACION[s] || [])[1] || ""}` }, (SITUACION[s] || [s])[0]);

// ---------- Detalle de créditos (propuesta o compra) ----------
// Con { seleccionable: true } el comprador marca con qué créditos se queda (en Grupal, el grupo completo).
// Regresa { seleccion() } → null si se queda con todo, o { refs, grupos, n, capital } con lo marcado.
async function verDetalle(ctx, folio, destino, { seleccionable = false, precio = null, alCambiar = null } = {}) {
  const { h, tabla, dinero, numero, toast } = ctx.ui;
  destino.replaceChildren(h("div", { class: "nota" }, "Cargando créditos…"));
  let filas;
  try { filas = (await ctx.rpc("portal_detalle", { p_folio: folio })).map((f) => ({ ...f, dias: f.dias == null ? null : Number(f.dias), capital: Number(f.capital) })); }
  catch (e) { destino.replaceChildren(); toast(e.message, "mal", 7000); return null; }
  const clave = (f) => (f.tipo === "Grupal" ? `G:${f.vgroupid}` : `J:${f.vreference}`);
  const capTotal = filas.reduce((s, f) => s + f.capital, 0);
  const marcados = new Set(filas.map(clave));
  const buscar = h("input", { class: "campo", placeholder: "🔍 vReference, grupo, colonia, municipio…", style: { maxWidth: "320px" } });
  const resumen = h("span", { class: "nota" });
  const resumenSel = h("div", { class: "pt-sel-res" });

  const cols = [
    { clave: "vreference", titulo: "vReference" }, { clave: "vgroupid", titulo: "vGroupId" },
    { clave: "dias", titulo: "Días de atraso", num: true, formato: (v) => (v == null ? "" : numero(v)) },
    { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
    { clave: "colonia", titulo: "Colonia" }, { clave: "cp", titulo: "C.P." },
    { clave: "municipio", titulo: "Municipio" }, { clave: "estado", titulo: "Estado" },
  ];
  if (seleccionable) cols.unshift({ clave: "_sel", titulo: "Me quedo", formato: (_, f) => h("input", { type: "checkbox", class: "pt-sel", "data-k": clave(f),
    checked: marcados.has(clave(f)), title: f.tipo === "Grupal" ? `Grupo ${f.vgroupid} completo` : "",
    onchange: (e) => { e.target.checked ? marcados.add(clave(f)) : marcados.delete(clave(f)); sincronizar(); } }) });
  const t = tabla(cols, { idFila: (f) => f.vreference, vacio: "Sin créditos con ese filtro",
    claseFila: (f) => (seleccionable && !marcados.has(clave(f)) ? "pt-fuera" : "") });
  t.el.style.maxHeight = "420px";

  function sincronizar() {
    t.el.querySelectorAll("input.pt-sel").forEach((c) => { c.checked = marcados.has(c.dataset.k); c.closest("tr")?.classList.toggle("pt-fuera", !c.checked); });
    const sel = filas.filter((f) => marcados.has(clave(f)));
    const cap = sel.reduce((s, f) => s + f.capital, 0);
    const fuera = filas.length - sel.length;
    resumenSel.replaceChildren(...[
      h("b", {}, `Te quedas con ${numero(sel.length)} de ${numero(filas.length)} créditos · capital ${dinero(cap)}`),
      precio != null ? h("span", {}, ` · precio ${dinero(capTotal ? (precio * cap) / capTotal : 0)}`) : null,
      fuera ? h("span", { class: "pt-sel-fuera" }, ` · ${numero(fuera)} regresan a la base al aceptar`) : null].filter(Boolean));
    const conDias = sel.filter((f) => f.dias != null);
    alCambiar?.({ n: sel.length, total: filas.length, capital: cap,
      precio: precio != null && capTotal ? (precio * cap) / capTotal : null,
      dias: conDias.length ? conDias.reduce((s, f) => s + f.dias, 0) / conDias.length : null });
  }
  const pintar = () => {
    const q = buscar.value.trim().toUpperCase();
    const v = q ? filas.filter((f) => [f.vreference, f.vgroupid, f.colonia, f.cp, f.municipio, f.estado].join(" ").toUpperCase().includes(q)) : filas;
    t.setFilas(v);
    resumen.textContent = `${numero(v.length)} créditos · capital ${dinero(v.reduce((s, f) => s + f.capital, 0))}`;
    if (seleccionable) sincronizar();
  };
  buscar.addEventListener("input", pintar);
  const marcarVista = (si) => {
    const q = buscar.value.trim().toUpperCase();
    filas.filter((f) => !q || [f.vreference, f.vgroupid, f.colonia, f.cp, f.municipio, f.estado].join(" ").toUpperCase().includes(q))
      .forEach((f) => (si ? marcados.add(clave(f)) : marcados.delete(clave(f))));
    sincronizar();
  };
  destino.replaceChildren(
    h("div", { class: "fila pt-det-enc" }, buscar, resumen,
      seleccionable ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => marcarVista(true) }, "☑ Marcar todos") : null,
      seleccionable ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => marcarVista(false) }, "☐ Desmarcar todos") : null),
    seleccionable ? h("div", { class: "nota" }, "Desmarca los créditos que no quieres. En cartera Grupal se elige el grupo completo. " +
      "Al aceptar, los que no marques regresan a la base como disponibles.") : null,
    seleccionable ? resumenSel : null,
    t.el);
  pintar();
  return {
    seleccion() {
      if (marcados.size === new Set(filas.map(clave)).size) return null;
      const sel = filas.filter((f) => marcados.has(clave(f)));
      return { refs: [...new Set(sel.filter((f) => f.tipo !== "Grupal").map((f) => f.vreference))],
               grupos: [...new Set(sel.filter((f) => f.tipo === "Grupal").map((f) => f.vgroupid))],
               n: sel.length, total: filas.length, capital: sel.reduce((s, f) => s + f.capital, 0), capTotal };
    },
  };
}

// ---------- 🏠 Inicio ----------
const inicio = {
  id: "inicio", titulo: "Inicio", icono: "🏠", roles: ["comprador"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast } = ctx.ui;
    let d;
    try { d = await ctx.rpc("portal_inicio"); } catch (e) { toast(e.message, "mal"); return; }
    const tarjeta = (id, icono, titulo, texto, extra, destacado) =>
      h("a", { class: `pt-menu-item ${destacado ? "destacado" : ""}`, href: `#/${id}` },
        h("div", { class: "pt-menu-ico" }, icono), h("b", {}, titulo), h("span", {}, texto), extra ? h("div", { class: "pt-menu-extra" }, extra) : null);
    cont.append(h("div", { class: "pt" },
      h("div", { class: "pt-hola" },
        h("h2", {}, `Hola, ${ctx.perfil.nombre || ctx.perfil.email}`),
        h("div", { class: "nota" }, d.comprador,
          d.vendedor ? ` · Tu ejecutivo: ${d.vendedor}${d.vendedor_correo ? ` (${d.vendedor_correo})` : ""}` : "")),
      h("div", { class: "pt-menu" },
        tarjeta("solicitar", "🛒", "Solicitar nueva compra", "Dinos qué cartera buscas y te armamos una propuesta.",
          d.solicitudes_abiertas ? `${numero(d.solicitudes_abiertas)} solicitud(es) en curso` : null),
        tarjeta("propuestas", "📋", "Mis propuestas", "Revisa el detalle de cada propuesta y acéptala o recházala.",
          d.propuestas_pendientes ? `🔴 ${numero(d.propuestas_pendientes)} por responder` : `${numero(d.propuestas)} propuesta(s)`,
          d.propuestas_pendientes > 0),
        tarjeta("compras", "✅", "Mis compras", "Tus compras, su avance y sus documentos.",
          `${numero(d.compras)} compra(s) · ${dinero(d.monto_compras)}`))));
  },
};

// ---------- 🛒 Solicitar nueva compra ----------
const TIPOS = [["Cualquiera", "Cualquiera"], ["JyP", "Individual (JyP)"], ["Grupal", "Grupal"]];
const solicitar = {
  id: "solicitar", titulo: "Solicitar nueva compra", icono: "🛒", roles: ["comprador"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, toast, dinero, numero, confirmar, tabla } = ctx.ui;
    let geo = [];
    try {   // una fila por estado con su lista de municipios (la API corta en 1,000 filas)
      geo = (await ctx.rpc("portal_catalogo_estados")).flatMap((r) => (r.municipios || []).map((m) => ({ tipo: r.tipo, estado: r.estado, municipio: m })));
    } catch (e) { toast(`No se pudieron cargar los estados: ${e.message}`, "mal", 9000); }

    let tipo = "Cualquiera";
    const elegidos = new Map();          // estado → Set(municipios elegidos); vacío = todos
    const filtroMuni = new Map();        // estado → texto de búsqueda
    const disponibles = () => geo.filter((g) => tipo === "Cualquiera" || g.tipo === tipo);
    const estadosDe = () => [...new Set(disponibles().map((g) => g.estado))].sort((a, b) => a.localeCompare(b, "es"));
    const munisDe = (e) => [...new Set(disponibles().filter((g) => g.estado === e).map((g) => g.municipio))].sort((a, b) => a.localeCompare(b, "es"));

    const cajaTipo = h("div", { class: "segmentado pt-tipo" });
    const chipsEstados = h("div", { class: "pt-chips" });
    const cajaMunis = h("div", { class: "pt-munis-sel" });
    const resumen = h("div", { class: "nota pt-resumen" });

    function pintarTipo() {
      cajaTipo.replaceChildren(...TIPOS.map(([v, t]) => h("button", { type: "button", class: tipo === v ? "activo" : "",
        onclick: () => { tipo = v; for (const e of [...elegidos.keys()]) if (!estadosDe().includes(e)) elegidos.delete(e); pintar(); } }, t)));
    }
    function pintarEstados() {
      const lista = estadosDe();
      chipsEstados.replaceChildren(...(lista.length ? lista.map((e) => h("button", { type: "button", class: `pt-chip ${elegidos.has(e) ? "sel" : ""}`,
        onclick: () => { elegidos.has(e) ? elegidos.delete(e) : elegidos.set(e, new Set()); pintar(); } }, e))
        : [h("span", { class: "nota" }, "No hay estados disponibles para este tipo de cartera.")]));
    }
    function pintarMunis() {
      cajaMunis.replaceChildren(...[...elegidos.keys()].sort((a, b) => a.localeCompare(b, "es")).map((e) => {
        const sel = elegidos.get(e), todos = munisDe(e), q = (filtroMuni.get(e) || "").toUpperCase();
        const vista = q ? todos.filter((m) => m.toUpperCase().includes(q)) : todos;
        const buscar = h("input", { class: "campo pt-buscar", placeholder: "🔍 Buscar municipio…", value: filtroMuni.get(e) || "" });
        buscar.addEventListener("input", () => { filtroMuni.set(e, buscar.value); const pos = buscar.selectionStart; pintarMunis();
          const nuevo = cajaMunis.querySelector(`[data-estado="${CSS.escape(e)}"] .pt-buscar`); nuevo?.focus(); nuevo?.setSelectionRange(pos, pos); });
        return h("div", { class: "pt-muni-bloque", "data-estado": e },
          h("div", { class: "pt-muni-enc" },
            h("b", {}, e),
            h("span", { class: "nota" }, sel.size ? `${numero(sel.size)} de ${numero(todos.length)} municipios` : `Todos los municipios (${numero(todos.length)})`),
            todos.length > 12 ? buscar : null,
            sel.size ? h("button", { type: "button", class: "btn btn-secundario btn-chico", onclick: () => { sel.clear(); pintarMunis(); pintarResumen(); } }, "Todos") : null,
            h("button", { type: "button", class: "btn btn-secundario btn-chico", title: `Quitar ${e}`, onclick: () => { elegidos.delete(e); pintar(); } }, "✖")),
          h("div", { class: "pt-chips pt-chips-muni" }, ...vista.map((m) => h("button", { type: "button", class: `pt-chip chico ${sel.has(m) ? "sel" : ""}`,
            onclick: () => { sel.has(m) ? sel.delete(m) : sel.add(m); pintarMunis(); pintarResumen(); } }, m)),
            vista.length ? null : h("span", { class: "nota" }, "Sin coincidencias.")));
      }));
    }
    function pintarResumen() {
      resumen.textContent = elegidos.size
        ? `Vas a solicitar: ${TIPOS.find(([v]) => v === tipo)[1]} · ` + [...elegidos].map(([e, s]) => `${e} (${s.size ? `${s.size} municipio${s.size === 1 ? "" : "s"}` : "todos"})`).join(", ")
        : "Elige uno o varios estados.";
    }
    function pintar() { pintarTipo(); pintarEstados(); pintarMunis(); pintarResumen(); }

    const capital = h("input", { class: "campo", type: "number", min: 0, step: 1000, placeholder: "$ aproximado (opcional)" });
    const coment = h("textarea", { class: "campo", rows: 2, placeholder: "Opcional: cualquier detalle que nos ayude a armar tu propuesta" });
    const btn = h("button", { class: "btn btn-marca", type: "submit" }, "Enviar solicitud");

    const t = tabla([
      { clave: "id", titulo: "#" }, { clave: "fecha", titulo: "Fecha", formato: (v) => fechaCorta(v) },
      { clave: "detalle", titulo: "Qué pediste", formato: (_, s) => [s.tipo_cartera !== "Cualquiera" ? s.tipo_cartera : null, s.estados,
          s.municipios ? `Municipios: ${s.municipios}` : null, s.capital_aprox ? `≈ ${dinero(s.capital_aprox)}` : null, s.comentarios].filter(Boolean).join(" · ") },
      { clave: "estatus", titulo: "Estatus", formato: (v) => pastilla(h, v) },
      { clave: "respuesta", titulo: "Respuesta", formato: (v, s) => [v, s.folio ? `Propuesta ${s.folio}` : null].filter(Boolean).join(" · ") },
      { clave: "acc", titulo: "", formato: (_, s) => (s.estatus === "NUEVA" ? h("button", { class: "btn btn-secundario btn-chico", onclick: async () => {
          if (!(await confirmar("Cancelar solicitud", `¿Cancelar la solicitud #${s.id}?`, "Cancelar solicitud"))) return;
          try { await ctx.rpc("portal_cancelar_solicitud", { p_id: s.id }); toast("Solicitud cancelada.", "bien"); cargar(); } catch (e) { toast(e.message, "mal"); }
        } }, "Cancelar") : "") },
    ], { vacio: "Aún no has hecho solicitudes." });

    const form = h("form", { class: "tarjeta pt-form", onsubmit: async (e) => {
      e.preventDefault();
      if (!elegidos.size) { toast("Elige al menos un estado.", "mal"); return; }
      btn.disabled = true;
      const estados = [...elegidos.keys()].sort((a, b) => a.localeCompare(b, "es"));
      const municipios = estados.filter((x) => elegidos.get(x).size)
        .map((x) => `${x}: ${[...elegidos.get(x)].sort((a, b) => a.localeCompare(b, "es")).join(", ")}`).join("; ");
      try {
        const id = await ctx.rpc("portal_solicitar", { p_datos: { tipo_cartera: tipo, estados: estados.join(", "), municipios,
          capital_aprox: capital.value, comentarios: coment.value.trim() } });
        toast(`Solicitud #${id} enviada. Tu ejecutivo te contactará con una propuesta.`, "bien", 7000);
        tipo = "Cualquiera"; elegidos.clear(); filtroMuni.clear(); capital.value = coment.value = ""; pintar();
        cargar();
      } catch (err) { toast(err.message, "mal", 7000); }
      btn.disabled = false;
    } },
      h("h3", {}, "🛒 ¿Qué cartera buscas?"),
      h("span", { class: "etiqueta" }, "1. Tipo de cartera"), cajaTipo,
      h("span", { class: "etiqueta pt-paso" }, "2. Estados ", h("small", { class: "nota" }, "(puedes marcar varios)")), chipsEstados,
      h("span", { class: "etiqueta pt-paso" }, "3. Municipios ", h("small", { class: "nota" }, "(si no marcas ninguno, se toman todos los del estado)")), cajaMunis,
      h("div", { class: "pt-grid" },
        h("label", {}, h("span", { class: "etiqueta" }, "Capital aproximado"), capital),
        h("label", {}, h("span", { class: "etiqueta" }, "Comentarios"), coment)),
      resumen,
      h("div", { class: "fila", style: { justifyContent: "flex-end", marginTop: "10px" } }, btn));

    cont.append(h("div", { class: "pt" }, form,
      h("div", { class: "tarjeta" }, h("h3", {}, "📨 Mis solicitudes"), t.el)));
    pintar();

    async function cargar() {
      try { t.setFilas(await ctx.rpc("portal_solicitudes")); } catch (e) { toast(e.message, "mal"); }
    }
    await cargar();
  },
};

// ---------- 📋 Mis propuestas ----------
const propuestas = {
  id: "propuestas", titulo: "Mis propuestas", icono: "📋", roles: ["comprador"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast, confirmar, pedirTexto } = ctx.ui;
    const lista = h("div", { class: "pt-lista" });
    cont.append(h("div", { class: "pt" }, h("div", { class: "pt-tit" }, h("h2", {}, "📋 Mis propuestas"),
      h("span", { class: "nota" }, "Abre una propuesta para ver sus créditos y elegir con cuáles te quedas. El precio aparece cuando la propuesta está autorizada.")), lista));

    async function responder(p, acepta, detalle) {
      let comentario = "";
      const sel = acepta ? detalle?.seleccion() ?? null : null;
      if (acepta) {
        if (sel && !sel.n) { toast("Marca al menos un crédito; si no te interesa ninguno, usa «Rechazar».", "mal"); return; }
        const cap = sel ? sel.capital : p.capital;
        const precio = p.precio == null ? null : sel ? (p.precio * sel.capital) / sel.capTotal : p.precio;
        const texto = sel
          ? `¿Aceptas ${p.folio} quedándote con ${numero(sel.n)} de ${numero(sel.total)} créditos?\nCapital ${dinero(cap)}` +
            (precio != null ? ` · precio aprox. ${dinero(precio)}` : "") +
            `\n\nLos ${numero(sel.total - sel.n)} créditos que no marcaste se quitan de la propuesta y regresan a la base. No se puede deshacer.`
          : `¿Aceptas la propuesta ${p.folio} completa?\n${numero(p.creditos)} créditos · capital ${dinero(p.capital)}` +
            (p.precio != null ? ` · precio ${dinero(p.precio)}` : "\nEl precio está por confirmar; tu ejecutivo te lo confirmará.");
        if (!(await confirmar("Aceptar propuesta", texto + "\n\nTu ejecutivo te contactará para formalizar la compra.", "Aceptar"))) return;
      } else {
        comentario = await pedirTexto("Rechazar propuesta", `¿Por qué rechazas ${p.folio}? (nos ayuda a armar una mejor propuesta)`);
        if (comentario === null) return;
      }
      try {
        if (acepta) {
          const r = await ctx.rpc("portal_aceptar", { p_folio: p.folio, p_refs: sel ? sel.refs : null, p_grupos: sel ? sel.grupos : null, p_comentario: comentario });
          toast(r.quitadas ? `¡Gracias! Aceptaste ${p.folio} con ${numero(sel.n)} créditos (capital ${dinero(r.capital)}).` : `¡Gracias! Aceptaste ${p.folio}.`, "bien", 7000);
        } else {
          await ctx.rpc("portal_responder", { p_folio: p.folio, p_respuesta: "RECHAZADA", p_comentario: comentario });
          toast(`Rechazaste ${p.folio}.`, "bien", 6000);
        }
        cargar();
      } catch (e) { toast(e.message, "mal", 8000); }
    }

    async function cargar() {
      let datos;
      try { datos = await ctx.rpc("portal_propuestas"); } catch (e) { toast(e.message, "mal"); return; }
      if (!datos.length) { lista.replaceChildren(h("div", { class: "tarjeta nota" }, "Todavía no tienes propuestas. Puedes pedir una en «🛒 Solicitar nueva compra».")); return; }
      lista.replaceChildren(...datos.map((p) => {
        const det = h("div", { class: "pt-det" });
        const pendiente = p.situacion === "PENDIENTE";
        let abierto = false, detalle = null;
        // valores de arriba: se mueven conforme el comprador marca / desmarca créditos
        const vCred = h("b"), vCap = h("b"), vPrecio = h("b"), vDias = h("b");
        const oCred = h("small", { class: "pt-orig" }), oCap = h("small", { class: "pt-orig" }), oPrecio = h("small", { class: "pt-orig" });
        function actualizar(sel) {
          const parcial = sel && sel.n < sel.total;
          vCred.textContent = numero(sel ? sel.n : p.creditos);
          vCap.textContent = dinero(sel ? sel.capital : p.capital);
          vPrecio.textContent = p.precio == null ? "Por confirmar" : dinero(sel && sel.precio != null ? sel.precio : p.precio);
          vDias.textContent = sel ? (sel.dias == null ? "—" : numero(Math.round(sel.dias))) : p.dias_prom != null ? numero(Math.round(p.dias_prom)) : "—";
          oCred.textContent = parcial ? `de ${numero(sel.total)}` : "";
          oCap.textContent = parcial ? `de ${dinero(p.capital)}` : "";
          oPrecio.textContent = parcial && p.precio != null ? `de ${dinero(p.precio)}` : "";
          [vCred, vCap, vDias].concat(p.precio == null ? [] : [vPrecio]).forEach((e) => e.classList.toggle("pt-cambio", !!parcial));
        }
        actualizar(null);
        const btnVer = h("button", { class: "btn btn-secundario", disabled: p.situacion === "NO DISPONIBLE",
          onclick: async () => {
            abierto = !abierto;
            btnVer.textContent = abierto ? "Ocultar créditos" : pendiente ? "Ver y elegir créditos" : "Ver créditos";
            if (abierto) detalle = await verDetalle(ctx, p.folio, det, { seleccionable: pendiente, precio: p.precio == null ? null : Number(p.precio),
              alCambiar: pendiente ? actualizar : null });
            else { det.replaceChildren(); detalle = null; actualizar(null); }
          } },
          pendiente ? "Ver y elegir créditos" : "Ver créditos");
        return h("div", { class: `tarjeta pt-prop s-${(SITUACION[p.situacion] || [])[1] || ""}` },
          h("div", { class: "pt-prop-enc" },
            h("div", {}, h("b", { class: "pt-folio" }, p.folio), " ", pastilla(h, p.situacion),
              h("div", { class: "nota" }, `Publicada ${fechaCorta(p.publicada_en)}${p.vendedor ? ` · ${p.vendedor}` : ""}`)),
            h("div", { class: "fila pt-acc" }, btnVer,
              p.situacion === "PENDIENTE" ? h("button", { class: "btn btn-secundario", onclick: () => responder(p, false) }, "👎 Rechazar") : null,
              p.situacion === "PENDIENTE" ? h("button", { class: "btn btn-marca", onclick: () => responder(p, true, detalle) }, "👍 Aceptar") : null)),
          h("div", { class: "pt-datos" },
            h("div", {}, h("small", {}, "Créditos"), vCred, oCred),
            h("div", {}, h("small", {}, "Capital"), vCap, oCap),
            h("div", {}, h("small", {}, "Precio"), vPrecio, oPrecio),
            h("div", {}, h("small", {}, "Tipo"), h("b", {}, p.tipo || "—")),
            h("div", {}, h("small", {}, "Días de atraso prom."), vDias),
            h("div", { class: "ancho" }, h("small", {}, "Estados"), h("b", {}, p.estados || "—"))),
          p.municipios ? h("div", { class: "nota pt-munis" }, `Municipios: ${p.municipios}`) : null,
          p.respuesta_en ? h("div", { class: "nota" }, `Respondiste el ${fechaCorta(p.respuesta_en)}${p.respuesta_comentario ? `: «${p.respuesta_comentario}»` : ""}`) : null,
          det);
      }));
    }
    await cargar();
  },
};

// ---------- ✅ Mis compras ----------
// Etapas después de la compra; cada una con su plazo en días (tabla etapas_plazos)
const ETAPAS_COMPRA = [
  { k: "md", nombre: "Creación de información demográfica final", listo: (c) => c.estatus_md === "Informacion Enviada", ini: "fecha_inicio_md", lim: "fecha_limite_md" },
  { k: "doc", nombre: "Petición de expedientes", listo: (c) => c.estatus_control_doc === "Entregados", ini: "fecha_inicio_admin", lim: "fecha_limite_admin" },
  { k: "juridico", nombre: "Firma de endoso", listo: (c) => c.estatus_juridico === "Contrato entregado" },
  { k: "cierre", nombre: "Creación de guía de entrega", listo: (c) => !!c.numero_guia || !!c.estatus_final },
];
const DIA = 86400000;
const aFecha = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`) : null);
const masDias = (f, n) => new Date(f.getTime() + n * DIA);
const dias = (a, b) => Math.round((b - a) / DIA);
const corta = (f) => f.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });

/** Calendario de una compra: por etapa, inicio, fecha compromiso, si está lista, día actual y retraso. */
function calendario(c, plazos) {
  const hoy = aFecha(new Date().toISOString());
  const listos = ETAPAS_COMPRA.map((e) => e.listo(c));
  for (let i = listos.length - 2; i >= 0; i--) if (listos[i + 1]) listos[i] = true;   // si ya pasó una etapa, las anteriores también
  let previo = aFecha(c.fecha_venta) || hoy;
  const etapas = ETAPAS_COMPRA.map((e0, i) => {
    let e = e0;
    const plazo = plazos[e.k]?.dias || 7;
    if (plazos[e.k]?.nombre) e = { ...e, nombre: plazos[e.k].nombre };
    const inicio = aFecha(e.ini && c[e.ini]) || previo;
    const fin = aFecha(e.lim && c[e.lim]) || masDias(inicio, plazo);
    previo = fin;
    return { ...e, plazo, inicio, fin, listo: listos[i] };
  });
  const actual = etapas.findIndex((e) => !e.listo);
  if (actual >= 0) {
    const e = etapas[actual];
    e.dia = Math.max(1, dias(e.inicio, hoy) + 1);
    e.retraso = Math.max(0, dias(e.fin, hoy));
    // si va retrasada, las fechas de las siguientes se recorren
    if (e.retraso) for (let i = actual + 1; i < etapas.length; i++) {
      etapas[i].inicio = masDias(etapas[i].inicio, e.retraso); etapas[i].fin = masDias(etapas[i].fin, e.retraso);
    }
  }
  return { etapas, actual, entrega: etapas[etapas.length - 1].fin };
}

const compras = {
  id: "compras", titulo: "Mis compras", icono: "✅", roles: ["comprador"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast, kpi, fecha } = ctx.ui;
    const kN = kpi("Compras"), kC = kpi("Capital comprado"), kM = kpi("Monto pagado");
    const lista = h("div", { class: "pt-lista" });
    cont.append(h("div", { class: "pt" }, h("div", { class: "pt-tit" }, h("h2", {}, "✅ Mis compras")),
      h("div", { class: "kpis" }, kN.el, kC.el, kM.el), lista));

    async function documentos(c, destino) {
      let docs;
      try { docs = await ctx.rpc("portal_documentos", { p_folio: c.folio }); } catch (e) { toast(e.message, "mal"); return; }
      destino.replaceChildren(docs.length ? h("ul", { class: "doc-lista pt-docs" }, ...docs.map((d) => h("li", {},
        h("span", {}, d.mime === "application/pdf" ? "📄 " : (d.mime || "").startsWith("image/") ? "🖼 " : "📝 "),
        h("a", { href: "#", onclick: async (e) => {
          e.preventDefault();
          const ventana = window.open("", "_blank");
          const { data, error } = await ctx.sb.storage.from(BUCKET).createSignedUrl(d.ruta, 300);
          if (error || !data?.signedUrl) { ventana?.close(); toast(error?.message || "No se pudo abrir el archivo.", "mal"); return; }
          if (ventana) ventana.location = data.signedUrl; else location.href = data.signedUrl;
        } }, d.nombre),
        h("small", { class: "nota" }, ` · ${d.tipo === "comprobante_pago" ? "Comprobante de pago" : "Documento"} · ${fecha(d.fecha)}`))))
        : h("div", { class: "nota" }, "Sin documentos todavía."));
    }

    let datos, plazos = {};
    try {
      const [d, p] = await Promise.all([ctx.rpc("portal_compras"), ctx.rpc("plazos_etapas")]);
      datos = d; plazos = Object.fromEntries(p.map((x) => [x.etapa, x]));
    } catch (e) { toast(e.message, "mal"); return; }
    kN.set(numero(datos.length), "ventas cerradas contigo");
    kC.set(dinero(datos.reduce((s, c) => s + Number(c.capital || 0), 0)), "capital de la cartera");
    kM.set(dinero(datos.reduce((s, c) => s + Number(c.monto_venta || 0), 0)), "monto de compra");
    if (!datos.length) { lista.replaceChildren(h("div", { class: "tarjeta nota" }, "Aún no tienes compras registradas.")); return; }
    lista.replaceChildren(...datos.map((c) => {
      const cal = calendario(c, plazos), act = cal.etapas[cal.actual];
      const extra = h("div", { class: "pt-det" });
      const docs = h("div");
      let abierto = false;
      const btnCred = c.con_detalle ? h("button", { class: "btn btn-secundario", onclick: () => {
        abierto = !abierto; btnCred.textContent = abierto ? "Ocultar créditos" : "Ver créditos"; abierto ? verDetalle(ctx, c.folio, extra) : extra.replaceChildren();
      } }, "Ver créditos") : null;
      const btnDocs = h("button", { class: "btn btn-secundario", onclick: () => { btnDocs.disabled = true; documentos(c, docs); } },
        `📂 Documentos (${numero(c.documentos)})`);
      return h("div", { class: "tarjeta pt-prop" },
        h("div", { class: "pt-prop-enc" },
          h("div", {}, h("b", { class: "pt-folio" }, c.folio), " ",
            h("span", { class: `pt-pill ${!act ? "ok" : act.retraso ? "no" : "proc"}` },
              !act ? "Cerrada" : `${act.nombre} · ${act.retraso ? `${numero(act.retraso)} día${act.retraso === 1 ? "" : "s"} de retraso` : `día ${numero(Math.min(act.dia, act.plazo))} de ${act.plazo}`}`),
            h("div", { class: "nota" }, `Fecha de compra ${fechaCorta(c.fecha_venta) || "—"}${c.numero_guia ? ` · 📦 Guía de entrega ${c.numero_guia}` : ""}`)),
          h("div", { class: "fila pt-acc" }, btnCred, btnDocs)),
        h("ol", { class: "pt-pasos" },
          h("li", { class: "ok" }, h("b", {}, "Compra registrada"), h("small", {}, fechaCorta(c.fecha_venta) || "")),
          ...cal.etapas.map((e, i) => h("li", { class: e.listo ? "ok" : i === cal.actual ? `act ${e.retraso ? "tarde" : ""}` : "" },
            h("b", {}, e.nombre), h("small", { class: "pt-plazo" }, `${e.plazo} días`),
            e.k === "cierre" && c.numero_guia ? h("button", { class: "pt-guia", title: "Copiar número de guía", onclick: () => {
              navigator.clipboard?.writeText(c.numero_guia).then(() => toast("Número de guía copiado.", "bien"), () => {}); } }, `📦 Guía ${c.numero_guia}`) : null,
            h("small", {}, e.listo ? "Lista"
              : i === cal.actual ? (e.retraso ? `⚠ ${numero(e.retraso)} días de retraso` : `Día ${numero(e.dia)} de ${e.plazo} · ${corta(e.fin)}`)
                : `≈ ${corta(e.fin)}`)))),
        act ? h("div", { class: "nota pt-entrega" }, `Fecha estimada de guía de entrega: ${cal.entrega.toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}`) : null,
        h("div", { class: "pt-datos" },
          h("div", {}, h("small", {}, "Créditos"), h("b", {}, c.con_detalle ? numero(c.creditos) : "—")),
          h("div", {}, h("small", {}, "Capital"), h("b", {}, c.capital != null ? dinero(c.capital) : "—")),
          h("div", {}, h("small", {}, "Monto de compra"), h("b", {}, c.monto_venta != null ? dinero(c.monto_venta) : "—")),
          h("div", {}, h("small", {}, "Tipo"), h("b", {}, c.tipo || "—")),
          h("div", { class: "ancho" }, h("small", {}, "Estado"), h("b", {}, c.estado || "—"))),
        docs, extra);
    }));
  },
};

export const modulos = [inicio, solicitar, propuestas, compras];
