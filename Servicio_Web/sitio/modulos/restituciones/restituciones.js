// ============================================================
// MÓDULO: Restituciones
// Cambiar un crédito o grupo vendido por otro disponible de capital similar (±$5,000).
// Motivos: Defunción, Liquidado, Venta duplicada, Incidencia en el expediente.
// ============================================================
const MOTIVOS = ["Defunción", "Liquidado", "Venta duplicada", "Incidencia en el expediente"];
const TOLERANCIA_MAX = 5000;

export default {
  id: "restituciones",
  titulo: "Restituciones",
  icono: "🔁",
  roles: ["vendedor", "auxiliar"],

  async montar(cont, ctx) {
    const { h, tabla, kpi, dinero, numero, dias, fecha, toast, confirmar, avisar, cargarCSS } = ctx.ui;
    cargarCSS(new URL("./restituciones.css", import.meta.url).href);

    let original = null;

    // ---- panel: venta → crédito / grupo ----
    let ventas = [];
    const inBuscaVenta = h("input", { class: "campo", placeholder: "🔎 Folio, comprador o vendedor", oninput: () => llenarVentas() });
    const selVenta = h("select", { class: "campo", onchange: () => elegirVenta() });
    const inBuscaPart = h("input", { class: "campo", placeholder: "🔎 Filtrar por clave o nombre", oninput: () => filtrarPartidas() });
    let partidas = [];
    const tPart = tabla([
      { clave: "elegir", titulo: "", formato: (_, f) => f.restituido
        ? h("span", { class: "nota", title: `Restituido en ${f.restituido}` }, "🔒")
        : h("button", { class: "btn btn-marca btn-chico", onclick: () => elegirPartida(f) }, "Elegir") },
      { clave: "clave", titulo: "Grupo / vReference" },
      { clave: "nombre", titulo: "Nombre / grupo" },
      { clave: "integrantes", titulo: "Créd.", num: true },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => (v == null ? "—" : dinero(v)) },
      { clave: "saldo_total", titulo: "Saldo", num: true, formato: (v) => (v == null ? "—" : dinero(v)) },
      { clave: "dias", titulo: "Mora", num: true, formato: (v) => (v == null ? "—" : dias(v)) },
    ], { idFila: (f) => f.tipo + f.clave, vacio: "Elige una venta para ver sus créditos y grupos." });
    tPart.el.style.maxHeight = "220px";
    const lblPart = h("span", { class: "nota" });

    // ---- panel: original ----
    const inTexto = h("input", { class: "campo", placeholder: "vReference o grupo (vGroupId), también de ventas viejas",
      onkeydown: (e) => { if (e.key === "Enter") validar(); } });
    const btnValidar = h("button", { class: "btn btn-primario", onclick: () => validar() }, "✔ Validar en bases");
    const ficha = h("div", { class: "rst-ficha vacia" }, "Escribe la vReference o el grupo y da clic en Validar.");
    // capital del original cuando el archivo de la venta histórica no lo traía
    const inCapital = h("input", { class: "campo", type: "number", min: 0, step: "0.01", placeholder: "Capital del crédito/grupo vendido",
      oninput: () => { if (original) { original.capital = Number(inCapital.value) || null; actualizarBoton(); } } });
    const cajaCapital = h("div", { hidden: true, style: { marginTop: "8px" } },
      h("span", { class: "etiqueta" }, "Capital original (no venía en el archivo de la venta)"), inCapital);

    // ---- panel: reemplazo ----
    const selMotivo = h("select", { class: "campo" }, h("option", { value: "" }, "— Selecciona el motivo —"),
      ...MOTIVOS.map((m) => h("option", { value: m }, m)));
    const inTol = h("input", { class: "campo", type: "number", min: 0, max: TOLERANCIA_MAX, step: 500, value: TOLERANCIA_MAX });
    const chkEstado = h("input", { type: "checkbox" });
    const inComentario = h("input", { class: "campo", placeholder: "Comentario (opcional): acta, folio, observación…" });
    const btnBuscar = h("button", { class: "btn btn-marca", disabled: true, onclick: () => buscar() }, "🔎 Buscar reemplazo");
    const lblCand = h("span", { class: "nota" });

    const tCand = tabla([
      { clave: "usar", titulo: "", formato: (_, f) => h("button", { class: "btn btn-marca btn-chico", onclick: () => aplicar(f) }, "Usar este") },
      { clave: "clave", titulo: "Grupo / vReference" },
      { clave: "integrantes", titulo: "Créditos", num: true },
      { clave: "estados", titulo: "Estado" },
      { clave: "municipios", titulo: "Municipio" },
      { clave: "dias", titulo: "Mora", num: true, formato: (v) => dias(v) },
      { clave: "capital", titulo: "Capital", num: true, formato: (v) => dinero(v) },
      { clave: "diferencia", titulo: "Diferencia", num: true,
        formato: (v) => h("span", { style: { color: Math.abs(v) <= 1000 ? "var(--bien)" : "var(--texto-2)", fontWeight: 700 } },
          (v > 0 ? "+" : "") + dinero(v)) },
    ], { idFila: (f) => f.clave, vacio: "Valida un crédito o grupo vendido y busca su reemplazo." });
    tCand.el.style.maxHeight = "calc(100vh - 470px)";
    tCand.el.style.minHeight = "160px";

    // ---- ventas duplicadas: un crédito o grupo en más de una venta ----
    const lblDup = h("span", { class: "nota" });
    const tDup = tabla([
      { clave: "tipo", titulo: "Tipo" },
      { clave: "clave", titulo: "Grupo / vReference" },
      { clave: "n_ventas", titulo: "Ventas", num: true },
      { clave: "ventas", titulo: "Vendido en", formato: (v, f) => h("span", { class: "rst-dup-ventas" },
        ...(v || []).map((x) => h("button", {
          class: "btn btn-secundario btn-chico", disabled: !x.visible,
          title: [x.comprador, x.vendedor, x.estatus, x.fecha ? fecha(x.fecha) : ""].filter(Boolean).join(" · "),
          onclick: () => restituirDuplicado(f, x.folio) }, x.folio))) },
      { clave: "integrantes_repetidos", titulo: "Integrantes repetidos", num: true, formato: (v, f) => (f.tipo === "JyP" ? "—" : numero(v)) },
      { clave: "restituido", titulo: "Restituido", formato: (v) => (v ? `🔒 ${v}` : h("span", { class: "rst-dup-pend" }, "Pendiente")) },
    ], { idFila: (f) => f.tipo + f.clave, vacio: "✔ Ningún crédito o grupo aparece en más de una venta." });
    tDup.el.style.maxHeight = "260px";

    // ---- historial ----
    const chkMias = h("input", { type: "checkbox", checked: ctx.perfil.rol === "vendedor", onchange: () => cargarHistorial() });
    const tHist = tabla([
      { clave: "id_restitucion", titulo: "Folio" },
      { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
      { clave: "usuario", titulo: "Usuario" },
      { clave: "motivo", titulo: "Motivo" },
      { clave: "tipo_cartera", titulo: "Tipo" },
      { clave: "clave_original", titulo: "Original" },
      { clave: "capital_original", titulo: "Capital orig.", num: true, formato: (v) => dinero(v) },
      { clave: "clave_reemplazo", titulo: "Reemplazo" },
      { clave: "capital_reemplazo", titulo: "Capital reemp.", num: true, formato: (v) => dinero(v) },
      { clave: "diferencia", titulo: "Dif.", num: true, formato: (v) => dinero(v) },
      { clave: "id_propuesta_reemplazo", titulo: "Propuesta" },
      { clave: "comentario", titulo: "Comentario" },
    ], { idFila: (f) => f.id_restitucion, vacio: "Sin restituciones" });
    tHist.el.style.maxHeight = "320px";

    cont.append(h("div", { class: "rst" },
      h("div", { class: "rst-izq" },
        h("div", { class: "tarjeta" },
          h("h3", {}, "1 · Venta"),
          h("div", { class: "fila" }, inBuscaVenta),
          h("div", { class: "fila", style: { marginTop: "6px" } }, selVenta),
          h("h3", { style: { marginTop: "12px" } }, "2 · Crédito o grupo a restituir"),
          h("div", { class: "fila", style: { marginBottom: "6px" } }, inBuscaPart, lblPart),
          tPart.el,
          h("span", { class: "etiqueta", style: { marginTop: "10px" } }, "…o escríbelo directamente"),
          h("div", { class: "fila" }, inTexto, h("span", { style: { flex: "0 0 auto" } }, btnValidar)),
          h("p", { class: "nota", style: { margin: "6px 0 10px" } },
            "Si escribes la vReference de un integrante de grupo se restituye el grupo completo."),
          ficha, cajaCapital),
        h("div", { class: "tarjeta" },
          h("h3", {}, "3 · Motivo y criterio"),
          h("span", { class: "etiqueta" }, "Motivo"), selMotivo,
          h("div", { class: "fila", style: { marginTop: "4px" } },
            h("div", {}, h("span", { class: "etiqueta" }, "Capital similar ± (máx. 5,000)"), inTol),
            h("label", { style: { alignSelf: "flex-end", paddingBottom: "8px" } }, chkEstado, " Mismo estado")),
          h("span", { class: "etiqueta" }, "Comentario"), inComentario,
          h("div", { style: { marginTop: "12px" } }, btnBuscar))),
      h("div", { class: "rst-der" },
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "4 · Reemplazos sugeridos"), lblCand),
          tCand.el),
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px", justifyContent: "flex-start" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "⚠ Ventas duplicadas"), lblDup,
            h("span", { style: { flex: 1 } }),
            h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => cargarDuplicados() }, "⟳")),
          h("p", { class: "nota", style: { margin: "0 0 8px" } },
            "Cada venta debe llevar créditos y grupos distintos. Da clic en el folio de la venta donde se va a restituir."),
          tDup.el),
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px", justifyContent: "flex-start" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "🔁 Historial de restituciones"),
            h("label", { style: { flex: "0 0 auto" } }, chkMias, " Sólo mías"),
            h("span", { style: { flex: 1 } }),
            h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => cargarHistorial() }, "⟳")),
          tHist.el))));

    // ---- ventas y partidas ----
    const etiquetaVenta = (v) => `${v.folio}${v.comprador ? " · " + v.comprador : ""}${v.vendedor ? " · " + v.vendedor : ""} · ${numero(v.partidas)} partidas${v.origen === "histórico" ? " (histórica)" : ""}`;
    async function cargarVentas() {
      try { ventas = (await ctx.rpc("restitucion_ventas")) || []; } catch (e) { ventas = []; toast(e.message, "mal"); }
      llenarVentas();
    }
    function llenarVentas() {
      const q = inBuscaVenta.value.trim().toLowerCase();
      const lista = ventas.filter((v) => !q || [v.folio, v.id_propuesta, v.comprador, v.vendedor].some((x) => String(x || "").toLowerCase().includes(q)));
      const previo = selVenta.value;
      selVenta.replaceChildren(h("option", { value: "" }, lista.length ? `— Selecciona la venta (${numero(lista.length)}) —` : "Sin ventas"),
        ...lista.map((v) => h("option", { value: v.folio }, etiquetaVenta(v))));
      if (lista.some((v) => v.folio === previo)) selVenta.value = previo;
      else if (q && lista.length === 1) { selVenta.value = lista[0].folio; elegirVenta(); }
    }
    async function elegirVenta(folio) {
      if (folio) { if (!ventas.some((v) => v.folio === folio)) return; inBuscaVenta.value = ""; llenarVentas(); selVenta.value = folio; }
      partidas = []; inBuscaPart.value = ""; lblPart.textContent = "";
      if (!selVenta.value) { tPart.setFilas([]); return; }
      try {
        partidas = ((await ctx.rpc("restitucion_partidas", { p_folio: selVenta.value })) || [])
          .map((f) => ({ ...f, capital: f.capital == null ? null : Number(f.capital), saldo_total: f.saldo_total == null ? null : Number(f.saldo_total) }));
      } catch (e) { toast(e.message, "mal"); }
      filtrarPartidas();
    }
    function filtrarPartidas() {
      const q = inBuscaPart.value.trim().toLowerCase();
      const lista = partidas.filter((f) => !q || [f.clave, f.nombre].some((x) => String(x || "").toLowerCase().includes(q)));
      tPart.setFilas(lista);
      const rest = partidas.filter((f) => f.restituido).length;
      lblPart.textContent = partidas.length ? `${numero(lista.length)} de ${numero(partidas.length)}${rest ? ` · ${rest} ya restituidas` : ""}` : "";
    }
    async function cargarDuplicados() {
      try {
        const filas = (await ctx.rpc("ventas_duplicadas")) || [];
        tDup.setFilas(filas);
        const pend = filas.filter((f) => !f.restituido).length;
        lblDup.textContent = filas.length ? `${numero(filas.length)} repetidos · ${numero(pend)} pendientes` : "";
        lblDup.className = pend ? "nota rst-dup-alerta" : "nota";
      } catch (e) { toast(e.message, "mal"); }
    }
    async function restituirDuplicado(f, folio) {
      if (folio) await elegirVenta(folio);
      if (!selVenta.value) inBuscaVenta.value = "";
      if (!f.restituido) selMotivo.value = "Venta duplicada";
      inTexto.value = f.clave; validar();
      cont.querySelector(".rst-izq")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
    function elegirPartida(f) { inTexto.value = f.clave; validar(); }

    function actualizarBoton() { btnBuscar.disabled = !(original && original.vendido && !original.bloqueado && original.capital > 0); }

    async function validar() {
      const texto = inTexto.value.trim();
      if (!texto) { inTexto.focus(); return; }
      btnValidar.disabled = true; original = null; tCand.setFilas([]); lblCand.textContent = "";
      cajaCapital.hidden = true; inCapital.value = "";
      try {
        original = await ctx.rpc("validar_restitucion", { p_texto: texto });
        original.capital = original.capital == null ? null : Number(original.capital);
        original.sinCapital = !(original.capital > 0);
        cajaCapital.hidden = !(original.sinCapital && original.vendido && !original.bloqueado);
        pintarFicha();
        const folioVenta = original.venta?.folio || original.venta?.id_propuesta || original.id_propuesta;
        const yaEnVenta = selVenta.value && partidas.some((f) => f.clave === original.clave);
        if (folioVenta && folioVenta !== selVenta.value && !yaEnVenta) elegirVenta(folioVenta);
      } catch (e) {
        ficha.className = "rst-ficha mal";
        ficha.replaceChildren(h("b", {}, "✖ "), e.message);
      }
      btnValidar.disabled = false; actualizarBoton();
    }

    function pintarFicha() {
      const o = original;
      let estado, clase;
      if (o.bloqueado) { estado = `Ya restituido (${o.restitucion} · ${o.motivo_bloqueo}). No se puede restituir de nuevo.`; clase = "mal"; }
      else if (o.id_propuesta) { estado = `En propuesta ${o.id_propuesta} · ${o.estatus_propuesta} · ${o.usuario_propuesta}`; clase = "bien"; }
      else if (o.venta?.historico) {
        estado = `Vendido en ${o.venta.folio} (venta anterior a la página)` + (o.en_base === false ? "; ya no viene en la base del mes" : "") +
          ". Se creará una propuesta de restitución." + (o.sinCapital ? " Captura el capital original para buscar reemplazo." : "");
        clase = "bien";
      }
      else if (!o.disponible_en_base) { estado = `Vendido antes de la página (Estatus en base: ${o.estatus_base}). Se creará una propuesta de restitución.`; clase = "bien"; }
      else { estado = "Está Disponible y no está en ninguna propuesta: no requiere restitución."; clase = "mal"; }
      ficha.className = `rst-ficha ${clase}`;
      ficha.replaceChildren(
        h("div", { class: "rst-titulo" }, h("b", {}, `${o.tipo === "Grupal" ? "Grupo" : "Crédito JyP"} ${o.clave}`),
          o.buscado.toUpperCase() !== o.clave.toUpperCase() ? h("small", {}, ` (buscaste ${o.buscado})`) : null),
        h("div", { class: "rst-datos" },
          dato("Capital", o.capital > 0 ? dinero(o.capital) : "—"), dato("Créditos", o.integrantes == null ? "—" : numero(o.integrantes)),
          dato("Mora", o.dias == null ? "—" : dias(o.dias)),
          dato("Estado", o.estados || "—"), dato("Municipio", o.municipios || "—")),
        h("div", { class: "rst-estado" }, estado),
        bloqueVenta(o),
        bloqueDetalle(o));
    }

    // Saldos y datos del crédito / integrantes tal como venían en el archivo de la venta histórica
    function bloqueDetalle(o) {
      const d = o.detalle_historico;
      if (!d || !d.filas?.length) return null;
      const din = (v) => (v == null ? "—" : dinero(v));
      const cols = [["vreference", "vReference"], ["nombre", "Nombre"], ["capital", "Capital", din], ["saldo_total", "Saldo total", din],
        ["saldo_vencido", "Saldo vencido", din], ["dias", "Mora", (v) => (v == null ? "—" : dias(v))], ["monto", "Monto otorgado", din],
        ["apertura", "Apertura"], ["ult_pago", "Últ. pago"], ["frecuencia", "Frecuencia"], ["plazo", "Plazo"],
        ["estatus_cred", "Estatus"], ["municipio", "Municipio"], ["colonia", "Colonia"]];
      const usadas = cols.filter(([k]) => d.filas.some((f) => f[k] != null && f[k] !== ""));
      return h("div", { class: "rst-venta rst-detalle" },
        h("div", { class: "rst-venta-tit" }, "📋 Así venía en la venta ", h("b", {}, d.folio),
          d.grupo ? h("small", {}, ` · grupo ${d.grupo}`) : null),
        h("div", { class: "rst-datos" },
          dato(o.tipo === "Grupal" ? "Integrantes" : "Créditos", numero(d.creditos)),
          dato("Capital", din(d.capital)), dato("Saldo total", din(d.saldo_total)),
          d.saldo_vencido != null ? dato("Saldo vencido", din(d.saldo_vencido)) : null,
          d.saldo_grupal != null ? dato("Saldo grupal", din(d.saldo_grupal)) : null,
          d.monto != null ? dato("Monto otorgado", din(d.monto)) : null,
          dato("Mora prom.", d.dias == null ? "—" : dias(d.dias)),
          dato("Estado", d.estados || "—"), dato("Municipio", d.municipios || "—")),
        h("div", { class: "rst-det-tabla" }, h("table", { class: "tabla-simple" },
          h("thead", {}, h("tr", {}, ...usadas.map(([, t]) => h("th", {}, t)))),
          h("tbody", {}, ...d.filas.map((f) => h("tr", {}, ...usadas.map(([k, , fmt]) =>
            h("td", { class: fmt ? "num" : "" }, fmt ? fmt(f[k]) : (f[k] ?? "—")))))))));
    }

    // Venta a la que pertenece el crédito / grupo
    function bloqueVenta(o) {
      const v = o.venta;
      if (!v) {
        return o.vendido && !o.disponible_en_base
          ? h("div", { class: "rst-venta nota" }, "Venta anterior a la página: no hay liga crédito → venta en el sistema.")
          : null;
      }
      const titulo = h("div", { class: "rst-venta-tit" }, "🧾 Venta a la que pertenece: ",
        h("b", {}, v.folio || v.id_propuesta), v.folio && v.id_propuesta && v.folio !== v.id_propuesta ? h("small", {}, ` · ${v.id_propuesta}`) : null);
      if (v.restringida) {
        return h("div", { class: "rst-venta" }, titulo,
          h("div", { class: "rst-datos" }, dato("Comprador", v.comprador || "—"), dato("Vendedor", v.vendedor || "—")),
          notaHistorico(v),
          h("div", { class: "nota" }, "La venta es de otro responsable; el detalle sólo lo ven su vendedor, admin y validador."));
      }
      return h("div", { class: "rst-venta" }, titulo,
        h("div", { class: "rst-datos" },
          dato("Comprador", v.comprador || "—"), dato("Vendedor", v.vendedor || "—"), dato("Tipo", v.tipo || "—"),
          dato("Estatus", v.estatus_venta || v.estatus_propuesta || "—"),
          dato("Fecha venta", v.fecha_venta ? fecha(v.fecha_venta) : "—"),
          dato("Fecha propuesta", v.fecha_propuesta ? fecha(v.fecha_propuesta) : "—"),
          dato("Capital venta", v.capital != null ? dinero(v.capital) : "—"),
          dato("Monto venta", v.monto_venta != null ? dinero(v.monto_venta) : "—"),
          dato("Precio", v.centavos != null ? `${Math.round(v.centavos * 100)}¢` : "—"),
          dato("Partidas", v.partidas != null ? numero(v.partidas) : "—"),
          v.estatus_control_doc ? dato("Control doc.", v.estatus_control_doc) : null,
          v.numero_guia ? dato("Guía", v.numero_guia) : null),
        notaHistorico(v));
    }
    const notaHistorico = (v) => (v.historico || v.otras_ventas?.length) ? h("div", { class: "nota" },
      v.historico ? `Histórico: tomado de ${v.archivo || "los archivos de la venta"} en SharePoint.` : "",
      v.otras_ventas?.length ? ` También aparece en: ${v.otras_ventas.join(", ")}.` : "") : null;
    const dato = (t, v) => h("div", {}, h("span", {}, t), h("b", {}, v));

    async function buscar() {
      if (!original) return;
      const tol = Math.min(Math.max(Number(inTol.value) || 0, 0), TOLERANCIA_MAX);
      inTol.value = tol;
      btnBuscar.disabled = true; lblCand.textContent = "Buscando…";
      try {
        const filas = await ctx.rpc("sugerir_restitucion", {
          p_tipo: original.tipo, p_capital: original.capital, p_tolerancia: tol,
          p_estado: chkEstado.checked ? original.estado_n : null });
        tCand.setFilas(filas.map((f) => ({ ...f, capital: Number(f.capital), diferencia: Number(f.diferencia),
          integrantes: Number(f.integrantes), dias: f.dias === null ? null : Number(f.dias) })));
        lblCand.textContent = filas.length
          ? `${filas.length} opciones entre ${dinero(Math.max(0, original.capital - tol))} y ${dinero(original.capital + tol)} (las más cercanas primero)`
          : `Sin opciones disponibles en ±${dinero(tol)}${chkEstado.checked ? " en el mismo estado" : ""}.`;
      } catch (e) { toast(e.message, "mal"); lblCand.textContent = ""; }
      actualizarBoton();
    }

    async function aplicar(c) {
      if (!selMotivo.value) { toast("Selecciona el motivo de la restitución.", "mal"); selMotivo.focus(); return; }
      const ok = await confirmar("Aplicar restitución",
        `Motivo: ${selMotivo.value}\n\nSale: ${original.clave} · ${dinero(original.capital)}\nEntra: ${c.clave} · ${dinero(c.capital)}\n` +
        `Diferencia: ${dinero(c.diferencia)}\n\n` +
        (original.id_propuesta ? `El reemplazo entra a la propuesta ${original.id_propuesta}.` : "Se creará una propuesta de restitución (APROBADA) para que el auxiliar genere la sub base.") +
        `\n${original.clave} quedará bloqueado y no se volverá a ofrecer.`, "Aplicar");
      if (!ok) return;
      try {
        const r = await ctx.rpc("aplicar_restitucion", { p_original: original.clave, p_reemplazo: c.clave,
          p_motivo: selMotivo.value, p_comentario: inComentario.value.trim(),
          p_capital_original: original.sinCapital ? original.capital : null });
        await avisar(`Restitución ${r.id_restitucion}`,
          `${r.original} → ${r.reemplazo}\nDiferencia: ${dinero(r.diferencia)}\nPropuesta: ${r.id_propuesta}` +
          (r.propuesta_nueva ? " (nueva, APROBADA)" : "") +
          "\n\nSe avisó al validador y al auxiliar de venta para generar la sub base.");
        inTexto.value = ""; inComentario.value = ""; selMotivo.value = ""; original = null;
        cajaCapital.hidden = true; inCapital.value = "";
        ficha.className = "rst-ficha vacia"; ficha.textContent = "Escribe la vReference o el grupo y da clic en Validar.";
        tCand.setFilas([]); lblCand.textContent = ""; actualizarBoton();
        ctx.refrescarAvisos(); cargarHistorial(); cargarDuplicados(); if (selVenta.value) elegirVenta();
      } catch (e) { toast(e.message, "mal", 9000); }
    }

    async function cargarHistorial() {
      let q = ctx.sb.from("restituciones").select("*").order("fecha", { ascending: false }).limit(2000);
      if (chkMias.checked) q = q.eq("user_id", ctx.perfil.user_id);
      const { data, error } = await q;
      if (error) { toast(error.message, "mal"); return; }
      tHist.setFilas(data.map((r) => ({ ...r, capital_original: Number(r.capital_original),
        capital_reemplazo: Number(r.capital_reemplazo), diferencia: Number(r.diferencia) })));
    }

    inBuscaVenta.focus();
    await Promise.all([cargarHistorial(), cargarVentas(), cargarDuplicados()]);
    // llegada desde «Ventas duplicadas»: #/restituciones?venta=VTA-0205&clave=G199051
    const qs = new URLSearchParams((location.hash.split("?")[1]) || "");
    if (qs.get("clave")) {
      await restituirDuplicado({ clave: qs.get("clave"), restituido: null }, qs.get("venta") || "");
      history.replaceState(null, "", "#/restituciones");
    }
  },
};
