// ============================================================
// MÓDULO: Propuesta IA
// Sólo Estado, Municipio y Monto: arma la propuesta al instante con el optimizador
// (mismo algoritmo que "Sugerir" de Armar propuesta) y la aparta con un clic.
// ============================================================
import { sugerir } from "../venta/venta.js";

const RANGO_ABAJO = 1000;
const RANGO_ARRIBA = 2000;
const ESTRATEGIAS = ["Mayor mora primero", "Mayor capital primero", "Menor mora primero", "Menor capital primero"];

export default {
  id: "propuesta_ia",
  titulo: "Propuesta IA",
  icono: "🤖",
  roles: ["vendedor"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, dinero, numero, dias, toast, confirmar, avisar, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./propuesta_ia.css", import.meta.url).href);

    const est = { tipo: "Grupal", geo: [], candidatos: [], elegidos: [], intento: 0,
      estados: new Set(), municipios: new Set() };

    const segBotones = ["Grupal", "JyP", "Dual"].map((t) => h("button", { type: "button", onclick: () => cambiarTipo(t) }, t));
    const pintarSeg = () => segBotones.forEach((b) => b.classList.toggle("activo", b.textContent === est.tipo));
    const buscaEstado = h("input", { class: "campo", placeholder: "🔍 Buscar estado…", oninput: () => pintarEstados() });
    const listaEstados = h("div", { class: "lista-cas" });
    const buscaMuni = h("input", { class: "campo", placeholder: "🔍 Buscar municipio…", oninput: () => pintarMunicipios() });
    const listaMunis = h("div", { class: "lista-cas" });
    const lblEstados = h("small", { class: "nota" });
    const lblMunis = h("small", { class: "nota" });
    const inMonto = h("input", { class: "campo ia-monto", type: "number", min: 1000, step: 1000, placeholder: "200000",
      onkeydown: (e) => { if (e.key === "Enter") generar(); } });
    const inCentavos = h("input", { class: "campo", type: "number", min: 0, step: 0.01, value: 0.26 });
    const inComprador = h("input", { class: "campo", placeholder: "Nombre del comprador (obligatorio)", autocomplete: "off" });
    const btnGenerar = h("button", { class: "btn btn-marca ia-generar", onclick: () => generar() }, "🤖 Generar propuesta");

    const kCap = kpi("💰 Capital"), kVenta = kpi("📈 Valor de venta"), kPart = kpi("☑ Partidas"), kMora = kpi("📅 Mora promedio");
    const lblEstrategia = h("span", { class: "nota" });
    const btnOtra = h("button", { class: "btn btn-secundario", disabled: true, onclick: () => generar(true) }, "🔁 Otra opción");
    const btnApartar = h("button", { class: "btn btn-marca", disabled: true, onclick: () => apartar() }, "✔ Apartar y enviar a revisión");
    const t = tabla([], { idFila: (f) => f.key, vacio: "Elige estados, municipios y monto, y presiona Generar." });
    t.el.style.maxHeight = "calc(100vh - 380px)";
    t.el.style.minHeight = "200px";

    const COLS = [
      { clave: "tipo", titulo: "Tipo" },
      { clave: "id", titulo: "Grupo / vReference" },
      { clave: "integrantes", titulo: "Créditos", num: true },
      { clave: "estado", titulo: "Estado" },
      { clave: "municipio", titulo: "Municipio" },
      { clave: "mora", titulo: "Mora", num: true, formato: (v) => dias(v) },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
    ];
    t.setColumnas(COLS);

    cont.append(h("div", { class: "ia" },
      h("div", { class: "tarjeta ia-panel" },
        h("h3", {}, "🤖 Propuesta IA"),
        h("p", { class: "nota", style: { margin: "0 0 8px" } }, "Elige uno o varios estados y municipios y el monto; la propuesta se arma sola dentro del rango (−$1,000 / +$2,000). Sin municipios marcados = todos."),
        h("span", { class: "etiqueta" }, "Tipo"), h("div", { class: "segmentado" }, ...segBotones),
        h("span", { class: "etiqueta" }, "Estados ", lblEstados), buscaEstado, h("div", { style: { height: "4px" } }), listaEstados,
        h("span", { class: "etiqueta" }, "Municipios ", lblMunis), buscaMuni, h("div", { style: { height: "4px" } }), listaMunis,
        h("div", { class: "fila", style: { marginTop: "4px", justifyContent: "flex-start", gap: "6px" } },
          h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => todosMunicipios(true) }, "☑ Todos los municipios"),
          h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => todosMunicipios(false) }, "Ninguno")),
        h("span", { class: "etiqueta" }, "Monto (capital objetivo)"), inMonto,
        h("span", { class: "etiqueta" }, "Centavos por peso"), inCentavos,
        h("span", { class: "etiqueta" }, "Comprador"), inComprador,
        h("div", { style: { marginTop: "12px" } }, btnGenerar)),
      h("div", { class: "ia-der" },
        h("div", { class: "kpis" }, kCap.el, kVenta.el, kPart.el, kMora.el),
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px", flexWrap: "wrap" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "Propuesta generada"), lblEstrategia,
            h("span", { class: "fila", style: { flex: "0 0 auto", gap: "6px" } }, btnOtra, btnApartar)),
          t.el))));

    function limpiar() {
      est.candidatos = []; est.elegidos = []; est.intento = 0;
      t.setFilas([]); lblEstrategia.textContent = "";
      [kCap, kVenta, kPart, kMora].forEach((k) => k.set("—"));
      btnOtra.disabled = btnApartar.disabled = true;
    }

    async function cargarGeo() {
      try { est.geo = await ctx.rpc("catalogo_geo", { p_tipo: est.tipo }); }
      catch (e) { toast(e.message, "mal"); est.geo = []; }
      const validos = new Set(est.geo.map((g) => g.estado));
      [...est.estados].forEach((e) => !validos.has(e) && est.estados.delete(e));
      pintarEstados();
    }

    // Lista de casillas con buscador (varios estados / municipios)
    function listaCasillas(caja, items, sel, filtro, alCambiar, vacio) {
      const f = filtro.trim().toUpperCase();
      const vis = items.filter((i) => !f || i.nombre.includes(f));
      caja.replaceChildren(...(vis.length ? vis.map((i) => {
        const chk = h("input", { type: "checkbox", checked: sel.has(i.nombre) });
        const lab = h("label", { class: sel.has(i.nombre) ? "sel" : "" }, chk, i.nombre, h("small", {}, numero(i.n)));
        chk.addEventListener("change", () => {
          chk.checked ? sel.add(i.nombre) : sel.delete(i.nombre);
          lab.classList.toggle("sel", chk.checked);
          alCambiar();
        });
        return lab;
      }) : [h("div", { class: "vacio" }, items.length ? "Sin coincidencias" : vacio)]));
    }
    function estadosItems() {
      const m = new Map();
      for (const g of est.geo) m.set(g.estado, (m.get(g.estado) || 0) + Number(g.registros));
      return [...m].map(([nombre, n]) => ({ nombre, n }));
    }
    function municipiosItems() {
      const m = new Map();
      for (const g of est.geo) if (est.estados.has(g.estado) && g.municipio) m.set(g.municipio, (m.get(g.municipio) || 0) + Number(g.registros));
      return [...m].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    }
    function pintarEstados() {
      listaCasillas(listaEstados, estadosItems(), est.estados, buscaEstado.value, () => {
        const validos = new Set(municipiosItems().map((m) => m.nombre));
        [...est.municipios].forEach((m) => !validos.has(m) && est.municipios.delete(m));
        pintarMunicipios(); limpiar();
      }, "Sin cartera");
      pintarMunicipios();
    }
    function pintarMunicipios() {
      listaCasillas(listaMunis, municipiosItems(), est.municipios, buscaMuni.value, () => { contar(); limpiar(); }, "Elige primero uno o más estados");
      contar();
    }
    function todosMunicipios(marcar) {
      est.municipios.clear();
      if (marcar) municipiosItems().forEach((m) => est.municipios.add(m.nombre));
      pintarMunicipios(); limpiar();
    }
    function contar() {
      lblEstados.textContent = est.estados.size ? `${est.estados.size} elegidos` : "";
      lblMunis.textContent = est.municipios.size ? `${est.municipios.size} elegidos` : (est.estados.size ? "Todos" : "");
    }
    const lugar = () => {
      const e = [...est.estados], m = [...est.municipios];
      return e.slice(0, 3).join(", ") + (e.length > 3 ? ` +${e.length - 3}` : "") +
        (m.length ? ` · ${m.slice(0, 3).join(", ")}${m.length > 3 ? ` +${m.length - 3}` : ""}` : " · todos los municipios");
    };

    async function cambiarTipo(tipo) {
      if (tipo === est.tipo) return;
      est.tipo = tipo; pintarSeg(); limpiar(); await cargarGeo();
    }

    async function traerCandidatos() {
      const f = { p_estados: [...est.estados], p_municipios: est.municipios.size ? [...est.municipios] : null,
        p_mora_min: null, p_mora_max: null, p_terminos: null };
      const filas = [];
      if (est.tipo !== "Grupal") {
        for (const r of await ctx.rpc("buscar_jyp", f)) {
          filas.push({ key: `J:${r.vreference}`, tipo: "JyP", id: r.vreference, estado: r.estado, municipio: r.municipio,
            integrantes: 1, mora: r.dias === null ? null : Number(r.dias), capital: Number(r.npendingk) });
        }
      }
      if (est.tipo !== "JyP") {
        for (const r of await ctx.rpc("buscar_grupos", f)) {
          if (!r.disponible) continue;
          filas.push({ key: `G:${r.vgroupid}`, tipo: "Grupal", id: r.vgroupid, estado: r.estados, municipio: r.municipios,
            integrantes: Number(r.integrantes), mora: r.dias_promedio === null ? null : Number(r.dias_promedio),
            capital: Number(r.capital) });
        }
      }
      return filas;
    }

    async function generar(otra = false) {
      const monto = Number(inMonto.value);
      if (!est.estados.size) { toast("Elige al menos un estado.", "mal"); buscaEstado.focus(); return; }
      if (!(monto > 0)) { toast("Escribe el monto.", "mal"); inMonto.focus(); return; }
      btnGenerar.disabled = true; btnOtra.disabled = true;
      try {
        if (!otra || !est.candidatos.length) {
          lblEstrategia.textContent = "Buscando cartera disponible…";
          est.candidatos = await traerCandidatos();
          est.intento = 0;
        } else est.intento++;
        const min = Math.max(0, monto - RANGO_ABAJO), max = monto + RANGO_ARRIBA;
        const total = est.candidatos.reduce((s, f) => s + f.capital, 0);
        if (!est.candidatos.length) throw new Error("No hay cartera disponible en los estados/municipios elegidos.");
        if (total < min) throw new Error(`Sólo hay ${dinero(total)} disponibles ahí (${numero(est.candidatos.length)} partidas). ` +
          "Baja el monto o agrega más municipios/estados.");

        // prueba las estrategias empezando por la que toca y se queda con la primera que cae en rango
        let mejor = null;
        for (let i = 0; i < ESTRATEGIAS.length; i++) {
          const estrategia = ESTRATEGIAS[(est.intento + i) % ESTRATEGIAS.length];
          const r = sugerir(est.candidatos, monto, min, max, estrategia);
          const enRango = r.total >= min && r.total <= max;
          if (!mejor || (enRango && !mejor.enRango) || (!mejor.enRango && Math.abs(r.total - monto) < Math.abs(mejor.total - monto))) {
            mejor = { ...r, estrategia, enRango };
          }
          if (enRango) { est.intento = (est.intento + i) % ESTRATEGIAS.length; break; }
        }
        const llaves = new Set(mejor.keys);
        est.elegidos = est.candidatos.filter((f) => llaves.has(f.key));
        t.setFilas(est.elegidos);
        pintarKpis(monto, min, max, mejor);
      } catch (e) {
        limpiar();
        lblEstrategia.textContent = "";
        toast(e.message, "mal", 8000);
      }
      btnGenerar.disabled = false;
    }

    function pintarKpis(monto, min, max, r) {
      const cap = est.elegidos.reduce((s, f) => s + f.capital, 0);
      const cent = Number(inCentavos.value) || 0;
      kCap.set(dinero(cap), r.enRango ? `✔ En rango (${dinero(min)} a ${dinero(max)})` : `Fuera de rango: ${dinero(min)} a ${dinero(max)}`,
        r.enRango ? "bien" : "mal");
      kVenta.set(dinero(cap * cent), `${cent} centavos por peso`);
      const integ = est.elegidos.reduce((s, f) => s + f.integrantes, 0);
      kPart.set(numero(est.elegidos.length), `${numero(integ)} créditos`);
      let sd = 0, nd = 0;
      for (const f of est.elegidos) if (f.mora !== null) { sd += f.mora * f.integrantes; nd += f.integrantes; }
      kMora.set(nd ? dias(sd / nd) : "N/D");
      lblEstrategia.textContent = `Criterio: ${r.estrategia} · de ${numero(est.candidatos.length)} partidas disponibles`;
      btnOtra.disabled = false;
      btnApartar.disabled = !r.enRango;
      if (!r.enRango) toast("No se logró caer exactamente en el rango con esa cartera. Prueba «Otra opción», otro municipio o ajusta el monto.", "mal", 8000);
    }

    async function apartar() {
      const comprador = inComprador.value.trim();
      if (!comprador) { toast("Escribe el nombre del comprador.", "mal"); inComprador.focus(); return; }
      const monto = Number(inMonto.value);
      const cent = Number(inCentavos.value) || 0;
      const cap = est.elegidos.reduce((s, f) => s + f.capital, 0);
      const refs = est.elegidos.filter((f) => f.tipo === "JyP").map((f) => f.id);
      const grupos = est.elegidos.filter((f) => f.tipo === "Grupal").map((f) => f.id);
      if (!(await confirmar("Apartar propuesta",
        `${lugar()}\nComprador: ${comprador}\nCapital: ${dinero(cap)}\nValor de venta: ${dinero(cap * cent)}\n` +
        `Partidas: ${refs.length} JyP + ${grupos.length} grupos\n\nSe apartará y se enviará a revisión del validador.`, "Apartar y enviar"))) return;
      btnApartar.disabled = true;
      try {
        const r = await ctx.rpc("apartar", { p_tipo_venta: est.tipo, p_capital_objetivo: monto, p_centavos: cent,
          p_refs: refs, p_grupos: grupos, p_comprador: comprador });
        await avisar(`Propuesta ${r.id_propuesta}`,
          `Se apartó y quedó EN REVISIÓN.\nComprador: ${r.comprador}\nCapital: ${dinero(r.capital)}\nValor de venta: ${dinero(r.valor_venta)}\n\n` +
          "Se avisó a los validadores. Puedes seguirla en la Bitácora.");
        limpiar();
      } catch (e) {
        toast("No se apartó nada (alguien pudo tomar parte de la cartera). Genera de nuevo.\n" + e.message, "mal", 9000);
        est.candidatos = [];
        btnApartar.disabled = false;
      }
    }

    pintarSeg(); limpiar();
    await cargarGeo();
  },
};
