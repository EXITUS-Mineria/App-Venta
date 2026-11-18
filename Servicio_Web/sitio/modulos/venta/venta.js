// ============================================================
// MÓDULO: Armar propuesta de venta (JyP / Grupal / Dual)
// ============================================================
import { sugerir, terminos, mapearJyP, mapearGrupo, aCandidato, rangoObjetivo } from "./cartera.js";

// Se reexporta para no romper a quien importaba el optimizador desde este módulo.
export { sugerir };

const PRIORIDADES = ["Mayor mora primero", "Menor mora primero", "Mayor capital primero", "Menor capital primero"];

export default {
  id: "venta",
  titulo: "Armar propuesta",
  icono: "📊",
  roles: ["vendedor", "admin"],

  async montar(cont, ctx) {
    const { h, kpi, tabla, dinero, numero, dias, toast, confirmar, avisar, listaCasillas, indiceGeo } = ctx.ui;
    ctx.ui.cargarCSS(new URL("./venta.css", import.meta.url).href);

    // Modo complemento: #/venta?complementar=VTA-0300 (agregar cartera a una venta existente)
    const idComp = new URLSearchParams((location.hash.split("?")[1]) || "").get("complementar");
    let comp = null;
    if (idComp) {
      const { data, error } = await ctx.sb.from("propuestas").select("*").eq("id_propuesta", idComp).maybeSingle();
      if (error || !data) { toast(`No encontré la propuesta ${idComp}.`, "mal"); }
      else comp = data;
    }

    // ---------------- estado ----------------
    const est = {
      tipo: "Grupal", objetivo: 200000, centavos: 0.26, prioridad: PRIORIDADES[0],
      geo: [], estados: new Set(), municipios: new Set(),
      filas: [], seleccion: new Set(),
    };
    const rango = () => rangoObjetivo(est.objetivo);

    // ---------------- panel izquierdo ----------------
    const segBotones = ["JyP", "Grupal", "Dual"].map((t) =>
      h("button", { type: "button", onclick: () => cambiarTipo(t) }, t));
    const pintarSeg = () => segBotones.forEach((b) => b.classList.toggle("activo", b.textContent === est.tipo));

    const inObjetivo = h("input", { class: "campo", type: "number", min: 0, step: 1000, value: est.objetivo,
      oninput: () => { est.objetivo = Number(inObjetivo.value) || 0; pintarRango(); actualizarKpis(); } });
    const inCentavos = h("input", { class: "campo", type: "number", min: 0, step: 0.01, value: est.centavos,
      oninput: () => { est.centavos = Number(inCentavos.value) || 0; actualizarKpis(); } });
    const lblRango = h("div", { class: "pastilla" });
    const inComprador = h("input", { class: "campo", placeholder: "Nombre del comprador (obligatorio)", autocomplete: "off" });
    const pintarRango = () => { const [a, b] = rango(); lblRango.textContent = `${dinero(a)} a ${dinero(b)}`; };
    const selPrioridad = h("select", { class: "campo", onchange: () => (est.prioridad = selPrioridad.value) },
      ...PRIORIDADES.map((p) => h("option", { value: p }, p)));

    const buscaEstado = h("input", { class: "campo", placeholder: "🔍 Buscar estado…", oninput: () => pintarEstados() });
    const listaEstados = h("div", { class: "lista-cas" });
    const buscaMuni = h("input", { class: "campo", placeholder: "🔍 Buscar municipio…", oninput: () => pintarMunicipios() });
    const listaMunis = h("div", { class: "lista-cas" });
    const lblEstados = h("small", { class: "nota" });
    const lblMunis = h("small", { class: "nota" });
    const inMoraMin = h("input", { class: "campo", type: "number", placeholder: "De" });
    const inMoraMax = h("input", { class: "campo", type: "number", placeholder: "A" });
    const inBuscar = h("input", { class: "campo", placeholder: "🔍 Una o varias, separadas por coma…",
      onkeydown: (e) => { if (e.key === "Enter") aplicar(); } });

    // Índice del catálogo geográfico: se arma una sola vez por carga (evita recorrerlo por cada pintado).
    let geoIdx = indiceGeo([]);
    const estadosItems = () => geoIdx.estados;
    const municipiosItems = () =>
      [...est.estados].flatMap((e) => geoIdx.municipios(e).filter((m) => m.nombre));
    function pintarEstados() {
      listaCasillas(listaEstados, estadosItems(), est.estados, buscaEstado.value, () => {
        const validos = new Set(municipiosItems().map((m) => m.nombre));
        [...est.municipios].forEach((m) => !validos.has(m) && est.municipios.delete(m));
        pintarMunicipios(); contar();
      });
      contar();
    }
    function pintarMunicipios() { listaCasillas(listaMunis, municipiosItems(), est.municipios, buscaMuni.value, contar); contar(); }
    function contar() {
      lblEstados.textContent = est.estados.size ? `${est.estados.size} elegidos` : "";
      lblMunis.textContent = est.municipios.size ? `${est.municipios.size} elegidos` : (est.estados.size ? "Todos" : "");
    }

    const panel = h("aside", { class: "venta-panel" },
      h("section", { class: "tarjeta" }, h("h3", {}, "Propuesta"),
        comp ? null : h("span", { class: "etiqueta" }, "Comprador"), comp ? null : inComprador,
        h("span", { class: "etiqueta" }, "Tipo de venta"), h("div", { class: "segmentado" }, ...segBotones),
        h("div", { class: "fila" },
          h("div", {}, h("span", { class: "etiqueta" }, "Capital objetivo"), inObjetivo),
          h("div", { style: { flex: "0 0 38%" } }, h("span", { class: "etiqueta" }, "Centavos por peso"), inCentavos)),
        h("span", { class: "etiqueta" }, "Rango permitido"), lblRango,
        h("span", { class: "etiqueta" }, "Prioridad para sugerir"), selPrioridad,
        h("button", { class: "btn btn-primario", style: { width: "100%", marginTop: "10px" }, onclick: () => sugerirAccion() }, "⚡ Sugerir propuesta")),
      h("section", { class: "tarjeta" }, h("h3", {}, "Filtros"),
        h("span", { class: "etiqueta" }, "Estados ", lblEstados), buscaEstado, h("div", { style: { height: "4px" } }), listaEstados,
        h("span", { class: "etiqueta" }, "Municipios ", lblMunis), buscaMuni, h("div", { style: { height: "4px" } }), listaMunis,
        h("span", { class: "etiqueta" }, "Días de mora"), h("div", { class: "fila" }, inMoraMin, inMoraMax),
        h("span", { class: "etiqueta" }, "Buscar vReference / Grupo"), inBuscar,
        h("div", { class: "nota" }, "Con referencia no es obligatorio elegir Estado."),
        h("div", { class: "fila", style: { marginTop: "10px" } },
          h("button", { class: "btn btn-primario", onclick: () => aplicar() }, "Aplicar filtros"),
          h("button", { class: "btn btn-secundario", onclick: () => limpiarFiltros() }, "Limpiar"))));

    // ---------------- derecha ----------------
    const K = {
      disp: kpi("📊 Disponibles"), capital: kpi("💰 Capital"), venta: kpi("📈 Valor de venta"),
      mora: kpi("📅 Mora promedio"), partidas: kpi("☑ Partidas"),
    };
    const lblTabla = h("b", {}, "DETALLE");
    const lblResumen = h("span", {}, "Elige estados o busca una referencia y presiona Aplicar filtros.");
    const btnApartar = h("button", { class: "btn btn-marca", onclick: () => apartar() },
      comp ? `➕ Agregar a ${comp.id_propuesta}` : "✔ Validar y apartar");
    const banner = comp ? h("div", { class: "venta-comp" },
      h("div", {}, h("b", {}, `➕ Complementando ${comp.id_propuesta}`),
        h("span", {}, ` · ${comp.usuario} · comprador ${comp.comprador || "sin capturar"} · ${comp.tipo_venta || ""} · estatus ${comp.estatus} · capital actual ${dinero(comp.capital)}` +
          ` · objetivo original ${dinero(comp.capital_objetivo)}`)),
      h("span", { class: "nota" }, "Selecciona lo que quieres agregar (no aplica el rango). Si ya estaba aprobada o en venta, regresa a revisión."),
      h("button", { class: "btn btn-secundario btn-chico", onclick: () => { location.hash = "#/venta"; } }, "✖ Salir del complemento")) : null;
    const raiz = h("div", { class: "venta" });
    const t = tabla([], {
      seleccion: est.seleccion, idFila: (f) => f.key, bloqueada: (f) => !f.disponible,
      alCambiar: actualizarKpis, vacio: "Aplica filtros para ver créditos o grupos disponibles",
    });

    const der = h("section", { class: "venta-der" },
      banner,
      h("div", { class: "venta-acciones" },
        h("button", { class: "btn btn-secundario", onclick: () => raiz.classList.toggle("sin-panel") }, "◀ Panel"),
        h("button", { class: "btn btn-primario", onclick: () => aplicar() }, "🔎 Aplicar filtros"),
        h("div", { class: "espacio" }),
        h("button", { class: "btn btn-secundario", onclick: () => { t.filas.filter((f) => f.disponible).forEach((f) => est.seleccion.add(f.key)); t.redibujar(); actualizarKpis(); } }, "☑ Todos"),
        h("button", { class: "btn btn-secundario", onclick: () => { est.seleccion.clear(); t.redibujar(); actualizarKpis(); } }, "Limpiar selección"),
        btnApartar),
      h("div", { class: "kpis" }, ...Object.values(K).map((k) => k.el)),
      h("div", { class: "tarjeta venta-tabla" }, h("div", { class: "barra" }, lblTabla, lblResumen), t.el));

    raiz.append(panel, der);
    cont.append(raiz);

    // ---------------- lógica ----------------
    const COLS = {
      JyP: [
        { clave: "id", titulo: "vReference" }, { clave: "estado", titulo: "Estado" },
        { clave: "municipio", titulo: "Municipio" }, { clave: "colonia", titulo: "Colonia" },
        { clave: "mora", titulo: "Mora", num: true, formato: (v) => dias(v) },
        { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      ],
      Grupal: [
        { clave: "id", titulo: "vGroupId" }, { clave: "integrantes", titulo: "Integrantes", num: true },
        { clave: "estado", titulo: "Estados" }, { clave: "municipio", titulo: "Municipios" },
        { clave: "colonia", titulo: "Colonias" },
        { clave: "mora", titulo: "Mora prom.", num: true, formato: (v) => dias(v) },
        { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
        { clave: "estatus", titulo: "Estatus" },
      ],
    };
    COLS.Dual = [{ clave: "tipo", titulo: "Tipo" }, ...COLS.Grupal];

    async function cargarGeo() {
      est.geo = await ctx.rpc("catalogo_geo", { p_tipo: est.tipo });
      geoIdx = indiceGeo(est.geo);
      const validos = new Set(geoIdx.estados.map((e) => e.nombre));
      [...est.estados].forEach((e) => !validos.has(e) && est.estados.delete(e));
      pintarEstados(); pintarMunicipios();
    }

    async function cambiarTipo(tipo) {
      if (tipo === est.tipo) return;
      est.tipo = tipo; pintarSeg();
      est.filas = []; est.seleccion.clear();
      t.setColumnas(COLS[tipo]); t.setFilas([]);
      actualizarKpis();
      await cargarGeo();
    }

    function filtros() {
      const vmin = inMoraMin.value === "" ? null : Number(inMoraMin.value);
      const vmax = inMoraMax.value === "" ? null : Number(inMoraMax.value);
      if (vmin !== null && vmax !== null && vmin > vmax) throw new Error("La mora mínima no puede ser mayor que la máxima.");
      const ter = terminos(inBuscar.value);
      if (!est.estados.size && !ter.length) throw new Error("Elige al menos un estado o busca una vReference / Grupo.");
      return {
        p_estados: est.estados.size ? [...est.estados] : null,
        p_municipios: est.municipios.size ? [...est.municipios] : null,
        p_mora_min: vmin, p_mora_max: vmax, p_terminos: ter.length ? ter : null,
      };
    }

    async function aplicar() {
      let f;
      try { f = filtros(); } catch (e) { toast(e.message, "mal"); return; }
      lblResumen.textContent = "Buscando…";
      try {
        const filas = [];
        if (est.tipo !== "Grupal") filas.push(...(await ctx.rpc("buscar_jyp", f)).map(mapearJyP));
        if (est.tipo !== "JyP") filas.push(...(await ctx.rpc("buscar_grupos", f)).map(mapearGrupo));
        est.filas = filas;
        const vivas = new Set(filas.filter((x) => x.disponible).map((x) => x.key));
        [...est.seleccion].forEach((k) => !vivas.has(k) && est.seleccion.delete(k));
        t.setFilas(filas);
        const bloq = filas.filter((x) => !x.disponible).length;
        lblTabla.textContent = `DETALLE · ${est.tipo.toUpperCase()} (${numero(filas.length)})` + (bloq ? ` · ${numero(bloq)} bloqueados` : "");
        const partes = [est.tipo, est.estados.size ? [...est.estados].slice(0, 3).join(", ") + (est.estados.size > 3 ? ` +${est.estados.size - 3}` : "") : "",
          est.municipios.size ? `${est.municipios.size} municipios` : (est.estados.size ? "todos los municipios" : ""),
          (f.p_mora_min !== null || f.p_mora_max !== null) ? `mora ${f.p_mora_min ?? 0}–${f.p_mora_max ?? "∞"} días` : "",
          f.p_terminos ? `búsqueda: ${f.p_terminos.slice(0, 3).join(", ")}` : ""].filter(Boolean);
        lblResumen.textContent = "🔎 " + partes.join("  ·  ");
        actualizarKpis();
      } catch (e) {
        lblResumen.textContent = "";
        toast(e.message, "mal");
      }
    }

    function limpiarFiltros() {
      est.estados.clear(); est.municipios.clear();
      buscaEstado.value = buscaMuni.value = inMoraMin.value = inMoraMax.value = inBuscar.value = "";
      pintarEstados(); pintarMunicipios();
    }

    function seleccionadas() { return est.filas.filter((f) => est.seleccion.has(f.key)); }

    function actualizarKpis() {
      // Un solo recorrido de las filas: disponibles + estadísticas de la selección.
      let disp = 0, dispCap = 0, cap = 0, nSel = 0, sd = 0, nd = 0, nj = 0, ng = 0, integ = 0;
      for (const f of est.filas) {
        if (f.disponible) { disp++; dispCap += f.capital; }
        if (!est.seleccion.has(f.key)) continue;
        nSel++; cap += f.capital;
        if (f.mora !== null) { sd += f.mora * f.integrantes; nd += f.integrantes; }
        if (f.tipo === "JyP") nj++; else { ng++; integ += f.integrantes; }
      }
      K.disp.set(numero(disp), disp ? `Capital ${dinero(dispCap)}` : "Aplica filtros");
      const [min, max] = rango();
      if (cap <= 0) K.capital.set(dinero(0), `Objetivo ${dinero(est.objetivo)}`);
      else if (cap < min) K.capital.set(dinero(cap), `Faltan ${dinero(min - cap)} para el mínimo`, "alerta");
      else if (cap > max) K.capital.set(dinero(cap), `Excede ${dinero(cap - max)} el máximo`, "mal");
      else K.capital.set(dinero(cap), "✔ Dentro del rango", "bien");
      K.venta.set(dinero(cap * est.centavos), `${est.centavos} centavos por peso`);
      K.mora.set(nd ? dias(sd / nd) : "N/D", "Promedio de días de atraso");
      K.partidas.set(numero(nSel), [nj ? `${nj} JyP` : "", ng ? `${ng} grupos · ${integ} integrantes` : ""].filter(Boolean).join(" + ") || "Sin selección");
      btnApartar.disabled = comp ? !(cap > 0) : !(cap >= min && cap <= max && cap > 0);
    }

    function sugerirAccion() {
      if (!est.filas.length) { toast("Primero aplica los filtros.", "mal"); return; }
      const [min, max] = rango();
      const cand = est.filas.filter((f) => f.disponible).map(aCandidato);
      const { keys, total } = sugerir(cand, est.objetivo, min, max, est.prioridad);
      est.seleccion.clear(); keys.forEach((k) => est.seleccion.add(k));
      t.redibujar(); t.verSeleccion(); actualizarKpis();
      if (total >= min && total <= max) toast(`Se seleccionaron ${keys.length} partidas por ${dinero(total)}.`, "bien");
      else toast(`No se logró caer en el rango. Mejor combinación: ${dinero(total)}. Amplía filtros o ajusta el objetivo.`, "mal", 7000);
    }

    async function apartar() {
      if (comp) return complementar();
      const comprador = inComprador.value.trim();
      if (!comprador) { toast("Escribe el nombre del comprador.", "mal"); inComprador.focus(); return; }
      const sel = seleccionadas();
      const cap = sel.reduce((s, f) => s + f.capital, 0);
      const refs = sel.filter((f) => f.tipo === "JyP").map((f) => f.id);
      const grupos = sel.filter((f) => f.tipo === "Grupal").map((f) => f.id);
      const ok = await confirmar("Apartar propuesta",
        `Usuario: ${ctx.perfil.nombre || ctx.perfil.email}\nComprador: ${comprador}\nCapital: ${dinero(cap)}\nCentavos por peso: ${est.centavos}\n` +
        `Valor de venta: ${dinero(cap * est.centavos)}\nPartidas: ${refs.length} JyP + ${grupos.length} grupos\n\n` +
        "Se apartarán y se enviará a revisión del validador.", "Apartar y enviar");
      if (!ok) return;
      btnApartar.disabled = true;
      try {
        const r = await ctx.rpc("apartar", {
          p_tipo_venta: est.tipo, p_capital_objetivo: est.objetivo, p_centavos: est.centavos,
          p_refs: refs, p_grupos: grupos, p_comprador: comprador,
        });
        await avisar(`Propuesta ${r.id_propuesta}`,
          `Se apartó y quedó EN REVISIÓN.\nComprador: ${r.comprador}\nCapital: ${dinero(r.capital)}\nValor de venta: ${dinero(r.valor_venta)}\n\n` +
          "Se avisó a los validadores. Puedes seguir su estatus en la Bitácora.");
        est.seleccion.clear();
      } catch (e) {
        toast("No se apartó nada.\n" + e.message, "mal", 9000);
      }
      await aplicar();
    }

    async function complementar() {
      const sel = seleccionadas();
      const cap = sel.reduce((s, f) => s + f.capital, 0);
      const refs = sel.filter((f) => f.tipo === "JyP").map((f) => f.id);
      const grupos = sel.filter((f) => f.tipo === "Grupal").map((f) => f.id);
      const ok = await confirmar(`Complementar ${comp.id_propuesta}`,
        `Se agregan ${refs.length} JyP + ${grupos.length} grupos por ${dinero(cap)}.\n` +
        `Capital actual: ${dinero(comp.capital)}\nCapital total: ${dinero(Number(comp.capital) + cap)}\n\n` +
        (["APROBADA", "EN VENTA"].includes(comp.estatus) ? "La propuesta regresará a EN REVISIÓN para que el validador revise el complemento." :
          "Se avisará al validador."), "Agregar");
      if (!ok) return;
      btnApartar.disabled = true;
      try {
        const r = await ctx.rpc("complementar_propuesta", { p_id: comp.id_propuesta, p_refs: refs, p_grupos: grupos });
        await avisar(`${r.id_propuesta} complementada`,
          `Se agregaron ${dinero(r.agregado)} (${r.partidas} partidas).\nCapital total: ${dinero(r.capital)}\n` +
          `Valor de venta: ${dinero(r.valor_venta)}\nEstatus: ${r.estatus}`);
        location.hash = "#/bitacora";
        return;
      } catch (e) { toast("No se agregó nada.\n" + e.message, "mal", 9000); }
      await aplicar();
    }

    // arranque
    if (comp) {
      if (["JyP", "Grupal", "Dual"].includes(comp.tipo_venta)) est.tipo = comp.tipo_venta;
      est.centavos = Number(comp.centavos) || est.centavos;
      inCentavos.value = est.centavos; inCentavos.disabled = true;
      const falta = Number(comp.capital_objetivo) - Number(comp.capital);
      est.objetivo = falta > 0 ? Math.round(falta) : 50000;
      inObjetivo.value = est.objetivo;
    }
    pintarSeg(); pintarRango(); selPrioridad.value = est.prioridad;
    t.setColumnas(COLS[est.tipo]);
    actualizarKpis();
    await cargarGeo();
  },
};
