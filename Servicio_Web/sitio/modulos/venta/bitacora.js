// ============================================================
// MÓDULO: Bitácora de propuestas (seguimiento del flujo, liberar)
// ============================================================
import { descargarLayout } from "./layout.js";

export default {
  id: "bitacora",
  titulo: "Bitácora",
  icono: "📋",
  roles: ["vendedor", "validador", "auxiliar", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, dinero, numero, fecha, toast, confirmar, pedirTexto, descargarCSV, pastillaEstatus } = ctx.ui;

    const chkVigentes = h("input", { type: "checkbox", checked: true, onchange: () => pintar() });
    const chkMias = h("input", { type: "checkbox", checked: ctx.perfil.rol === "vendedor", onchange: () => pintar() });
    const buscar = h("input", { class: "campo", placeholder: "🔍 Id, vendedor…", style: { maxWidth: "240px" }, oninput: () => pintar() });
    const lbl = h("span", { class: "nota" });
    let datos = [];

    const VIGENTES = ["EN REVISIÓN", "APROBADA", "EN VENTA", "APARTADA", "EN CONFLICTO"];
    const puedeLiberar = (p) => VIGENTES.includes(p.estatus) &&
      (ctx.esAdmin || (p.user_id === ctx.perfil.user_id && ["EN REVISIÓN", "APARTADA", "EN CONFLICTO"].includes(p.estatus)));
    const puedeComplementar = (p) => ["EN REVISIÓN", "APROBADA", "EN VENTA", "APARTADA"].includes(p.estatus) &&
      (ctx.esAdmin || p.user_id === ctx.perfil.user_id);
    const puedeLayout = (p) => ctx.tieneRol("auxiliar", "validador") && p.estatus !== "LIBERADA" && p.estatus !== "RECHAZADA";

    const t = tabla([
      { clave: "id_propuesta", titulo: "Id" },
      { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
      { clave: "usuario", titulo: "Vendedor" },
      { clave: "tipo_venta", titulo: "Tipo" },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      { clave: "centavos", titulo: "Centavos", num: true },
      { clave: "valor_venta", titulo: "Venta", num: true, formato: (v) => dinero(v) },
      { clave: "dias_mora", titulo: "Mora", num: true },
      { clave: "estatus", titulo: "Estatus", formato: (v) => pastillaEstatus(v) },
      { clave: "revisada_por", titulo: "Revisó", formato: (v, p) => (v ? `${v} · ${fecha(p.revisada_en)}` : "") },
      { clave: "comentario", titulo: "Comentario", formato: (v, p) => v || p.conflicto || "" },
      { clave: "sub_base_por", titulo: "Sub base", formato: (v, p) => (v ? `${v} · ${fecha(p.sub_base_en)}` : "") },
      { clave: "liberada_por", titulo: "Liberó", formato: (v, p) => (v ? `${v} · ${fecha(p.liberada_en)}` : "") },
      { clave: "acciones", titulo: "", formato: (_, p) => h("span", { class: "fila", style: { gap: "4px" } },
          puedeLayout(p) ? h("button", { class: "btn btn-secundario btn-chico", title: "Descargar layout para Funnel", onclick: () => layout(p) }, "⬇ Layout") : null,
          puedeComplementar(p) ? h("button", { class: "btn btn-secundario btn-chico", title: "Agregar más cartera a esta venta",
            onclick: () => { location.hash = `#/venta?complementar=${encodeURIComponent(p.id_propuesta)}`; } }, "➕ Complementar") : null,
          puedeLiberar(p) ? h("button", { class: "btn btn-marca btn-chico", onclick: () => liberar(p) }, "Liberar") : null) },
    ], { idFila: (p) => p.id_propuesta, claseFila: (p) => (p.estatus === "EN CONFLICTO" ? "conflicto" : ["LIBERADA", "RECHAZADA"].includes(p.estatus) ? "bloq" : ""),
         vacio: "Sin propuestas" });
    t.el.style.maxHeight = "calc(100vh - 200px)";

    cont.append(h("div", { class: "tarjeta" },
      h("div", { class: "fila", style: { justifyContent: "flex-start", flexWrap: "wrap", marginBottom: "10px" } },
        h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📋 Bitácora de propuestas"),
        h("label", { style: { flex: "0 0 auto" } }, chkVigentes, " Sólo vigentes"),
        h("label", { style: { flex: "0 0 auto" } }, chkMias, " Sólo mías"),
        buscar,
        h("span", { style: { flex: 1 } }),
        lbl,
        h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => exportar() }, "⬇ Exportar bitácora"),
        h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
      t.el));

    async function cargar() {
      const { data, error } = await ctx.sb.from("propuestas").select("*").order("fecha", { ascending: false }).limit(5000);
      if (error) { toast(error.message, "mal"); return; }
      datos = data.map((p) => ({ ...p, capital: Number(p.capital), valor_venta: Number(p.valor_venta) }));
      pintar();
    }

    function visibles() {
      const q = buscar.value.trim().toUpperCase();
      return datos.filter((p) =>
        (!chkVigentes.checked || VIGENTES.includes(p.estatus)) &&
        (!chkMias.checked || p.user_id === ctx.perfil.user_id) &&
        (!q || `${p.id_propuesta} ${p.usuario}`.toUpperCase().includes(q)));
    }

    function pintar() {
      const v = visibles();
      t.setFilas(v);
      const conf = v.filter((p) => p.estatus === "EN CONFLICTO").length;
      lbl.textContent = `${numero(v.length)} propuestas` + (conf ? ` · ${conf} en conflicto` : "");
      lbl.style.color = conf ? "var(--rojo)" : "";
    }

    async function layout(p) {
      try { const n = await descargarLayout(ctx, p); toast(`${numero(n)} registros descargados.`, "bien"); }
      catch (e) { toast(e.message, "mal"); }
    }

    async function liberar(p) {
      if (!(await confirmar("Liberar propuesta", `¿Regresar a Disponible todo lo de ${p.id_propuesta}?\n\n` +
        "Úsalo cuando la propuesta se canceló o quedó EN CONFLICTO.", "Liberar"))) return;
      const motivo = await pedirTexto("Motivo", "Motivo de la liberación (opcional):");
      if (motivo === null) return;
      try { await ctx.rpc("liberar", { p_id: p.id_propuesta, p_motivo: motivo }); toast("Propuesta liberada.", "bien"); ctx.refrescarAvisos(); }
      catch (e) { toast(e.message, "mal"); }
      cargar();
    }

    function exportar() {
      const cols = ["id_propuesta", "fecha", "usuario", "tipo_venta", "capital_objetivo", "capital", "centavos", "valor_venta",
        "dias_mora", "estatus", "capital_original", "partidas_quitadas", "revisada_en", "revisada_por", "comentario",
        "sub_base_en", "sub_base_por", "conflicto", "origen", "liberada_en", "liberada_por", "motivo"];
      descargarCSV(`Bitacora_VentaCartera_${new Date().toISOString().slice(0, 10)}.csv`, cols, visibles());
    }

    await cargar();
  },
};
