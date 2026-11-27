// ============================================================
// MÓDULO: Brokers (interno)
//  Brokers: alta, accesos al portal, validación de documentos (aprobar / rechazar con motivo) y validación del alta.
//  Propuestas de inversión: las que mandan los brokers desde su portal; se aceptan o rechazan y se descargan sus créditos.
//  Tarifas: precio por peso de capital JyP y Grupal con que se arma la propuesta del broker.
// Editar, validar y responder: validador / admin. El auxiliar de venta consulta.
// ============================================================
import { bloqueDocsBroker, tablaPropuesta, descargarCreditos, pildora, ESTATUS_BROKER, ESTATUS_DOC, ESTATUS_PROP, nombreDoc, cent } from "./comun.js";

export default {
  id: "brokers",
  titulo: "Brokers",
  icono: "💼",
  roles: ["auxiliar", "validador", "admin"],

  async montar(cont, ctx) {
    const { h } = ctx.ui;
    ctx.ui.cargarCSS(new URL("./brokers.css", import.meta.url).href);
    const maestro = ctx.esAdmin;
    let pestana = "brokers";
    const tabs = h("div", { class: "segmentado pestanas", role: "tablist" });
    const cuerpo = h("div", { class: "brk-cuerpo" });
    const pintarTabs = () => tabs.replaceChildren(...[["brokers", "Brokers"], ["propuestas", "Propuestas de inversión"], ["tarifas", "Tarifas"]]
      .map(([k, t]) => h("button", { class: pestana === k ? "activo" : "", role: "tab", onclick: () => { pestana = k; pintarTabs(); mostrar(); } }, t)));
    const mostrar = () => (pestana === "brokers" ? listaBrokers(ctx, cuerpo, maestro) : pestana === "propuestas" ? propuestasAdmin(ctx, cuerpo, maestro) : tarifas(ctx, cuerpo, maestro));
    cont.append(h("div", { class: "brk" }, tabs, cuerpo));
    pintarTabs();
    await mostrar();
  },
};

async function listaBrokers(ctx, cuerpo, maestro) {
  const { h, toast, tabla, dinero, numero, fecha, avisar, confirmar, pedirTexto } = ctx.ui;
  const ficha = h("div", { class: "brk-ficha", hidden: true });
  let filas = [];
  const t = tabla([
    { clave: "nombre", titulo: "Broker", formato: (v, f) => h("span", {}, h("b", {}, v), f.empresa ? h("div", { class: "nota" }, f.empresa) : null) },
    { clave: "estatus", titulo: "Estatus", formato: (v) => pildora(h, ESTATUS_BROKER, v) },
    { clave: "avance", titulo: "Documentos", formato: (v) => `${v.aprobados}/${v.requeridos} aprobados · ${v.subidos} subidos` },
    { clave: "accesos", titulo: "Accesos", formato: (v) => (v.length ? `${v.filter((u) => u.activo).length} acceso(s)` : "—") },
    { clave: "abiertas", titulo: "Propuestas abiertas", num: true, formato: (v) => numero(v) },
    { clave: "monto_aceptado", titulo: "Aceptado", num: true, formato: (v) => dinero(v) },
  ], { vacio: "Sin brokers todavía.", claseFila: (f) => (f.estatus === "revision" ? "brk-revisar" : "") });
  // el detalle se abre debajo del broker tocado; tocarlo otra vez lo cierra
  const celda = h("td", { colSpan: 6 });
  const filaDet = h("tr", { class: "brk-det" }, celda);
  let abiertoId = null;
  t.el.addEventListener("click", (e) => {
    if (e.target.closest("thead")) { setTimeout(colocar, 0); return; }
    if (e.target.closest(".brk-det")) return;
    const f = t.filaDe(e.target.closest("tbody tr"));
    if (!f) return;
    if (abiertoId === f.id) { cerrar(); return; }
    abrir(f);
  });
  function colocar() {
    const tr = abiertoId != null && t.el.querySelector(`tbody tr[data-id="${abiertoId}"]`);
    if (!tr) { filaDet.remove(); return; }
    tr.after(filaDet); tr.classList.add("sel");
  }
  function cerrar() { abiertoId = null; filaDet.remove(); ficha.hidden = true; t.el.querySelectorAll("tbody tr.sel").forEach((x) => x.classList.remove("sel")); }
  const enRevision = h("span", { class: "nota" });
  cuerpo.replaceChildren(
    h("div", { class: "tarjeta" },
      h("div", { class: "fila", style: { justifyContent: "space-between", flexWrap: "wrap" } },
        h("div", {}, h("h3", { style: { margin: 0 } }, "Brokers de venta"), enRevision),
        maestro ? h("button", { class: "btn btn-primario", onclick: () => abrir(null) }, "Nuevo broker") : null),
      ficha,
      h("div", { class: "nota" }, "Da clic en un broker para ver debajo sus datos, accesos y documentos."), t.el));

  async function cargar() {
    try { filas = (await ctx.rpc("brokers_lista")) || []; } catch (e) { toast(e.message, "mal"); return; }
    t.setFilas(filas);
    colocar();
    const n = filas.filter((f) => f.estatus === "revision").length;
    enRevision.textContent = n ? `${n} por validar` : "";
  }

  function abrir(b) {
    const campo = (k, ph) => h("input", { class: "campo", value: b?.[k] || "", placeholder: ph || "", disabled: !maestro });
    const fNombre = campo("nombre", "Nombre o razón social"), fEmp = campo("empresa"), fRfc = campo("rfc"), fCorreo = campo("correo"), fTel = campo("telefono");
    const fNotas = h("textarea", { class: "campo", rows: 2, disabled: !maestro }, b?.notas || "");
    const guardar = h("button", { class: "btn btn-primario", onclick: async () => {
      try {
        const id = await ctx.rpc("broker_guardar", { p: { id: b?.id ?? null, nombre: fNombre.value, empresa: fEmp.value, rfc: fRfc.value, correo: fCorreo.value, telefono: fTel.value, notas: fNotas.value } });
        toast("Broker guardado.", "bien"); await cargar();
        const nuevo = filas.find((x) => x.id === id); if (nuevo) { abiertoId = null; abrir(nuevo); }
      } catch (e) { toast(e.message, "mal"); }
    } }, b ? "Guardar cambios" : "Crear broker");

    const seccion = (titulo, ...hijos) => h("section", { class: "brk-sec" }, h("h4", {}, titulo), ...hijos);
    let extra = [];
    if (b) {
      // accesos (la contraseña inicial la escribe el maestro; no se genera)
      const aCorreo = h("input", { class: "campo", type: "email", placeholder: "correo@broker.com", autocomplete: "off" });
      const aNombre = h("input", { class: "campo", placeholder: "Nombre de la persona" });
      const aClave = h("input", { class: "campo", type: "password", placeholder: "Mínimo 8 caracteres", autocomplete: "new-password" });
      const accesos = seccion("Accesos al portal",
        b.accesos.length ? h("ul", { class: "brk-accesos" }, ...b.accesos.map((u) => h("li", { class: u.activo ? "" : "bloq" }, `${u.email} · ${u.nombre || ""}${u.activo ? "" : " (inactivo)"}`)))
          : h("div", { class: "nota" }, "Sin accesos todavía."),
        maestro ? h("div", { class: "brk-grid" },
          h("label", {}, h("span", { class: "etiqueta" }, "Correo"), aCorreo), h("label", {}, h("span", { class: "etiqueta" }, "Nombre"), aNombre),
          h("label", {}, h("span", { class: "etiqueta" }, "Contraseña inicial"), aClave),
          h("div", { style: { alignSelf: "end" } }, h("button", { class: "btn btn-primario", disabled: b.estatus === "suspendido", onclick: async () => {
            if (!aCorreo.value.trim()) { toast("Escribe el correo.", "mal"); return; }
            try {
              await ctx.rpc("broker_crear_acceso", { p_broker: b.id, p_email: aCorreo.value.trim(), p_nombre: aNombre.value.trim(), p_clave: aClave.value });
              await avisar("Acceso al portal creado", `Broker: ${b.nombre}\nCorreo: ${aCorreo.value.trim().toLowerCase()}\nPágina: ${location.origin}\n\n` +
                "Comparte la contraseña que escribiste por un medio seguro. El broker puede cambiarla con «¿Olvidaste tu contraseña?».");
              await cargar(); abiertoId = null; abrir(filas.find((x) => x.id === b.id) || b);
            } catch (e) { toast(e.message, "mal", 8000); }
          } }, "Dar acceso"))) : null,
        h("div", { class: "nota" }, "Para desactivar un acceso o cambiar su contraseña usa el módulo Usuarios."));

      const av = b.avance;
      const listo = av.aprobados >= av.requeridos;
      const validar = seccion("Validación del alta",
        h("div", { class: "fila", style: { justifyContent: "flex-start", gap: "8px", flexWrap: "wrap" } }, pildora(h, ESTATUS_BROKER, b.estatus),
          b.validado_por ? h("span", { class: "nota" }, `Validado por ${b.validado_por} · ${fecha(b.validado_fecha)}`) : null),
        b.motivo ? h("div", { class: "brk-motivo" }, b.motivo) : null,
        h("ul", { class: "brk-check" }, ...av.tipos.map((x) => h("li", { class: `s-${x.estatus}` }, h("span", {}, nombreDoc(x.tipo)), pildora(h, ESTATUS_DOC, x.estatus)))),
        maestro ? h("div", { class: "fila", style: { justifyContent: "flex-start", gap: "8px", flexWrap: "wrap" } },
          h("button", { class: "btn btn-marca", disabled: !listo || b.estatus === "validado", title: listo ? "" : "Aprueba primero los 5 documentos",
            onclick: () => cambiar("validado") }, "Validar broker"),
          h("button", { class: "btn btn-secundario", disabled: b.estatus === "rechazado", onclick: () => cambiar("rechazado") }, "Rechazar alta"),
          b.estatus === "suspendido" ? h("button", { class: "btn btn-secundario", onclick: () => cambiar("documentos") }, "Reactivar")
            : h("button", { class: "btn btn-secundario", onclick: () => cambiar("suspendido") }, "Suspender")) : null);

      async function cambiar(estatus) {
        let motivo = null;
        if (estatus === "rechazado" || estatus === "suspendido") {
          motivo = await pedirTexto(estatus === "rechazado" ? "Rechazar alta" : "Suspender broker", "Motivo (lo verá el broker):");
          if (!motivo?.trim()) return;
        } else if (!(await confirmar(estatus === "validado" ? "Validar broker" : "Reactivar broker",
          estatus === "validado" ? `¿Validar a ${b.nombre}? Podrá enviar propuestas de inversión.` : `¿Reactivar a ${b.nombre}?`))) return;
        try { await ctx.rpc("broker_validar", { p_broker: b.id, p_estatus: estatus, p_motivo: motivo }); toast("Listo. Se avisó al broker.", "bien"); }
        catch (e) { toast(e.message, "mal", 8000); return; }
        await cargar(); abiertoId = null; abrir(filas.find((x) => x.id === b.id) || b);
      }

      const docs = seccion("Documentos", h("div", { class: "nota" }, "Abre cada archivo, apruébalo o recházalo con el motivo. Con los 5 aprobados se habilita «Validar broker»."),
        bloqueDocsBroker(ctx, { brokerId: b.id, modo: maestro ? "admin" : "consulta", alCambiar: async () => { await cargar(); const x = filas.find((y) => y.id === b.id); if (x && x.avance.aprobados !== b.avance.aprobados) { abiertoId = null; abrir(x); } } }));
      extra = [validar, docs, accesos];
    }

    t.el.querySelectorAll("tbody tr.sel").forEach((x) => x.classList.remove("sel"));
    abiertoId = b ? b.id : null;
    const destino = b ? celda : ficha;
    if (b) { ficha.hidden = true; celda.replaceChildren(); colocar(); } else { filaDet.remove(); ficha.hidden = false; }
    destino.replaceChildren(
      h("div", { class: "fila", style: { justifyContent: "space-between" } }, h("h3", { style: { margin: 0 } }, b ? b.nombre : "Nuevo broker"),
        h("button", { class: "btn btn-secundario btn-chico", onclick: () => cerrar() }, "Cerrar")),
      h("div", { class: "brk-grid" },
        h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Nombre"), fNombre), h("label", {}, h("span", { class: "etiqueta" }, "Empresa"), fEmp),
        h("label", {}, h("span", { class: "etiqueta" }, "RFC"), fRfc), h("label", {}, h("span", { class: "etiqueta" }, "Correo"), fCorreo),
        h("label", {}, h("span", { class: "etiqueta" }, "Teléfono"), fTel), h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Notas"), fNotas)),
      maestro ? h("div", { class: "fila", style: { justifyContent: "flex-end" } }, guardar) : null,
      ...extra);
    (b ? filaDet : ficha).scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  await cargar();
}

async function propuestasAdmin(ctx, cuerpo, maestro) {
  const { h, toast, dinero, numero, fecha, pedirTexto, confirmar } = ctx.ui;
  const todas = h("input", { type: "checkbox", onchange: () => cargar() });
  const caja = h("div", { class: "pt-lista" });
  cuerpo.replaceChildren(h("div", { class: "tarjeta" },
    h("div", { class: "fila", style: { justifyContent: "space-between", flexWrap: "wrap" } }, h("h3", { style: { margin: 0 } }, "Propuestas de inversión de brokers"),
      h("label", {}, todas, " Ver también las respondidas")), caja));

  async function cargar() {
    let lista;
    try { lista = (await ctx.rpc("brokers_propuestas", { p_todas: todas.checked })) || []; } catch (e) { toast(e.message, "mal"); return; }
    caja.replaceChildren(...(lista.length ? lista.map((p) => {
      const det = h("div", { class: "pt-det" });
      const responder = async (estatus) => {
        let resp = "";
        if (estatus === "rechazada") { resp = await pedirTexto("Rechazar propuesta", `Motivo para ${p.broker} (lo verá en su portal):`); if (resp === null) return; }
        else if (!(await confirmar("Aceptar propuesta", `¿Aceptar ${p.folio} de ${p.broker} por ${dinero(p.monto)}?\nSe le avisará; arma la venta con sus créditos (Descargar créditos).`, "Aceptar"))) return;
        try { await ctx.rpc("broker_responder_propuesta", { p_id: p.id, p_estatus: estatus, p_respuesta: resp }); toast(`${p.folio}: ${estatus}. Se avisó al broker.`, "bien"); cargar(); }
        catch (e) { toast(e.message, "mal"); }
      };
      return h("div", { class: `pt-prop tarjeta s-${p.estatus === "enviada" ? "pend" : p.estatus === "aceptada" ? "ok" : "gris"}` },
        h("div", { class: "pt-prop-enc" },
          h("div", {}, h("b", { class: "pt-folio" }, p.folio), " ", pildora(h, ESTATUS_PROP, p.estatus),
            h("div", { class: "nota" }, `${p.broker} · ${fecha(p.creado)}${p.respondido_por ? ` · respondió ${p.respondido_por}` : ""}`)),
          h("div", { class: "fila pt-acc" },
            h("button", { class: "btn btn-secundario btn-chico", onclick: () => { det.childElementCount ? det.replaceChildren() : det.replaceChildren(tablaPropuesta(ctx, p.resumen)); } }, "Detalle"),
            h("button", { class: "btn btn-secundario btn-chico", onclick: () => descargarCreditos(ctx, p) }, "Descargar créditos"),
            maestro && p.estatus === "enviada" ? h("button", { class: "btn btn-primario btn-chico", onclick: () => responder("aceptada") }, "Aceptar") : null,
            maestro && p.estatus === "enviada" ? h("button", { class: "btn btn-secundario btn-chico", onclick: () => responder("rechazada") }, "Rechazar") : null)),
        h("div", { class: "pt-datos" },
          h("div", {}, h("small", {}, "Inversión"), h("b", {}, dinero(p.monto))), h("div", {}, h("small", {}, "Capital"), dinero(p.capital)),
          h("div", {}, h("small", {}, "Créditos"), numero(p.creditos)), h("div", {}, h("small", {}, "Grupos"), numero(p.grupos)),
          h("div", { class: "ancho" }, h("small", {}, "Estados"), (p.filtros?.estados || []).join(", "))),
        p.comentario ? h("div", { class: "nota" }, `Comentario: ${p.comentario}`) : null,
        p.respuesta ? h("div", { class: "brk-motivo" }, `Respuesta: ${p.respuesta}`) : null,
        det);
    }) : [h("div", { class: "nota" }, todas.checked ? "Sin propuestas." : "Sin propuestas por responder.")]));
  }
  await cargar();
}

async function tarifas(ctx, cuerpo, maestro) {
  const { h, toast } = ctx.ui;
  let cfg;
  try { cfg = Object.fromEntries((await ctx.rpc("config_lista")).map((c) => [c.clave, c.valor])); } catch (e) { toast(e.message, "mal"); return; }
  const campo = (k, def) => h("input", { class: "campo", type: "number", step: "0.01", min: "0.01", value: cfg[k] ?? def, disabled: !maestro, style: { maxWidth: "140px" } });
  const fJ = campo("broker_centavos_jyp", 0.14), fG = campo("broker_centavos_grupal", 0.26);
  cuerpo.replaceChildren(h("div", { class: "tarjeta" }, h("h3", {}, "Tarifa de la propuesta de inversión"),
    h("div", { class: "nota" }, "Precio por cada peso de capital con que se arma sola la propuesta del broker. Las propuestas ya enviadas conservan su tarifa."),
    h("div", { class: "brk-grid" },
      h("label", {}, h("span", { class: "etiqueta" }, "JyP ($ por peso de capital)"), fJ),
      h("label", {}, h("span", { class: "etiqueta" }, "Grupal ($ por peso de capital)"), fG)),
    h("div", { class: "nota" }, `Actual: JyP ${cent(cfg.broker_centavos_jyp ?? 0.14)} · Grupal ${cent(cfg.broker_centavos_grupal ?? 0.26)}`),
    maestro ? h("div", { class: "fila", style: { justifyContent: "flex-end" } }, h("button", { class: "btn btn-primario", onclick: async () => {
      const j = Number(fJ.value), g = Number(fG.value);
      if (!(j > 0 && j < 1 && g > 0 && g < 1)) { toast("Escribe tarifas entre 0.01 y 0.99.", "mal"); return; }
      try {
        await ctx.rpc("config_guardar", { p_clave: "broker_centavos_jyp", p_valor: j });
        await ctx.rpc("config_guardar", { p_clave: "broker_centavos_grupal", p_valor: g });
        toast("Tarifas guardadas.", "bien"); tarifas(ctx, cuerpo, maestro);
      } catch (e) { toast(e.message, "mal"); }
    } }, "Guardar tarifas")) : null));
}
