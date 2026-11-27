// ============================================================
// PORTAL DEL BROKER (rol «broker»)
//  Inicio · Resumen de cartera · Propuesta de inversión · Mis propuestas · Mis documentos
//  - La propuesta se arma sola: eliges tipo, estado(s) y municipio(s) y se calcula a la tarifa del broker
//    (por defecto $0.14 por peso de capital JyP y $0.26 Grupal).
//  - Sólo un broker con documentación validada puede enviarla; antes puede simular.
// ============================================================
import { bloqueDocsBroker, tablaPropuesta, descargarCreditos, pildora, ESTATUS_BROKER, ESTATUS_DOC, ESTATUS_PROP, nombreDoc, cent } from "./comun.js";

const css = (ctx) => ctx.ui.cargarCSS(new URL("./brokers.css", import.meta.url).href);
let datosInicio = null;
async function miInicio(ctx, fresco = false) {
  if (!datosInicio || fresco) datosInicio = await ctx.rpc("broker_inicio");
  return datosInicio;
}

const PASOS = [["documentos", "Sube tus documentos"], ["revision", "Revisión"], ["validado", "Validado"]];
function pasos(h, estatus) {
  const i = estatus === "validado" ? 2 : estatus === "revision" ? 1 : 0;
  return h("ol", { class: "pt-pasos" }, ...PASOS.map(([, t], k) => h("li", { class: k < i || estatus === "validado" ? "ok" : k === i ? "act" : "" }, t)));
}

const inicio = {
  id: "b_inicio", titulo: "Inicio", roles: ["broker"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast } = ctx.ui;
    let d;
    try { d = await miInicio(ctx, true); } catch (e) { toast(e.message, "mal"); return; }
    const av = d.avance || { tipos: [] };
    const tarjeta = (id, titulo, texto, extra, destacado) =>
      h("a", { class: `pt-menu-item ${destacado ? "destacado" : ""}`, href: `#/${id}` }, h("b", {}, titulo), h("span", {}, texto),
        extra ? h("div", { class: "pt-menu-extra" }, extra) : null);
    const validado = d.estatus === "validado";
    cont.append(h("div", { class: "pt brk" },
      h("div", { class: "pt-hola" }, h("h2", {}, `Hola, ${ctx.perfil.nombre || ctx.perfil.email}`),
        h("div", { class: "nota" }, [d.broker, d.empresa].filter(Boolean).join(" · "))),
      h("div", { class: "tarjeta brk-estatus" },
        h("div", { class: "fila", style: { justifyContent: "space-between", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0 } }, "Validación de tu documentación"), pildora(h, ESTATUS_BROKER, d.estatus)),
        pasos(h, d.estatus),
        d.motivo ? h("div", { class: "brk-motivo" }, d.motivo) : null,
        h("ul", { class: "brk-check" }, ...av.tipos.map((t) => h("li", { class: `s-${t.estatus}` }, h("span", {}, nombreDoc(t.tipo)), pildora(h, ESTATUS_DOC, t.estatus)))),
        h("div", { class: "nota" }, validado ? "Tu alta está validada: ya puedes enviar propuestas de inversión."
          : `${numero(av.aprobados)} de ${numero(av.requeridos)} documentos aprobados. Mientras tanto puedes revisar la cartera y simular propuestas.`)),
      h("div", { class: "pt-menu" },
        tarjeta("b_cartera", "Resumen de cartera", "Saldos de cartera disponible JyP y Grupal por estado y municipio."),
        tarjeta("b_inversion", "Propuesta de inversión", `Elige estados o municipios y se arma sola a ${cent(d.tarifas?.JyP)} JyP y ${cent(d.tarifas?.Grupal)} Grupal por peso de capital.`, null, validado),
        tarjeta("b_propuestas", "Mis propuestas", "Seguimiento de lo que enviaste.",
          `${numero(d.propuestas)} propuesta(s)${d.propuestas_abiertas ? ` · ${numero(d.propuestas_abiertas)} en revisión` : ""}${d.monto_aceptado ? ` · ${dinero(d.monto_aceptado)} aceptado` : ""}`),
        tarjeta("b_documentos", "Mis documentos", "INE, constancia fiscal, comprobante de domicilio, formato de alta y NDA.",
          `${numero(av.subidos)} de ${numero(av.requeridos)} subidos`, !validado))));
  },
};

const cartera = {
  id: "b_cartera", titulo: "Resumen de cartera", roles: ["broker"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast } = ctx.ui;
    cont.append(h("div", { class: "nota" }, "Calculando cartera disponible…"));
    let r;
    try { r = await ctx.rpc("broker_resumen_cartera"); } catch (e) { cont.replaceChildren(h("div", { class: "tarjeta" }, e.message)); return; }
    const tipos = r.tipos || [];
    const tot = tipos.reduce((a, t) => ({ cap: a.cap + Number(t.capital), cr: a.cr + Number(t.creditos), pr: a.pr + Number(t.precio) }), { cap: 0, cr: 0, pr: 0 });
    const kp = (t, v, s, cls = "") => h("div", { class: `kpi ${cls}` }, h("div", { class: "t" }, t), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
    const tablaMora = h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
      h("thead", {}, h("tr", {}, h("th", {}, "Tipo"), h("th", {}, "Días de atraso"), h("th", { class: "num" }, "Créditos"), h("th", { class: "num" }, "Capital"))),
      h("tbody", {}, ...(r.mora || []).map((m) => h("tr", {}, h("td", {}, m.tipo), h("td", {}, m.tramo), h("td", { class: "num" }, numero(m.creditos)), h("td", { class: "num" }, dinero(m.capital)))))));

    // estados: clic abre municipios debajo
    const filtro = h("input", { class: "campo", placeholder: "Buscar estado…", style: { maxWidth: "260px" }, oninput: () => pintar() });
    const cuerpo = h("tbody");
    let abierto = null;
    function pintar() {
      const f = filtro.value.trim().toUpperCase();
      cuerpo.replaceChildren(...(r.estados || []).filter((e) => !f || e.clave.includes(f) || e.estado.toUpperCase().includes(f)).flatMap((e) => {
        const tr = h("tr", { class: `brk-fila ${abierto === e.clave ? "sel" : ""}`, onclick: () => { abierto = abierto === e.clave ? null : e.clave; pintar(); } },
          h("td", {}, h("b", {}, e.estado)), h("td", { class: "num" }, numero(e.jyp.creditos)), h("td", { class: "num" }, dinero(e.jyp.capital)),
          h("td", { class: "num" }, numero(e.grupal.grupos)), h("td", { class: "num" }, numero(e.grupal.creditos)), h("td", { class: "num" }, dinero(e.grupal.capital)),
          h("td", { class: "num" }, dinero(e.capital)), h("td", { class: "num" }, numero((e.municipios || []).length)));
        if (abierto !== e.clave) return [tr];
        const det = h("tr", { class: "brk-det" }, h("td", { colSpan: 8 },
          h("div", { class: "brk-munis" }, ...(e.municipios || []).map((m) => h("div", { class: "brk-muni" },
            h("b", {}, m.municipio || "Sin municipio"), h("span", {}, `JyP ${dinero(m.jyp)} · Grupal ${dinero(m.grupal)} · ${numero(m.creditos)} créditos`)))),
          h("a", { class: "btn btn-primario btn-chico", href: `#/b_inversion?estado=${encodeURIComponent(e.clave)}`, style: { marginTop: "8px" } }, "Armar propuesta con este estado")));
        return [tr, det];
      }));
    }
    pintar();
    cont.replaceChildren(h("div", { class: "pt brk" },
      h("div", { class: "pt-tit" }, h("h2", {}, "Resumen de cartera disponible"), h("span", { class: "nota" }, "Créditos JyP y grupos completos libres para venta.")),
      h("div", { class: "kpis" },
        kp("Capital disponible", dinero(tot.cap), `${numero(tot.cr)} créditos`, "destacado"),
        ...tipos.map((t) => kp(t.tipo === "JyP" ? "JyP (individual)" : "Grupal", dinero(t.capital),
          `${numero(t.creditos)} créditos${t.tipo === "Grupal" ? ` · ${numero(t.grupos)} grupos` : ""} · ${numero(t.estados)} estados · mora prom. ${numero(t.dias)} d`)),
        kp("Inversión a tarifa", dinero(tot.pr), `JyP ${cent(r.tarifas?.JyP)} · Grupal ${cent(r.tarifas?.Grupal)} por peso`)),
      h("div", { class: "tarjeta" }, h("h3", {}, "Por días de atraso"), tablaMora),
      h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { justifyContent: "space-between", flexWrap: "wrap" } }, h("h3", { style: { margin: 0 } }, "Por estado"), filtro),
        h("div", { class: "nota" }, "Da clic en un estado para ver sus municipios."),
        h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
          h("thead", {}, h("tr", {}, ...["Estado", "JyP créditos", "JyP capital", "Grupos", "Grupal créditos", "Grupal capital", "Capital total", "Municipios"]
            .map((t, i) => h("th", { class: i ? "num" : "" }, t)))), cuerpo)))));
  },
};

const inversion = {
  id: "b_inversion", titulo: "Propuesta de inversión", roles: ["broker"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, toast, confirmar } = ctx.ui;
    cont.append(h("div", { class: "nota" }, "Cargando cartera…"));
    let r, d;
    try { [r, d] = await Promise.all([ctx.rpc("broker_resumen_cartera"), miInicio(ctx, true)]); }
    catch (e) { cont.replaceChildren(h("div", { class: "tarjeta" }, e.message)); return; }
    const validado = d.estatus === "validado";
    const tipos = new Set(["JyP", "Grupal"]);
    const estados = new Set();
    const munis = new Map();       // estado → Set(municipio)
    const pre = new URLSearchParams((location.hash.split("?")[1] || "")).get("estado");
    if (pre && (r.estados || []).some((e) => e.clave === pre)) estados.add(pre);

    const chkTipo = (t, txt) => {
      const c = h("input", { type: "checkbox", checked: true, onchange: () => { c.checked ? tipos.add(t) : tipos.delete(t); pintarEstados(); calcular(); } });
      return h("label", { class: "brk-tipo" }, c, ` ${txt} · ${cent(r.tarifas?.[t])} por peso`);
    };
    const filtro = h("input", { class: "campo", placeholder: "Buscar estado…", oninput: () => pintarEstados() });
    const listaEst = h("div", { class: "brk-estados" });
    const listaMun = h("div", { class: "pt-munis-sel" });
    const tope = h("input", { class: "campo", type: "number", min: 0, step: 1000, placeholder: "Sin tope", style: { maxWidth: "200px" }, oninput: () => calcular() });
    const comentario = h("textarea", { class: "campo", rows: 2, placeholder: "Comentario para tu ejecutivo (opcional)" });
    const resultado = h("div", { class: "brk-resultado" }, h("div", { class: "nota" }, "Elige al menos un estado para ver la propuesta."));
    const btnEnviar = h("button", { class: "btn btn-marca", disabled: true, onclick: enviar }, "Enviar propuesta");
    let ultimo = null;

    const capEstado = (e) => (tipos.has("JyP") ? Number(e.jyp.capital) : 0) + (tipos.has("Grupal") ? Number(e.grupal.capital) : 0);
    function pintarEstados() {
      const f = filtro.value.trim().toUpperCase();
      listaEst.replaceChildren(...(r.estados || []).filter((e) => capEstado(e) > 0 && (!f || e.estado.toUpperCase().includes(f) || estados.has(e.clave))).map((e) => {
        const c = h("input", { type: "checkbox", checked: estados.has(e.clave), onchange: () => {
          c.checked ? estados.add(e.clave) : (estados.delete(e.clave), munis.delete(e.clave));
          pintarEstados(); pintarMunis(); calcular();
        } });
        return h("label", { class: `brk-est ${estados.has(e.clave) ? "sel" : ""}` }, c, h("span", {}, e.estado), h("small", {}, dinero(capEstado(e))));
      }));
    }
    function pintarMunis() {
      listaMun.replaceChildren(...(r.estados || []).filter((e) => estados.has(e.clave)).map((e) => {
        const sel = munis.get(e.clave) || new Set();
        return h("div", { class: "pt-muni-bloque" },
          h("div", { class: "pt-muni-enc" }, h("b", {}, e.estado), h("span", { class: "nota" }, sel.size ? `${sel.size} municipio(s)` : "Todo el estado")),
          h("div", { class: "pt-chips" }, ...(e.municipios || []).filter((m) => (tipos.has("JyP") ? m.jyp : 0) + (tipos.has("Grupal") ? m.grupal : 0) > 0).map((m) => {
            const clave = `${e.clave}|${m.clave}`;
            return h("button", { class: `pt-chip ${sel.has(clave) ? "sel" : ""}`, title: `JyP ${dinero(m.jyp)} · Grupal ${dinero(m.grupal)}`, onclick: () => {
              sel.has(clave) ? sel.delete(clave) : sel.add(clave);
              munis.set(e.clave, sel); pintarMunis(); calcular();
            } }, m.municipio || "Sin municipio");
          })));
      }));
    }
    const filtros = () => ({ tipos: [...tipos], estados: [...estados], municipios: [...munis.values()].flatMap((s) => [...s]), tope: Number(tope.value) || null });

    let espera = null, turno = 0;
    function calcular() {
      clearTimeout(espera);
      btnEnviar.disabled = true;
      if (!estados.size || !tipos.size) { ultimo = null; resultado.replaceChildren(h("div", { class: "nota" }, !tipos.size ? "Elige JyP, Grupal o ambos." : "Elige al menos un estado para ver la propuesta.")); return; }
      espera = setTimeout(async () => {
        const t = ++turno;
        resultado.replaceChildren(h("div", { class: "nota" }, "Calculando…"));
        try {
          const x = await ctx.rpc("broker_simular", { p: filtros() });
          if (t !== turno) return;
          ultimo = x;
          resultado.replaceChildren(Number(x.creditos) ? tablaPropuesta(ctx, x) : h("div", { class: "nota" }, "No hay cartera disponible con esos filtros."));
          btnEnviar.disabled = !validado || !Number(x.creditos);
        } catch (e) { if (t === turno) resultado.replaceChildren(h("div", { class: "nota" }, e.message)); }
      }, 350);
    }

    async function enviar() {
      if (!ultimo) return;
      if (!(await confirmar("Enviar propuesta de inversión", `${numero(ultimo.creditos)} créditos · capital ${dinero(ultimo.capital)}\nInversión: ${dinero(ultimo.monto)}\n\n¿Enviarla a revisión?`, "Enviar"))) return;
      btnEnviar.disabled = true;
      try {
        const folio = await ctx.rpc("broker_generar_propuesta", { p: filtros(), p_comentario: comentario.value });
        toast(`Propuesta ${folio} enviada. Te avisaremos la respuesta.`, "bien", 7000);
        location.hash = "#/b_propuestas";
      } catch (e) { toast(e.message, "mal", 8000); btnEnviar.disabled = false; }
    }

    pintarEstados(); pintarMunis();
    cont.replaceChildren(h("div", { class: "pt brk" },
      h("div", { class: "pt-tit" }, h("h2", {}, "Propuesta de inversión"),
        h("span", { class: "nota" }, "Se arma sola con la cartera disponible de los estados y municipios que elijas.")),
      validado ? null : h("div", { class: "tarjeta brk-aviso" }, "Tu documentación aún no está validada: puedes simular, pero el envío se habilita cuando se apruebe. ",
        h("a", { href: "#/b_documentos" }, "Ver mis documentos")),
      h("div", { class: "brk-arma" },
        h("div", { class: "tarjeta" },
          h("h3", {}, "1. Tipo de cartera"), h("div", { class: "fila", style: { justifyContent: "flex-start", gap: "16px", flexWrap: "wrap" } },
            chkTipo("JyP", "JyP (individual)"), chkTipo("Grupal", "Grupal (grupo completo)")),
          h("h3", { class: "pt-paso" }, "2. Estado(s)"), filtro, listaEst,
          h("h3", { class: "pt-paso" }, "3. Municipio(s) (opcional)"), h("div", { class: "nota" }, "Sin municipios marcados entra todo el estado."), listaMun,
          h("h3", { class: "pt-paso" }, "4. Tope de inversión (opcional)"),
          h("div", { class: "nota" }, "Con tope se toman primero los créditos de menor atraso hasta no pasar el monto."), tope),
        h("div", { class: "tarjeta" }, h("h3", {}, "Tu propuesta"), resultado,
          h("div", { class: "brk-enviar" }, comentario, btnEnviar)))));
    calcular();
  },
};

const propuestas = {
  id: "b_propuestas", titulo: "Mis propuestas", roles: ["broker"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, dinero, numero, fecha, toast, confirmar } = ctx.ui;
    let lista;
    try { lista = (await ctx.rpc("broker_mis_propuestas")) || []; } catch (e) { toast(e.message, "mal"); return; }
    const caja = h("div", { class: "pt-lista" });
    function pintar() {
      caja.replaceChildren(...(lista.length ? lista.map((p) => {
        const det = h("div", { class: "pt-det" });
        return h("div", { class: `tarjeta pt-prop s-${p.estatus === "aceptada" ? "ok" : p.estatus === "enviada" ? "pend" : "gris"}` },
          h("div", { class: "pt-prop-enc" },
            h("div", {}, h("b", { class: "pt-folio" }, p.folio), " ", pildora(h, ESTATUS_PROP, p.estatus), h("div", { class: "nota" }, fecha(p.creado))),
            h("div", { class: "fila pt-acc" },
              h("button", { class: "btn btn-secundario btn-chico", onclick: () => { det.childElementCount ? det.replaceChildren() : det.replaceChildren(tablaPropuesta(ctx, p.resumen)); } }, "Detalle"),
              h("button", { class: "btn btn-secundario btn-chico", onclick: () => descargarCreditos(ctx, p) }, "Descargar créditos"),
              p.estatus === "enviada" ? h("button", { class: "btn btn-secundario btn-chico", onclick: async () => {
                if (!(await confirmar("Cancelar propuesta", `¿Cancelar ${p.folio}?`, "Cancelar propuesta"))) return;
                try { await ctx.rpc("broker_cancelar_propuesta", { p_id: p.id }); p.estatus = "cancelada"; pintar(); } catch (e) { toast(e.message, "mal"); }
              } }, "Cancelar") : null)),
          h("div", { class: "pt-datos" },
            h("div", {}, h("small", {}, "Inversión"), h("b", {}, dinero(p.monto))),
            h("div", {}, h("small", {}, "Capital"), dinero(p.capital)),
            h("div", {}, h("small", {}, "Créditos"), numero(p.creditos)),
            h("div", {}, h("small", {}, "Grupos"), numero(p.grupos)),
            h("div", { class: "ancho" }, h("small", {}, "Estados"), (p.filtros?.estados || []).map((e) => e.charAt(0) + e.slice(1).toLowerCase()).join(", "))),
          p.respuesta ? h("div", { class: "brk-motivo" }, `Respuesta: ${p.respuesta}`) : null,
          det);
      }) : [h("div", { class: "tarjeta" }, "Aún no envías propuestas. ", h("a", { href: "#/b_inversion" }, "Armar una propuesta de inversión"))]));
    }
    pintar();
    cont.append(h("div", { class: "pt brk" }, h("div", { class: "pt-tit" }, h("h2", {}, "Mis propuestas de inversión")), caja));
  },
};

const documentos = {
  id: "b_documentos", titulo: "Mis documentos", roles: ["broker"],
  async montar(cont, ctx) {
    css(ctx);
    const { h, toast } = ctx.ui;
    let d;
    try { d = await miInicio(ctx, true); } catch (e) { toast(e.message, "mal"); return; }
    const cab = h("div", {});
    const pintarCab = (x) => cab.replaceChildren(h("div", { class: "fila", style: { justifyContent: "space-between", flexWrap: "wrap" } },
      h("h2", { style: { margin: 0 } }, "Mis documentos"), pildora(h, ESTATUS_BROKER, x.estatus)), pasos(h, x.estatus),
      x.motivo ? h("div", { class: "brk-motivo" }, x.motivo) : null);
    pintarCab(d);
    cont.append(h("div", { class: "pt brk" }, cab,
      h("div", { class: "nota" }, "Son los mismos documentos que pedimos a los compradores. PDF, foto, Word o Excel, máx. 10 MB. Al subir todos pasa a revisión; si alguno se rechaza verás el motivo y podrás subirlo de nuevo."),
      h("div", { class: "tarjeta" }, bloqueDocsBroker(ctx, { brokerId: d.id, modo: "broker", alCambiar: async () => pintarCab(await miInicio(ctx, true)) }))));
  },
};

export const modulos = [inicio, cartera, inversion, propuestas, documentos];
