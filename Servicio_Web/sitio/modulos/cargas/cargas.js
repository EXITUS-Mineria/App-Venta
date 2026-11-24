// ============================================================
// MÓDULO: Bases cargadas y exclusiones (sólo administradores)
//  🗂️ Bases: las sube cargar_supabase.py (fuera del sitio).
//  🚫 Exclusiones: gestiones SIGE (promesas de pago), pagos y lista negra. Los créditos excluidos
//     dejan de estar disponibles; se vuelven a aplicar solos cada vez que se carga la base.
// ============================================================
import { leerCSV } from "../venta/propuesta_final.js";
import { extraerExclusiones, leerTabla } from "./exclusiones.js";

const ORIGENES = [
  { k: "promesa", titulo: "🤝 Promesas de pago (gestiones SIGE)", sw: "excluir_promesas", dias: "dias_promesa",
    ayuda: "Archivo de gestiones de SIGE. Se toman las filas cuyo resultado diga PROMESA / CONVENIO / COMPROMISO (si no hay columna de resultado, todas). Columnas: vReference o Referencia, FechaPromesa o FechaGestión, Resultado." },
  { k: "pago", titulo: "💵 Pagos recientes", sw: "excluir_pagos", dias: "dias_pago",
    ayuda: "Archivo de pagos. Columnas: vReference o Referencia, FechaPago o Fecha, Monto o Importe." },
  { k: "lista_negra", titulo: "⛔ Lista negra", sw: "excluir_lista_negra",
    ayuda: "Lista de vReference que nunca deben ofrecerse. Basta una columna vReference (o la primera columna)." },
];
const PARTE = 4000;

export default {
  id: "cargas",
  titulo: "Bases",
  icono: "🗂️",
  roles: ["admin"],

  async montar(cont, ctx) {
    const { h, tabla, numero, fecha, toast, confirmar, descargarCSV } = ctx.ui;
    const t = tabla([
      { clave: "cartera", titulo: "Cartera" },
      { clave: "archivo", titulo: "Archivo" },
      { clave: "filas", titulo: "Filas", num: true, formato: (v) => numero(v) },
      { clave: "usuario", titulo: "Cargó" },
      { clave: "cargado", titulo: "Fecha", formato: (v) => fecha(v) },
    ], { vacio: "Aún no se han cargado bases" });

    const excl = h("div", { class: "tarjeta" });
    cont.append(h("div", { class: "tarjeta" },
      h("h3", {}, "🗂️ Bases cargadas"),
      h("p", { class: "nota", style: { fontSize: ".85rem" } },
        "Para actualizar la cartera del mes corre cargar_supabase.py con Base JyP.csv y Base Grupal.csv. ",
        "Los apartados vigentes se conservan y las exclusiones de abajo se vuelven a aplicar solas."),
      t.el), excl);

    const { data, error } = await ctx.sb.from("cargas").select("cartera, archivo, filas, usuario, cargado").order("cargado", { ascending: false }).limit(50);
    if (error) toast(error.message, "mal");
    t.setFilas(data || []);

    // ================= Exclusiones =================
    async function pintarExclusiones() {
      let resumen = [], config = [];
      try { [resumen, config] = await Promise.all([ctx.rpc("exclusiones_resumen"), ctx.rpc("config_lista")]); }
      catch (e) { excl.replaceChildren(h("div", { class: "nota" }, `Exclusiones: ${e.message}`)); return; }
      const cfg = Object.fromEntries((config || []).map((c) => [c.clave, c.valor]));
      const res = Object.fromEntries((resumen || []).map((r) => [r.origen, r]));
      const guardar = async (clave, valor, aviso) => {
        try { await ctx.rpc("config_guardar", { p_clave: clave, p_valor: valor }); toast(aviso, "bien"); pintarExclusiones(); }
        catch (e) { toast(e.message, "mal", 8000); }
      };
      const bloques = ORIGENES.map((o) => {
        const r = res[o.k] || {};
        const activo = cfg[o.sw] === true;
        const input = h("input", { type: "file", accept: ".csv,.txt,.xlsx,.xls", hidden: true, onchange: () => { if (input.files[0]) cargar(o, input.files[0]); input.value = ""; } });
        const diasInput = o.dias ? h("input", { class: "campo", type: "number", min: 1, max: 365, value: Number(cfg[o.dias] ?? 30), style: { width: "80px" } }) : null;
        return h("div", { class: "excl-bloque", "data-origen": o.k, style: { borderTop: "1px solid var(--borde, #D9DDE3)", padding: "10px 0" } },
          h("div", { class: "fila", style: { justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" } },
            h("b", {}, o.titulo),
            h("label", { class: "fila", style: { gap: "6px", alignItems: "center", flex: "0 0 auto" } },
              h("input", { type: "checkbox", class: "excl-sw", checked: activo,
                onchange: (e) => guardar(o.sw, e.target.checked, e.target.checked ? "Exclusión activada: se quitaron los créditos de la base disponible." : "Exclusión desactivada: los créditos regresaron a la base.") }),
              activo ? "Activa" : "Desactivada")),
          h("div", { class: "nota" }, o.ayuda),
          h("div", { class: "nota" },
            `${numero(r.cargados || 0)} referencias cargadas · ${numero(r.vigentes || 0)} vigentes · fuera de la base: ${numero(r.jyp_fuera || 0)} JyP y ${numero(r.grupos_fuera || 0)} grupos`,
            r.cargado ? ` · último archivo ${r.archivo || ""} (${fecha(r.cargado)}${r.cargado_por ? `, ${r.cargado_por}` : ""})` : ""),
          h("div", { class: "fila", style: { gap: "8px", alignItems: "center", flexWrap: "wrap" } },
            input,
            h("button", { class: "btn btn-secundario btn-chico", onclick: () => input.click() }, "⬆ Cargar archivo (reemplaza el anterior)"),
            diasInput ? h("span", { class: "nota" }, o.k === "pago" ? "Pagos de los últimos" : "Promesa vigente hasta") : null,
            diasInput,
            diasInput ? h("span", { class: "nota" }, o.k === "pago" ? "días" : "días después de su fecha") : null,
            diasInput ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => guardar(o.dias, Number(diasInput.value) || 30, "Días guardados y exclusiones aplicadas.") }, "💾") : null));
      });
      excl.replaceChildren(
        h("h3", {}, "🚫 Exclusiones de la cartera disponible"),
        h("p", { class: "nota", style: { fontSize: ".85rem" } },
          "Los créditos con promesa de pago, pago reciente o en lista negra dejan de ofrecerse (su estatus pasa a «Promesa de pago», «Pago reciente» o «Lista negra»). ",
          "En Grupal sale el grupo completo si un integrante está excluido. Al desactivar una exclusión o cuando vence, los créditos regresan como Disponibles. ",
          "Los créditos que ya estaban apartados en una propuesta no se tocan."),
        ...bloques,
        h("div", { class: "fila", style: { gap: "8px", marginTop: "8px" } },
          h("button", { class: "btn btn-secundario", onclick: async () => {
            try { const r = await ctx.rpc("exclusiones_aplicar"); toast(`Aplicado: fuera ${numero(r.jyp_quitados)} JyP y ${numero(r.grupal_quitados)} integrantes grupales; regresaron ${numero(r.jyp_regresados + r.grupal_regresados)}.`, "bien", 7000); pintarExclusiones(); }
            catch (e) { toast(e.message, "mal", 8000); }
          } }, "🔄 Volver a aplicar"),
          h("button", { class: "btn btn-secundario", onclick: async () => {
            try {
              const filas = await ctx.rpc("exclusiones_fuera");
              if (!filas?.length) { toast("No hay créditos fuera de la base por exclusiones.", ""); return; }
              descargarCSV("creditos_excluidos.csv", [
                { clave: "tipo", titulo: "Tipo" }, { clave: "vreference", titulo: "vReference" }, { clave: "vgroupid", titulo: "vGroupId" },
                { clave: "motivo", titulo: "Motivo" }, { clave: "estatus_original", titulo: "Estatus original" }, { clave: "capital", titulo: "Capital" },
                { clave: "estado", titulo: "Estado" }, { clave: "municipio", titulo: "Municipio" }], filas);
            } catch (e) { toast(e.message, "mal", 8000); }
          } }, "⬇ Créditos excluidos (CSV)")));
    }

    async function cargar(o, archivo) {
      let lect;
      try { lect = extraerExclusiones(await leerTabla(archivo, leerCSV), o.k); }
      catch (e) { toast(`No se pudo leer ${archivo.name}: ${e.message}`, "mal", 8000); return; }
      if (!lect.filas.length) { toast(`${archivo.name}: no se encontró ninguna referencia${o.k === "promesa" ? " con promesa de pago" : ""}.`, "mal", 8000); return; }
      const c = lect.columnas;
      const ok = await confirmar(`Cargar ${o.titulo}`,
        `${archivo.name}\n${numero(lect.leidas)} filas leídas → ${numero(lect.filas.length)} referencias únicas` +
        (lect.descartadas ? ` (${numero(lect.descartadas)} filas no cuentan${o.k === "promesa" ? ": no son promesa" : ""})` : "") +
        `\n\nColumnas: referencia «${c.referencia}»` + (c.fecha ? ` · fecha «${c.fecha}»` : " · sin fecha") + (c.monto ? ` · monto «${c.monto}»` : "") +
        (c.resultado ? ` · resultado «${c.resultado}»` : "") + "\n\nReemplaza la carga anterior de este tipo.", "Cargar");
      if (!ok) return;
      try {
        for (let i = 0; i < lect.filas.length; i += PARTE) {
          await ctx.rpc("exclusiones_cargar", { p_origen: o.k, p_filas: lect.filas.slice(i, i + PARTE), p_reemplazar: i === 0, p_archivo: archivo.name });
        }
        const r = await ctx.rpc("exclusiones_aplicar");
        toast(`${numero(lect.filas.length)} referencias cargadas. Fuera de la base: ${numero(r.jyp_quitados)} JyP y ${numero(r.grupal_quitados)} integrantes grupales; regresaron ${numero(r.jyp_regresados + r.grupal_regresados)}.`, "bien", 9000);
      } catch (e) { toast(e.message, "mal", 9000); }
      pintarExclusiones();
    }

    await pintarExclusiones();
  },
};
