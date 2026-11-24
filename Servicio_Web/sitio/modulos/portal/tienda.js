// ============================================================
// PORTAL DEL COMPRADOR · 🛍️ Tienda
//  · ⭐ Para ti: zonas donde ya compraste, con la cartera disponible hoy ahí (o lo más disponible si es tu primera compra).
//  · 📦 Paquetes listos: armados por Exitus (tipo, zona, mora, tamaño y precio de lista; con tu descuento de lealtad).
//  Sólo cifras agregadas (créditos, capital, mora). Al pedir uno se crea tu solicitud de compra y tu ejecutivo
//  te arma la propuesta; nada se aparta hasta entonces.
// ============================================================
const cent = (v) => `${(Number(v) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} ¢`;

export const tienda = {
  id: "tienda", titulo: "Tienda de cartera", icono: "🛍️", roles: ["comprador"],
  async montar(cont, ctx) {
    const { h, dinero, numero, toast, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./portal.css", import.meta.url).href);
    const caja = h("div", { class: "pt tienda" }, h("div", { class: "nota" }, "Cargando la tienda…"));
    cont.append(caja);
    let t;
    try { t = await ctx.rpc("portal_tienda"); } catch (e) { caja.replaceChildren(h("div", { class: "tarjeta" }, e.message)); return; }

    const zonaTxt = (estados, municipios) => [
      (estados || []).join(", ") || "Todo el país",
      (municipios || []).length ? `${municipios.slice(0, 4).join(", ")}${municipios.length > 4 ? ` y ${municipios.length - 4} más` : ""}` : null,
    ].filter(Boolean).join(" · ");
    const cifras = (d) => h("div", { class: "td-cifras" },
      h("div", {}, h("b", {}, dinero(d?.capital || 0)), h("span", {}, "capital disponible")),
      h("div", {}, h("b", {}, numero(d?.creditos || 0)), h("span", {}, d?.grupos ? `créditos · ${numero(d.grupos)} grupos` : "créditos")),
      h("div", {}, h("b", {}, d?.dias != null ? `${numero(d.dias)} d` : "—"), h("span", {}, "mora promedio")));

    function pedir(boton, datos, titulo, capitalSug) {
      const inCap = h("input", { class: "campo", type: "number", min: 0, step: 10000, value: capitalSug ? Math.round(capitalSug) : "", placeholder: "Capital que te interesa" });
      const inCom = h("input", { class: "campo", placeholder: "Comentario (opcional)" });
      const form = h("div", { class: "td-pedir" },
        h("label", {}, h("span", { class: "etiqueta" }, "Capital aproximado"), inCap),
        h("label", {}, h("span", { class: "etiqueta" }, "Comentario"), inCom),
        h("button", { class: "btn btn-marca", onclick: async (e) => {
          e.target.disabled = true;
          try {
            const id = await ctx.rpc("portal_pedir_paquete", { p: { ...datos, capital: Number(inCap.value) || null, comentario: inCom.value.trim() } });
            form.replaceChildren(h("div", { class: "td-ok" }, `✅ Listo: solicitud #${id} (${titulo}). Tu ejecutivo te armará la propuesta y la verás en «Mis propuestas».`));
          } catch (err) { toast(err.message, "mal", 8000); e.target.disabled = false; }
        } }, "Pedir propuesta"));
      boton.replaceWith(form);
      inCap.focus();
    }

    const tarjetaPaquete = (p) => {
      const btn = h("button", { class: "btn btn-marca", onclick: () => pedir(btn, { paquete_id: p.id }, p.titulo, p.capital) }, "🛒 Lo quiero");
      const precioLista = p.centavos ? Number(p.capital) * Number(p.centavos) : null;
      const precioTuyo = p.centavos_lealtad ? Number(p.capital) * Number(p.centavos_lealtad) : null;
      return h("article", { class: `td-card ${p.destacado ? "destacado" : ""}` },
        h("div", { class: "td-cat" }, p.destacado ? "⭐ Destacado · " : "", p.tipo === "Grupal" ? "Grupal" : "Individual (JyP)"),
        h("h4", {}, p.titulo),
        h("div", { class: "td-zona" }, "📍 ", zonaTxt(p.estados, p.municipios)),
        p.descripcion ? h("p", {}, p.descripcion) : null,
        p.dias_min != null || p.dias_max != null ? h("div", { class: "nota" }, `Mora: ${p.dias_min ?? 0}–${p.dias_max ?? "∞"} días`) : null,
        cifras(p.disponible),
        h("div", { class: "td-precio" },
          h("span", {}, "Paquete de ", h("b", {}, dinero(p.capital)), " de capital"),
          precioLista ? h("span", {}, " · ", precioTuyo && precioTuyo < precioLista
            ? [h("s", {}, dinero(precioLista)), " ", h("b", { class: "td-tuyo" }, `${dinero(precioTuyo)} (${cent(p.centavos_lealtad)} con tu nivel)`)]
            : h("b", {}, `${dinero(precioLista)} (${cent(p.centavos)})`)) : null),
        btn);
    };

    const tarjetaRecomendado = (r, propia) => {
      const disp = (r.disponible?.capital || 0) > 0 ? r.disponible : r.disponible_estado || r.disponible;
      const soloEstado = disp === r.disponible_estado;
      const capSug = Math.min(Number(t.mi_capital_promedio || 0) || Number(disp?.capital || 0), Number(disp?.capital || 0));
      const btn = h("button", { class: "btn btn-marca", onclick: () => pedir(btn,
        { tipo: r.tipo, estado: r.estado, municipios: soloEstado ? [] : (r.municipios || []) }, `${r.tipo} en ${r.estado}`, capSug) }, "🛒 Pedir propuesta");
      return h("article", { class: "td-card recomendado" },
        h("div", { class: "td-cat" }, propia ? "⭐ Como tus compras anteriores" : "🔥 Más disponible hoy", " · ", r.tipo === "Grupal" ? "Grupal" : "Individual (JyP)"),
        h("h4", {}, `${r.tipo === "Grupal" ? "Grupos" : "Créditos"} en ${r.estado}`),
        h("div", { class: "td-zona" }, "📍 ", soloEstado || !(r.municipios || []).length ? `Todo ${r.estado}` : zonaTxt([], r.municipios)),
        propia ? h("div", { class: "nota" }, `Ya compraste aquí ${numero(r.ventas)} vez(es) · ${dinero(r.capital_comprado)} de capital`) : null,
        cifras(disp),
        t.mi_centavos && propia ? h("div", { class: "td-precio" }, "Tu precio de referencia: ", h("b", {}, cent(t.mi_centavos)), " por peso") : null,
        (disp?.capital || 0) > 0 ? btn : h("div", { class: "nota" }, "Por ahora no hay cartera disponible en esta zona."));
    };

    const recs = t.recomendados?.length ? t.recomendados : t.populares || [];
    caja.replaceChildren(
      h("div", { class: "pt-hola" }, h("h2", {}, "🛍️ Tienda de cartera"),
        h("div", { class: "nota" }, "Elige un paquete o una zona y pide tu propuesta. Las cifras son de la cartera disponible hoy; se confirman al armar tu propuesta.",
          t.descuento_centavos > 0 ? ` Tu nivel de lealtad te da ${cent(t.descuento_centavos)} de descuento por peso.` : "")),
      h("h3", { class: "td-sec" }, t.recomendados?.length ? "⭐ Para ti, según tus compras" : "🔥 Lo más disponible"),
      h("div", { class: "td-grid" }, ...recs.map((r) => tarjetaRecomendado(r, !!t.recomendados?.length))),
      h("h3", { class: "td-sec" }, "📦 Paquetes listos"),
      t.paquetes?.length ? h("div", { class: "td-grid" }, ...t.paquetes.map(tarjetaPaquete))
        : h("div", { class: "tarjeta nota" }, "Pronto publicaremos paquetes. Mientras, pide tu propuesta en «Solicitar nueva compra»."));
  },
};
