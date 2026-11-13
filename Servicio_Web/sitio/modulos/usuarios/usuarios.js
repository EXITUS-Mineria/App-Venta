// ============================================================
// MÓDULO: Usuarios (usuarios maestros: Validador y Administrador)
// Alta de usuarios y edición completa: correo, nombre, rol, activo y contraseña.
// ============================================================
const ROLES = [
  ["vendedor", "Vendedor"],
  ["validador", "Validador (maestro)"],
  ["auxiliar", "Auxiliar de venta"],
  ["admin", "Administrador"],
];

function claveAleatoria() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const n = new Uint32Array(10);
  crypto.getRandomValues(n);
  return "Vta-" + [...n].map((x) => letras[x % letras.length]).join("") + "!";
}

export default {
  id: "usuarios",
  titulo: "Usuarios",
  icono: "👥",
  roles: ["validador", "admin"],

  async montar(cont, ctx) {
    const { h, toast, fecha, avisar, pedirTexto, confirmar } = ctx.ui;
    const selectRol = (valor = "vendedor") => {
      const s = h("select", { class: "campo" }, ...ROLES.map(([v, t]) => h("option", { value: v }, t)));
      s.value = valor;
      return s;
    };

    // ---- alta ----
    const nCorreo = h("input", { class: "campo", type: "email", placeholder: "correo@exitus.com", autocomplete: "off" });
    const nNombre = h("input", { class: "campo", placeholder: "Nombre completo" });
    const nRol = selectRol();
    const nClave = h("input", { class: "campo", value: claveAleatoria(), autocomplete: "new-password" });
    const btnAlta = h("button", { class: "btn btn-marca", onclick: () => alta() }, "＋ Dar de alta");

    const cuerpo = h("tbody");
    const buscar = h("input", { class: "campo", placeholder: "🔍 Buscar correo o nombre…", style: { maxWidth: "260px" },
      oninput: () => pintar() });
    let usuarios = [];

    cont.append(
      h("div", { class: "tarjeta", style: { marginBottom: "12px" } },
        h("h3", {}, "＋ Nuevo usuario"),
        h("div", { class: "fila", style: { flexWrap: "wrap", alignItems: "flex-end" } },
          h("div", { style: { flex: "2 1 220px" } }, h("span", { class: "etiqueta" }, "Correo"), nCorreo),
          h("div", { style: { flex: "2 1 200px" } }, h("span", { class: "etiqueta" }, "Nombre"), nNombre),
          h("div", { style: { flex: "1 1 170px" } }, h("span", { class: "etiqueta" }, "Rol"), nRol),
          h("div", { style: { flex: "1.5 1 200px" } }, h("span", { class: "etiqueta" }, "Contraseña inicial"),
            h("div", { class: "fila", style: { gap: "4px" } }, nClave,
              h("button", { class: "btn btn-secundario", style: { flex: "0 0 auto" }, title: "Generar otra",
                onclick: () => { nClave.value = claveAleatoria(); } }, "🎲"))),
          h("div", { style: { flex: "0 0 auto" } }, btnAlta)),
        h("p", { class: "nota", style: { margin: "8px 0 0", fontSize: ".82rem" } },
          "La cuenta queda lista para entrar con ese correo y contraseña. Compártela por un medio seguro; ",
          "la persona puede cambiarla con «¿Olvidaste tu contraseña?» si su correo es real. ",
          "Flujo: Vendedor arma → Validador (maestro) revisa → Auxiliar de venta genera la sub base.")),
      h("div", { class: "tarjeta" },
        h("div", { class: "fila", style: { marginBottom: "8px", justifyContent: "flex-start" } },
          h("h3", { style: { margin: 0, flex: "0 0 auto" } }, "👥 Usuarios"), buscar,
          h("span", { class: "nota", style: { flex: "1 1 auto" } }, "Edita en la fila y da clic en Guardar (se activa al cambiar algo).")),
        h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
          h("thead", {}, h("tr", {}, ...["Correo", "Nombre", "Rol", "Activo", "Alta", ""].map((t) => h("th", {}, t)))),
          cuerpo))));

    async function alta() {
      const correo = nCorreo.value.trim(), clave = nClave.value;
      if (!correo) { toast("Escribe el correo.", "mal"); nCorreo.focus(); return; }
      btnAlta.disabled = true;
      try {
        await ctx.rpc("admin_crear_usuario", { p_email: correo, p_nombre: nNombre.value.trim(), p_rol: nRol.value, p_clave: clave });
        const rolTxt = ROLES.find(([v]) => v === nRol.value)[1];
        await avisar("Usuario creado",
          `Correo: ${correo.toLowerCase()}\nContraseña: ${clave}\nRol: ${rolTxt}\n\nCópialo ahora; la contraseña no se vuelve a mostrar.`);
        nCorreo.value = ""; nNombre.value = ""; nRol.value = "vendedor"; nClave.value = claveAleatoria();
        await cargar();
      } catch (e) { toast(e.message, "mal", 8000); }
      btnAlta.disabled = false;
    }

    async function cargar() {
      try { usuarios = await ctx.rpc("admin_usuarios"); } catch (e) { toast(e.message, "mal"); return; }
      pintar();
    }

    function pintar() {
      const q = buscar.value.trim().toLowerCase();
      const lista = usuarios.filter((u) => !q || `${u.email} ${u.nombre || ""}`.toLowerCase().includes(q));
      cuerpo.replaceChildren(...lista.map((u) => {
        const correo = h("input", { class: "campo", type: "email", value: u.email });
        const nombre = h("input", { class: "campo", value: u.nombre || "" });
        const rol = selectRol(u.rol);
        const activo = h("input", { type: "checkbox", checked: u.activo });
        const guardar = h("button", { class: "btn btn-primario btn-chico", disabled: true, onclick: async () => {
          const cambioCorreo = correo.value.trim().toLowerCase() !== u.email;
          if (cambioCorreo && !(await confirmar("Cambiar correo",
            `${u.email} → ${correo.value.trim().toLowerCase()}\n\nA partir de ahora entrará con el correo nuevo y la misma contraseña.`,
            "Cambiar"))) return;
          guardar.disabled = true;
          try {
            await ctx.rpc("admin_editar_usuario", { p_user: u.user_id, p_email: correo.value.trim(), p_nombre: nombre.value.trim(),
              p_rol: rol.value, p_activo: activo.checked });
            toast(`${correo.value.trim().toLowerCase()} actualizado.`, "bien");
            cargar();
          } catch (e) { toast(e.message, "mal", 8000); guardar.disabled = false; }
        } }, "Guardar");
        const tr = h("tr", { class: u.activo ? "" : "bloq" });
        const revisar = () => {
          const cambio = correo.value.trim().toLowerCase() !== u.email || nombre.value.trim() !== (u.nombre || "") ||
            rol.value !== u.rol || activo.checked !== u.activo;
          guardar.disabled = !cambio;
          tr.classList.toggle("editado", cambio);
        };
        [correo, nombre].forEach((x) => x.addEventListener("input", revisar));
        [rol, activo].forEach((x) => x.addEventListener("change", revisar));
        const clave = h("button", { class: "btn btn-secundario btn-chico", title: "Asignar nueva contraseña", onclick: async () => {
          const nueva = await pedirTexto("Nueva contraseña", `Nueva contraseña para ${u.email} (mínimo 8 caracteres):`, claveAleatoria());
          if (nueva === null) return;
          if (!(await confirmar("Cambiar contraseña", `¿Cambiar la contraseña de ${u.email}?\n\nNueva: ${nueva}`, "Cambiar"))) return;
          try { await ctx.rpc("admin_cambiar_clave", { p_user: u.user_id, p_clave: nueva }); toast("Contraseña cambiada.", "bien"); }
          catch (e) { toast(e.message, "mal"); }
        } }, "🔑 Contraseña");
        tr.append(h("td", {}, correo), h("td", {}, nombre), h("td", {}, rol),
          h("td", { class: "chk" }, activo), h("td", {}, fecha(u.creado)),
          h("td", {}, h("span", { class: "fila", style: { gap: "4px" } }, guardar, clave)));
        return tr;
      }));
    }

    await cargar();
  },
};
