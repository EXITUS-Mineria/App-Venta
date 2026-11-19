// ============================================================
// MÓDULO: Jurídico · funnel de juicios (réplica de la lista SharePoint «LEGAL 1» del Área Legal)
// Un renglón por juicio ligado al crédito por vReference. 4 etapas:
//   1 Presentación de demanda → 2 Emplazamiento → 3 Probatoria → 4 Sentencia y resolución.
// Regla de oro del manual: cada movimiento lleva OPCIÓN + FECHA del acto + OBSERVACIÓN (se agrega, no se borra).
// Editan: abogado o pasante asignado (sus juicios), coordinación jurídica y maestros (todos).
// ============================================================
import { bloqueDocumentos } from "./documentos.js";

const ETAPAS = [
  { n: 1, titulo: "Presentación de demanda", corto: "Demanda",
    opciones: ["Admision de Demanda", "Prevención", "Desechamiento"],
    ayuda: { "Admision de Demanda": "El juzgado admitió la demanda", "Prevención": "El juzgado pidió aclarar o corregir algo (al admitirse, cámbiala a Admisión)",
      "Desechamiento": "El juzgado desechó la demanda (anota el motivo)" } },
  { n: 2, titulo: "Emplazamiento", corto: "Emplazamiento",
    opciones: ["Cedula", "Nueva Fecha de Diligencia", "Diligencia Exitosa", "Diligencia No Exitosa", "Ilocalizable"],
    ayuda: { "Cedula": "Ya se turnó la cédula o están listos cédula y traslado; falta ir", "Nueva Fecha de Diligencia": "Hay cita o fecha programada con el actuario",
      "Diligencia Exitosa": "Se emplazó al demandado y hay razón actuarial", "Diligencia No Exitosa": "Se fue y no se pudo emplazar (no estaba, no abrió, domicilio mal)",
      "Ilocalizable": "Después de buscarlo, el demandado no se localiza" } },
  { n: 3, titulo: "Probatoria", corto: "Pruebas",
    opciones: ["Apertura Prueba", "Confesional", "Pericial"],
    ayuda: { "Apertura Prueba": "El juzgado abrió el periodo de pruebas", "Confesional": "Se programó o desahogó la prueba confesional",
      "Pericial": "Se programó o desahogó la prueba pericial" } },
  { n: 4, titulo: "Sentencia y resolución", corto: "Resolución",
    opciones: ["Sentencia Favorable", "Sentencia No Favorable", "Apelacion", "Amparo", "Ejecucion", "Convenio"],
    ayuda: { "Sentencia Favorable": "Sentencia a favor de Exitus Credit", "Sentencia No Favorable": "Sentencia en contra", "Apelacion": "Alguna parte apeló",
      "Amparo": "Se promovió amparo", "Ejecucion": "Se está ejecutando la sentencia (embargo, remate, cobro)",
      "Convenio": "Se firmó convenio de pago (en cualquier momento del juicio)" } },
];
const NEGATIVAS = new Set(["Desechamiento", "Diligencia No Exitosa", "Ilocalizable", "Sentencia No Favorable"]);
const FAVORABLES = new Set(["Sentencia Favorable", "Ejecucion", "Convenio"]);
const DIAS_ALERTA = 60, DIAS_AVISO = 30;
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
const fechaCorta = (d) => (d ? d.split("-").reverse().join("/") : "");
const diasDesde = (d) => (d ? Math.floor((Date.parse(hoy()) - Date.parse(d.slice(0, 10))) / 86400000) : null);

const etapaDe = (j) => (j.etapa4 ? 4 : j.etapa3 ? 3 : j.etapa2 ? 2 : j.etapa1 ? 1 : 0);
const situacion = (j) => { const e = etapaDe(j); return e ? j[`etapa${e}`] : "Sin etapa"; };
const fechaEtapa = (j) => { const e = etapaDe(j); return e ? j[`fecha_etapa${e}`] : null; };
// último movimiento: la fecha de etapa más reciente; si no hay, la fecha de alta
const ultimoMov = (j) => [j.fecha_etapa1, j.fecha_etapa2, j.fecha_etapa3, j.fecha_etapa4].filter(Boolean).sort().pop() || (j.creado || "").slice(0, 10);
function pendientes(j) {
  const p = [];
  if (!/^\d+-\d$/.test(j.vreference || "") && !/^GI\d+$/.test(j.vreference || "")) p.push("vReference sin formato");
  if (j.vref_repetida) p.push("vReference repetida");
  if (!j.abogado_email) p.push("sin abogado");
  if (!j.expediente) p.push("sin expediente");
  else if (!/^\d+\/\d{4}$/.test(j.expediente)) p.push("expediente no es número/año");
  if (!j.juzgado) p.push("sin juzgado");
  if (!j.pasante) p.push("sin pasante");
  ETAPAS.forEach(({ n }) => { if (j[`etapa${n}`] && !j[`fecha_etapa${n}`]) p.push(`E${n} sin fecha`); });
  return p;
}

export default {
  id: "juridico",
  titulo: "Jurídico",
  icono: "⚖",
  roles: ["abogado", "coord_juridico"],

  async montar(cont, ctx) {
    const { h, tabla, numero, toast, descargarCSV, cargarCSS, kpi, confirmar, pedirTexto, fecha } = ctx.ui;
    cargarCSS(new URL("./juridico.css", import.meta.url).href);
    const esCoord = ctx.tieneRol("coord_juridico");

    let datos = [], abogados = [], pasantes = [], vista = "funnel", filtro = { etapa: null, opcion: null }, abierta = null;
    const selAbog = h("select", { class: "campo", onchange: () => pintar() });
    const selPas = h("select", { class: "campo", onchange: () => pintar() });
    const selMov = h("select", { class: "campo", onchange: () => pintar() },
      h("option", { value: "" }, "Cualquier movimiento"), h("option", { value: "60" }, `⏰ Sin movimiento > ${DIAS_ALERTA} días`),
      h("option", { value: "30" }, `Sin movimiento > ${DIAS_AVISO} días`), h("option", { value: "pend" }, "🧹 Con datos incompletos"),
      h("option", { value: "neg" }, "Con resultado negativo"));
    const chkMios = h("input", { type: "checkbox", checked: !esCoord, onchange: () => pintar() });
    const buscar = h("input", { class: "campo", placeholder: "🔍 vReference, nombre, expediente, juzgado, folio…", oninput: () => pintar() });
    const kT = kpi("Juicios activos"), kR = kpi("Resolución favorable"), kM = kpi(`⏰ Sin movimiento > ${DIAS_ALERTA} d`),
      kN = kpi("Resultado negativo"), kP = kpi("🧹 Datos incompletos");
    const embudo = h("div", { class: "jur-embudo" });
    const lbl = h("span", { class: "nota" });
    const det = h("aside", { class: "jur-det", hidden: true });
    const panel = h("div", { class: "jur-panel" });
    const listaJuz = h("datalist", { id: "jur-juzgados" });
    const pestanas = h("div", { class: "jur-pestanas" });

    const pasos = (j) => {
      const e = etapaDe(j);
      return h("span", { class: "jur-pasos", title: `${e ? `Etapa ${e}: ` : ""}${situacion(j)}` },
        ...ETAPAS.map(({ n, corto }) => {
          const v = j[`etapa${n}`];
          return h("i", { title: `${n} · ${corto}${v ? `: ${v}` : ""}`,
            class: !v ? (n < e ? "salto" : "") : NEGATIVAS.has(v) ? "neg" : n === e ? (FAVORABLES.has(v) ? "fav" : "act") : "ok" });
        }));
    };
    const semaforo = (j) => {
      const d = j.dias_sin_mov;
      return h("span", { class: `jur-dias ${d > DIAS_ALERTA ? "rojo" : d > DIAS_AVISO ? "amarillo" : "verde"}`,
        title: `Último movimiento: ${fechaCorta(j.ultimo_mov)}` }, d == null ? "—" : `${d} d`);
    };
    const pill = (j) => h("span", { class: `jur-sit ${NEGATIVAS.has(situacion(j)) ? "neg" : FAVORABLES.has(situacion(j)) ? "fav" : `e${etapaDe(j)}`}` }, situacion(j));

    const t = tabla([
      { clave: "folio", titulo: "Folio" },
      { clave: "vreference", titulo: "vReference" },
      { clave: "nombre", titulo: "Demandado" },
      { clave: "expediente", titulo: "Expediente" },
      { clave: "abogado", titulo: "Abogado" },
      { clave: "pasante", titulo: "Pasante" },
      { clave: "etapa", titulo: "Avance", formato: (_, j) => h("span", { class: "fila", style: { gap: "6px", flexWrap: "nowrap" } }, pasos(j), pill(j)) },
      { clave: "fecha_actual", titulo: "Fecha etapa", formato: (v) => fechaCorta(v) },
      { clave: "dias_sin_mov", titulo: "Sin mov.", num: true, formato: (_, j) => semaforo(j) },
      { clave: "n_pend", titulo: "", formato: (_, j) => h("span", { class: "jur-marcas" },
          j.n_pend ? h("span", { title: pendientes(j).join(" · ") }, "🧹") : "",
          j.adjuntos?.length || j.n_documentos ? h("span", { title: `${j.adjuntos?.length || 0} adjunto(s) SharePoint · ${j.n_documentos} en la página` }, "📎") : "",
          j.es_mio ? h("span", { title: "Asignado a ti" }, "★") : "") },
      { clave: "juzgado", titulo: "Juzgado" },
    ], { idFila: (j) => j.id, claseFila: (j) => (abierta?.id === j.id ? "sel" : ""), vacio: "Sin juicios con ese filtro" });
    t.el.style.maxHeight = "calc(100vh - 360px)"; t.el.classList.add("jur-lista");
    t.el.addEventListener("click", (e) => {
      if (e.target.closest("a,button")) return;
      const j = t.filaDe(e.target.closest("tbody tr")); if (j) abrir(j);
    });

    const barra = h("div", { class: "fila jur-filtros" },
      h("div", { style: { flex: "0 1 230px" } }, selAbog), h("div", { style: { flex: "0 1 230px" } }, selPas),
      h("div", { style: { flex: "0 1 230px" } }, selMov), h("div", { style: { flex: "1 1 220px" } }, buscar),
      h("label", { style: { flex: "0 0 auto" }, title: "Juicios donde eres abogado o pasante" }, chkMios, " Sólo los míos"),
      lbl,
      h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: () => abrir(null) }, "＋ Nuevo juicio"),
      h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => exportar() }, "⬇ Exportar"),
      h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, title: "Recargar", onclick: () => cargar() }, "⟳"),
      ctx.esAdmin ? h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => archivoImp.click(),
        title: "Maestros: carga LEGAL1_export.json (exportación de la lista SharePoint). No pisa juicios ya editados en la página." }, "⬆ Importar LEGAL 1") : null);
    const archivoImp = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: () => importar(archivoImp.files[0]) });

    const raiz = h("div", { class: "jur" },
      h("div", { class: "jur-izq" },
        h("div", { class: "kpis" }, kT.el, kR.el, kM.el, kN.el, kP.el),
        embudo, h("div", { class: "tarjeta" }, pestanas, barra, panel)),
      det);
    cont.append(raiz, listaJuz, archivoImp);

    // ---------------- datos ----------------
    async function cargar() {
      try {
        [datos, abogados, pasantes] = await Promise.all([ctx.rpc("juridico_lista"), ctx.rpc("juridico_abogados"), ctx.rpc("juridico_pasantes_lista")]);
      } catch (e) { toast(e.message, "mal", 8000); return; }
      pasantes = (pasantes || []).map((p) => (typeof p === "string" ? p : Object.values(p)[0]));
      datos.forEach((j) => {
        j.etapa = etapaDe(j); j.fecha_actual = fechaEtapa(j); j.ultimo_mov = ultimoMov(j);
        j.dias_sin_mov = diasDesde(j.ultimo_mov); j.n_pend = pendientes(j).length;
        j.n_documentos = Number(j.n_documentos || 0);
      });
      const pa = selAbog.value, pp = selPas.value;
      const nomAbog = [...new Set(datos.map((j) => j.abogado).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
      selAbog.replaceChildren(h("option", { value: "" }, "Todos los abogados"), ...nomAbog.map((a) => h("option", { value: a }, a)));
      const nomPas = [...new Set([...pasantes, ...datos.map((j) => j.pasante).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "es"));
      selPas.replaceChildren(h("option", { value: "" }, "Todos los pasantes"), ...nomPas.map((a) => h("option", { value: a }, a)));
      selAbog.value = nomAbog.includes(pa) ? pa : ""; selPas.value = nomPas.includes(pp) ? pp : "";
      listaJuz.replaceChildren(...[...new Set(datos.map((j) => j.juzgado).filter(Boolean))].sort().map((v) => h("option", { value: v })));
      if (!datos.some((j) => j.es_mio)) chkMios.checked = false;
      pintar();
      if (abierta) { const j = datos.find((x) => x.id === abierta.id); if (j) abrir(j); }
    }

    function base() {
      const q = buscar.value.trim().toUpperCase(), m = selMov.value;
      return datos.filter((j) => (!chkMios.checked || j.es_mio) && (!selAbog.value || j.abogado === selAbog.value) &&
        (!selPas.value || j.pasante === selPas.value) &&
        (!m || (m === "pend" ? j.n_pend : m === "neg" ? NEGATIVAS.has(situacion(j)) : j.dias_sin_mov > Number(m))) &&
        (!q || [j.folio, j.vreference, j.nombre, j.expediente, j.juzgado, j.abogado, j.pasante].join(" ").toUpperCase().includes(q)));
    }

    function pintar() {
      const b = base();
      kT.set(numero(b.length), `${numero(b.filter((j) => j.etapa === 4).length)} con resolución`);
      const fav = b.filter((j) => FAVORABLES.has(j.etapa4));
      kR.set(numero(fav.length), ["Convenio", "Sentencia Favorable", "Ejecucion"].map((o) => `${b.filter((j) => j.etapa4 === o).length} ${o.toLowerCase()}`).join(" · "), fav.length ? "bien" : "");
      const nM = b.filter((j) => j.dias_sin_mov > DIAS_ALERTA).length;
      kM.set(numero(nM), b.length ? `${Math.round((nM / b.length) * 100)}% de los juicios` : "", nM ? "mal" : "bien");
      const nN = b.filter((j) => NEGATIVAS.has(situacion(j))).length;
      kN.set(numero(nN), "desechada, no emplazado, ilocalizable o en contra", nN ? "alerta" : "");
      const nP = b.filter((j) => j.n_pend).length;
      kP.set(numero(nP), "fechas, expediente, juzgado o pasante", nP ? "alerta" : "bien");

      // embudo
      const max = Math.max(1, ...[0, 1, 2, 3, 4].map((e) => b.filter((j) => j.etapa === e).length));
      const cols = [...(b.some((j) => j.etapa === 0) ? [{ n: 0, titulo: "Sin etapa", opciones: [] }] : []), ...ETAPAS];
      embudo.classList.toggle("sin-cero", cols.length === 4);
      embudo.replaceChildren(...cols.map((et) => {
        const g = b.filter((j) => j.etapa === et.n);
        const act = filtro.etapa === et.n && !filtro.opcion;
        return h("div", { class: `jur-paso e${et.n} ${filtro.etapa === et.n ? "activo" : ""}` },
          h("button", { class: "jur-paso-enc", onclick: () => { filtro = act ? { etapa: null, opcion: null } : { etapa: et.n, opcion: null }; pintar(); } },
            h("div", { class: "jur-barra" }, h("span", { style: { width: `${(g.length / max) * 100}%` } })),
            h("b", {}, numero(g.length)), h("span", {}, et.n ? `${et.n} · ${et.titulo}` : "Sin etapa"),
            h("small", {}, `${numero(g.filter((j) => j.dias_sin_mov > DIAS_ALERTA).length)} sin movimiento > ${DIAS_ALERTA} d`)),
          h("div", { class: "jur-ops" }, ...et.opciones.map((o) => {
            const n = g.filter((j) => j[`etapa${et.n}`] === o).length;
            return n ? h("button", { class: `jur-op ${NEGATIVAS.has(o) ? "neg" : FAVORABLES.has(o) ? "fav" : ""} ${filtro.opcion === o ? "activo" : ""}`,
              title: et.ayuda[o], onclick: () => { filtro = filtro.opcion === o ? { etapa: null, opcion: null } : { etapa: et.n, opcion: o }; pintar(); } },
              `${o} `, h("b", {}, numero(n))) : null;
          })));
      }));

      pestanas.replaceChildren(...[["funnel", "📋 Juicios"], ["abogados", "👤 Por abogado"], ["calidad", "🧹 Calidad de datos"]].map(([k, txt]) =>
        h("button", { class: `jur-tab ${vista === k ? "activo" : ""}`, onclick: () => { vista = k; pintar(); } }, txt)));

      const v = b.filter((j) => filtro.etapa == null || (j.etapa === filtro.etapa && (!filtro.opcion || j[`etapa${filtro.etapa}`] === filtro.opcion)));
      lbl.textContent = `${numero(v.length)} juicios`;
      if (vista === "funnel") { t.setFilas(v); panel.replaceChildren(t.el); }
      else if (vista === "abogados") panel.replaceChildren(porAbogado(v));
      else panel.replaceChildren(calidad(v));
    }

    function porAbogado(v) {
      const grupos = {};
      v.forEach((j) => { const k = j.abogado || "Sin abogado"; (grupos[k] ||= []).push(j); });
      const filas = Object.entries(grupos).sort((a, b) => b[1].length - a[1].length);
      const celda = (lista, nom, f) => {
        const n = lista.filter(f).length;
        return h("td", { class: `num ${n ? "clic" : "cero"}`, onclick: n ? () => { selAbog.value = nom === "Sin abogado" ? "" : nom; vista = "funnel"; pintar(); } : null }, n ? numero(n) : "·");
      };
      return h("div", { class: "tabla-caja", style: { maxHeight: "calc(100vh - 360px)" } }, h("table", { class: "tabla jur-matriz" },
        h("thead", {}, h("tr", {}, h("th", {}, "Abogado"), h("th", { class: "num" }, "Juicios"),
          h("th", { class: "num" }, "Sin etapa"), ...ETAPAS.map((e) => h("th", { class: "num" }, `${e.n} · ${e.corto}`)),
          h("th", { class: "num" }, "Favorable"), h("th", { class: "num" }, "Negativo"),
          h("th", { class: "num" }, `> ${DIAS_ALERTA} d sin mov.`), h("th", { class: "num" }, "Incompletos"),
          h("th", { class: "num" }, "Días prom. sin mov."))),
        h("tbody", {}, ...filas.map(([nom, l]) => h("tr", {},
          h("td", {}, nom), h("td", { class: "num" }, h("b", {}, numero(l.length))),
          celda(l, nom, (j) => j.etapa === 0), ...ETAPAS.map((e) => celda(l, nom, (j) => j.etapa === e.n)),
          celda(l, nom, (j) => FAVORABLES.has(j.etapa4)), celda(l, nom, (j) => NEGATIVAS.has(situacion(j))),
          celda(l, nom, (j) => j.dias_sin_mov > DIAS_ALERTA), celda(l, nom, (j) => j.n_pend),
          h("td", { class: "num" }, numero(Math.round(l.reduce((s, j) => s + (j.dias_sin_mov || 0), 0) / l.length))))))));
    }

    function calidad(v) {
      const conteo = {};
      v.forEach((j) => pendientes(j).forEach((p) => { conteo[p] = (conteo[p] || 0) + 1; }));
      const malos = v.filter((j) => j.n_pend).sort((a, b) => b.n_pend - a.n_pend);
      const tq = tabla([
        { clave: "folio", titulo: "Folio" }, { clave: "vreference", titulo: "vReference" }, { clave: "nombre", titulo: "Demandado" },
        { clave: "abogado", titulo: "Abogado" }, { clave: "n_pend", titulo: "Pendientes", formato: (_, j) => pendientes(j).join(" · ") },
      ], { idFila: (j) => j.id, vacio: "Sin pendientes 🎉" });
      tq.setFilas(malos); tq.el.style.maxHeight = "calc(100vh - 430px)";
      tq.el.addEventListener("click", (e) => { const j = tq.filaDe(e.target.closest("tbody tr")); if (j) abrir(j); });
      return h("div", {},
        h("p", { class: "nota", style: { fontSize: ".85rem" } }, "Checklist del manual: vReference con guion y dígito, abogado asignado, expediente número/año, juzgado, ",
          "y cada etapa con opción debe tener su fecha. Da clic en un juicio para completarlo."),
        h("div", { class: "jur-chips" }, ...Object.entries(conteo).sort((a, b) => b[1] - a[1]).map(([k, n]) => h("span", { class: "jur-chip" }, `${k}: `, h("b", {}, numero(n))))),
        tq.el);
    }

    // ---------------- detalle / edición ----------------
    function abrir(j0) {
      const nuevo = !j0;
      const j = j0 || { id: null, folio: "Nuevo juicio", puede_editar: true, adjuntos: [], es_mio: true };
      abierta = nuevo ? null : j; t.redibujar(); det.hidden = false; raiz.classList.add("con-detalle");
      const editable = !!j.puede_editar;
      const campos = {};
      const marcar = (el) => { el.classList.add("cambiado"); btnGuardar.disabled = false; };
      const campo = (clave, el, original) => {
        campos[clave] = { el, original: original ?? "" };
        el.addEventListener("input", () => marcar(el)); el.addEventListener("change", () => marcar(el));
        return el;
      };
      const input = (clave, attrs = {}) => campo(clave, h("input", { class: "campo", value: j[clave] ?? "", disabled: !editable, ...attrs }), j[clave]);
      const select = (clave, opciones, vacio = "—", deshabilitar = !editable) => {
        const v = j[clave] ?? "";
        const s = h("select", { class: "campo", disabled: deshabilitar }, h("option", { value: "" }, vacio),
          ...opciones.map((o) => (Array.isArray(o) ? h("option", { value: o[0] }, o[1]) : h("option", { value: o }, o))));
        if (v && !opciones.some((o) => (Array.isArray(o) ? o[0] : o) === v)) s.append(h("option", { value: v }, v));
        s.value = v;
        return campo(clave, s, v);
      };
      const et = (txt, el, ancho) => h("label", { class: ancho ? "ancho" : "" }, h("span", { class: "etiqueta" }, txt), el);

      // abogado: coordinación lo elige; el abogado ve el suyo
      const optAbog = abogados.map((a) => [a.email, `${a.nombre}${a.tiene_usuario ? "" : " (sin usuario)"}`]);
      const selAbogado = select("abogado_email", optAbog, "— Elegir abogado —", !(editable && esCoord));
      if (nuevo && !esCoord) { selAbogado.value = ""; selAbogado.replaceChildren(h("option", { value: "" }, ctx.perfil.nombre || ctx.perfil.email)); }
      const chkMP = h("input", { type: "checkbox", checked: !!j.medio_preparatorio, disabled: !editable });
      campos.medio_preparatorio = { el: chkMP, original: String(!!j.medio_preparatorio), check: true };
      chkMP.addEventListener("change", () => { btnGuardar.disabled = false; });

      const btnGuardar = h("button", { class: "btn btn-marca", disabled: true, onclick: () => guardar() }, nuevo ? "💾 Dar de alta" : "💾 Guardar cambios");
      const secciones = ETAPAS.map((e) => seccionEtapa(e));

      function seccionEtapa(e) {
        const sOp = select(`etapa${e.n}`, e.opciones);
        const fEl = input(`fecha_etapa${e.n}`, { type: "date", max: hoy() });
        const ayuda = h("div", { class: "nota" }, e.ayuda[sOp.value] || "");
        sOp.addEventListener("change", () => {
          ayuda.textContent = e.ayuda[sOp.value] || "";
          if (sOp.value && !fEl.value) { fEl.value = hoy(); marcar(fEl); toast(`Revisa la fecha de etapa ${e.n}: debe ser la del acuerdo o diligencia, no la de hoy.`, "", 6000); }
        });
        const obs = j[`obs_e${e.n}`];
        const nota = h("textarea", { class: "campo", rows: 2, placeholder: "Detalle del movimiento (se agrega al final con su fecha)…", disabled: !editable || nuevo });
        const fNota = h("input", { class: "campo", type: "date", value: hoy(), max: hoy(), disabled: !editable || nuevo, style: { maxWidth: "150px" } });
        const btnNota = h("button", { class: "btn btn-primario btn-chico", disabled: !editable || nuevo, onclick: async () => {
          try { await ctx.rpc("juridico_agregar_nota", { p_id: j.id, p_etapa: e.n, p_fecha: fNota.value || null, p_texto: nota.value });
            toast("Observación agregada.", "bien"); await cargar(); } catch (err) { toast(err.message, "mal", 8000); }
        } }, "➕ Agregar");
        const v = j[`etapa${e.n}`];
        return h("section", { class: `jur-sec ${v ? (NEGATIVAS.has(v) ? "neg" : FAVORABLES.has(v) ? "fav" : "con") : ""}` },
          h("h4", {}, `Etapa ${e.n} · ${e.titulo}`),
          h("div", { class: "jur-grid" }, et("Opción", sOp), et(`Fecha de etapa ${e.n} (del acto)`, fEl)),
          ayuda,
          h("div", { class: "etiqueta", style: { marginTop: "6px" } }, `Observaciones E${e.n}`),
          h("pre", { class: "jur-obs" }, obs || "Sin observaciones."),
          editable && !nuevo ? h("div", { class: "fila jur-nota" }, nota, h("div", { style: { flex: "0 0 auto", display: "flex", flexDirection: "column", gap: "4px" } }, fNota, btnNota)) : null);
      }

      const historial = h("details", { class: "jur-hist" }, h("summary", {}, "🕘 Historial de cambios"), h("div", { class: "nota" }, "Cargando…"));
      historial.addEventListener("toggle", async () => {
        if (!historial.open || historial.dataset.ok) return;
        try {
          const hs = await ctx.rpc("juridico_historial", { p_id: j.id });
          historial.dataset.ok = "1";
          historial.replaceChildren(historial.firstChild, h("ul", { class: "jur-hist-l" }, ...(hs.length ? hs.map((x) => h("li", {},
            h("small", {}, `${fecha(x.fecha)} · ${x.quien || ""}`), h("div", {}, h("b", {}, x.campo.replace(/_/g, " ")), ": ",
              x.antes ? h("s", {}, x.antes) : null, x.antes && x.despues ? " → " : "", x.despues || ""))) : [h("li", {}, "Sin cambios registrados en la página (los anteriores están en SharePoint).")])));
        } catch (e) { toast(e.message, "mal"); }
      });

      det.replaceChildren(...[
        h("div", { class: "jur-det-enc" },
          h("div", {}, h("b", {}, j.folio), " ", nuevo ? null : pill(j),
            h("div", { class: "nota" }, nuevo ? "Antes de empezar busca la vReference: si ya existe, no la dupliques."
              : `${j.vreference || ""} · ${j.nombre || ""}${j.origen === "sharepoint" ? ` · migrado de LEGAL 1 (Id ${j.sp_id})` : ""}`),
            !nuevo && j.dias_sin_mov > DIAS_ALERTA ? h("div", { class: "jur-alerta" }, `⏰ ${j.dias_sin_mov} días sin movimiento (último ${fechaCorta(j.ultimo_mov)})`) : null,
            !nuevo && j.n_pend ? h("div", { class: "jur-alerta amarilla" }, `🧹 ${pendientes(j).join(" · ")}`) : null),
          h("button", { class: "btn btn-secundario btn-chico", onclick: cerrar }, "✖")),
        nuevo ? null : h("div", { class: "jur-avance" }, pasos(j), h("span", { class: "nota" }, `Actualizado ${fecha(j.actualizado)} · ${j.actualizado_por || ""}`)),
        h("section", { class: "jur-sec" }, h("h4", {}, "📁 Datos del juicio"),
          h("div", { class: "jur-grid" },
            et("vReference", input("vreference", { placeholder: "1000974336-9" })), et("Demandado (vName)", input("nombre")),
            et("Abogado asignado", selAbogado), et("Pasante", select("pasante", pasantes)),
            et("Expediente", input("expediente", { placeholder: "781/2026" })), et("Juzgado", input("juzgado", { list: "jur-juzgados", placeholder: "JUZGADO 40 DE LO CIVIL DE PROCESO ORAL" })),
            h("label", { class: "ancho jur-check" }, chkMP, " Medio preparatorio"))),
        ...secciones,
        nuevo ? null : h("section", { class: "jur-sec" }, h("h4", {}, "📎 Documentos"),
          bloqueDocumentos(ctx, { juicio: j, editable, alConteo: (n) => { j.n_documentos = n; t.redibujar(); } }),
          j.adjuntos?.length ? h("div", { class: "doc-bloque" }, h("div", { class: "doc-enc" }, h("b", {}, `Adjuntos en SharePoint LEGAL 1 (${j.adjuntos.length})`)),
            h("ul", { class: "jur-adj" }, ...j.adjuntos.map((a) => h("li", {}, h("a", { href: a.url, target: "_blank", rel: "noopener" }, a.nombre))))) : null),
        nuevo ? null : h("section", { class: "jur-sec" }, historial),
        h("div", { class: "jur-pie" },
          editable ? btnGuardar : h("span", { class: "nota" }, `Sólo lectura: lo editan ${j.abogado || "el abogado asignado"}, su pasante o la coordinación jurídica.`),
          !nuevo && esCoord ? h("button", { class: "btn btn-secundario", onclick: () => baja() }, "🗃 Dar de baja") : null)].filter(Boolean));

      async function guardar() {
        const cambios = {};
        for (const [k, c] of Object.entries(campos)) {
          if (c.el.disabled) continue;
          const val = c.check ? String(c.el.checked) : c.el.value;
          if (val !== String(c.original ?? "")) cambios[k] = c.check ? c.el.checked : val;
        }
        if (cambios.abogado_email !== undefined) cambios.abogado = abogados.find((a) => a.email === cambios.abogado_email)?.nombre || "";
        if (!Object.keys(cambios).length) { toast("No hay cambios."); return; }
        if (cambios.vreference) {
          const dup = datos.find((x) => x.vreference === cambios.vreference.trim().toUpperCase() && x.id !== j.id);
          if (dup && !(await confirmar("vReference repetida", `${cambios.vreference} ya está en ${dup.folio} (${dup.nombre || ""}, exp. ${dup.expediente || "s/n"}).\n¿Es otro juicio del mismo crédito?`, "Sí, es otro juicio"))) return;
        }
        btnGuardar.disabled = true;
        try {
          const id = await ctx.rpc("juridico_guardar", { p_id: j.id, p_datos: cambios });
          toast(nuevo ? "Juicio dado de alta. Agrega la observación y adjunta la demanda o acuerdo." : `${j.folio} actualizado.`, "bien", 6000);
          abierta = { id }; await cargar();
        } catch (e) { toast(e.message, "mal", 9000); btnGuardar.disabled = false; }
      }
      async function baja() {
        const motivo = await pedirTexto("Dar de baja", `${j.folio} dejará de verse en el funnel (no se borra). Motivo:`);
        if (!motivo) return;
        try { await ctx.rpc("juridico_baja", { p_id: j.id, p_motivo: motivo }); toast(`${j.folio} dado de baja.`, "bien"); cerrar(); await cargar(); }
        catch (e) { toast(e.message, "mal", 8000); }
      }
    }
    function cerrar() { abierta = null; det.hidden = true; raiz.classList.remove("con-detalle"); t.redibujar(); }

    function exportar() {
      const cols = [["folio", "Folio"], ["sp_id", "Id LEGAL 1"], ["vreference", "vReference"], ["nombre", "vName"], ["abogado", "Abogado Asignado"],
        ["expediente", "Expediente"], ["juzgado", "Juzgado"], ["medio_preparatorio", "Medio preparatorio"],
        ["etapa1", "Etapa 1"], ["fecha_etapa1", "Fecha de Etapa 1"], ["obs_e1", "Observaciones E1"],
        ["etapa2", "Etapa 2"], ["fecha_etapa2", "Fecha de Etapa 2"], ["obs_e2", "Observaciones E2"],
        ["etapa3", "Etapa 3"], ["fecha_etapa3", "Fecha de Etapa 3"], ["obs_e3", "Observaciones E3"],
        ["etapa4", "Etapa 4"], ["fecha_etapa4", "Fecha de Etapa 4"], ["obs_e4", "Observaciones E4"],
        ["pasante", "Pasante"], ["etapa", "Etapa actual"], ["dias_sin_mov", "Dias sin movimiento"], ["actualizado_por", "Modificado por"]];
      const fechas = new Set(cols.map(([k]) => k).filter((k) => k.startsWith("fecha")));
      const v = base().filter((j) => filtro.etapa == null || (j.etapa === filtro.etapa && (!filtro.opcion || j[`etapa${filtro.etapa}`] === filtro.opcion)));
      descargarCSV(`Juridico_Funnel_${hoy()}.csv`, cols.map(([, t2]) => t2),
        v.map((j) => Object.fromEntries(cols.map(([k, t2]) => [t2, fechas.has(k) ? fechaCorta(j[k]) : k === "medio_preparatorio" ? (j[k] ? "Sí" : "No") : j[k] ?? ""]))));
    }

    // Migración / re-sincronización desde SharePoint LEGAL 1 (sólo maestros)
    async function importar(file) {
      archivoImp.value = "";
      if (!file) return;
      const SP = "https://exituscredit365-my.sharepoint.com/personal/alfredo_ortiz_exitus_com/Lists/LEGAL%201/Attachments/";
      let filas;
      try {
        const crudo = JSON.parse(await file.text());
        filas = crudo.map((r) => (!Array.isArray(r) ? r : {
          sp_id: r[0], vreference: r[1], nombre: r[2], abogado_email: r[3], abogado: r[4], expediente: r[5], juzgado: r[6], medio_preparatorio: !!r[7],
          etapa1: r[8], fecha_etapa1: r[9], obs_e1: r[10], etapa2: r[11], fecha_etapa2: r[12], obs_e2: r[13],
          etapa3: r[14], fecha_etapa3: r[15], obs_e3: r[16], etapa4: r[17], fecha_etapa4: r[18], obs_e4: r[19],
          pasante: r[20], creado: r[21], actualizado: r[22], creado_por: r[23], actualizado_por: r[24],
          adjuntos: (r[25] || []).map((f) => ({ nombre: f, url: `${SP}${r[0]}/${encodeURIComponent(f)}` })) }));
        if (!filas.length || filas.some((f) => !f.sp_id)) throw new Error("El archivo no es una exportación de LEGAL 1");
      } catch (e) { toast(`No se pudo leer ${file.name}: ${e.message}`, "mal", 9000); return; }
      if (!(await confirmar("Importar LEGAL 1", `${numero(filas.length)} juicios de ${file.name}.\nLos ya migrados se actualizan con lo de SharePoint, salvo los que ya se editaron en la página.`, "Importar"))) return;
      let n = 0;
      try {
        for (let i = 0; i < filas.length; i += 100) {
          n += await ctx.rpc("juridico_importar", { p_filas: filas.slice(i, i + 100) });
          lbl.textContent = `Importando… ${numero(Math.min(i + 100, filas.length))} / ${numero(filas.length)}`;
        }
        toast(`${numero(n)} juicios importados de LEGAL 1.`, "bien", 7000);
      } catch (e) { toast(e.message, "mal", 9000); }
      await cargar();
    }

    await cargar();
  },
};
