// ============================================================
// MÓDULO: Revisión de ventas duplicadas
// Cada venta debe llevar créditos y grupos distintos. Aquí se ven los créditos JyP y grupos que aparecen
// en más de una venta (archivos históricos + propuestas de la página) y se les da seguimiento:
// Pendiente → En revisión → Justificado (con comentario) o Restituido (desde Restituciones).
// El vendedor sólo ve los duplicados de sus ventas y no cambia estatus.
// ============================================================
const ESTATUS = ["Pendiente", "En revisión", "Justificado", "Restituido"];

export default {
  id: "duplicados",
  titulo: "Ventas duplicadas",
  icono: "⚠️",
  roles: ["vendedor", "validador", "auxiliar", "control_doc", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, numero, fecha, toast, pedirTexto, descargarCSV, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./duplicados.css", import.meta.url).href);
    const puedeMarcar = ctx.tieneRol("auxiliar");
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
          onclick: () => ctx.ir(`restituciones?venta=${encodeURIComponent(x.folio)}&clave=${encodeURIComponent(f.clave)}`) },
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
