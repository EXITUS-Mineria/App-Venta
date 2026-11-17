// ============================================================
// MÓDULO: Bitácora — seguimiento de propuestas y ventas
//  - Contadores por estatus (clic = filtro), búsqueda, sólo mías.
//  - Panel de detalle: datos, historial (quién/cuándo), partidas y créditos.
//  - Descargas: CSV de la propuesta (siempre) y base final Funnel (cuando ya está aprobada).
// ============================================================
import { descargarLayout, descargarPropuestaCSV } from "./layout.js";

const ESTATUS = [
  ["EN REVISIÓN", "🕒 En revisión"], ["APROBADA", "✅ Aprobadas"], ["EN VENTA", "💼 En venta"],
  ["APARTADA", "📌 Apartadas (escritorio)"], ["EN CONFLICTO", "⚠ En conflicto"],
  ["RECHAZADA", "✖ Rechazadas"], ["LIBERADA", "↩ Liberadas"],
];
const VIGENTES = ["EN REVISIÓN", "APROBADA", "EN VENTA", "APARTADA", "EN CONFLICTO"];
const CON_BASE_FINAL = ["APROBADA", "EN VENTA", "APARTADA"];
const ICONO_EVENTO = {
  "Creada": "🆕", "Aprobada": "✅", "Rechazada": "✖", "Sub base generada": "📦", "Liberada": "↩",
  "Regresa a revisión": "🕒", "Complemento": "➕", "Restitución": "🔁", "Partidas quitadas por el validador": "✂",
  "Capital modificado": "✏", "Comprador": "🧾",
};

export default {
  id: "bitacora",
  titulo: "Bitácora",
  icono: "📋",
  roles: ["vendedor", "validador", "auxiliar", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, dinero, numero, dias, fecha, toast, confirmar, pedirTexto, descargarCSV, pastillaEstatus, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./bitacora.css", import.meta.url).href);

    let datos = [];
    let filtroEstatus = null;          // null = vigentes
    let abierta = null;

    const chkMias = h("input", { type: "checkbox", checked: ctx.perfil.rol === "vendedor", onchange: () => pintar() });
    const buscar = h("input", { class: "campo", placeholder: "🔍 Id, vendedor, comentario…", style: { flex: "1 1 180px", maxWidth: "280px" }, oninput: () => pintar() });
    const lbl = h("span", { class: "nota" });
    const chips = h("div", { class: "bit-chips" });

    const esMia = (p) => p.user_id === ctx.perfil.user_id;
    const puedeLiberar = (p) => VIGENTES.includes(p.estatus) &&
      (ctx.esAdmin || (esMia(p) && ["EN REVISIÓN", "APARTADA", "EN CONFLICTO"].includes(p.estatus)));
    const puedeComplementar = (p) => ["EN REVISIÓN", "APROBADA", "EN VENTA", "APARTADA"].includes(p.estatus) && (ctx.esAdmin || esMia(p));
    const puedeBaseFinal = (p) => (ctx.tieneRol("auxiliar", "validador") && !["LIBERADA", "RECHAZADA"].includes(p.estatus)) ||
      (esMia(p) && CON_BASE_FINAL.includes(p.estatus));

    const t = tabla([
      { clave: "ver", titulo: "", formato: (_, p) => h("span", { class: "fila", style: { gap: "4px", flexWrap: "nowrap" } },
          h("button", { class: "btn btn-secundario btn-chico", onclick: () => abrir(p) }, "👁 Ver"),
          h("button", { class: "btn btn-secundario btn-chico", title: `${p.id_propuesta}_Propuesta.csv`, onclick: () => csvPropuesta(p) }, "⬇ CSV"),
          puedeBaseFinal(p) ? h("button", { class: "btn btn-marca btn-chico", title: `${p.id_propuesta}_BaseFinal.csv`, onclick: () => baseFinal(p) }, "⬇ Base final") : null) },
      { clave: "id_propuesta", titulo: "Id" },
      { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
      { clave: "usuario", titulo: "Vendedor" },
      { clave: "comprador", titulo: "Comprador", formato: (v) => v || h("span", { class: "nota" }, "sin capturar") },
      { clave: "tipo_venta", titulo: "Tipo" },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      { clave: "valor_venta", titulo: "Venta", num: true, formato: (v) => dinero(v) },
      { clave: "estatus", titulo: "Estatus", formato: (v) => pastillaEstatus(v) },
      { clave: "ultimo", titulo: "Último movimiento", formato: (_, p) => h("span", { class: "bit-col-extra" }, ultimoMovimiento(p)) },
      { clave: "comentario", titulo: "Comentario", formato: (v, p) => h("span", { class: "bit-col-extra" }, v || p.conflicto || p.motivo || "") },
    ], { idFila: (p) => p.id_propuesta,
         claseFila: (p) => [p.estatus === "EN CONFLICTO" ? "conflicto" : ["LIBERADA", "RECHAZADA"].includes(p.estatus) ? "bloq" : "",
                            abierta?.id_propuesta === p.id_propuesta ? "sel" : ""].join(" "),
         vacio: "Sin propuestas con ese filtro" });
    t.el.style.maxHeight = "calc(100vh - 280px)";
    t.el.addEventListener("dblclick", (e) => { const p = t.filaDe(e.target.closest("tbody tr")); if (p) abrir(p); });

    // ---- panel de detalle ----
    const det = h("aside", { class: "bit-det", hidden: true });

    const raiz = h("div", { class: "bit" });
    cont.append(raiz);
    raiz.append(
      h("div", { class: "bit-izq" },
        chips,
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { justifyContent: "flex-start", flexWrap: "wrap", marginBottom: "10px" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "📋 Bitácora de propuestas y ventas"),
            h("label", { style: { flex: "0 0 auto" } }, chkMias, " Sólo mías"),
            buscar, h("span", { style: { flex: 1 } }), lbl,
            h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => exportar() }, "⬇ Exportar bitácora"),
            h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
          t.el)),
      det);

    // ---------- datos ----------
    async function cargar() {
      const { data, error } = await ctx.sb.from("propuestas").select("*").order("fecha", { ascending: false }).limit(5000);
      if (error) { toast(error.message, "mal"); return; }
      datos = data.map((p) => ({ ...p, capital: Number(p.capital), valor_venta: Number(p.valor_venta) }));
      pintar();
      if (abierta) { const p = datos.find((x) => x.id_propuesta === abierta.id_propuesta); if (p) abrir(p); }
    }

    const fechaUltimo = (p) => [p.fecha, p.revisada_en, p.sub_base_en, p.liberada_en].filter(Boolean).sort().pop();
    function ultimoMovimiento(p) {
      const opciones = [[p.liberada_en, `Liberada · ${p.liberada_por || ""}`], [p.sub_base_en, `Sub base · ${p.sub_base_por || ""}`],
        [p.revisada_en, `${p.estatus === "RECHAZADA" ? "Rechazada" : "Revisada"} · ${p.revisada_por || ""}`], [p.fecha, "Creada"]]
        .filter(([f]) => f).sort((a, b) => String(b[0]).localeCompare(String(a[0])));
      return opciones.length ? `${opciones[0][1]} · ${fecha(opciones[0][0])}` : "";
    }

    function base() {
      const q = buscar.value.trim().toUpperCase();
      return datos.filter((p) => (!chkMias.checked || esMia(p)) &&
        (!q || `${p.id_propuesta} ${p.usuario} ${p.comprador || ""} ${p.comentario || ""} ${p.tipo_venta || ""}`.toUpperCase().includes(q)));
    }
    function visibles() {
      const b = base();
      return filtroEstatus === "TODAS" ? b : filtroEstatus ? b.filter((p) => p.estatus === filtroEstatus) : b.filter((p) => VIGENTES.includes(p.estatus));
    }

    function pintar() {
      const b = base();
      const cuenta = (e) => b.filter((p) => p.estatus === e).length;
      const chip = (clave, texto, n, cap) => h("button", {
        class: `bit-chip ${filtroEstatus === clave ? "activo" : ""}`,
        onclick: () => { filtroEstatus = filtroEstatus === clave ? null : clave; pintar(); },
      }, h("span", {}, texto), h("b", {}, numero(n)), cap !== undefined ? h("small", {}, dinero(cap)) : null);
      const vig = b.filter((p) => VIGENTES.includes(p.estatus));
      chips.replaceChildren(
        chip(null, "📂 Vigentes", vig.length, vig.reduce((s, p) => s + p.capital, 0)),
        ...ESTATUS.filter(([e]) => cuenta(e) || ["EN REVISIÓN", "APROBADA", "EN VENTA"].includes(e)).map(([e, txt]) =>
          chip(e, txt, cuenta(e), b.filter((p) => p.estatus === e).reduce((s, p) => s + p.capital, 0))),
        chip("TODAS", "🗂 Todas", b.length));
      const v = visibles().map((p) => ({ ...p, ultimo: fechaUltimo(p) }));
      t.setFilas(v);
      lbl.textContent = `${numero(v.length)} propuestas · ${dinero(v.reduce((s, p) => s + p.capital, 0))}`;
    }

    // ---------- detalle ----------
    async function abrir(p) {
      abierta = p; t.redibujar();
      det.hidden = false; raiz.classList.add("con-detalle");
      det.replaceChildren(h("div", { class: "bit-cargando" }, "Cargando…"));
      let partidas = [], eventos = [], restit = [];
      try {
        const [rp, re, rr] = await Promise.all([
          ctx.rpc("partidas_propuesta", { p_id: p.id_propuesta }),
          ctx.sb.from("propuesta_eventos").select("*").eq("id_propuesta", p.id_propuesta).order("fecha"),
          ctx.sb.from("restituciones").select("*").or(`id_propuesta_reemplazo.eq.${p.id_propuesta},id_propuesta_original.eq.${p.id_propuesta}`).order("fecha"),
        ]);
        partidas = rp || [];
        if (re.error) throw new Error(re.error.message); eventos = re.data;
        if (!rr.error) restit = rr.data;
      } catch (e) { det.replaceChildren(h("div", { class: "bit-cargando" }, e.message)); return; }
      if (abierta?.id_propuesta !== p.id_propuesta) return;

      const creditos = partidas.reduce((s, f) => s + Number(f.integrantes), 0);
      const kCap = kpi("Capital"), kVta = kpi("Valor de venta"), kPart = kpi("Partidas"), kMora = kpi("Mora prom.");
      kCap.set(dinero(p.capital), p.capital_original && Number(p.capital_original) !== p.capital ? `Original ${dinero(p.capital_original)}` : `Objetivo ${dinero(p.capital_objetivo)}`);
      kVta.set(dinero(p.valor_venta), `${p.centavos} centavos`);
      kPart.set(numero(partidas.length), `${numero(creditos)} créditos`);
      kMora.set(dias(p.dias_mora));

      const tPart = tabla([
        { clave: "tipo", titulo: "Cartera" }, { clave: "clave", titulo: "Grupo / vReference" },
        { clave: "integrantes", titulo: "Créd.", num: true }, { clave: "estados", titulo: "Estado" },
        { clave: "municipios", titulo: "Municipio" },
        { clave: "dias", titulo: "Mora", num: true, formato: (v) => dias(v) },
        { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      ], { idFila: (f) => `${f.tipo}|${f.clave}`, vacio: "Sin partidas (liberada o rechazada)" });
      tPart.setFilas(partidas.map((f) => ({ ...f, capital: Number(f.capital), integrantes: Number(f.integrantes), dias: f.dias === null ? null : Number(f.dias) })));
      tPart.el.style.maxHeight = "300px";

      const linea = eventos.map((e) => h("li", {},
        h("span", { class: "bit-ico" }, ICONO_EVENTO[e.evento] || "•"),
        h("div", {}, h("b", {}, e.evento), h("small", {}, ` · ${e.usuario || ""} · ${fecha(e.fecha)}`),
          e.detalle ? h("div", { class: "bit-ev-det" }, e.detalle) : null)));
      for (const r of restit) {
        linea.push(h("li", {}, h("span", { class: "bit-ico" }, "🔁"),
          h("div", {}, h("b", {}, `Restitución ${r.id_restitucion} · ${r.motivo}`), h("small", {}, ` · ${r.usuario} · ${fecha(r.fecha)}`),
            h("div", { class: "bit-ev-det" }, `${r.clave_original} (${dinero(r.capital_original)}) → ${r.clave_reemplazo} (${dinero(r.capital_reemplazo)})` +
              (r.comentario ? ` · ${r.comentario}` : "")))));
      }

      const baseOk = puedeBaseFinal(p);
      const btnBase = h("button", { class: "btn btn-marca", disabled: !baseOk || !partidas.length,
        title: baseOk ? "Layout para Funnel (Latin-1) con todas las columnas de la base" : "Disponible cuando la venta esté aprobada",
        onclick: () => baseFinal(p) }, "⬇ Base final (Funnel)");

      det.replaceChildren(...[
        h("div", { class: "bit-det-enc" },
          h("div", {}, h("b", {}, p.id_propuesta), " ", pastillaEstatus(p.estatus),
            h("div", { class: "bit-comprador" }, "🧾 Comprador: ", h("b", {}, p.comprador || "sin capturar"),
              puedeComplementar(p) || (ctx.esAdmin && !["LIBERADA", "RECHAZADA"].includes(p.estatus))
                ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => cambiarComprador(p) }, "✏") : null),
            h("div", { class: "nota" }, `Vendedor ${p.usuario} · ${p.tipo_venta || ""} · ${fecha(p.fecha)}`)),
          h("button", { class: "btn btn-secundario btn-chico", onclick: cerrar, title: "Cerrar" }, "✖")),
        h("div", { class: "bit-acciones" },
          h("button", { class: "btn btn-primario", disabled: !partidas.length, onclick: () => csvPropuesta(p) }, "⬇ CSV propuesta"),
          btnBase,
          puedeComplementar(p) ? h("button", { class: "btn btn-secundario",
            onclick: () => { location.hash = `#/venta?complementar=${encodeURIComponent(p.id_propuesta)}`; } }, "➕ Complementar") : null,
          puedeLiberar(p) ? h("button", { class: "btn btn-secundario", onclick: () => liberar(p) }, "↩ Liberar") : null),
        !baseOk && !["LIBERADA", "RECHAZADA"].includes(p.estatus)
          ? h("div", { class: "nota", style: { margin: "-4px 0 8px" } }, "La base final se habilita cuando el validador aprueba la venta.") : null,
        h("div", { class: "kpis" }, kCap.el, kVta.el, kPart.el, kMora.el),
        p.comentario ? h("div", { class: "bit-coment" }, "💬 ", p.comentario) : null,
        h("h4", {}, "🧭 Seguimiento"),
        h("ul", { class: "bit-linea" }, ...linea),
        h("h4", {}, `📄 Contenido (${numero(partidas.length)} partidas · ${numero(creditos)} créditos)`),
        tPart.el].filter(Boolean));
    }

    async function cambiarComprador(p) {
      const nuevo = await pedirTexto("Comprador", `Nombre del comprador de ${p.id_propuesta}:`, p.comprador || "");
      if (nuevo === null) return;
      try { await ctx.rpc("asignar_comprador", { p_id: p.id_propuesta, p_comprador: nuevo }); toast("Comprador guardado.", "bien"); }
      catch (e) { toast(e.message, "mal"); }
      cargar();
    }

    function cerrar() { abierta = null; det.hidden = true; raiz.classList.remove("con-detalle"); t.redibujar(); }

    async function csvPropuesta(p) {
      try { const n = await descargarPropuestaCSV(ctx, p); toast(`${numero(n)} créditos descargados.`, "bien"); }
      catch (e) { toast(e.message, "mal"); }
    }

    async function baseFinal(p) {
      try { const n = await descargarLayout(ctx, p); toast(`Base final ${p.id_propuesta}: ${numero(n)} registros.`, "bien"); }
      catch (e) { toast(e.message, "mal", 8000); }
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
      const cols = ["id_propuesta", "fecha", "usuario", "comprador", "tipo_venta", "capital_objetivo", "capital", "centavos", "valor_venta",
        "dias_mora", "estatus", "capital_original", "partidas_quitadas", "complementos", "revisada_en", "revisada_por", "comentario",
        "sub_base_en", "sub_base_por", "conflicto", "origen", "liberada_en", "liberada_por", "motivo"];
      const v = visibles();
      const hoy = new Date().toISOString().slice(0, 10);
      // con una sola venta en pantalla, el archivo lleva su nomenclatura
      descargarCSV(v.length === 1 ? `${v[0].id_propuesta}_Bitacora.csv` : `Bitacora_VentaCartera_${hoy}.csv`, cols, v);
    }

    await cargar();
  },
};
