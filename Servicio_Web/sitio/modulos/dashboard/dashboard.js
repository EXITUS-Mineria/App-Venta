// ============================================================
// MÓDULO: Dashboard de Venta de Cartera (en vivo desde el Funnel en Supabase)
// Réplica del Dashboard_Venta_Cartera.html: 1) Resultado del mes  2) Avance por zona, vendedor y tipo
// 3) Candados para comisión  4) Comparativa mensual  + detalle con búsqueda y CSV.
// Reglas: metas y candados = Estatus Venta Vendida/Vendido; comparativa = sólo Vendida;
// propuestas = Estatus que empieza con "Propuest". Avance esperado por días hábiles (L-V).
// El VENDEDOR sólo ve sus ventas (dashboard_datos usa funnel_puede_ver) y su propia meta.
// Metas en la tabla dashboard_metas; las edita validador/admin desde «⚙ Metas».
// ============================================================
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const ZONAS = ["Centro", "Norte", "Sur"];

export const norm = (t) => String(t ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const div = (a, b) => (b ? a / b : 0);
const pct = (v, signo = false) => `${signo && v > 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;
export const esVendido = (r) => ["vendida", "vendido"].includes(norm(r.estatus_venta));
export const esVendida = (r) => norm(r.estatus_venta) === "vendida";
export const esPropuesta = (r) => norm(r.estatus_venta).startsWith("propuest");
const nombreCorto = (n) => String(n || "").trim().split(/\s+/).slice(0, 2).join(" ");
const sumar = (regs) => regs.reduce((a, r) => a + Number(r.monto_venta || 0), 0);

/** Días hábiles (lunes a viernes) del mes; si el mes ya pasó cuenta todos como transcurridos. */
export function diasHabiles(anio, mes, hoy = new Date()) {
  const ultimo = new Date(anio, mes, 0).getDate();
  const esActual = hoy.getFullYear() === anio && hoy.getMonth() + 1 === mes;
  const pasado = anio < hoy.getFullYear() || (anio === hoy.getFullYear() && mes < hoy.getMonth() + 1);
  let total = 0, transcurridos = 0;
  for (let d = 1; d <= ultimo; d++) {
    const ds = new Date(anio, mes - 1, d).getDay();
    if (ds !== 0 && ds !== 6) { total++; if (pasado || (esActual && d <= hoy.getDate())) transcurridos++; }
  }
  return { total, transcurridos, restantes: Math.max(total - transcurridos, 0) };
}

/** Metas de vendedor: claves «vendedor:<parte del nombre>». Devuelve la meta que aplica a un nombre. */
export function metaDeVendedor(metas, nombre) {
  const n = norm(nombre);
  for (const [k, v] of Object.entries(metas)) {
    if (k.startsWith("vendedor:") && n.includes(norm(k.slice(9)))) return { clave: k.slice(9), meta: v, principal: true };
  }
  return { clave: null, meta: metas.complementario ?? 50000, principal: false };
}

export default {
  id: "dashboard",
  titulo: "Dashboard",
  icono: "📊",
  roles: ["vendedor", "validador", "auxiliar", "control_doc", "admin"],

  async montar(cont, ctx) {
    const { h, dinero, numero, toast, descargarCSV, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./dashboard.css", import.meta.url).href);
    const mdp = (v) => { const n = Number(v || 0); return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)} M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)} mil` : dinero(n); };
    const soloPropio = ctx.perfil.rol === "vendedor";
    const hoy = new Date();
    let datos = [], metas = {}, anioCargado = null;

    // ---------- filtros ----------
    const opt = (v, t) => h("option", { value: v }, t ?? v);
    const selAnio = h("select", { class: "campo", onchange: () => cargar() },
      ...[hoy.getFullYear(), hoy.getFullYear() - 1].map((a) => opt(String(a))));
    const selMes = h("select", { class: "campo", onchange: () => pintar() }, ...MESES.map((m, i) => opt(String(i + 1), m)));
    selMes.value = String(hoy.getMonth() + 1);
    const selZona = h("select", { class: "campo", onchange: () => pintar() }, opt("", "Todas"), ...ZONAS.concat("Sin zona").map((z) => opt(z)));
    const selTipo = h("select", { class: "campo", onchange: () => pintar() }, opt("", "Todos"), ...["Grupal", "JyP", "Dual"].map((t) => opt(t)));
    const selVend = h("select", { class: "campo", onchange: () => pintar() }, opt("", "Todos"));
    const selEst = h("select", { class: "campo", onchange: () => pintar() }, opt("", "Todos"), ...["Vendida", "Propuesta", "Cancelada"].map((t) => opt(t)));
    const filtro = (t, el) => h("div", { class: "dsh-filtro" }, h("label", {}, t), el);
    const btnMetas = ctx.esAdmin ? h("button", { class: "btn btn-secundario", onclick: () => panelMetas() }, "⚙ Metas") : null;

    const cab = h("div", { class: "dsh-cab" });
    const k = {};
    const kpiEl = (id, titulo, principal) => {
      k[id] = { v: h("div", { class: "dsh-kv" }), s: h("div", { class: "dsh-ks" }) };
      const extra = principal ? [h("div", { class: "dsh-track" }, k[id].bar = h("span"), k[id].marca = h("i")), k[id].esp = h("div", { class: "dsh-esp" })] : [];
      return h("div", { class: `dsh-kpi${principal ? " principal" : ""}` }, h("div", { class: "dsh-kt" }, titulo),
        principal ? h("div", { class: "dsh-kfila" }, k[id].v, k[id].s) : k[id].v, principal ? null : k[id].s, ...extra);
    };
    const lectura = h("div", { class: "dsh-lectura" });
    const cajaZonas = h("div", { class: "dsh-cbody" }), cajaVend = h("div", { class: "dsh-cbody" }), cajaTipos = h("div", { class: "dsh-cbody" });
    const tZonas = h("div", { class: "dsh-tabla" }), tComp = h("div", { class: "dsh-tabla lim" }), tProp = h("div", { class: "dsh-tabla lim" });
    const hist = { kpis: h("div", { class: "dsh-mini-grid" }), barras: h("div", { class: "dsh-barras" }), tabla: h("div", { class: "dsh-tabla" }) };
    const buscador = h("input", { class: "campo dsh-buscar", placeholder: "🔎 Buscar folio, comprador, estado…", oninput: () => pintarDetalle() });
    const tDet = h("div", { class: "dsh-tabla det" });
    const lblDet = h("span", { class: "nota" });
    const seccion = (n, t, d) => h("div", { class: "dsh-sec" }, h("span", { class: "dsh-num" }, n), h("h2", {}, t), h("span", { class: "nota" }, d));
    const tarjeta = (t, cuerpo, sub) => h("div", { class: "dsh-card" }, h("div", { class: "dsh-ctit" }, t, sub ? h("small", {}, sub) : null), cuerpo);
    const panelMetasEl = h("div", { class: "dsh-metas", hidden: true });

    cont.append(h("div", { class: "dsh" },
      cab,
      h("div", { class: "dsh-filtros" }, filtro("AÑO", selAnio), filtro("MES", selMes), filtro("ZONA", selZona), filtro("TIPO", selTipo),
        soloPropio ? null : filtro("VENDEDOR", selVend), filtro("ESTATUS", selEst),
        h("div", { class: "dsh-acc" }, h("button", { class: "btn btn-secundario", onclick: () => limpiar() }, "✕ Limpiar"),
          h("button", { class: "btn btn-secundario", onclick: () => cargar() }, "⟳"), btnMetas)),
      panelMetasEl,
      seccion(1, soloPropio ? "Mi resultado del mes" : "Resultado del mes", "Vendida contra la meta"),
      h("div", { class: "dsh-kpis" }, kpiEl("gen", "🎯 AVANCE DE LA META", true), kpiEl("ven", "💰 VENDIDO"), kpiEl("fal", "⏳ FALTA PARA LA META"),
        kpiEl("pro", "📈 PROYECCIÓN AL CIERRE"), kpiEl("prop", "📝 EN PROPUESTA")),
      lectura,
      seccion(2, soloPropio ? "Mi venta por zona y tipo" : "Avance por zona y vendedor", "La línea vertical marca el avance esperado a hoy"),
      h("div", { class: "dsh-g3" }, tarjeta("🗺️ Zonas", cajaZonas), tarjeta(soloPropio ? "👤 Mi meta" : "👤 Vendedores principales", cajaVend),
        tarjeta("📦 Tipo de cartera", cajaTipos)),
      seccion(3, "Candados para comisión", "Qué está liberado y cuánto falta"),
      h("div", { class: "dsh-g2" }, tarjeta(soloPropio ? "🔒 Mi candado" : "🔒 Candados por zona", tZonas),
        soloPropio ? null : tarjeta("👥 Vendedores complementarios", tComp, "Meta individual")),
      h("div", { style: { marginTop: "12px" } }, tarjeta("📝 Propuestas por vendedor", tProp, "Pendiente de convertirse en venta")),
      seccion(4, "Comparativa vs meses anteriores", "Sólo Estatus Venta = Vendida"),
      h("div", { class: "dsh-card" }, hist.kpis, h("div", { class: "dsh-hgrid" }, hist.barras, hist.tabla)),
      h("details", { class: "dsh-det" }, h("summary", {}, "📋 Detalle de registros del mes ", lblDet),
        h("div", { class: "dsh-card" }, h("div", { class: "dsh-detacc" }, buscador,
          h("button", { class: "btn btn-primario", onclick: () => exportar() }, "⬇ Exportar CSV")), tDet))));

    // ---------- datos ----------
    async function cargar() {
      try {
        const anio = Number(selAnio.value);
        const [filas, ms] = await Promise.all([ctx.rpc("dashboard_datos", { p_anio: anio }), ctx.rpc("dashboard_metas_lista")]);
        datos = (filas || []).map((r) => ({ ...r, monto_venta: Number(r.monto_venta || 0), capital: Number(r.capital || 0), mes: Number(r.mes || 0) }));
        metas = Object.fromEntries((ms || []).map((m) => [m.clave, Number(m.valor)]));
        anioCargado = anio;
        const vendedores = [...new Set(datos.map((r) => r.vendedor).filter(Boolean))].sort();
        const prev = selVend.value;
        selVend.replaceChildren(opt("", "Todos"), ...vendedores.map((v) => opt(v)));
        selVend.value = vendedores.includes(prev) ? prev : "";
        pintar();
      } catch (e) { toast(e.message, "mal", 8000); }
    }
    function limpiar() { selZona.value = selTipo.value = selVend.value = selEst.value = ""; buscador.value = ""; selMes.value = String(hoy.getMonth() + 1); pintar(); }

    const pasa = (r, conEstatus = true) => (!selZona.value || r.zona === selZona.value) && (!selTipo.value || r.tipo === selTipo.value) &&
      (!selVend.value || r.vendedor === selVend.value) && (!conEstatus || !selEst.value || r.estatus_venta === selEst.value);
    const delMes = () => datos.filter((r) => r.mes === Number(selMes.value) && pasa(r));

    // meta que aplica a la vista: propia (vendedor), del vendedor filtrado, o la general
    function metaVista() {
      if (soloPropio) return { ...metaDeVendedor(metas, ctx.perfil.nombre || ctx.perfil.email), titulo: "tu meta" };
      if (selVend.value) return { ...metaDeVendedor(metas, selVend.value), titulo: `meta de ${nombreCorto(selVend.value)}` };
      if (selZona.value && metas[`zona:${selZona.value}`]) return { meta: metas[`zona:${selZona.value}`], titulo: `meta zona ${selZona.value}` };
      if (selTipo.value === "Grupal") return { meta: metas.grupal ?? 0, titulo: "meta Grupal" };
      if (selTipo.value === "JyP") return { meta: metas.jyp ?? 0, titulo: "meta JyP" };
      return { meta: metas.general ?? 0, titulo: "meta general" };
    }

    // ---------- pintar ----------
    function pintar() {
      const anio = anioCargado || Number(selAnio.value), mes = Number(selMes.value);
      const D = diasHabiles(anio, mes, hoy);
      const ESP = Math.min(div(D.transcurridos, D.total) * 100, 100);
      const regs = delMes();
      const vendidos = regs.filter(esVendido), propuestas = regs.filter(esPropuesta);
      const mv = metaVista(), meta = Number(mv.meta || 0);
      const venta = sumar(vendidos), montoProp = sumar(propuestas);
      const avance = div(venta, meta) * 100, falta = Math.max(meta - venta, 0);
      const proy = div(venta, D.transcurridos) * D.total, avProy = div(proy, meta) * 100;
      const req = D.restantes > 0 ? falta / D.restantes : falta;
      const espMonto = meta * ESP / 100, brecha = venta - espMonto;
      const color = (p, e = ESP) => (p >= 100 || p >= e ? "var(--bien)" : p >= e * 0.8 ? "var(--alerta)" : "var(--rojo)");
      const clase = (p, e = ESP) => (p >= 100 || p >= e ? "verde" : p >= e * 0.8 ? "ambar" : "rojo");

      cab.replaceChildren(h("div", {}, h("h1", {}, soloPropio ? `📊 Mi venta de cartera` : "📊 Venta de cartera"),
        h("p", {}, "Reporte de ", h("b", {}, `${MESES[mes - 1]} ${anio}`), ` · día hábil ${D.transcurridos} de ${D.total}`,
          soloPropio ? ` · ${ctx.perfil.nombre || ""}` : "")),
        h("div", { class: "dsh-upd" }, h("small", {}, "📅 ACTUALIZADO"), h("b", {}, hoy.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" }))));

      k.gen.v.textContent = meta ? pct(avance) : "—"; k.gen.v.className = `dsh-kv ${clase(avance)}`;
      k.gen.s.replaceChildren(dinero(venta), h("br"), `de ${dinero(meta)} (${mv.titulo})`);
      k.gen.bar.style.width = `${Math.min(avance, 100)}%`; k.gen.bar.style.background = color(avance);
      k.gen.marca.style.left = `calc(${ESP}% - 1px)`;
      k.gen.esp.textContent = `Esperado a hoy: ${pct(ESP)} (${mdp(espMonto)}) · ${brecha >= 0 ? `adelante ${mdp(brecha)}` : `atrás ${mdp(-brecha)}`}`;
      k.ven.v.textContent = mdp(venta); k.ven.s.textContent = `${numero(vendidos.length)} operaciones`;
      k.fal.v.textContent = falta > 0 ? mdp(falta) : "✔ Cumplida"; k.fal.v.className = `dsh-kv ${falta > 0 ? "rojo" : "verde"}`;
      k.fal.s.textContent = falta > 0 ? `${mdp(req)} por día hábil (${D.restantes} restantes)` : `Excedente ${mdp(venta - meta)}`;
      k.pro.v.textContent = mdp(proy); k.pro.v.className = `dsh-kv ${clase(avProy, 100)}`; k.pro.s.textContent = `${pct(avProy)} de la meta al ritmo actual`;
      k.prop.v.textContent = mdp(montoProp); k.prop.v.className = "dsh-kv ambar"; k.prop.s.textContent = `${numero(propuestas.length)} propuestas abiertas`;
      lectura.innerHTML = "";
      lectura.append(...(falta <= 0
        ? [soloPropio ? "💡 Tu meta" : "💡 La ", soloPropio ? "" : h("b", {}, mv.titulo), " de ", h("b", {}, dinero(meta)), " ya está ", h("b", {}, "cumplida"), " con ", h("b", {}, dinero(venta)),
          ". Quedan ", h("b", {}, dinero(montoProp)), " en propuesta."]
        : ["💡 Llevas ", h("b", {}, dinero(venta)), ` (${pct(avance)} de ${soloPropio ? "tu meta" : "la " + mv.titulo}) y vas `,
          h("b", {}, brecha >= 0 ? "adelante del ritmo" : `${dinero(-brecha)} atrás del ritmo`), ". Para cumplir faltan ", h("b", {}, dinero(falta)),
          ": ", h("b", {}, dinero(req)), " por día hábil. Hay ", h("b", {}, dinero(montoProp)), " en propuesta",
          montoProp >= falta ? ", suficiente para cerrar la meta si se convierte." : ", que no alcanza a cubrir lo que falta."]));

      // 2. avance
      const fila = (nombre, v, m, extra = "") => {
        const av = m ? div(v, m) * 100 : null, c = av === null ? "var(--pizarra)" : color(av);
        return h("div", { class: "dsh-prog" },
          h("div", { class: "dsh-ptop" }, h("span", { class: "dsh-pnom" }, nombre), h("span", { class: "dsh-ppct", style: { color: c } }, av === null ? mdp(v) : pct(av))),
          h("div", { class: "dsh-track" }, h("span", { style: { width: `${Math.min(av ?? div(v, venta) * 100, 100)}%`, background: c } }),
            av === null ? null : h("i", { style: { left: `calc(${ESP}% - 1px)` } })),
          h("div", { class: "dsh-psub" }, h("span", {}, av === null ? `${pct(div(v, venta) * 100)} de lo vendido${extra}` : `${mdp(v)} de ${mdp(m)}${extra}`),
            h("span", {}, av === null ? "" : (m - v > 0 ? `Faltan ${mdp(m - v)}` : "✔ Cumplida"))));
      };
      const conMeta = !soloPropio;
      cajaZonas.replaceChildren(...ZONAS.map((z) => fila(z, sumar(vendidos.filter((r) => r.zona === z)), conMeta ? metas[`zona:${z}`] : null)));
      const principales = Object.keys(metas).filter((x) => x.startsWith("vendedor:")).map((x) => x.slice(9));
      cajaVend.replaceChildren(...(soloPropio
        ? [fila(nombreCorto(ctx.perfil.nombre) || "Mi venta", venta, meta, mv.principal ? " · meta principal" : " · meta complementaria")]
        : principales.map((p) => fila(p, sumar(vendidos.filter((r) => norm(r.vendedor).includes(norm(p)))), metas[`vendedor:${p}`]))));
      cajaTipos.replaceChildren(fila("Grupal", sumar(vendidos.filter((r) => r.tipo === "Grupal")), conMeta ? metas.grupal : null),
        fila("JyP", sumar(vendidos.filter((r) => r.tipo === "JyP")), conMeta ? metas.jyp : null),
        ...(vendidos.some((r) => r.tipo === "Dual") ? [fila("Dual", sumar(vendidos.filter((r) => r.tipo === "Dual")), null)] : []));

      // 3. candados
      const candado = (av) => h("span", { class: `dsh-candado ${av >= 100 ? "abierto" : "cerrado"}` }, av >= 100 ? "🔓 Liberado" : "🔒 Pendiente");
      const tablaH = (cols, filas, pie) => h("table", {}, h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", {}, c)))),
        h("tbody", {}, ...(filas.length ? filas : [h("tr", {}, h("td", { colspan: cols.length, class: "vacio" }, "Sin datos."))])), pie ? h("tfoot", {}, pie) : null);
      const celdaAv = (av) => h("td", { class: clase(av, 100), style: { fontWeight: 700 } }, pct(av));
      if (soloPropio) {
        tZonas.replaceChildren(tablaH(["Meta", "Vendido", "Avance", "Falta", "Candado"],
          [h("tr", {}, h("td", {}, dinero(meta)), h("td", {}, dinero(venta)), celdaAv(avance), h("td", {}, dinero(falta)), h("td", { class: "centro" }, candado(avance)))]));
      } else {
        let tm = 0, tv = 0;
        const filasZ = ZONAS.map((z) => { const m = Number(metas[`zona:${z}`] || 0), v = sumar(vendidos.filter((r) => r.zona === z)); tm += m; tv += v;
          const av = div(v, m) * 100;
          return h("tr", {}, h("td", {}, z), h("td", {}, dinero(m)), h("td", {}, dinero(v)), celdaAv(av), h("td", {}, dinero(Math.max(m - v, 0))), h("td", { class: "centro" }, candado(av))); });
        const sinZona = sumar(vendidos.filter((r) => !ZONAS.includes(r.zona)));
        if (sinZona > 0) { tv += sinZona; filasZ.push(h("tr", {}, h("td", { class: "tenue" }, "Sin zona"), h("td", {}, "-"), h("td", {}, dinero(sinZona)), h("td", {}, "-"), h("td", {}, "-"), h("td"))); }
        tZonas.replaceChildren(tablaH(["Zona", "Meta", "Vendido", "Avance", "Falta", "Candado"], filasZ,
          h("tr", {}, h("td", {}, "TOTAL"), h("td", {}, dinero(tm)), h("td", {}, dinero(tv)), h("td", {}, pct(div(tv, tm) * 100)), h("td", {}, dinero(Math.max(tm - tv, 0))), h("td"))));
      }
      const metaComp = Number(metas.complementario ?? 50000);
      const porVend = {};
      vendidos.forEach((r) => { if (!metaDeVendedor(metas, r.vendedor).principal) porVend[r.vendedor] = (porVend[r.vendedor] || 0) + r.monto_venta; });
      tComp.replaceChildren(tablaH(["Vendedor", "Vendido", "Avance", "Falta", "Candado"],
        Object.entries(porVend).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([v, s]) => { const av = div(s, metaComp) * 100;
          return h("tr", {}, h("td", {}, nombreCorto(v)), h("td", {}, dinero(s)), celdaAv(av), h("td", {}, dinero(Math.max(metaComp - s, 0))), h("td", { class: "centro" }, candado(av))); })));
      const pv = {};
      propuestas.forEach((r) => { (pv[r.vendedor] ||= { n: 0, m: 0 }); pv[r.vendedor].n++; pv[r.vendedor].m += r.monto_venta; });
      const fp = Object.entries(pv).sort((a, b) => b[1].m - a[1].m);
      const tn = fp.reduce((a, [, x]) => a + x.n, 0), tmn = fp.reduce((a, [, x]) => a + x.m, 0);
      tProp.replaceChildren(tablaH(["Vendedor", "Propuestas", "Monto propuesto", "Ticket promedio"],
        fp.map(([v, x]) => h("tr", {}, h("td", {}, nombreCorto(v)), h("td", {}, numero(x.n)), h("td", {}, dinero(x.m)), h("td", {}, dinero(div(x.m, x.n))))),
        fp.length ? h("tr", {}, h("td", {}, "TOTAL"), h("td", {}, numero(tn)), h("td", {}, dinero(tmn)), h("td", {}, dinero(div(tmn, tn)))) : null));

      pintarHistorico(mes);
      pintarDetalle();
    }

    function pintarHistorico(mesSel) {
      const meses = MESES.slice(0, mesSel).map((nombre, i) => ({ n: i + 1, nombre, venta: 0, ops: 0 }));
      datos.filter((r) => esVendida(r) && pasa(r, false) && r.mes >= 1 && r.mes <= mesSel)
        .forEach((r) => { const m = meses[r.mes - 1]; m.venta += r.monto_venta; m.ops++; });
      meses.forEach((m, i) => { const ant = i ? meses[i - 1].venta : 0; m.var = i && ant > 0 ? (m.venta - ant) / ant * 100 : null; });
      const total = meses.reduce((a, m) => a + m.venta, 0), prom = meses.length ? total / meses.length : 0;
      const act = meses[meses.length - 1], ant = meses[meses.length - 2];
      const vsProm = prom > 0 ? (act.venta - prom) / prom * 100 : 0;
      const mini = (t, v, s, cls = "") => h("div", { class: "dsh-mini" }, h("div", { class: "dsh-mt" }, t), h("div", { class: `dsh-mv ${cls}` }, v), h("div", { class: "dsh-ms" }, s));
      const cv = (v) => (v > 0 ? "verde" : v < 0 ? "rojo" : "");
      hist.kpis.replaceChildren(mini("VENTA DEL MES", mdp(act.venta), act.nombre),
        mini("VS MES ANTERIOR", act.var === null ? "-" : pct(act.var, true), ant ? `${ant.nombre}: ${mdp(ant.venta)}` : "Sin mes anterior", cv(act.var || 0)),
        mini("PROMEDIO MENSUAL", mdp(prom), `Enero a ${act.nombre}`), mini("MES VS PROMEDIO", pct(vsProm, true), vsProm >= 0 ? "Por arriba del promedio" : "Por debajo del promedio", cv(vsProm)));
      const max = Math.max(...meses.map((m) => m.venta), prom, 1);
      hist.barras.replaceChildren(h("div", { class: "dsh-prom", style: { bottom: `${prom / max * 100}%` }, title: `Promedio ${dinero(prom)}` }),
        ...meses.map((m) => h("div", { class: "dsh-barra", title: `${m.nombre}: ${dinero(m.venta)} · ${m.ops} ops.` },
          h("span", { class: "dsh-bval" }, m.venta ? mdp(m.venta) : ""),
          h("div", { class: `dsh-bcol${m.n === mesSel ? " actual" : ""}`, style: { height: `${m.venta / max * 100}%` } }),
          h("span", { class: "dsh-blbl" }, m.nombre.slice(0, 3)))));
      hist.tabla.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Mes", "Vendido", "Ops.", "Vs anterior"].map((c) => h("th", {}, c)))),
        h("tbody", {}, ...meses.map((m) => h("tr", { class: m.n === mesSel ? "mes-actual" : "" }, h("td", {}, m.nombre), h("td", {}, dinero(m.venta)), h("td", {}, numero(m.ops)),
          h("td", { class: m.var === null ? "" : cv(m.var) }, m.var === null ? (m.venta > 0 && m.n > 1 ? "▲ Inicia venta" : "-") : `${m.var > 0 ? "▲" : m.var < 0 ? "▼" : "●"} ${pct(m.var, true)}`)))),
        h("tfoot", {}, h("tr", {}, h("td", {}, "TOTAL"), h("td", {}, dinero(total)), h("td", {}, numero(meses.reduce((a, m) => a + m.ops, 0))), h("td")))));
    }

    const COLS = [["folio", "Folio"], ["comprador", "Comprador"], ["vendedor", "Vendedor"], ["tipo", "Tipo"], ["zona", "Zona"], ["estado", "Estado"],
      ["capital", "Capital"], ["monto_venta", "Monto venta"], ["estatus_venta", "Estatus"], ["fecha_propuesta", "F. propuesta"], ["fecha_venta", "F. venta"],
      ["estatus_md", "MD"], ["estatus_control_doc", "Control doc."], ["estatus_final", "Estatus final"]];
    const detalle = () => { const q = norm(buscador.value); return delMes().filter((r) => !q || COLS.some(([c]) => norm(r[c]).includes(q))); };
    function pintarDetalle() {
      const filas = detalle();
      lblDet.textContent = `(${numero(filas.length)} registros)`;
      tDet.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...COLS.map(([, t]) => h("th", {}, t)))),
        h("tbody", {}, ...filas.map((r) => h("tr", {}, ...COLS.map(([c]) => {
          const v = r[c];
          if (c === "capital" || c === "monto_venta") return h("td", {}, dinero(v));
          if (c === "estatus_venta") return h("td", { class: "centro" }, h("span", { class: `dsh-pill ${esVendido(r) ? "vendido" : esPropuesta(r) ? "propuesta" : ""}` }, v || ""));
          return h("td", { class: "izq" }, v ?? "");
        }))))));
    }
    function exportar() {
      const filas = detalle();
      if (!filas.length) { toast("No hay registros para exportar.", "mal"); return; }
      descargarCSV(`Dashboard_Venta_${MESES[Number(selMes.value) - 1]}_${anioCargado}.csv`, COLS.map(([, t]) => t),
        filas.map((r) => Object.fromEntries(COLS.map(([c, t]) => [t, r[c] ?? ""]))));
    }

    // ---------- metas (validador / admin) ----------
    function panelMetas() {
      if (!panelMetasEl.hidden) { panelMetasEl.hidden = true; return; }
      const fijas = [["general", "Meta general"], ["grupal", "Meta Grupal"], ["jyp", "Meta JyP"], ["complementario", "Meta complementario (por vendedor)"],
        ...ZONAS.map((z) => [`zona:${z}`, `Zona ${z}`])];
      const vend = Object.keys(metas).filter((x) => x.startsWith("vendedor:"));
      const entrada = (clave, etiqueta, borrable) => {
        const inp = h("input", { class: "campo", type: "number", min: 0, step: 1000, value: metas[clave] ?? "" });
        return h("div", { class: "dsh-meta" }, h("span", {}, etiqueta), inp,
          h("button", { class: "btn btn-marca btn-chico", onclick: async () => {
            try { await ctx.rpc("dashboard_guardar_meta", { p_clave: clave, p_valor: inp.value === "" ? null : Number(inp.value) }); toast("Meta guardada.", "bien"); await cargar(); }
            catch (e) { toast(e.message, "mal"); } } }, "Guardar"),
          borrable ? h("button", { class: "btn btn-secundario btn-chico", onclick: async () => {
            try { await ctx.rpc("dashboard_guardar_meta", { p_clave: clave, p_valor: null }); panelMetasEl.hidden = true; await cargar(); panelMetas(); }
            catch (e) { toast(e.message, "mal"); } } }, "Quitar") : null);
      };
      const nuevoNom = h("input", { class: "campo", placeholder: "Parte del nombre del vendedor (p. ej. Rubén)" });
      const nuevoVal = h("input", { class: "campo", type: "number", min: 0, step: 1000, placeholder: "Meta" });
      panelMetasEl.replaceChildren(h("h3", {}, "⚙ Metas del dashboard"),
        h("p", { class: "nota" }, "Las metas de vendedor se aplican a quien tenga ese texto en su nombre; los demás usan la meta complementaria."),
        h("div", { class: "dsh-metas-grid" }, ...fijas.map(([c, t]) => entrada(c, t, false)), ...vend.map((c) => entrada(c, `Vendedor: ${c.slice(9)}`, true))),
        h("div", { class: "dsh-meta" }, h("span", {}, "➕ Meta de vendedor"), nuevoNom, nuevoVal,
          h("button", { class: "btn btn-marca btn-chico", onclick: async () => {
            if (!nuevoNom.value.trim() || nuevoVal.value === "") { toast("Escribe el nombre y la meta.", "mal"); return; }
            try { await ctx.rpc("dashboard_guardar_meta", { p_clave: `vendedor:${nuevoNom.value.trim()}`, p_valor: Number(nuevoVal.value) });
              panelMetasEl.hidden = true; await cargar(); panelMetas(); } catch (e) { toast(e.message, "mal"); } } }, "Agregar")));
      panelMetasEl.hidden = false;
    }

    await cargar();
  },
};
