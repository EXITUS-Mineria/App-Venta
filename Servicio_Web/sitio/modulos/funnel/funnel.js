// ============================================================
// MÓDULO: Funnel de ventas (réplica de la lista SharePoint "VENTAS DE CARTERA")
// Avance de cada venta: Venta → MD → Control documental → Jurídico → Cierre.
// Las ventas de la página (VTA-####) entran solas al apartar la propuesta.
// Propuesta y Base final de las ventas de la página se GENERAN al presionar el botón (no se guardan).
// Las ventas migradas de SharePoint conservan sus ligas y adjuntos (ligas, no copias).
// ============================================================
import { descargarLayout, descargarPropuestaCSV } from "../venta/layout.js";

const OPC = {
  tipo: ["J&P", "Grupal", "Dual"],
  estatus_venta: ["Propuesta", "Vendida", "Cancelada"],
  estatus_md: ["En Proceso", "Informacion Enviada", "En Atraso"],
  estatus_control_doc: ["En Proceso", "Entregados"],
  estatus_juridico: ["Envío pagarés a jurídico", "Contrato en proceso", "Contrato entregado"],
  estatus_final: ["Expedientes enviados a comprador", "Venta cerrada"],
  estado: ["Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua", "CDMX", "Coahuila",
    "Colima", "Durango", "México", "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "Michoacan", "Morelos", "Nayarit", "Nuevo Leon",
    "Oaxaca", "Puebla", "Queretaro", "Quintana Roo", "San Luis Potosi", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala",
    "Veracruz", "Yucatan", "Zacatecas", "Multi-Estado"],
};
// Secciones del formulario, igual que las columnas de SharePoint. venta=true: el vendedor dueño también la edita.
const SECCIONES = [
  ["🧾 Venta", true, [["comprador", "Comprador"], ["estado", "Estado", "estado"], ["municipios", "Municipio's"],
    ["fecha_propuesta", "Fecha Propuesta", "fecha"], ["fecha_venta", "Fecha Venta", "fecha"], ["vendedor", "Vendedor"],
    ["propuesta_url", "Propuesta", "url"], ["comprobante_pago", "Comprobante de Pago (liga)", "url"]]],
  ["💰 Importes y estatus", false, [["estatus_venta", "Estatus Venta", "estatus_venta"], ["tipo", "Tipo", "tipo"],
    ["capital", "Capital", "num"], ["monto_venta", "Monto Venta", "num"]]],
  ["📤 MD (mesa de datos)", false, [["estatus_md", "Estatus MD", "estatus_md"], ["fecha_inicio_md", "Fecha Inicio MD", "fecha"],
    ["fecha_limite_md", "Fecha Límite MD", "fecha"], ["base_completa_venta", "Base Completa Venta", "url"]]],
  ["📁 Control documental", false, [["estatus_control_doc", "Estatus Control Documental", "estatus_control_doc"],
    ["fecha_inicio_admin", "Fecha Inicio Admin", "fecha"], ["fecha_limite_admin", "Fecha Límite Admin", "fecha"]]],
  ["⚖ Jurídico y cierre", false, [["estatus_juridico", "Estatus Jurídico", "estatus_juridico"],
    ["estatus_final", "Estatus Final", "estatus_final"], ["base_final", "Base Final", "url"]]],
  ["📦 Contrato y envío", false, [["fecha_ticket_contrato", "Fecha Ticket Contrato", "fecha"],
    ["numero_ticket_contrato", "Número de Ticket Contrato"], ["numero_guia", "Número de Guía"]]],
];
const ETAPAS = [
  ["propuesta", "1 · Propuesta"], ["md", "2 · MD"], ["doc", "3 · Control documental"], ["juridico", "4 · Jurídico"],
  ["cierre", "5 · Cierre"], ["cerrada", "✔ Cerrada"], ["cancelada", "✖ Cancelada"],
];
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const hoy = () => new Date().toISOString().slice(0, 10);

function etapa(f) {
  if (f.estatus_venta === "Cancelada") return "cancelada";
  if (f.estatus_venta !== "Vendida") return "propuesta";
  if (f.estatus_md !== "Informacion Enviada") return "md";
  if (f.estatus_control_doc !== "Entregados") return "doc";
  if (f.estatus_juridico !== "Contrato entregado") return "juridico";
  if (!f.estatus_final) return "cierre";
  return "cerrada";
}
function atraso(f) {
  const e = etapa(f), d = hoy();
  if (f.estatus_md === "En Atraso") return "MD en atraso";
  if (e === "md" && f.fecha_limite_md && f.fecha_limite_md < d) return `MD vencida (${f.fecha_limite_md})`;
  if (e === "doc" && f.fecha_limite_admin && f.fecha_limite_admin < d) return `Admin vencida (${f.fecha_limite_admin})`;
  return "";
}
function mes(f) {
  const fe = f.fecha_venta || f.fecha_propuesta;
  if (!fe) return "";
  const [a, m] = fe.split("-");
  return `${MESES[Number(m) - 1]} ${a}`;
}
const normalizaMes = (m) => (m ? m.trim().replace(/^./, (c) => c.toUpperCase()) : "");
const fechaCorta = (d) => (d ? d.split("-").reverse().join("/") : "");

export default {
  id: "funnel",
  titulo: "Funnel",
  icono: "📈",
  roles: ["vendedor", "validador", "auxiliar", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, dinero, numero, toast, descargarCSV, cargarCSS, kpi } = ctx.ui;
    cargarCSS(new URL("./funnel.css", import.meta.url).href);
    const puedeTodo = ctx.tieneRol("auxiliar");

    let datos = [], filtroEtapa = null, abierta = null;
    const selMes = h("select", { class: "campo", onchange: () => pintar() });
    const selVend = h("select", { class: "campo", onchange: () => pintar() });
    const buscar = h("input", { class: "campo", placeholder: "🔍 Folio, comprador, estado, ticket…", oninput: () => pintar() });
    const chkAtraso = h("input", { type: "checkbox", onchange: () => pintar() });
    const embudo = h("div", { class: "fun-embudo" });
    const kV = kpi("Ventas"), kC = kpi("Capital vendido"), kM = kpi("Monto venta"), kA = kpi("⏰ En atraso");
    const lbl = h("span", { class: "nota" });
    const det = h("aside", { class: "fun-det", hidden: true });

    const pasos = (f) => {
      const e = etapa(f), orden = ["propuesta", "md", "doc", "juridico", "cierre", "cerrada"];
      const i = orden.indexOf(e);
      return h("span", { class: "fun-pasos", title: ETAPAS.find(([k]) => k === e)[1] },
        ...["Venta", "MD", "Doc", "Jur", "Cierre"].map((t, k) => h("i", {
          class: e === "cancelada" ? "x" : k < i ? "ok" : k === i ? "act" : "", title: t })));
    };

    const t = tabla([
      { clave: "folio", titulo: "Folio" },
      { clave: "mes", titulo: "Mes" },
      { clave: "comprador", titulo: "Comprador" },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => (v == null ? "" : dinero(v)) },
      { clave: "monto_venta", titulo: "Monto venta", num: true, formato: (v) => (v == null ? "" : dinero(v)) },
      { clave: "estado", titulo: "Estado" },
      { clave: "tipo", titulo: "Tipo" },
      { clave: "vendedor", titulo: "Vendedor" },
      { clave: "etapa", titulo: "Avance", formato: (_, f) => h("span", { class: "fila", style: { gap: "6px", flexWrap: "nowrap" } },
          pasos(f), h("span", { class: `fun-etapa e-${etapa(f)}` }, ETAPAS.find(([k]) => k === etapa(f))[1])) },
      { clave: "alerta", titulo: "", formato: (_, f) => (atraso(f) ? h("span", { class: "fun-atraso", title: atraso(f) }, "⏰") : "") },
      { clave: "numero_ticket_contrato", titulo: "Ticket" },
      { clave: "numero_guia", titulo: "Guía" },
    ], { idFila: (f) => f.folio, claseFila: (f) => (abierta?.folio === f.folio ? "sel" : f.estatus_venta === "Cancelada" ? "bloq" : ""),
         vacio: "Sin ventas con ese filtro" });
    t.el.style.maxHeight = "calc(100vh - 330px)";
    t.el.addEventListener("click", (e) => {
      if (e.target.closest("a,button")) return;
      const f = t.filaDe(e.target.closest("tbody tr")); if (f) abrir(f);
    });

    const raiz = h("div", { class: "fun" },
      h("div", { class: "fun-izq" },
        h("div", { class: "kpis" }, kV.el, kC.el, kM.el, kA.el),
        embudo,
        h("div", { class: "tarjeta" },
          h("div", { class: "fila fun-filtros" },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📈 Funnel de ventas"),
            h("div", { style: { flex: "0 1 170px" } }, selMes), h("div", { style: { flex: "0 1 210px" } }, selVend),
            h("div", { style: { flex: "1 1 200px" } }, buscar),
            h("label", { style: { flex: "0 0 auto" } }, chkAtraso, " Sólo en atraso"),
            lbl,
            h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => exportar() }, "⬇ Exportar"),
            h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
          t.el)),
      det);
    cont.append(raiz);

    async function cargar() {
      try { datos = (await ctx.rpc("funnel_lista")).map((f) => ({ ...f, capital: f.capital == null ? null : Number(f.capital),
        monto_venta: f.monto_venta == null ? null : Number(f.monto_venta) })); }
      catch (e) { toast(e.message, "mal"); return; }
      datos.forEach((f) => { f.mes = normalizaMes(f.mes) || mes(f); f.etapa = ETAPAS.findIndex(([k]) => k === etapa(f)); });
      const meses = [...new Set(datos.map((f) => f.mes).filter(Boolean))];
      const vends = [...new Set(datos.map((f) => f.vendedor).filter(Boolean))].sort();
      const pm = selMes.value, pv = selVend.value;
      selMes.replaceChildren(h("option", { value: "" }, "Todos los meses"), ...meses.map((m) => h("option", { value: m }, m)));
      selVend.replaceChildren(h("option", { value: "" }, "Todos los vendedores"), ...vends.map((v) => h("option", { value: v }, v)));
      selMes.value = meses.includes(pm) ? pm : ""; selVend.value = vends.includes(pv) ? pv : "";
      pintar();
      if (abierta) { const f = datos.find((x) => x.folio === abierta.folio); if (f) abrir(f); }
    }

    function base() {
      const q = buscar.value.trim().toUpperCase();
      return datos.filter((f) => (!selMes.value || f.mes === selMes.value) && (!selVend.value || f.vendedor === selVend.value) &&
        (!chkAtraso.checked || atraso(f)) &&
        (!q || [f.folio, f.comprador, f.estado, f.municipios, f.vendedor, f.numero_ticket_contrato, f.numero_guia]
          .join(" ").toUpperCase().includes(q)));
    }

    function pintar() {
      const b = base();
      const vend = b.filter((f) => f.estatus_venta === "Vendida");
      kV.set(numero(vend.length), `${numero(b.filter((f) => f.estatus_venta === "Propuesta").length)} en propuesta`);
      kC.set(dinero(vend.reduce((s, f) => s + (f.capital || 0), 0)), "ventas vendidas");
      kM.set(dinero(vend.reduce((s, f) => s + (f.monto_venta || 0), 0)), "cobrado / por cobrar");
      const nAt = b.filter((f) => atraso(f)).length;
      kA.set(numero(nAt), "fechas límite vencidas", nAt ? "mal" : "bien");

      const total = Math.max(1, ...ETAPAS.map(([k]) => b.filter((f) => etapa(f) === k).length));
      embudo.replaceChildren(...ETAPAS.map(([k, txt]) => {
        const g = b.filter((f) => etapa(f) === k);
        return h("button", { class: `fun-paso e-${k} ${filtroEtapa === k ? "activo" : ""}`,
          onclick: () => { filtroEtapa = filtroEtapa === k ? null : k; pintar(); } },
          h("div", { class: "fun-barra" }, h("span", { style: { width: `${(g.length / total) * 100}%` } })),
          h("b", {}, numero(g.length)), h("span", {}, txt),
          h("small", {}, dinero(g.reduce((s, f) => s + (f.monto_venta || 0), 0))));
      }));
      const v = filtroEtapa ? b.filter((f) => etapa(f) === filtroEtapa) : b;
      t.setFilas(v);
      lbl.textContent = `${numero(v.length)} ventas`;
    }

    function abrir(f) {
      abierta = f; t.redibujar(); det.hidden = false; raiz.classList.add("con-detalle");
      const editaTodo = puedeTodo, editaVenta = puedeTodo || f.es_mia;
      const campos = {};
      const control = (clave, tipo, editable) => {
        // ventas de la página: propuesta y base final se generan al momento, sin guardar archivos
        if (f.id_propuesta && (clave === "propuesta_url" || clave === "base_final")) {
          const esBase = clave === "base_final";
          return h("button", { class: `btn ${esBase ? "btn-marca" : "btn-primario"}`, style: { width: "100%" },
            title: esBase ? `${f.folio}_BaseFinal.csv · layout Funnel con todas las columnas` : `${f.folio}_Propuesta.csv · un renglón por crédito`,
            onclick: () => generar(esBase) }, esBase ? "⬇ Generar base final" : "⬇ Generar propuesta (CSV)");
        }
        const v = f[clave] ?? "";
        let el;
        if (OPC[tipo]) {
          el = h("select", { class: "campo", disabled: !editable }, h("option", { value: "" }, "—"),
            ...OPC[tipo].map((o) => h("option", { value: o }, o)));
          if (v && !OPC[tipo].includes(v)) el.append(h("option", { value: v }, v));
          el.value = v;
        } else if (tipo === "fecha") el = h("input", { class: "campo", type: "date", value: v || "", disabled: !editable });
        else if (tipo === "num") el = h("input", { class: "campo", type: "number", step: "0.01", value: v === "" ? "" : v, disabled: !editable });
        else el = h("input", { class: "campo", value: v, disabled: !editable, placeholder: tipo === "url" ? "https://…" : "" });
        el.addEventListener("input", () => { el.classList.add("cambiado"); btnGuardar.disabled = false; });
        el.addEventListener("change", () => { el.classList.add("cambiado"); btnGuardar.disabled = false; });
        campos[clave] = { el, original: v === null ? "" : String(v) };
        const etiquetaLiga = (f.ligas_desc && f.ligas_desc[clave]) || "Abrir";
        const link = tipo === "url" && v ? h("a", { href: v, target: "_blank", rel: "noopener", class: "fun-link", title: v }, `${etiquetaLiga} ↗`) : null;
        return el.disabled && tipo === "url" && v ? h("div", {}, link) : h("div", { class: "fila", style: { gap: "4px" } }, el, link);
      };
      const btnGuardar = h("button", { class: "btn btn-marca", disabled: true, onclick: () => guardar() }, "💾 Guardar cambios");

      async function generar(esBase) {
        try {
          const { data: p, error } = await ctx.sb.from("propuestas").select("*").eq("id_propuesta", f.id_propuesta).single();
          if (error) throw new Error(error.message);
          const n = esBase ? await descargarLayout(ctx, p) : await descargarPropuestaCSV(ctx, p);
          toast(`${f.folio}: ${numero(n)} registros.`, "bien");
        } catch (e) { toast(e.message, "mal", 8000); }
      }
      const adjuntos = Array.isArray(f.adjuntos) ? f.adjuntos : [];

      det.replaceChildren(...[
        h("div", { class: "fun-det-enc" },
          h("div", {}, h("b", {}, f.folio), " ", h("span", { class: `fun-etapa e-${etapa(f)}` }, ETAPAS.find(([k]) => k === etapa(f))[1]),
            h("div", { class: "nota" }, `${f.comprador || "sin comprador"} · ${f.vendedor || ""}` +
              (f.id_propuesta ? ` · propuesta ${f.estatus_propuesta}` : ` · histórico ${f.origen}`)),
            atraso(f) ? h("div", { class: "fun-atraso-txt" }, `⏰ ${atraso(f)}`) : null),
          h("button", { class: "btn btn-secundario btn-chico", onclick: cerrar }, "✖")),
        h("div", { class: "fun-avance" }, pasos(f), h("span", { class: "nota" }, `Actualizado ${new Date(f.actualizado).toLocaleString("es-MX")} · ${f.actualizado_por || ""}`)),
        ...SECCIONES.map(([titulo, esVenta, lista]) => h("section", { class: "fun-sec" },
          h("h4", {}, titulo),
          h("div", { class: "fun-grid" }, ...lista.map(([clave, etiqueta, tipo]) =>
            h("label", {}, h("span", { class: "etiqueta" }, etiqueta), control(clave, tipo, esVenta ? editaVenta : editaTodo)))))),
        adjuntos.length ? h("section", { class: "fun-sec" }, h("h4", {}, `📎 Adjuntos en SharePoint (${adjuntos.length})`),
          h("ul", { class: "fun-adj" }, ...adjuntos.map((a) => h("li", {}, h("a", { href: a.url, target: "_blank", rel: "noopener" }, a.nombre))))) : null,
        h("div", { class: "fun-pie" },
          editaVenta ? btnGuardar : h("span", { class: "nota" }, "Sólo lectura: el seguimiento lo actualiza el auxiliar de venta o un maestro."),
          !editaTodo && editaVenta ? h("span", { class: "nota" }, "Como vendedor puedes editar la sección Venta.") : null)].filter(Boolean));

      async function guardar() {
        const cambios = {};
        for (const [k, c] of Object.entries(campos)) if (!c.el.disabled && c.el.value !== c.original) cambios[k] = c.el.value;
        if (!Object.keys(cambios).length) { toast("No hay cambios."); return; }
        if (cambios.estatus_venta === "Vendida" && !cambios.fecha_venta && !f.fecha_venta) cambios.fecha_venta = hoy();
        btnGuardar.disabled = true;
        try { await ctx.rpc("funnel_guardar", { p_folio: f.folio, p_datos: cambios }); toast(`${f.folio} actualizada.`, "bien"); await cargar(); }
        catch (e) { toast(e.message, "mal", 8000); btnGuardar.disabled = false; }
      }
    }
    function cerrar() { abierta = null; det.hidden = true; raiz.classList.remove("con-detalle"); t.redibujar(); }

    function exportar() {
      const cols = [["mes", "MES"], ["folio", "Folio de Venta"], ["comprador", "Comprador"], ["capital", "Capital"], ["monto_venta", "Monto Venta"],
        ["estado", "Estado"], ["municipios", "Municipio's"], ["tipo", "TIpo"], ["estatus_venta", "Estatus Venta"],
        ["fecha_propuesta", "Fecha Propuesta"], ["fecha_venta", "Fecha Venta"], ["vendedor", "Vendedor"], ["estatus_md", "Estatus MD"],
        ["fecha_inicio_md", "Fecha Inicio MD"], ["fecha_limite_md", "Fecha Límite MD"], ["base_completa_venta", "Base Completa Venta"],
        ["estatus_control_doc", "Estatus Control Documental"], ["fecha_inicio_admin", "Fecha Inicio Admin"],
        ["fecha_limite_admin", "Fecha Límite Admin"], ["estatus_juridico", "Estatus Jurídico"], ["estatus_final", "Estatus FInal"],
        ["base_final", "Base Final"], ["propuesta_url", "Propuesta"], ["comprobante_pago", "Comprobante de Pago"],
        ["fecha_ticket_contrato", "Fecha Ticket Contrado"], ["numero_ticket_contrato", "Numero de Ticket Contrato"], ["numero_guia", "Numero de Guia"]];
      const fechas = new Set(cols.map(([k]) => k).filter((k) => k.startsWith("fecha")));
      const v = filtroEtapa ? base().filter((f) => etapa(f) === filtroEtapa) : base();
      descargarCSV(`Funnel_VentasCartera_${hoy()}.csv`, cols.map(([, t2]) => t2),
        v.map((f) => Object.fromEntries(cols.map(([k, t2]) => [t2, fechas.has(k) ? fechaCorta(f[k]) : f[k] ?? ""]))));
    }

    await cargar();
  },
};
