-- ============================================================
-- NÚCLEO · usuarios, roles y utilidades comunes a todos los módulos
-- Idempotente: se puede correr varias veces.
-- ============================================================


-- ---------- Perfiles (rol de cada usuario de Supabase Auth) ----------
create table if not exists public.perfiles (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    email      text not null,
    nombre     text,
    rol        text not null default 'vendedor',
    activo     boolean not null default true,
    creado     timestamptz not null default now()
);

-- Roles: vendedor -> validador -> auxiliar (de venta).
-- "Maestros": validador y admin pueden todo (incluye dar de alta usuarios).
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('vendedor', 'validador', 'auxiliar', 'admin'));

-- Alta automática del perfil cuando se crea un usuario en Auth
create or replace function public.tg_nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into public.perfiles (user_id, email, nombre)
    values (new.id, new.email, split_part(new.email, '@', 1))
    on conflict (user_id) do nothing;
    return new;
end $$;

drop trigger if exists tr_nuevo_usuario on auth.users;
create trigger tr_nuevo_usuario after insert on auth.users
    for each row execute function public.tg_nuevo_usuario();

create or replace function public.es_activo() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo)
$$;

-- Usuario maestro: administrador o validador
create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and rol in ('admin', 'validador'))
$$;

-- ¿El usuario tiene alguno de estos roles? (los maestros siempre cuentan)
create or replace function public.tiene_rol(p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and (rol in ('admin', 'validador') or rol = any (p_roles)))
$$;

create or replace function public._exigir_rol(p_roles text[], p_accion text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.tiene_rol(p_roles) then
        raise exception 'Tu rol no permite %', p_accion using errcode = '42501';
    end if;
end $$;

alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon, authenticated;
grant select on public.perfiles to authenticated;

drop policy if exists perfiles_lectura on public.perfiles;
create policy perfiles_lectura on public.perfiles for select to authenticated
    using (user_id = auth.uid() or public.es_admin());

-- Para no confundir "MÉXICO" con "MEXICO": mayúsculas y espacios simples
create or replace function public.norm(t text) returns text
language sql immutable set search_path = public as $$ select upper(regexp_replace(trim(coalesce(t, '')), '\s+', ' ', 'g')) $$;

create or replace function public._exigir_activo() returns void
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.es_activo() then
        raise exception 'Usuario sin acceso a Venta de Cartera' using errcode = '42501';
    end if;
end $$;

-- Mi perfil
create or replace function public.mi_perfil() returns json
language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
    select json_build_object('email', email, 'nombre', nombre, 'rol', rol, 'activo', activo)
      into r from public.perfiles where user_id = auth.uid();
    return r;
end $$;

-- Administración de usuarios
create or replace function public.admin_usuarios()
returns table (user_id uuid, email text, nombre text, rol text, activo boolean, creado timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo administradores'; end if;
    return query select p.user_id, p.email, p.nombre, p.rol, p.activo, p.creado
                 from public.perfiles p order by p.email;
end $$;

create or replace function public.admin_actualizar_usuario(p_user uuid, p_nombre text, p_rol text, p_activo boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo administradores'; end if;
    if p_user = auth.uid() and (p_rol not in ('admin', 'validador') or not p_activo) then
        raise exception 'No puedes quitarte a ti mismo el rol de usuario maestro';
    end if;
    update public.perfiles set nombre = p_nombre, rol = p_rol, activo = p_activo where user_id = p_user;
end $$;

-- Editar usuario completo, incluido el correo (sólo maestros)
create or replace function public.admin_editar_usuario(p_user uuid, p_email text, p_nombre text, p_rol text, p_activo boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden editar usuarios'; end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'admin') then raise exception 'Rol no válido: %', p_rol; end if;
    if p_user = auth.uid() and (p_rol not in ('admin', 'validador') or not p_activo) then
        raise exception 'No puedes quitarte a ti mismo el rol de usuario maestro';
    end if;
    if exists (select 1 from auth.users where lower(email) = v_email and id <> p_user) then
        raise exception 'Ya existe otro usuario con el correo %', v_email;
    end if;
    update auth.users set email = v_email, updated_at = now() where id = p_user and email is distinct from v_email;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_email), updated_at = now()
     where user_id = p_user and provider = 'email';
    update public.perfiles
       set email = v_email, nombre = nullif(trim(p_nombre), ''), rol = p_rol, activo = p_activo
     where user_id = p_user;
    if not found then raise exception 'No existe el usuario'; end if;
end $$;

-- Alta de usuarios desde la página (sólo maestros). Crea la cuenta de Supabase Auth ya confirmada.
create or replace function public.admin_crear_usuario(p_email text, p_nombre text, p_rol text, p_clave text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(trim(p_email));
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden dar de alta usuarios'; end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'admin') then raise exception 'Rol no válido: %', p_rol; end if;
    if length(coalesce(p_clave, '')) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
    if exists (select 1 from auth.users where lower(email) = v_email) then
        raise exception 'Ya existe un usuario con el correo %', v_email;
    end if;

    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
        phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
        extensions.crypt(p_clave, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', '{}', now(), now(),
        '', '', '', '', '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
        jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
        'email', now(), now(), now());

    -- el perfil lo crea el trigger tr_nuevo_usuario; aquí se completa
    insert into public.perfiles (user_id, email, nombre, rol)
    values (v_id, v_email, coalesce(nullif(trim(p_nombre), ''), split_part(v_email, '@', 1)), p_rol)
    on conflict (user_id) do update set nombre = excluded.nombre, rol = excluded.rol, activo = true;
    return v_id;
end $$;

-- Cambiar la contraseña de un usuario (sólo maestros)
create or replace function public.admin_cambiar_clave(p_user uuid, p_clave text)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden cambiar contraseñas'; end if;
    if length(coalesce(p_clave, '')) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
    update auth.users set encrypted_password = extensions.crypt(p_clave, extensions.gen_salt('bf')), updated_at = now()
     where id = p_user;
    if not found then raise exception 'No existe el usuario'; end if;
end $$;


-- ============================================================
-- Notificaciones (campana del encabezado). Cualquier módulo las crea con
--   perform public._notificar(array['validador'], null, 'Título', 'Mensaje', 'revision');
-- ============================================================
create table if not exists public.notificaciones (
    id       bigserial primary key,
    user_id  uuid not null references auth.users (id) on delete cascade,
    titulo   text not null,
    mensaje  text,
    enlace   text,                      -- id del módulo a abrir (#/enlace)
    leida    boolean not null default false,
    creada   timestamptz not null default now()
);
create index if not exists notificaciones_usuario on public.notificaciones (user_id, leida, creada desc);
alter table public.notificaciones enable row level security;
revoke all on public.notificaciones from anon, authenticated;

-- Envía a todos los usuarios activos con esos roles (admin incluido) y/o a un usuario.
-- No se notifica a quien hizo la acción.
create or replace function public._notificar(p_roles text[], p_user uuid, p_titulo text,
                                             p_mensaje text, p_enlace text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    insert into public.notificaciones (user_id, titulo, mensaje, enlace)
    select p.user_id, p_titulo, p_mensaje, p_enlace
    from public.perfiles p
    where p.activo and p.user_id is distinct from auth.uid()
      and ((p_roles is not null and (p.rol = 'admin' or p.rol = any (p_roles)))
           or p.user_id = p_user);
end $$;
revoke all on function public._notificar(text[], uuid, text, text, text) from public, anon, authenticated;

create or replace function public.mis_notificaciones(p_limite integer default 30)
returns table (id bigint, titulo text, mensaje text, enlace text, leida boolean, creada timestamptz, sin_leer bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select n.id, n.titulo, n.mensaje, n.enlace, n.leida, n.creada,
           (select count(*) from public.notificaciones x where x.user_id = auth.uid() and not x.leida)
    from public.notificaciones n where n.user_id = auth.uid()
    order by n.creada desc limit greatest(1, least(p_limite, 200));
end $$;

-- p_ids nulo = marcar todas
create or replace function public.marcar_notificaciones(p_ids bigint[] default null) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    update public.notificaciones set leida = true
     where user_id = auth.uid() and not leida and (p_ids is null or id = any (p_ids));
end $$;


-- Permisos de ejecución: sólo usuarios con sesión
do $$
declare f text;
begin
    foreach f in array array[
        'mi_perfil()',
        'tiene_rol(text[])',
        'mis_notificaciones(integer)',
        'marcar_notificaciones(bigint[])',
        'admin_usuarios()',
        'admin_actualizar_usuario(uuid,text,text,boolean)',
        'admin_crear_usuario(text,text,text,text)',
        'admin_editar_usuario(uuid,text,text,text,boolean)',
        'admin_cambiar_clave(uuid,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;

-- Funciones internas: nadie las llama directo desde la página
revoke all on function public.tg_nuevo_usuario() from public, anon, authenticated;
revoke all on function public._exigir_activo() from public, anon, authenticated;
revoke all on function public._exigir_rol(text[], text) from public, anon, authenticated;
-- Usadas por las políticas RLS: sólo usuarios con sesión
revoke all on function public.es_activo() from public, anon;
revoke all on function public.es_admin() from public, anon;
grant execute on function public.es_activo() to authenticated;
grant execute on function public.es_admin() to authenticated;
