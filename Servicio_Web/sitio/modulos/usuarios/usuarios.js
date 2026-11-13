// ============================================================
// MÓDULO: Usuarios (sólo administradores)
// Alta de usuarios: Supabase > Authentication > Users > Add user.
// Aquí se asigna nombre, rol y si está activo.
// ============================================================
export default {
  id: "usuarios",
  titulo: "Usuarios",
  icono: "👥",
  roles: ["admin"],

  async montar(cont, ctx) {
    const { h, toast, fecha } = ctx.ui;
    const cuerpo = h("tbody");

    cont.append(h("div", { class: "tarjeta" },
      h("h3", {}, "👥 Usuarios"),
      h("p", { class: "nota", style: { fontSize: ".85rem" } },
        "Para dar de alta a alguien: Supabase › Authentication › Users › Add user (correo y contraseña). ",
        "Aparece aquí como Vendedor activo; puedes cambiar su nombre, rol o desactivarlo.\n",
        "Flujo: Vendedor arma la propuesta → Validador la revisa → Auxiliar de venta genera la sub base. ",
        "El Administrador puede hacer todo."),
      h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
        h("thead", {}, h("tr", {}, ...["Correo", "Nombre", "Rol", "Activo", "Alta", ""].map((t) => h("th", {}, t)))),
        cuerpo))));

    async function cargar() {
      let usuarios;
      try { usuarios = await ctx.rpc("admin_usuarios"); } catch (e) { toast(e.message, "mal"); return; }
      cuerpo.replaceChildren(...usuarios.map((u) => {
        const nombre = h("input", { class: "campo", value: u.nombre || "" });
        const rol = h("select", { class: "campo" },
          h("option", { value: "vendedor" }, "Vendedor"), h("option", { value: "validador" }, "Validador"),
          h("option", { value: "auxiliar" }, "Auxiliar de venta"), h("option", { value: "admin" }, "Administrador"));
        rol.value = u.rol;
        const activo = h("input", { type: "checkbox", checked: u.activo });
        const guardar = h("button", { class: "btn btn-primario btn-chico", onclick: async () => {
          try {
            await ctx.rpc("admin_actualizar_usuario", { p_user: u.user_id, p_nombre: nombre.value.trim(), p_rol: rol.value, p_activo: activo.checked });
            toast(`${u.email} actualizado.`, "bien");
          } catch (e) { toast(e.message, "mal"); cargar(); }
        } }, "Guardar");
        return h("tr", {}, h("td", {}, u.email), h("td", {}, nombre), h("td", {}, rol),
          h("td", { class: "chk" }, activo), h("td", {}, fecha(u.creado)), h("td", {}, guardar));
      }));
    }
    await cargar();
  },
};
