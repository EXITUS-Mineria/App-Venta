// ============================================================
// MÓDULO: Compradores (interno)
//  🛒 Solicitudes: lo que piden los compradores desde su portal (vendedor / auxiliar las atienden).
//  🏢 Catálogo: datos del comprador, nombres con que aparece en el Funnel (alias) y accesos al portal.
//     Editar y dar accesos: sólo validador / admin. Los demás lo consultan.
// ============================================================
function claveAleatoria() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const n = new Uint32Array(10);
  crypto.getRandomValues(n);
  return "Cmp-" + [...n].map((x) => letras[x % letras.length]).join("") + "!";
}
const clave = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const palabras = (t) => clave(t).split(" ").filter((w) => w.length >= 3);
const parecido = (a, b) => { const A = new Set(palabras(a)); return palabras(b).filter((w) => A.has(w)).length; };
const ESTATUS = { NUEVA: "Nueva", "EN PROCESO": "En proceso", ATENDIDA: "Atendida", CANCELADA: "Cancelada" };

export default {
  id: "compradores",
  titulo: "Compradores",
  icono: "🏢",
  roles: ["vendedor", "auxiliar", "validador", "admin"],

  async montar(cont, ctx) {
    const { h, toast, tabla, dinero, numero, fecha, avisar, confirmar } = ctx.ui;
    ctx.ui.cargarCSS(new URL("./compradores.css", import.meta.url).href);
    const maestro = ctx.esAdmin;
    let pestana = "solicitudes";
    const tabs = h("div", { class: "segmentado cmp-tabs" });
    const cuerpo = h("div");
    cont.append(tabs, cuerpo);
    const pintarTabs = () => tabs.replaceChildren(...[["solicitudes", "🛒 Solicitudes"], ["catalogo", "🏢 Catálogo y accesos"]]
      .map(([k, t]) => h("button", { class: pestana === k ? "activo" : "", onclick: () => { pestana = k; pintarTabs(); mostrar(); } }, t)));
    const mostrar = () => (pestana === "solicitudes" ? solicitudes() : catalogo());

    // ================= Solicitudes =================
    async function solicitudes() {
      const panel = h("div", { class: "tarjeta cmp-panel", hidden: true });
      const verTodas = h("input", { type: "checkbox", onchange: () => pintar() });
      let datos = [];
      const t = tabla([
        { clave: "id", titulo: "#" }, { clave: "fecha", titulo: "Fecha", formato: (v) => fecha(v) },
        { clave: "comprador", titulo: "Comprador" }, { clave: "vendedor", titulo: "Ejecutivo" },
        { clave: "pide", titulo: "Qué pide", formato: (_, s) => [s.tipo_cartera !== "Cualquiera" ? s.tipo_cartera : null, s.estados, s.municipios,
            s.dias_min != null || s.dias_max != null ? `${s.dias_min ?? 0}–${s.dias_max ?? "∞"} días` : null,
            s.capital_aprox ? `≈ ${dinero(s.capital_aprox)}` : null].filter(Boolean).join(" · ") },
        { clave: "comentarios", titulo: "Comentarios" },
        { clave: "estatus", titulo: "Estatus", formato: (v) => h("span", { class: `cmp-est e-${v.replace(" ", "-")}` }, ESTATUS[v] || v) },
        { clave: "folio", titulo: "Propuesta" }, { clave: "respuesta", titulo: "Respuesta al comprador" },
      ], { vacio: "Sin solicitudes", claseFila: (s) => (s.estatus === "CANCELADA" ? "bloq" : "") });
      t.el.addEventListener("click", (e) => { const s = t.filaDe(e.target.closest("tbody tr")); if (s) atender(s); });
      cuerpo.replaceChildren(h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "8px" } },
          h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "🛒 Solicitudes de compra"),
          h("label", { style: { flex: "0 0 auto" } }, verTodas, " Ver también atendidas y canceladas"),
          h("span", { class: "nota", style: { flex: "1 1 auto" } }, "Da clic en una solicitud para atenderla. El comprador ve el estatus y tu respuesta en su portal."),
          h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => cargar() }, "⟳")), t.el), panel);

      function pintar() { t.setFilas(verTodas.checked ? datos : datos.filter((s) => ["NUEVA", "EN PROCESO"].includes(s.estatus))); }
      async function cargar() {
        try { datos = await ctx.rpc("solicitudes_lista"); } catch (e) { toast(e.message, "mal"); return; }
        pintar();
      }
      function atender(s) {
        if (!ctx.tieneRol("vendedor", "auxiliar")) return;
        const est = h("select", { class: "campo" }, ...["EN PROCESO", "ATENDIDA", "CANCELADA"].map((v) => h("option", { value: v }, ESTATUS[v])));
        est.value = s.estatus === "NUEVA" ? "EN PROCESO" : s.estatus;
        const folio = h("input", { class: "campo", value: s.folio || "", placeholder: "VTA-#### (opcional)" });
        const resp = h("input", { class: "campo", value: s.respuesta || "", placeholder: "Ej. Te publicamos la propuesta VTA-0310 en tu portal" });
        panel.hidden = false;
        panel.replaceChildren(h("h3", {}, `Atender solicitud #${s.id} · ${s.comprador}`),
          h("div", { class: "nota" }, [s.tipo_cartera, s.estados, s.municipios, s.comentarios].filter(Boolean).join(" · ")),
          h("div", { class: "cmp-grid" },
            h("label", {}, h("span", { class: "etiqueta" }, "Estatus"), est),
            h("label", {}, h("span", { class: "etiqueta" }, "Propuesta (folio)"), folio),
            h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Respuesta para el comprador"), resp)),
          h("div", { class: "fila", style: { justifyContent: "flex-end", gap: "6px" } },
            h("button", { class: "btn btn-secundario", onclick: () => { panel.hidden = true; } }, "Cerrar"),
            h("button", { class: "btn btn-marca", onclick: async () => {
              try {
                await ctx.rpc("solicitud_atender", { p_id: s.id, p_estatus: est.value, p_folio: folio.value.trim(), p_respuesta: resp.value.trim() });
                toast(`Solicitud #${s.id}: ${ESTATUS[est.value]}. Se le avisó al comprador.`, "bien"); panel.hidden = true; cargar();
              } catch (e) { toast(e.message, "mal", 8000); }
            } }, "Guardar y avisar")));
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      await cargar();
    }

    // ================= Catálogo =================
    async function catalogo() {
      let datos = [], nombres = [], vendedores = [];
      const buscar = h("input", { class: "campo", placeholder: "🔍 Buscar comprador…", style: { maxWidth: "260px" }, oninput: () => pintar() });
      const ficha = h("div", { class: "tarjeta cmp-panel", hidden: true });
      const t = tabla([
        { clave: "nombre", titulo: "Comprador" }, { clave: "rfc", titulo: "RFC" }, { clave: "correo", titulo: "Correo" },
        { clave: "vendedor", titulo: "Ejecutivo" },
        { clave: "ventas", titulo: "Ventas", num: true, formato: (v, c) => `${numero(c.vendidas)} / ${numero(v)}` },
        { clave: "monto", titulo: "Monto vendido", num: true, formato: (v) => dinero(v) },
        { clave: "accesos", titulo: "Portal", formato: (v) => (v.length ? `👤 ${v.filter((u) => u.activo).length} acceso(s)` : "—") },
        { clave: "solicitudes_abiertas", titulo: "Solicitudes", num: true, formato: (v) => (v ? `🛒 ${v}` : "") },
        { clave: "activo", titulo: "Activo", formato: (v) => (v ? "✔" : "✖") },
      ], { vacio: "Sin compradores en el catálogo", claseFila: (c) => (c.activo ? "" : "bloq") });
      t.el.addEventListener("click", (e) => { const c = t.filaDe(e.target.closest("tbody tr")); if (c) abrir(c); });
      cuerpo.replaceChildren(h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { justifyContent: "flex-start", marginBottom: "8px" } },
          h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "🏢 Compradores"), buscar,
          h("span", { class: "nota", style: { flex: "1 1 auto" } }, maestro ? "Da clic en un comprador para editarlo o darle acceso al portal."
            : "Consulta. El validador o un administrador editan el catálogo y dan los accesos."),
          maestro ? h("button", { class: "btn btn-marca", style: { flex: "0 0 auto" }, onclick: () => abrir(null) }, "＋ Nuevo comprador") : null), t.el), ficha);

      function pintar() {
        const q = clave(buscar.value);
        t.setFilas(datos.filter((c) => !q || clave(`${c.nombre} ${c.rfc || ""} ${c.correo || ""} ${(c.alias || []).join(" ")}`).includes(q)));
      }
      async function cargar() {
        try {
          [datos, nombres] = await Promise.all([ctx.rpc("compradores_lista"), ctx.rpc("compradores_nombres_funnel")]);
          if (maestro && !vendedores.length) vendedores = (await ctx.rpc("admin_usuarios")).filter((u) => u.activo && u.rol === "vendedor");
        } catch (e) { toast(e.message, "mal"); return; }
        pintar();
      }

      function abrir(c) {
        const ed = maestro;
        const campo = (v, ph, tipo = "text") => h("input", { class: "campo", type: tipo, value: v || "", placeholder: ph || "", disabled: !ed });
        const fNombre = campo(c?.nombre, "Nombre o razón social"), fRfc = campo(c?.rfc, "RFC"), fCorreo = campo(c?.correo, "correo@empresa.com", "email");
        const fTel = campo(c?.telefono, "Teléfono"), fNotas = h("textarea", { class: "campo", rows: 2, disabled: !ed }, c?.notas || "");
        const fVend = h("select", { class: "campo", disabled: !ed }, h("option", { value: "" }, "— sin asignar —"),
          ...vendedores.map((u) => h("option", { value: u.user_id }, u.nombre || u.email)));
        if (c?.vendedor_user && !vendedores.some((u) => u.user_id === c.vendedor_user)) fVend.append(h("option", { value: c.vendedor_user }, c.vendedor || "otro"));
        fVend.value = c?.vendedor_user || "";
        const fActivo = h("input", { type: "checkbox", checked: c ? c.activo : true, disabled: !ed });

        // alias: nombres del Funnel ligados a este comprador
        const alias = new Set(c?.alias || []);
        const qAlias = h("input", { class: "campo", placeholder: "🔍 Buscar nombre en el Funnel…", disabled: !ed });
        const listaAlias = h("div", { class: "cmp-alias" });
        const pintarAlias = () => {
          const q = clave(qAlias.value), base = fNombre.value || c?.nombre || "";
          const libres = nombres.filter((n) => !n.comprador_id || n.comprador_id === c?.id);
          const vista = libres.filter((n) => alias.has(n.nombre) || (q ? clave(n.nombre).includes(q) : parecido(base, n.nombre) >= 2 || clave(n.nombre) === clave(base)))
            .sort((a, b) => (alias.has(b.nombre) - alias.has(a.nombre)) || parecido(base, b.nombre) - parecido(base, a.nombre));
          listaAlias.replaceChildren(...(vista.length ? vista.slice(0, 60).map((n) => h("label", { class: alias.has(n.nombre) ? "sel" : "" },
            h("input", { type: "checkbox", checked: alias.has(n.nombre), disabled: !ed, onchange: (e) => { e.target.checked ? alias.add(n.nombre) : alias.delete(n.nombre); pintarAlias(); } }),
            ` ${n.nombre} `, h("small", { class: "nota" }, `(${n.ventas})`)))
            : [h("div", { class: "nota" }, q ? "Sin coincidencias." : "Escribe para buscar cómo aparece este comprador en el Funnel.")]));
        };
        qAlias.addEventListener("input", pintarAlias);
        fNombre.addEventListener("input", pintarAlias);

        const btnGuardar = h("button", { class: "btn btn-marca", onclick: async () => {
          btnGuardar.disabled = true;
          try {
            await ctx.rpc("compradores_guardar", { p_id: c?.id ?? null, p_datos: { nombre: fNombre.value, rfc: fRfc.value, correo: fCorreo.value,
              telefono: fTel.value, notas: fNotas.value, vendedor_user: fVend.value, activo: fActivo.checked, alias: [...alias] } });
            toast(`${fNombre.value.trim()} guardado.`, "bien"); ficha.hidden = true; await cargar();
          } catch (e) { toast(e.message, "mal", 9000); }
          btnGuardar.disabled = false;
        } }, "💾 Guardar");

        // accesos al portal
        let accesos = null;
        if (c) {
          const aCorreo = h("input", { class: "campo", type: "email", placeholder: "correo@comprador.com", autocomplete: "off" });
          const aNombre = h("input", { class: "campo", placeholder: "Nombre de la persona" });
          const aClave = h("input", { class: "campo", value: claveAleatoria(), autocomplete: "new-password" });
          accesos = h("section", { class: "cmp-sec" }, h("h4", {}, "👤 Accesos al portal"),
            c.accesos.length ? h("ul", { class: "cmp-accesos" }, ...c.accesos.map((u) => h("li", { class: u.activo ? "" : "bloq" },
              `${u.email} · ${u.nombre || ""} ${u.activo ? "" : "(inactivo)"}`))) : h("div", { class: "nota" }, "Sin accesos todavía."),
            ed ? h("div", { class: "cmp-grid" },
              h("label", {}, h("span", { class: "etiqueta" }, "Correo"), aCorreo),
              h("label", {}, h("span", { class: "etiqueta" }, "Nombre"), aNombre),
              h("label", {}, h("span", { class: "etiqueta" }, "Contraseña inicial"), h("div", { class: "fila", style: { gap: "4px" } }, aClave,
                h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, onclick: () => { aClave.value = claveAleatoria(); } }, "🎲"))),
              h("div", { style: { alignSelf: "end" } }, h("button", { class: "btn btn-primario", disabled: !c.activo, onclick: async () => {
                if (!aCorreo.value.trim()) { toast("Escribe el correo.", "mal"); return; }
                try {
                  await ctx.rpc("comprador_crear_acceso", { p_comprador: c.id, p_email: aCorreo.value.trim(), p_nombre: aNombre.value.trim(), p_clave: aClave.value });
                  await avisar("Acceso al portal creado", `Comprador: ${c.nombre}\nCorreo: ${aCorreo.value.trim().toLowerCase()}\nContraseña: ${aClave.value}\n` +
                    `Página: ${location.origin}\n\nCópialo ahora y compártelo por un medio seguro; la contraseña no se vuelve a mostrar.\n` +
                    "El comprador puede cambiarla con «¿Olvidaste tu contraseña?».");
                  ficha.hidden = true; await cargar();
                } catch (e) { toast(e.message, "mal", 8000); }
              } }, "＋ Dar acceso"))) : null,
            h("div", { class: "nota" }, "Para desactivar un acceso o cambiar su contraseña usa el módulo 👥 Usuarios."));
        }

        ficha.hidden = false;
        ficha.replaceChildren(
          h("div", { class: "fila", style: { justifyContent: "space-between" } }, h("h3", { style: { margin: 0 } }, c ? c.nombre : "＋ Nuevo comprador"),
            h("button", { class: "btn btn-secundario btn-chico", onclick: () => { ficha.hidden = true; } }, "✖")),
          c ? h("div", { class: "nota" }, `${numero(c.vendidas)} compras de ${numero(c.ventas)} ventas en el Funnel · ${dinero(c.monto)}`) : null,
          h("div", { class: "cmp-grid" },
            h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Nombre"), fNombre),
            h("label", {}, h("span", { class: "etiqueta" }, "RFC"), fRfc), h("label", {}, h("span", { class: "etiqueta" }, "Correo"), fCorreo),
            h("label", {}, h("span", { class: "etiqueta" }, "Teléfono"), fTel), h("label", {}, h("span", { class: "etiqueta" }, "Ejecutivo (vendedor)"), fVend),
            h("label", { class: "ancho" }, h("span", { class: "etiqueta" }, "Notas"), fNotas),
            h("label", {}, fActivo, " Activo (si lo desactivas, sus accesos al portal se apagan)")),
          h("section", { class: "cmp-sec" }, h("h4", {}, "🔗 Nombres con que aparece en el Funnel"),
            h("div", { class: "nota" }, "Marca todas las formas en que se capturó este comprador. Sus ventas pasadas y nuevas se ligan solas y las verá en «Mis compras»."),
            qAlias, listaAlias),
          ed ? h("div", { class: "fila", style: { justifyContent: "flex-end" } }, btnGuardar) : null,
          accesos);
        pintarAlias();
        ficha.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      await cargar();
    }

    pintarTabs();
    await mostrar();
  },
};
