// ============================================================
// MÓDULO: Sub bases (auxiliar de venta)
// Propuestas APROBADAS: generar la sub base (layout Funnel, Latin-1) y
// marcarla EN VENTA. Las ya generadas se pueden volver a descargar.
// ============================================================
import { descargarLayout } from "../venta/layout.js";

export default {
  id: "subbases",
  titulo: "Sub bases",
  icono: "📦",
  roles: ["auxiliar", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, dinero, numero, fecha, toast, confirmar, pastillaEstatus } = ctx.ui;

    const kPend = kpi("Por generar"), kCap = kpi("Capital por generar"), kVenta = kpi("En venta");
    const chkTodas = h("input", { type: "checkbox", onchange: () => pintar() });
    let datos = [];

    const t = tabla([
      { clave: "id_propuesta", titulo: "Id venta" },
      { clave: "usuario", titulo: "Vendedor" },
      { clave: "comprador", titulo: "Comprador" },
      { clave: "tipo_venta", titulo: "Tipo" },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      { clave: "centavos", titulo: "Centavos", num: true },
      { clave: "valor_venta", titulo: "Venta", num: true, formato: (v) => dinero(v) },
      { clave: "dias_mora", titulo: "Mora", num: true },
      { clave: "revisada_por", titulo: "Aprobó", formato: (v, p) => (v ? `${v} · ${fecha(p.revisada_en)}` : "") },
      { clave: "comentario", titulo: "Comentario" },
      { clave: "estatus", titulo: "Estatus", formato: (v) => pastillaEstatus(v) },
      { clave: "acciones", titulo: "", formato: (_, p) => p.estatus === "APROBADA"
          ? h("button", { class: "btn btn-marca btn-chico", onclick: () => generar(p) }, "⬇ Generar sub base")
          : h("button", { class: "btn btn-secundario btn-chico", onclick: () => generar(p) }, "⬇ Descargar otra vez") },
    ], { idFila: (p) => p.id_propuesta, vacio: "No hay propuestas aprobadas pendientes" });
    t.el.style.maxHeight = "calc(100vh - 290px)";

    cont.append(
      h("div", { class: "kpis", style: { marginBottom: "10px" } }, kPend.el, kCap.el, kVenta.el),
      h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "10px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📦 Sub bases para venta"),
          h("label", { style: { flex: "0 0 auto" } }, chkTodas, " Incluir ya generadas (En venta)"),
          h("span", { style: { flex: 1 } }),
          h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
        t.el));

    async function cargar() {
      const { data, error } = await ctx.sb.from("propuestas").select("*")
        .in("estatus", ["APROBADA", "EN VENTA"]).order("revisada_en", { ascending: true });
      if (error) { toast(error.message, "mal"); return; }
      datos = data.map((p) => ({ ...p, capital: Number(p.capital), valor_venta: Number(p.valor_venta) }));
      pintar();
    }

    function pintar() {
      const pend = datos.filter((p) => p.estatus === "APROBADA");
      const venta = datos.filter((p) => p.estatus === "EN VENTA");
      kPend.set(numero(pend.length), "propuestas aprobadas", pend.length ? "alerta" : "bien");
      kCap.set(dinero(pend.reduce((s, p) => s + p.capital, 0)));
      kVenta.set(numero(venta.length), "sub bases generadas");
      t.setFilas(chkTodas.checked ? datos : pend);
    }

    async function generar(p) {
      if (p.estatus === "APROBADA" && !(await confirmar("Generar sub base",
        `${p.id_propuesta} · ${p.usuario}\nComprador: ${p.comprador || "sin capturar"}\nCapital: ${dinero(p.capital)}\n\n` +
        "Se descargará el layout para Funnel y la propuesta pasará a EN VENTA.", "Generar"))) return;
      try {
        const r = await ctx.rpc("generar_sub_base", { p_id: p.id_propuesta });
        const n = await descargarLayout(ctx, { ...p, estatus: r.estatus });
        toast(`${p.id_propuesta}: ${numero(n)} registros descargados.`, "bien");
      } catch (e) { toast(e.message, "mal", 8000); }
      ctx.refrescarAvisos();
      await cargar();
    }

    await cargar();
  },
};
