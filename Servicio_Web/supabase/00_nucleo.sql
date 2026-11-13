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

-- Roles: vendedor -> validador -> auxiliar (de venta); admin puede todo
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

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo and rol = 'admin')
$$;

-- ¿El usuario tiene alguno de estos roles? (admin siempre cuenta)
create or replace function public.tiene_rol(p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and (rol = 'admin' or rol = any (p_roles)))
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
    if p_user = auth.uid() and (p_rol <> 'admin' or not p_activo) then
        raise exception 'No puedes quitarte a ti mismo el rol de administrador';
    end if;
    update public.perfiles set nombre = p_nombre, rol = p_rol, activo = p_activo where user_id = p_user;
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
        'admin_actualizar_usuario(uuid,text,text,boolean)'] loop
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
