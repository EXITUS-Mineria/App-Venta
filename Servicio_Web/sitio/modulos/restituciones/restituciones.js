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

    // ---- panel: original ----
    const inTexto = h("input", { class: "campo", placeholder: "vReference o grupo (vGroupId)",
      onkeydown: (e) => { if (e.key === "Enter") validar(); } });
    const btnValidar = h("button", { class: "btn btn-primario", onclick: () => validar() }, "✔ Validar en bases");
    const ficha = h("div", { class: "rst-ficha vacia" }, "Escribe la vReference o el grupo y da clic en Validar.");

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
          h("h3", {}, "1 · Crédito o grupo a restituir"),
          h("div", { class: "fila" }, inTexto, h("span", { style: { flex: "0 0 auto" } }, btnValidar)),
          h("p", { class: "nota", style: { margin: "6px 0 10px" } },
            "Si escribes la vReference de un integrante de grupo se restituye el grupo completo."),
          ficha),
        h("div", { class: "tarjeta" },
          h("h3", {}, "2 · Motivo y criterio"),
          h("span", { class: "etiqueta" }, "Motivo"), selMotivo,
          h("div", { class: "fila", style: { marginTop: "4px" } },
            h("div", {}, h("span", { class: "etiqueta" }, "Capital similar ± (máx. 5,000)"), inTol),
            h("label", { style: { alignSelf: "flex-end", paddingBottom: "8px" } }, chkEstado, " Mismo estado")),
          h("span", { class: "etiqueta" }, "Comentario"), inComentario,
          h("div", { style: { marginTop: "12px" } }, btnBuscar))),
      h("div", { class: "rst-der" },
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "3 · Reemplazos sugeridos"), lblCand),
          tCand.el),
        h("div", { class: "tarjeta" },
          h("div", { class: "fila", style: { marginBottom: "8px", justifyContent: "flex-start" } },
            h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "🔁 Historial de restituciones"),
            h("label", { style: { flex: "0 0 auto" } }, chkMias, " Sólo mías"),
            h("span", { style: { flex: 1 } }),
            h("button", { class: "btn btn-secundario btn-chico", style: { flex: "0 0 auto" }, onclick: () => cargarHistorial() }, "⟳")),
          tHist.el))));

    function actualizarBoton() { btnBuscar.disabled = !(original && original.vendido && !original.bloqueado); }

    async function validar() {
      const texto = inTexto.value.trim();
      if (!texto) { inTexto.focus(); return; }
      btnValidar.disabled = true; original = null; tCand.setFilas([]); lblCand.textContent = "";
      try {
        original = await ctx.rpc("validar_restitucion", { p_texto: texto });
        pintarFicha();
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
      else if (!o.disponible_en_base) { estado = `Vendido antes de la página (Estatus en base: ${o.estatus_base}). Se creará una propuesta de restitución.`; clase = "bien"; }
      else { estado = "Está Disponible y no está en ninguna propuesta: no requiere restitución."; clase = "mal"; }
      ficha.className = `rst-ficha ${clase}`;
      ficha.replaceChildren(
        h("div", { class: "rst-titulo" }, h("b", {}, `${o.tipo === "Grupal" ? "Grupo" : "Crédito JyP"} ${o.clave}`),
          o.buscado.toUpperCase() !== o.clave.toUpperCase() ? h("small", {}, ` (buscaste ${o.buscado})`) : null),
        h("div", { class: "rst-datos" },
          dato("Capital", dinero(o.capital)), dato("Créditos", numero(o.integrantes)), dato("Mora", dias(o.dias)),
          dato("Estado", o.estados || "—"), dato("Municipio", o.municipios || "—")),
        h("div", { class: "rst-estado" }, estado));
    }
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
          p_motivo: selMotivo.value, p_comentario: inComentario.value.trim() });
        await avisar(`Restitución ${r.id_restitucion}`,
          `${r.original} → ${r.reemplazo}\nDiferencia: ${dinero(r.diferencia)}\nPropuesta: ${r.id_propuesta}` +
          (r.propuesta_nueva ? " (nueva, APROBADA)" : "") +
          "\n\nSe avisó al validador y al auxiliar de venta para generar la sub base.");
        inTexto.value = ""; inComentario.value = ""; selMotivo.value = ""; original = null;
        ficha.className = "rst-ficha vacia"; ficha.textContent = "Escribe la vReference o el grupo y da clic en Validar.";
        tCand.setFilas([]); lblCand.textContent = ""; actualizarBoton();
        ctx.refrescarAvisos(); cargarHistorial();
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

    inTexto.focus();
    await cargarHistorial();
  },
};
