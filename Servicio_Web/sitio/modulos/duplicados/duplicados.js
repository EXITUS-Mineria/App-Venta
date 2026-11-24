// ============================================================
// MÓDULO: Revisión de ventas duplicadas
// Cada venta debe llevar créditos y grupos distintos. Aquí se ven los créditos JyP y grupos que aparecen
// en más de una venta (archivos históricos + propuestas de la página) y se les da seguimiento:
// Pendiente → En revisión → Justificado (con comentario) o Restituido (en una ventana, sin salir de aquí:
// clic en la venta donde NO le corresponde → se busca reemplazo y se restituye en esa venta).
// Sólo lo ve el ADMINISTRADOR (ni el validador ni otros perfiles).
// ============================================================
const ESTATUS = ["Pendiente", "En revisión", "Justificado", "Restituido"];
const MOTIVOS = ["Venta duplicada", "Defunción", "Liquidado", "Incidencia en el expediente"];
const TOLERANCIA_MAX = 5000;

/** Ventana para restituir el crédito / grupo duplicado f en la venta x (la que no le corresponde). */
export async function ventanaRestitucion(ctx, f, x, alTerminar) {
  const { h, tabla, dinero, numero, dias, toast, confirmar, avisar, cargarCSS } = ctx.ui;
  cargarCSS(new URL("../restituciones/restituciones.css", import.meta.url).href);
  const otras = (f.ventas || []).filter((v) => v.folio !== x.folio).map((v) => v.folio);
  const cuerpo = h("div", { class: "dup-rst-cuerpo" }, h("div", { class: "nota" }, "Validando…"));
  const cerrar = () => { velo.remove(); };
  const velo = h("div", { class: "velo" },
    h("div", { class: "ventana dup-rst", role: "dialog", "aria-modal": "true", "aria-label": `Restituir ${f.clave}` },
      h("header", { class: "dup-rst-enc" }, h("span", {}, `🔁 Restituir ${f.tipo === "Grupal" ? "grupo" : "crédito"} ${f.clave} en ${x.folio}`),
        h("button", { class: "dup-rst-x", title: "Cerrar", onclick: cerrar }, "✖")),
      cuerpo));
  velo.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrar(); });
  document.body.append(velo);

  let o;
  try { o = await ctx.rpc("validar_restitucion", { p_texto: f.clave }); if (!o) throw new Error(`No pude validar ${f.clave}`); }
  catch (e) { cuerpo.replaceChildren(h("div", { class: "rst-ficha mal" }, "✖ ", e.message)); return; }
  o.capital = o.capital == null ? null : Number(o.capital);
  const sinCapital = !(o.capital > 0);
  if (o.bloqueado) {
    cuerpo.replaceChildren(h("div", { class: "rst-ficha mal" }, `Ya restituido (${o.restitucion} · ${o.motivo_bloqueo}). No se puede restituir de nuevo.`),
      h("footer", {}, h("button", { class: "btn btn-secundario", onclick: cerrar }, "Cerrar")));
    return;
  }
  const dato = (t, v) => h("div", {}, h("span", {}, t), h("b", {}, v));
  const inCapital = h("input", { class: "campo", type: "number", min: 0, step: "0.01", value: o.capital > 0 ? o.capital : "",
    placeholder: "Capital del crédito / grupo", oninput: () => { o.capital = Number(inCapital.value) || null; btnBuscar.disabled = !(o.capital > 0); } });
  const selMotivo = h("select", { class: "campo" }, ...MOTIVOS.map((m) => h("option", { value: m }, m)));
  const inTol = h("input", { class: "campo", type: "number", min: 0, max: TOLERANCIA_MAX, step: 500, value: TOLERANCIA_MAX });
  const chkEstado = h("input", { type: "checkbox" });
  const inComentario = h("input", { class: "campo", value: `Duplicado: también vendido en ${otras.join(", ") || "otra venta"}` });
  const lbl = h("span", { class: "nota" });
  const btnBuscar = h("button", { class: "btn btn-marca", disabled: !(o.capital > 0), onclick: () => buscar() }, "🔎 Buscar reemplazo");
  const tCand = tabla([
    { clave: "usar", titulo: "", formato: (_, c) => h("button", { class: "btn btn-marca btn-chico", onclick: () => aplicar(c) }, "Usar este") },
    { clave: "clave", titulo: "Grupo / vReference" },
    { clave: "integrantes", titulo: "Créditos", num: true },
    { clave: "estados", titulo: "Estado" }, { clave: "municipios", titulo: "Municipio" },
    { clave: "dias", titulo: "Mora", num: true, formato: (v) => dias(v) },
    { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
    { clave: "diferencia", titulo: "Diferencia", num: true, formato: (v) => (v > 0 ? "+" : "") + dinero(v) },
  ], { idFila: (c) => c.clave, vacio: "Da clic en «Buscar reemplazo»." });
  tCand.el.style.maxHeight = "300px";

  cuerpo.replaceChildren(
    h("div", { class: "rst-ficha bien" },
      h("div", { class: "rst-datos" },
        dato("Sale de", `${x.folio}${x.comprador ? " · " + x.comprador : ""}`),
        dato("Se queda en", otras.join(", ") || "—"),
        dato("Capital", o.capital > 0 ? dinero(o.capital) : "—"),
        dato(f.tipo === "Grupal" ? "Integrantes" : "Créditos", o.integrantes == null ? "—" : numero(o.integrantes)),
        dato("Mora", o.dias == null ? "—" : dias(o.dias)), dato("Estado", o.estados || "—"))),
    o.capital > 0 ? null : h("label", {}, h("span", { class: "etiqueta" }, "Capital original (no venía en el archivo de la venta)"), inCapital),
    h("div", { class: "dup-rst-grid" },
      h("label", {}, h("span", { class: "etiqueta" }, "Motivo"), selMotivo),
      h("label", {}, h("span", { class: "etiqueta" }, "Capital similar ± (máx. 5,000)"), inTol),
      h("label", { class: "dup-rst-chk" }, chkEstado, " Mismo estado"),
      h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Comentario"), inComentario)),
    h("div", { class: "fila", style: { justifyContent: "flex-start", gap: "10px", margin: "8px 0" } }, h("span", { style: { flex: "0 0 auto" } }, btnBuscar), lbl),
    tCand.el,
    h("footer", {}, h("button", { class: "btn btn-secundario", onclick: cerrar }, "Cerrar")));
  if (o.capital > 0) buscar();

  async function buscar() {
    const tol = Math.min(Math.max(Number(inTol.value) || 0, 0), TOLERANCIA_MAX);
    inTol.value = tol; lbl.textContent = "Buscando…"; btnBuscar.disabled = true;
    try {
      const filas = (await ctx.rpc("sugerir_restitucion", { p_tipo: o.tipo, p_capital: o.capital, p_tolerancia: tol,
        p_estado: chkEstado.checked ? o.estado_n : null })) || [];
      tCand.setFilas(filas.map((c) => ({ ...c, capital: Number(c.capital), diferencia: Number(c.diferencia), integrantes: Number(c.integrantes),
        dias: c.dias == null ? null : Number(c.dias) })));
      lbl.textContent = filas.length ? `${numero(filas.length)} opciones (las más cercanas primero)` : `Sin opciones disponibles en ±${dinero(tol)}.`;
    } catch (e) { toast(e.message, "mal"); lbl.textContent = ""; }
    btnBuscar.disabled = false;
  }
  async function aplicar(c) {
    const ok = await confirmar("Aplicar restitución",
      `Venta: ${x.folio}\nMotivo: ${selMotivo.value}\n\nSale: ${o.clave} · ${dinero(o.capital)}\nEntra: ${c.clave} · ${dinero(c.capital)}\n` +
      `Diferencia: ${dinero(c.diferencia)}\n\n${o.clave} se queda en ${otras.join(", ") || "la otra venta"} y no se volverá a ofrecer.`, "Aplicar");
    if (!ok) return;
    try {
      const r = await ctx.rpc("aplicar_restitucion", { p_original: o.clave, p_reemplazo: c.clave, p_motivo: selMotivo.value,
        p_comentario: inComentario.value.trim(), p_capital_original: sinCapital ? o.capital : null, p_folio: x.folio });
      cerrar();
      await avisar(`Restitución ${r.id_restitucion}`, `${r.original} → ${r.reemplazo} en ${x.folio}\nDiferencia: ${dinero(r.diferencia)}\n` +
        `Propuesta: ${r.id_propuesta}${r.propuesta_nueva ? " (nueva, APROBADA)" : ""}\n\nSe avisó al validador y al auxiliar de venta para generar la sub base.`);
      ctx.refrescarAvisos?.();
      alTerminar?.();
    } catch (e) { toast(e.message, "mal", 9000); }
  }
}

export default {
  id: "duplicados",
  titulo: "Ventas duplicadas",
  icono: "⚠️",
  roles: ["admin"],
  rolesExactos: true,

  async montar(cont, ctx) {
    const { h, tabla, kpi, numero, fecha, toast, pedirTexto, descargarCSV, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./duplicados.css", import.meta.url).href);
    const puedeMarcar = ctx.perfil.rol === "admin";
    let filas = [];

    const kTot = kpi("Repetidos"), kPend = kpi("Pendientes"), kRev = kpi("En revisión"), kJus = kpi("Justificados"), kRes = kpi("Restituidos");
    const opt = (v, t) => h("option", { value: v }, t ?? v);
    const selEst = h("select", { class: "campo", onchange: () => pintar() }, opt("", "Todos los estatus"), ...ESTATUS.map((e) => opt(e)));
    const selTipo = h("select", { class: "campo", onchange: () => pintar() }, opt("", "JyP y Grupal"), opt("JyP"), opt("Grupal"));
    const inBuscar = h("input", { class: "campo", placeholder: "🔎 Grupo, vReference, folio, comprador o vendedor", oninput: () => pintar() });
    const lbl = h("span", { class: "nota" });

    const pastilla = (e) => h("span", { class: `dup-est dup-${e.replace(/\s+/g, "-").toLowerCase()}` }, e);
    const t = tabla([
      { clave: "revision", titulo: "Estatus", formato: (v, f) => h("span", {}, pastilla(v),
        f.revisado_por && v !== "Restituido" ? h("div", { class: "nota" }, `${f.revisado_por} · ${fecha(f.revisado_en)}`) : null) },
      { clave: "tipo", titulo: "Tipo" },
      { clave: "clave", titulo: "Grupo / vReference" },
      { clave: "n_ventas", titulo: "Ventas", num: true },
      { clave: "ventas", titulo: "Vendido en (clic = restituir en esa venta)", formato: (v, f) => h("span", { class: "dup-ventas" },
        ...(v || []).map((x) => h("button", {
          class: "btn btn-secundario btn-chico", disabled: !x.visible || f.revision === "Restituido",
          title: [x.comprador, x.vendedor, x.estatus, x.fecha ? fecha(x.fecha) : ""].filter(Boolean).join(" · "),
          onclick: () => ventanaRestitucion(ctx, f, x, cargar) },
          `${x.folio}${x.comprador ? " · " + x.comprador.split(/\s+/).slice(0, 2).join(" ") : ""}`))) },
      { clave: "integrantes_repetidos", titulo: "Integrantes repetidos", num: true, formato: (v, f) => (f.tipo === "JyP" ? "—" : numero(v)) },
      { clave: "comentario", titulo: "Comentario", formato: (v, f) => (f.restituido ? `Restituido en ${f.restituido}` : v || "") },
      { clave: "acciones", titulo: "", formato: (_, f) => (!puedeMarcar || f.revision === "Restituido") ? null : h("span", { class: "dup-acc" },
        f.revision !== "En revisión" ? h("button", { class: "btn btn-secundario btn-chico", title: "Marcar en revisión", onclick: () => marcar(f, "En revisión") }, "⏳") : null,
        f.revision !== "Justificado" ? h("button", { class: "btn btn-secundario btn-chico", title: "Justificar (no es duplicado real)", onclick: () => marcar(f, "Justificado") }, "✔ Justificar") : null,
        f.revision !== "Pendiente" ? h("button", { class: "btn btn-secundario btn-chico", title: "Regresar a pendiente", onclick: () => marcar(f, "Pendiente") }, "↺") : null) },
    ], { idFila: (f) => f.tipo + f.clave, claseFila: (f) => (f.revision === "Pendiente" ? "dup-fila-pend" : ""),
         vacio: "✔ Ningún crédito o grupo aparece en más de una venta." });
    t.el.style.maxHeight = "calc(100vh - 330px)";

    cont.append(h("div", { class: "dup" },
      h("div", { class: "kpis" }, kTot.el, kPend.el, kRev.el, kJus.el, kRes.el),
      h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { flexWrap: "wrap", marginBottom: "8px" } },
          h("div", { style: { flex: "0 1 190px" } }, selEst), h("div", { style: { flex: "0 1 150px" } }, selTipo),
          h("div", { style: { flex: "1 1 260px" } }, inBuscar), lbl,
          h("span", { class: "fila", style: { flex: "0 0 auto", gap: "6px" } },
            h("button", { class: "btn btn-secundario", onclick: () => exportar() }, "⬇ CSV"),
            h("button", { class: "btn btn-secundario", onclick: () => cargar() }, "⟳"))),
        h("p", { class: "nota", style: { margin: "0 0 8px" } },
          "Un grupo con integrantes repetidos es el mismo crédito vendido dos veces: se restituye en la venta que no le corresponde. ",
          "Si sólo coincide el número de grupo (otro ciclo), márcalo como Justificado."),
        t.el)));

    async function cargar() {
      try { filas = (await ctx.rpc("ventas_duplicadas")) || []; } catch (e) { toast(e.message, "mal"); filas = []; }
      const c = (e) => filas.filter((f) => f.revision === e).length;
      kTot.set(numero(filas.length), `${numero(filas.filter((f) => f.mismo_credito).length)} con el mismo crédito`);
      kPend.set(numero(c("Pendiente")), "", c("Pendiente") ? "alerta" : "bien");
      kRev.set(numero(c("En revisión"))); kJus.set(numero(c("Justificado"))); kRes.set(numero(c("Restituido")), "", "bien");
      pintar();
    }
    const visibles = () => {
      const q = inBuscar.value.trim().toLowerCase();
      return filas.filter((f) => (!selEst.value || f.revision === selEst.value) && (!selTipo.value || f.tipo === selTipo.value) &&
        (!q || [f.clave, f.comentario, ...(f.ventas || []).flatMap((x) => [x.folio, x.comprador, x.vendedor])]
          .some((x) => String(x || "").toLowerCase().includes(q))));
    };
    function pintar() { const v = visibles(); t.setFilas(v); lbl.textContent = `${numero(v.length)} de ${numero(filas.length)}`; }

    async function marcar(f, estatus) {
      let comentario = null;
      if (estatus === "Justificado") {
        comentario = await pedirTexto("Justificar duplicado", `${f.tipo} ${f.clave} en ${(f.ventas || []).map((x) => x.folio).join(", ")}\n¿Por qué no es un duplicado real?`);
        if (comentario === null) return;
        if (!comentario.trim()) { toast("Escribe el motivo.", "mal"); return; }
      }
      try { await ctx.rpc("duplicado_marcar", { p_tipo: f.tipo, p_clave: f.clave, p_estatus: estatus, p_comentario: comentario }); toast(`${f.clave}: ${estatus}.`, "bien"); }
      catch (e) { toast(e.message, "mal"); }
      await cargar();
    }

    function exportar() {
      const v = visibles();
      if (!v.length) { toast("No hay registros para exportar.", "mal"); return; }
      descargarCSV("Ventas_duplicadas.csv", ["Estatus", "Tipo", "Clave", "Ventas", "Folios", "Compradores", "Integrantes repetidos", "Restitucion", "Comentario", "Revisado por"],
        v.map((f) => ({ Estatus: f.revision, Tipo: f.tipo, Clave: f.clave, Ventas: f.n_ventas, Folios: (f.ventas || []).map((x) => x.folio).join(" / "),
          Compradores: (f.ventas || []).map((x) => x.comprador || "").join(" / "), "Integrantes repetidos": f.integrantes_repetidos ?? "",
          Restitucion: f.restituido || "", Comentario: f.comentario || "", "Revisado por": f.revisado_por || "" })));
    }

    await cargar();
  },
};
