// ============================================================
// MÓDULO: Revisión (validador)
// Propuestas EN REVISIÓN: ver partidas, quitar las que no deben venderse,
// aprobar (avisa al auxiliar de venta) o rechazar (todo regresa a Disponible).
// ============================================================
import { descargarCuentasRevision } from "../venta/layout.js";
import { botonPropuestaFinal } from "../venta/propuesta_final.js";

export default {
  id: "revision",
  titulo: "Revisión",
  icono: "✅",
  roles: ["validador", "admin"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, dinero, numero, dias, fecha, toast, confirmar, pedirTexto, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./revision.css", import.meta.url).href);

    let propuestas = [];
    let actual = null;
    const quitar = new Set();
    let yaVendidas = new Map();   // "tipo|clave" -> folios donde ya se vendió

    // ---- lista de pendientes ----
    const lblPend = h("span", { class: "nota" });
    const tLista = tabla([
      { clave: "id_propuesta", titulo: "Id" },
      { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
      { clave: "usuario", titulo: "Vendedor" },
      { clave: "comprador", titulo: "Comprador" },
      { clave: "tipo_venta", titulo: "Tipo" },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
    ], { idFila: (p) => p.id_propuesta, claseFila: (p) => (p.id_propuesta === actual?.id_propuesta ? "sel" : ""),
         vacio: "No hay propuestas por revisar 🎉" });
    tLista.el.addEventListener("click", (e) => {
      const p = tLista.filaDe(e.target.closest("tbody tr")); if (p) abrir(p);
    });

    // ---- aviso: partidas que ya están en otra venta ----
    const avisoDup = h("div", { class: "rev-aviso-dup", hidden: true });

    // ---- detalle ----
    const titulo = h("h3", { style: { margin: 0 } }, "Selecciona una propuesta");
    const sub = h("div", { class: "nota" });
    const kCap = kpi("Capital"), kRango = kpi("Rango objetivo"), kVenta = kpi("Valor de venta"),
          kPart = kpi("Partidas"), kMora = kpi("Mora promedio");
    const lblQuitar = h("span", { class: "nota" });
    const btnQuitar = h("button", { class: "btn btn-secundario", disabled: true, onclick: () => quitarSel() }, "✂ Quitar marcadas");
    const btnRechazar = h("button", { class: "btn btn-secundario", disabled: true, onclick: () => revisar(false) }, "✖ Rechazar");
    const btnAprobar = h("button", { class: "btn btn-marca", disabled: true, onclick: () => revisar(true) }, "✔ Aprobar");
    const btnCuentas = h("button", { class: "btn btn-secundario", disabled: true, title: "Referencias para preguntar si siguen disponibles para venta",
      onclick: async () => {
        try { const n = await descargarCuentasRevision(ctx, actual); toast(`${numero(n)} cuentas descargadas.`, "bien"); }
        catch (e) { toast(e.message, "mal"); }
      } }, "⬇ Cuentas");
    const cajaFinal = h("span", { style: { display: "contents" } });
    const tDet = tabla([
      { clave: "tipo", titulo: "Cartera" },
      { clave: "clave", titulo: "Grupo / vReference" },
      { clave: "integrantes", titulo: "Créditos", num: true },
      { clave: "estados", titulo: "Estado" },
      { clave: "municipios", titulo: "Municipio" },
      { clave: "colonias", titulo: "Colonia" },
      { clave: "dias", titulo: "Mora", num: true, formato: (v) => dias(v) },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      { clave: "ya_vendida", titulo: "Ya vendida en", formato: (_, f) => {
        const v = yaVendidas.get(`${f.tipo}|${f.clave}`);
        return v ? h("span", { class: "rev-dup" }, `⚠ ${v.join(", ")}`) : "";
      } },
    ], { seleccion: quitar, idFila: (f) => `${f.tipo}|${f.clave}`, alCambiar: () => pintarQuitar(),
         claseFila: (f) => (yaVendidas.has(`${f.tipo}|${f.clave}`) ? "rev-fila-dup" : ""),
         vacio: "Sin partidas" });

    cont.append(h("div", { class: "rev" },
      h("div", { class: "tarjeta rev-lista" },
        h("div", { class: "fila", style: { marginBottom: "8px" } },
          h("h3", { style: { margin: 0 } }, "Por revisar"), lblPend,
          h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")),
        tLista.el),
      h("div", { class: "rev-det" },
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { flexWrap: "wrap" } },
            h("div", { style: { flex: "1 1 260px" } }, titulo, sub),
            h("div", { class: "fila", style: { flex: "0 0 auto", gap: "6px", flexWrap: "wrap" } }, btnCuentas, cajaFinal, btnQuitar, btnRechazar, btnAprobar))),
        h("div", { class: "kpis" }, kCap.el, kRango.el, kVenta.el, kPart.el, kMora.el),
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "6px" } },
            h("b", { style: { flex: "0 0 auto" } }, "Partidas"), lblQuitar),
          avisoDup,
          h("p", { class: "nota", style: { margin: "0 0 6px" } },
            "Marca las partidas que NO deben venderse y da clic en Quitar marcadas: regresan a Disponible."),
          tDet.el))));

    async function cargar() {
      const { data, error } = await ctx.sb.from("propuestas").select("*")
        .eq("estatus", "EN REVISIÓN").order("fecha", { ascending: true });
      if (error) { toast(error.message, "mal"); return; }
      propuestas = data.map((p) => ({ ...p, capital: Number(p.capital) }));
      tLista.setFilas(propuestas);
      lblPend.textContent = `${numero(propuestas.length)} pendientes`;
      if (actual) {
        const sigue = propuestas.find((p) => p.id_propuesta === actual.id_propuesta);
        sigue ? abrir(sigue) : limpiar();
      } else if (propuestas.length) abrir(propuestas[0]);
      else limpiar();
    }

    function limpiar() {
      actual = null; quitar.clear(); tDet.setFilas([]); avisoDup.hidden = true;
      titulo.textContent = "Selecciona una propuesta"; sub.textContent = "";
      [kCap, kRango, kVenta, kPart, kMora].forEach((k) => k.set("—"));
      [btnQuitar, btnRechazar, btnAprobar, btnCuentas].forEach((b) => (b.disabled = true));
      cajaFinal.replaceChildren();
      tLista.redibujar(); pintarQuitar();
    }

    async function abrir(p) {
      if (actual?.id_propuesta !== p.id_propuesta) quitar.clear();
      actual = p; tLista.redibujar();
      titulo.textContent = `${p.id_propuesta} · ${p.tipo_venta || ""}`;
      sub.textContent = `Comprador: ${p.comprador || "sin capturar"} · vendedor ${p.usuario} · ${fecha(p.fecha)}` +
        (p.partidas_quitadas ? ` · ${p.partidas_quitadas} partidas quitadas (capital original ${dinero(p.capital_original)})` : "");
      let partidas;
      try { partidas = await ctx.rpc("partidas_propuesta", { p_id: p.id_propuesta }); }
      catch (e) { toast(e.message, "mal"); return; }
      partidas = partidas.map((f) => ({ ...f, capital: Number(f.capital), dias: f.dias === null ? null : Number(f.dias), integrantes: Number(f.integrantes) }));
      yaVendidas = new Map();
      try {
        for (const d of (await ctx.rpc("propuesta_ya_vendidas", { p_id: p.id_propuesta })) || []) yaVendidas.set(`${d.tipo}|${d.clave}`, d.ventas || []);
      } catch { /* sin aviso si falla */ }
      tDet.setFilas(partidas);
      if (yaVendidas.size) {
        avisoDup.replaceChildren(h("b", {}, `⚠ ${yaVendidas.size} partidas ya están vendidas en otra venta. `),
          "Cada venta debe llevar créditos y grupos distintos. ",
          h("button", { class: "btn btn-secundario btn-chico", onclick: () => {
            partidas.forEach((f) => { if (yaVendidas.has(`${f.tipo}|${f.clave}`)) quitar.add(`${f.tipo}|${f.clave}`); });
            tDet.redibujar(); pintarQuitar();
          } }, "Marcarlas para quitar"));
        avisoDup.hidden = false;
      } else avisoDup.hidden = true;

      const cap = Number(p.capital), obj = Number(p.capital_objetivo);
      const min = Math.max(0, obj - 1000), max = obj + 2000, enRango = cap >= min && cap <= max;
      kCap.set(dinero(cap), `Objetivo ${dinero(obj)}`, enRango ? "bien" : "alerta");
      kRango.set(enRango ? "En rango" : "Fuera de rango", `${dinero(min)} a ${dinero(max)}`, enRango ? "bien" : "alerta");
      kVenta.set(dinero(p.valor_venta), `${p.centavos} centavos por peso`);
      kPart.set(numero(partidas.length), `${numero(partidas.reduce((s, f) => s + f.integrantes, 0))} créditos`);
      kMora.set(dias(p.dias_mora));
      btnRechazar.disabled = btnAprobar.disabled = btnCuentas.disabled = false;
      cajaFinal.replaceChildren(botonPropuestaFinal(ctx, p, () => cargar()));
      pintarQuitar();
    }

    function pintarQuitar() {
      const marcadas = tDet.filas.filter((f) => quitar.has(`${f.tipo}|${f.clave}`));
      btnQuitar.disabled = !actual || marcadas.length === 0;
      lblQuitar.textContent = marcadas.length
        ? `${marcadas.length} marcadas para quitar · ${dinero(marcadas.reduce((s, f) => s + f.capital, 0))}` : "";
      lblQuitar.style.color = marcadas.length ? "var(--rojo)" : "";
    }

    async function quitarSel() {
      const marcadas = tDet.filas.filter((f) => quitar.has(`${f.tipo}|${f.clave}`));
      if (!marcadas.length) return;
      if (!(await confirmar("Quitar partidas",
        `Se quitarán ${marcadas.length} partidas de ${actual.id_propuesta} y regresarán a Disponible.\n` +
        `Capital que sale: ${dinero(marcadas.reduce((s, f) => s + f.capital, 0))}`, "Quitar"))) return;
      try {
        const r = await ctx.rpc("quitar_partidas", {
          p_id: actual.id_propuesta,
          p_refs: marcadas.filter((f) => f.tipo === "JyP").map((f) => f.clave),
          p_grupos: marcadas.filter((f) => f.tipo === "Grupal").map((f) => f.clave),
        });
        toast(`Se quitaron ${r.quitadas} partidas. Nuevo capital: ${dinero(r.capital)}.`, "bien");
        quitar.clear();
      } catch (e) { toast(e.message, "mal", 8000); }
      await cargar();
    }

    async function revisar(aprobar) {
      if (!actual) return;
      let comentario = "";
      if (aprobar) {
        if (!(await confirmar("Aprobar propuesta",
          `${actual.id_propuesta}\nCapital: ${dinero(actual.capital)}\nValor de venta: ${dinero(actual.valor_venta)}\n\n` +
          "Se avisará al auxiliar de venta para que genere la sub base.", "Aprobar"))) return;
        comentario = await pedirTexto("Comentario", "Comentario para el vendedor y el auxiliar (opcional):");
        if (comentario === null) return;
      } else {
        comentario = await pedirTexto("Rechazar propuesta",
          `Motivo del rechazo de ${actual.id_propuesta}.\nTodas sus partidas regresarán a Disponible.`);
        if (comentario === null) return;
        if (!comentario.trim()) { toast("Escribe el motivo del rechazo.", "mal"); return; }
      }
      try {
        await ctx.rpc("revisar_propuesta", { p_id: actual.id_propuesta, p_aprobar: aprobar, p_comentario: comentario });
        toast(`${actual.id_propuesta} ${aprobar ? "aprobada" : "rechazada"}.`, "bien");
        actual = null;
      } catch (e) { toast(e.message, "mal", 8000); }
      ctx.refrescarAvisos();
      await cargar();
    }

    await cargar();
  },
};
