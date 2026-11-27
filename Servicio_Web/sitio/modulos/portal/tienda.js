// ============================================================
// PORTAL DEL COMPRADOR · 🛍️ Tienda
//  · 🧺 Paquetes de $10,000: generados solos por estado y municipio (JyP y Grupal) con la cartera disponible;
//    el comprador arma su carrito y pide su propuesta. 🔥 Ofertas: estados donde no hemos vendido en los
//    últimos 90 días, a menor precio (más capital por los mismos $10,000).
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
    const cajaAuto = h("div", { class: "td-auto" }, h("div", { class: "nota" }, "Cargando paquetes por estado…"));
    caja.replaceChildren(
      h("div", { class: "pt-hola" }, h("h2", {}, "🛍️ Tienda de cartera"),
        h("div", { class: "nota" }, "Elige un paquete o una zona y pide tu propuesta. Las cifras son de la cartera disponible hoy; se confirman al armar tu propuesta.",
          t.descuento_centavos > 0 ? ` Tu nivel de lealtad te da ${cent(t.descuento_centavos)} de descuento por peso.` : "")),
      h("h3", { class: "td-sec" }, t.recomendados?.length ? "⭐ Para ti, según tus compras" : "🔥 Lo más disponible"),
      h("div", { class: "td-grid" }, ...recs.map((r) => tarjetaRecomendado(r, !!t.recomendados?.length))),
      cajaAuto,
      t.paquetes?.length ? h("h3", { class: "td-sec" }, "📦 Paquetes especiales") : null,
      t.paquetes?.length ? h("div", { class: "td-grid" }, ...t.paquetes.map(tarjetaPaquete)) : null);
    try { paquetesAuto(ctx, cajaAuto, await ctx.rpc("portal_tienda_catalogo")); }
    catch (e) { cajaAuto.replaceChildren(h("div", { class: "nota" }, e.message)); }
  },
};

/** 🧺 Paquetes de $10,000 por estado y municipio + 🔥 ofertas + carrito. */
export function paquetesAuto(ctx, caja, cat) {
  const { h, dinero, numero, toast } = ctx.ui;
  if (!cat || !cat.activo || !(cat.estados || []).length) { caja.replaceChildren(); return; }
  const monto = Number(cat.monto_paquete);
  const capPaq = (e) => Number(e.oferta ? cat.capital_paquete_oferta : cat.capital_paquete);
  const precio = (e) => Number(e.oferta ? cat.centavos_oferta : cat.centavos);
  let tipo = cat.estados.some((e) => e.tipo === "JyP") ? "JyP" : "Grupal";
  let estadoSel = null;
  const carrito = new Map();   // clave tipo|estado|municipio → {tipo, estado, municipio, paquetes, oferta, capital}
  const clave = (t, e, m) => `${t}|${e}|${m}`;

  const segTipo = h("div", { class: "segmentado td-tipo" });
  const selEstado = h("select", { class: "campo", onchange: () => { estadoSel = selEstado.value || null; pintarMunicipios(); } });
  const ofertas = h("div", { class: "td-ofertas" });
  const municipios = h("div", { class: "td-grid td-munis" });
  const cajaCarrito = h("div", { class: "td-carrito", hidden: true });

  function pintarTipo() {
    segTipo.replaceChildren(...[["JyP", "Individual (JyP)"], ["Grupal", "Grupal"]].map(([k, t]) =>
      h("button", { class: tipo === k ? "activo" : "", onclick: () => { tipo = k; estadoSel = null; pintarTipo(); pintarEstados(); } }, t)));
  }
  function pintarEstados() {
    const lista = cat.estados.filter((e) => e.tipo === tipo);
    selEstado.replaceChildren(h("option", { value: "" }, "Elige un estado…"),
      ...lista.map((e) => h("option", { value: e.estado }, `${e.oferta ? "🔥 " : ""}${e.estado} · ${numero(e.paquetes)} paquetes`)));
    selEstado.value = estadoSel || "";
    const of = lista.filter((e) => e.oferta);
    ofertas.replaceChildren(...(of.length ? [
      h("h4", {}, `🔥 Ofertas: ${(cat.centavos_oferta * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} ¢ por peso — cada paquete de ${dinero(monto)} trae ${dinero(cat.capital_paquete_oferta)} de capital`),
      h("div", { class: "td-grid td-of-grid" }, ...of.map((e) => h("button", { class: `td-of ${estadoSel === e.estado ? "activo" : ""}`, onclick: () => { estadoSel = e.estado; selEstado.value = e.estado; pintarMunicipios(); pintarEstados(); } },
        h("span", { class: "td-of-tag" }, "OFERTA"), h("b", {}, e.estado),
        h("span", {}, `${numero(e.paquetes)} paquetes · ${numero(e.municipios.length)} municipios`),
        h("small", {}, `${dinero(e.capital)} disponibles · mora prom. ${e.dias ?? "—"} d`))))] : []));
    pintarMunicipios();
  }
  function pintarMunicipios() {
    const e = cat.estados.find((x) => x.tipo === tipo && x.estado === estadoSel);
    if (!e) { municipios.replaceChildren(h("div", { class: "nota" }, "Elige un estado (o una oferta) para ver sus paquetes por municipio.")); return; }
    municipios.replaceChildren(...e.municipios.map((m) => {
      const k = clave(tipo, e.estado, m.municipio);
      const ya = carrito.get(k)?.paquetes || 0;
      const inp = h("input", { class: "campo", type: "number", min: 1, max: m.paquetes, value: ya || 1, style: { width: "70px" } });
      return h("article", { class: `td-card td-muni ${e.oferta ? "oferta" : ""}` },
        e.oferta ? h("div", { class: "td-cat" }, "🔥 Oferta") : null,
        h("h4", {}, m.municipio), h("div", { class: "td-zona" }, e.estado),
        h("div", { class: "td-cifras" },
          h("div", {}, h("b", {}, numero(m.paquetes)), h("span", {}, "paquetes")),
          h("div", {}, h("b", {}, numero(tipo === "Grupal" ? m.grupos : m.creditos)), h("span", {}, tipo === "Grupal" ? "grupos" : "créditos")),
          h("div", {}, h("b", {}, m.dias != null ? `${numero(m.dias)} d` : "—"), h("span", {}, "mora prom."))),
        h("div", { class: "td-precio" }, `${dinero(monto)} por paquete = ${dinero(capPaq(e))} de capital (${(precio(e) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} ¢)`),
        h("div", { class: "fila td-agregar" }, inp,
          h("button", { class: "btn btn-marca btn-chico", onclick: () => {
            const n = Math.floor(Number(inp.value));
            if (!(n >= 1 && n <= m.paquetes)) { toast(`Puedes pedir de 1 a ${m.paquetes} paquetes en ${m.municipio}.`, "mal"); return; }
            carrito.set(k, { tipo, estado: e.estado, municipio: m.municipio, paquetes: n, oferta: e.oferta, capital: n * capPaq(e) });
            pintarCarrito(); toast(`🧺 ${n} paquete(s) en ${m.municipio} al carrito.`, "bien");
          } }, ya ? "Actualizar" : "🧺 Agregar")));
    }));
  }
  function pintarCarrito() {
    const l = [...carrito.values()];
    cajaCarrito.hidden = !l.length;
    if (!l.length) return;
    const n = l.reduce((s, x) => s + x.paquetes, 0), cap = l.reduce((s, x) => s + x.capital, 0);
    const com = h("input", { class: "campo", placeholder: "Comentario para tu ejecutivo (opcional)" });
    cajaCarrito.replaceChildren(
      h("h4", {}, `🧺 Tu carrito · ${numero(n)} paquete(s) = ${dinero(n * monto)} de compra · ≈ ${dinero(cap)} de capital`),
      h("ul", {}, ...l.map((x) => h("li", {}, `${x.paquetes} × ${dinero(monto)} · ${x.municipio}, ${x.estado} (${x.tipo})${x.oferta ? " 🔥" : ""}`,
        h("button", { class: "btn btn-secundario btn-chico", title: "Quitar", onclick: () => { carrito.delete(clave(x.tipo, x.estado, x.municipio)); pintarCarrito(); pintarMunicipios(); } }, "✖")))),
      com,
      h("button", { class: "btn btn-marca", onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          const r = await ctx.rpc("portal_pedir_carrito", { p_lineas: l.map(({ tipo: t, estado, municipio, paquetes }) => ({ tipo: t, estado, municipio, paquetes })), p_comentario: com.value.trim() });
          carrito.clear();
          cajaCarrito.hidden = false;
          cajaCarrito.replaceChildren(h("div", { class: "td-ok" }, `✅ Listo: solicitud(es) ${(r?.solicitudes || []).map((i) => `#${i}`).join(", ")}. Tu ejecutivo te armará la propuesta y la verás en «Mis propuestas».`));
          pintarMunicipios();
        } catch (e) { toast(e.message, "mal", 9000); ev.target.disabled = false; }
      } }, "Pedir propuesta"));
  }

  caja.replaceChildren(
    h("h3", { class: "td-sec" }, `🧺 Paquetes de ${dinero(monto)} por estado y municipio`),
    h("div", { class: "nota" }, `Cada paquete es de ${dinero(monto)} de compra: a ${(cat.centavos * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })} ¢ por peso trae ${dinero(cat.capital_paquete)} de capital` +
      (cat.descuento_centavos > 0 ? " (ya con tu descuento de lealtad)." : ".") + " Arma tu carrito y pide tu propuesta; los créditos se confirman al armarla."),
    h("div", { class: "fila td-filtros" }, segTipo, selEstado),
    ofertas, municipios, cajaCarrito);
  pintarTipo(); pintarEstados();
}
