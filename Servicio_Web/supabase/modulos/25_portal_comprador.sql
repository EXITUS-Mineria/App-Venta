-- ============================================================
-- PORTAL DEL COMPRADOR
--  El comprador entra a la misma página con su correo (rol "comprador") y sólo ve su portal:
--    🛒 Solicitar nueva compra · 📋 Mis propuestas · ✅ Mis compras
--  - Catálogo de compradores: nombre, RFC, contacto, vendedor responsable y los nombres con que
--    aparece en el Funnel (alias). Las ventas se ligan solas por nombre (sin acentos ni mayúsculas).
--  - Accesos al portal: sólo validador / admin los dan de alta (módulo Compradores).
--  - El vendedor PUBLICA la propuesta al comprador (puede estar EN REVISIÓN). El comprador la ve en
--    pantalla y la Acepta o Rechaza. El precio se muestra cuando el validador ya la aprobó.
--  - Mis compras: ventas Vendidas (también las históricas) con su avance y documentos (sólo ver).
--  SEGURIDAD: es_activo() deja de contar a los compradores, así que TODAS las funciones y políticas
--  internas los rechazan. El portal usa sólo funciones portal_* que filtran por su comprador.
-- Requiere 00 y 10-24. Idempotente.
-- ============================================================

-- ---------- roles ----------
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador'));

-- Usuario INTERNO activo (los compradores no cuentan)
create or replace function public.es_activo() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo and rol <> 'comprador')
$$;

-- Cualquier usuario activo (interno o comprador): sólo para la campana de avisos
create or replace function public._exigir_usuario() returns void
language plpgsql stable security definer set search_path = public as $$
begin
    if not exists (select 1 from public.perfiles where user_id = auth.uid() and activo) then
        raise exception 'Usuario sin acceso' using errcode = '42501';
    end if;
end $$;
revoke all on function public._exigir_usuario() from public, anon, authenticated;

-- ---------- catálogo de compradores ----------
create table if not exists public.compradores (
    id             bigserial primary key,
    nombre         text not null,
    rfc            text,
    correo         text,
    telefono       text,
    notas          text,
    alias          text[] not null default '{}',     -- nombres con que aparece en el Funnel
    vendedor_user  uuid references auth.users (id) on delete set null,
    activo         boolean not null default true,
    creado         timestamptz not null default now(),
    creado_por     text
);
alter table public.compradores enable row level security;
revoke all on public.compradores from anon, authenticated;

-- "José de Jesús  Valdés" = "JOSE DE JESUS VALDES"
create or replace function public._clave_nombre(t text) returns text
language sql immutable set search_path = public as $$
    select regexp_replace(trim(public._sin_acentos(t)), '\s+', ' ', 'g')
$$;
create unique index if not exists compradores_nombre on public.compradores (public._clave_nombre(nombre));

alter table public.perfiles add column if not exists comprador_id bigint references public.compradores (id) on delete set null;

alter table public.funnel_ventas add column if not exists comprador_id bigint references public.compradores (id) on delete set null;
alter table public.funnel_ventas add column if not exists publicada_en timestamptz;
alter table public.funnel_ventas add column if not exists publicada_por text;
alter table public.funnel_ventas add column if not exists vistas integer not null default 0;
alter table public.funnel_ventas add column if not exists ultima_vista timestamptz;
alter table public.funnel_ventas add column if not exists respuesta text;
alter table public.funnel_ventas add column if not exists respuesta_en timestamptz;
alter table public.funnel_ventas add column if not exists respuesta_por text;
alter table public.funnel_ventas add column if not exists respuesta_comentario text;
alter table public.funnel_ventas drop constraint if exists funnel_respuesta_check;
alter table public.funnel_ventas add constraint funnel_respuesta_check check (respuesta in ('ACEPTADA', 'RECHAZADA'));
create index if not exists funnel_comprador_id on public.funnel_ventas (comprador_id);

-- ¿A qué comprador del catálogo corresponde este nombre del Funnel?
create or replace function public._comprador_de(p_nombre text) returns bigint
language sql stable security definer set search_path = public as $$
    select c.id from public.compradores c
     where coalesce(trim(p_nombre), '') <> ''
       and (public._clave_nombre(c.nombre) = public._clave_nombre(p_nombre)
            or exists (select 1 from unnest(c.alias) a where public._clave_nombre(a) = public._clave_nombre(p_nombre)))
     order by c.activo desc, c.id limit 1
$$;
revoke all on function public._comprador_de(text) from public, anon, authenticated;

create or replace function public._funnel_ligar_comprador() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if tg_op = 'INSERT' or new.comprador is distinct from old.comprador then
        new.comprador_id := public._comprador_de(new.comprador);
    end if;
    return new;
end $$;
revoke all on function public._funnel_ligar_comprador() from public, anon, authenticated;
drop trigger if exists funnel_ligar_comprador on public.funnel_ventas;
create trigger funnel_ligar_comprador before insert or update of comprador on public.funnel_ventas
    for each row execute function public._funnel_ligar_comprador();

create or replace function public._religar_compradores() returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
    update public.funnel_ventas f set comprador_id = x.nuevo
      from (select folio, public._comprador_de(comprador) nuevo from public.funnel_ventas) x
     where x.folio = f.folio and f.comprador_id is distinct from x.nuevo;
    get diagnostics n = row_count;
    return n;
end $$;
revoke all on function public._religar_compradores() from public, anon, authenticated;

-- Avisar a todos los usuarios del portal de un comprador
create or replace function public._notificar_comprador(p_comprador bigint, p_titulo text, p_mensaje text, p_enlace text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare u uuid;
begin
    for u in select user_id from public.perfiles where comprador_id = p_comprador and rol = 'comprador' and activo loop
        perform public._notificar(null, u, p_titulo, p_mensaje, p_enlace);
    end loop;
end $$;
revoke all on function public._notificar_comprador(bigint, text, text, text) from public, anon, authenticated;

-- ---------- campana: también para compradores ----------
create or replace function public.mis_notificaciones(p_limite integer default 30)
returns table (id bigint, titulo text, mensaje text, enlace text, leida boolean, creada timestamptz, sin_leer bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_usuario();
    return query
    select n.id, n.titulo, n.mensaje, n.enlace, n.leida, n.creada,
           (select count(*) from public.notificaciones x where x.user_id = auth.uid() and not x.leida)
    from public.notificaciones n where n.user_id = auth.uid()
    order by n.creada desc limit greatest(1, least(p_limite, 200));
end $$;

create or replace function public.marcar_notificaciones(p_ids bigint[] default null) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_usuario();
    update public.notificaciones set leida = true
     where user_id = auth.uid() and not leida and (p_ids is null or id = any (p_ids));
end $$;

-- ---------- usuarios: el rol comprador sólo se da desde Compradores ----------
create or replace function public._crear_usuario_auth(p_email text, p_nombre text, p_rol text, p_clave text, p_comprador bigint)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(trim(p_email));
begin
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
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
    insert into public.perfiles (user_id, email, nombre, rol, comprador_id)
    values (v_id, v_email, coalesce(nullif(trim(p_nombre), ''), split_part(v_email, '@', 1)), p_rol, p_comprador)
    on conflict (user_id) do update set nombre = excluded.nombre, rol = excluded.rol, activo = true,
                                        comprador_id = excluded.comprador_id;
    return v_id;
end $$;
revoke all on function public._crear_usuario_auth(text, text, text, text, bigint) from public, anon, authenticated;

create or replace function public.admin_crear_usuario(p_email text, p_nombre text, p_rol text, p_clave text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden dar de alta usuarios'; end if;
    if p_rol = 'comprador' then raise exception 'Los accesos de comprador se dan de alta en el módulo Compradores'; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin') then raise exception 'Rol no válido: %', p_rol; end if;
    return public._crear_usuario_auth(p_email, p_nombre, p_rol, p_clave, null);
end $$;

create or replace function public.admin_editar_usuario(p_user uuid, p_email text, p_nombre text, p_rol text, p_activo boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_comp bigint;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden editar usuarios'; end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador') then raise exception 'Rol no válido: %', p_rol; end if;
    select comprador_id into v_comp from public.perfiles where user_id = p_user;
    if p_rol = 'comprador' and v_comp is null then
        raise exception 'Los accesos de comprador se dan de alta en el módulo Compradores';
    end if;
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
       set email = v_email, nombre = nullif(trim(p_nombre), ''), rol = p_rol, activo = p_activo,
           comprador_id = case when p_rol = 'comprador' then comprador_id end
     where user_id = p_user;
    if not found then raise exception 'No existe el usuario'; end if;
end $$;

drop function if exists public.admin_usuarios();
create or replace function public.admin_usuarios()
returns table (user_id uuid, email text, nombre text, rol text, activo boolean, creado timestamptz, comprador text)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo administradores'; end if;
    return query select p.user_id, p.email, p.nombre, p.rol, p.activo, p.creado, c.nombre
                 from public.perfiles p left join public.compradores c on c.id = p.comprador_id order by p.email;
end $$;

-- ============================================================
-- INTERNO: catálogo, accesos, solicitudes y publicación
-- ============================================================
create table if not exists public.solicitudes_compra (
    id            bigserial primary key,
    comprador_id  bigint not null references public.compradores (id) on delete cascade,
    user_id       uuid references auth.users (id) on delete set null,
    solicitante   text,
    tipo_cartera  text check (tipo_cartera in ('JyP', 'Grupal', 'Cualquiera')),
    estados       text,
    municipios    text,
    dias_min      integer,
    dias_max      integer,
    capital_aprox numeric,
    comentarios   text,
    estatus       text not null default 'NUEVA' check (estatus in ('NUEVA', 'EN PROCESO', 'ATENDIDA', 'CANCELADA')),
    folio         text references public.funnel_ventas (folio) on delete set null,
    respuesta     text,                       -- lo que ve el comprador
    atendida_por  text,
    actualizada   timestamptz,
    fecha         timestamptz not null default now()
);
create index if not exists solicitudes_comprador on public.solicitudes_compra (comprador_id, fecha desc);
alter table public.solicitudes_compra enable row level security;
revoke all on public.solicitudes_compra from anon, authenticated;

create or replace function public.compradores_lista()
returns table (id bigint, nombre text, rfc text, correo text, telefono text, notas text, alias text[],
               vendedor_user uuid, vendedor text, activo boolean, creado timestamptz,
               ventas bigint, vendidas bigint, monto numeric, accesos jsonb, solicitudes_abiertas bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select c.id, c.nombre, c.rfc, c.correo, c.telefono, c.notas, c.alias, c.vendedor_user,
           (select coalesce(v.nombre, v.email) from public.perfiles v where v.user_id = c.vendedor_user), c.activo, c.creado,
           (select count(*) from public.funnel_ventas f where f.comprador_id = c.id),
           (select count(*) from public.funnel_ventas f where f.comprador_id = c.id and f.estatus_venta = 'Vendida'),
           (select coalesce(sum(f.monto_venta), 0) from public.funnel_ventas f where f.comprador_id = c.id and f.estatus_venta = 'Vendida'),
           coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'email', p.email, 'nombre', p.nombre, 'activo', p.activo)
                                      order by p.email)
                       from public.perfiles p where p.comprador_id = c.id and p.rol = 'comprador'), '[]'::jsonb),
           (select count(*) from public.solicitudes_compra s where s.comprador_id = c.id and s.estatus in ('NUEVA', 'EN PROCESO'))
      from public.compradores c
     order by c.activo desc, c.nombre;
end $$;

-- Nombres de comprador escritos en el Funnel (para ligarlos como alias)
create or replace function public.compradores_nombres_funnel()
returns table (nombre text, ventas bigint, comprador_id bigint, comprador text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select f.comprador, count(*), max(f.comprador_id), max(c.nombre)
      from public.funnel_ventas f left join public.compradores c on c.id = f.comprador_id
     where coalesce(trim(f.comprador), '') <> ''
     group by f.comprador order by f.comprador;
end $$;

create or replace function public.compradores_guardar(p_id bigint, p_datos jsonb)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint := p_id; v_quien text; v_nombre text := nullif(trim(p_datos->>'nombre'), ''); v_alias text[];
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden editar compradores' using errcode = '42501'; end if;
    if v_nombre is null then raise exception 'Escribe el nombre del comprador'; end if;
    select coalesce(array_agg(distinct trim(a)) filter (where coalesce(trim(a), '') <> ''), '{}') into v_alias
      from jsonb_array_elements_text(coalesce(p_datos->'alias', '[]'::jsonb)) a;
    -- un nombre del Funnel sólo puede pertenecer a un comprador
    if exists (select 1 from public.compradores c, unnest(v_alias || v_nombre) a
                where c.id is distinct from p_id
                  and (public._clave_nombre(c.nombre) = public._clave_nombre(a)
                       or exists (select 1 from unnest(c.alias) b where public._clave_nombre(b) = public._clave_nombre(a)))) then
        raise exception 'Uno de los nombres ya pertenece a otro comprador: %', (
            select string_agg(distinct a || ' → ' || c.nombre, ', ') from public.compradores c, unnest(v_alias || v_nombre) a
             where c.id is distinct from p_id
               and (public._clave_nombre(c.nombre) = public._clave_nombre(a)
                    or exists (select 1 from unnest(c.alias) b where public._clave_nombre(b) = public._clave_nombre(a))));
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    if v_id is null then
        insert into public.compradores (nombre, rfc, correo, telefono, notas, alias, vendedor_user, activo, creado_por)
        values (v_nombre, upper(nullif(trim(p_datos->>'rfc'), '')), lower(nullif(trim(p_datos->>'correo'), '')),
                nullif(trim(p_datos->>'telefono'), ''), nullif(trim(p_datos->>'notas'), ''), v_alias,
                nullif(p_datos->>'vendedor_user', '')::uuid, coalesce((p_datos->>'activo')::boolean, true), v_quien)
        returning id into v_id;
    else
        update public.compradores
           set nombre = v_nombre, rfc = upper(nullif(trim(p_datos->>'rfc'), '')), correo = lower(nullif(trim(p_datos->>'correo'), '')),
               telefono = nullif(trim(p_datos->>'telefono'), ''), notas = nullif(trim(p_datos->>'notas'), ''), alias = v_alias,
               vendedor_user = nullif(p_datos->>'vendedor_user', '')::uuid, activo = coalesce((p_datos->>'activo')::boolean, activo)
         where id = v_id;
        if not found then raise exception 'No existe el comprador'; end if;
        if not coalesce((p_datos->>'activo')::boolean, true) then
            update public.perfiles set activo = false where comprador_id = v_id and rol = 'comprador';
        end if;
    end if;
    perform public._religar_compradores();
    return v_id;
end $$;

-- Dar acceso al portal (sólo maestros). La contraseña se muestra una vez y se comparte por un medio seguro.
create or replace function public.comprador_crear_acceso(p_comprador bigint, p_email text, p_nombre text, p_clave text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden dar accesos al portal' using errcode = '42501'; end if;
    if not exists (select 1 from public.compradores where id = p_comprador and activo) then
        raise exception 'El comprador no existe o está inactivo';
    end if;
    return public._crear_usuario_auth(p_email, p_nombre, 'comprador', p_clave, p_comprador);
end $$;

create or replace function public.solicitudes_lista()
returns table (id bigint, comprador_id bigint, comprador text, solicitante text, tipo_cartera text, estados text, municipios text,
               dias_min integer, dias_max integer, capital_aprox numeric, comentarios text, estatus text, folio text,
               respuesta text, atendida_por text, actualizada timestamptz, fecha timestamptz, vendedor text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select s.id, s.comprador_id, c.nombre, s.solicitante, s.tipo_cartera, s.estados, s.municipios, s.dias_min, s.dias_max,
           s.capital_aprox, s.comentarios, s.estatus, s.folio, s.respuesta, s.atendida_por, s.actualizada, s.fecha,
           (select coalesce(v.nombre, v.email) from public.perfiles v where v.user_id = c.vendedor_user)
      from public.solicitudes_compra s join public.compradores c on c.id = s.comprador_id
     order by (s.estatus in ('NUEVA', 'EN PROCESO')) desc, s.fecha desc;
end $$;

create or replace function public.solicitud_atender(p_id bigint, p_estatus text, p_folio text, p_respuesta text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_s public.solicitudes_compra; v_quien text;
begin
    perform public._exigir_rol(array['vendedor', 'auxiliar'], 'atender solicitudes de compra');
    if p_estatus not in ('EN PROCESO', 'ATENDIDA', 'CANCELADA') then raise exception 'Estatus no válido'; end if;
    select * into v_s from public.solicitudes_compra where id = p_id for update;
    if not found then raise exception 'No existe la solicitud'; end if;
    if nullif(trim(p_folio), '') is not null and not exists (select 1 from public.funnel_ventas where folio = upper(trim(p_folio))) then
        raise exception 'No existe el folio % en el Funnel', p_folio;
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.solicitudes_compra
       set estatus = p_estatus, folio = coalesce(upper(nullif(trim(p_folio), '')), folio),
           respuesta = nullif(trim(p_respuesta), ''), atendida_por = v_quien, actualizada = now()
     where id = p_id;
    perform public._notificar_comprador(v_s.comprador_id,
        case p_estatus when 'EN PROCESO' then '🛒 Estamos armando tu propuesta' when 'ATENDIDA' then '🛒 Tu solicitud fue atendida'
                       else '🛒 Tu solicitud fue cancelada' end,
        'Solicitud #' || p_id || coalesce(' · ' || nullif(trim(p_respuesta), ''), ''), 'solicitar');
end $$;

-- Publicar la propuesta en el portal del comprador (vendedor dueño, auxiliar o maestros)
create or replace function public.funnel_publicar(p_folio text, p_comprador bigint default null)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_f public.funnel_ventas; v_est text; v_quien text; v_comp public.compradores; v_correos text[];
begin
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro pueden publicarla', p_folio using errcode = '42501';
    end if;
    select * into v_f from public.funnel_ventas where folio = p_folio for update;
    if v_f.id_propuesta is null then raise exception '% es una venta histórica; no tiene propuesta en la página', p_folio; end if;
    select estatus into v_est from public.propuestas where id_propuesta = v_f.id_propuesta;
    if v_est in ('LIBERADA', 'RECHAZADA') then raise exception 'La propuesta está %; ya no se puede publicar', v_est; end if;
    if v_f.estatus_venta = 'Vendida' then raise exception '% ya está Vendida', p_folio; end if;

    if p_comprador is not null then
        select * into v_comp from public.compradores where id = p_comprador and activo;
        if not found then raise exception 'El comprador no existe o está inactivo'; end if;
        -- el nombre del Funnel queda como alias para que la liga no se pierda
        if public._comprador_de(v_f.comprador) is distinct from p_comprador and coalesce(trim(v_f.comprador), '') <> '' then
            if public._comprador_de(v_f.comprador) is not null then
                raise exception 'El nombre «%» ya está ligado a otro comprador del catálogo', v_f.comprador;
            end if;
            update public.compradores set alias = array_append(alias, trim(v_f.comprador)) where id = p_comprador;
        end if;
        v_f.comprador_id := p_comprador;
    end if;
    if v_f.comprador_id is null then
        raise exception 'Liga % con un comprador del catálogo antes de publicar', p_folio;
    end if;
    select * into v_comp from public.compradores where id = v_f.comprador_id;
    select array_agg(email order by email) into v_correos
      from public.perfiles where comprador_id = v_f.comprador_id and rol = 'comprador' and activo;

    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.funnel_ventas
       set comprador_id = v_f.comprador_id, comprador = coalesce(nullif(trim(comprador), ''), v_comp.nombre),
           publicada_en = now(), publicada_por = v_quien,
           respuesta = null, respuesta_en = null, respuesta_por = null, respuesta_comentario = null,
           actualizado = now(), actualizado_por = v_quien
     where folio = p_folio;
    insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
    values (v_f.id_propuesta, v_quien, 'Publicada al comprador', v_comp.nombre);
    perform public._notificar_comprador(v_f.comprador_id, '📋 Nueva propuesta: ' || p_folio,
        'Tienes una propuesta de cartera para revisar.', 'propuestas');
    perform public._notificar(array['validador'], null, '🌐 Propuesta publicada al comprador',
        p_folio || ' → ' || v_comp.nombre || ' (' || v_quien || ')', 'funnel');
    return json_build_object('comprador', v_comp.nombre, 'correos', coalesce(v_correos, '{}'),
                             'vendedor', v_quien, 'estatus_propuesta', v_est);
end $$;

create or replace function public.funnel_retirar(p_folio text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text; v_prop text;
begin
    if not public.funnel_puede_editar(p_folio) then raise exception 'Sin permiso para %', p_folio using errcode = '42501'; end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.funnel_ventas set publicada_en = null, publicada_por = null, actualizado = now(), actualizado_por = v_quien
     where folio = p_folio returning id_propuesta into v_prop;
    if v_prop is not null then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle) values (v_prop, v_quien, 'Retirada del portal', null);
    end if;
end $$;

-- Datos para el correo de aviso (Edge Function "enviar-propuesta", acción "avisar")
create or replace function public.funnel_aviso_portal(p_folio text)
returns table (correo text, nombre text, comprador text, vendedor_nombre text, vendedor_correo text)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.funnel_puede_editar(p_folio) then raise exception 'Sin permiso para %', p_folio using errcode = '42501'; end if;
    return query
    select p.email, p.nombre, c.nombre, yo.nombre, yo.email
      from public.funnel_ventas f join public.compradores c on c.id = f.comprador_id
      join public.perfiles p on p.comprador_id = c.id and p.rol = 'comprador' and p.activo
      left join public.perfiles yo on yo.user_id = auth.uid()
     where f.folio = p_folio and f.publicada_en is not null;
end $$;

-- Aviso al marcar Vendida (interno + comprador)
create or replace function public._funnel_aviso_estatus() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
    if new.estatus_venta is distinct from old.estatus_venta and new.estatus_venta = 'Vendida' then
        select user_id into v_user from public.propuestas where id_propuesta = new.id_propuesta;
        perform public._notificar(array['validador', 'auxiliar'], v_user, '✅ Venta marcada como Vendida',
            new.folio || ' · ' || coalesce(new.comprador, '') || ' · monto ' ||
            coalesce(to_char(new.monto_venta, 'FM$999,999,999.00'), '—') || ' (' || coalesce(new.actualizado_por, '') || ')', 'funnel');
        if new.comprador_id is not null then
            perform public._notificar_comprador(new.comprador_id, '✅ Compra registrada: ' || new.folio,
                'Tu compra quedó registrada. Puedes seguir su avance en Mis compras.', 'compras');
        end if;
    end if;
    return new;
end $$;
revoke all on function public._funnel_aviso_estatus() from public, anon, authenticated;

-- funnel_lista con comprador del catálogo y estado en el portal
drop function if exists public.funnel_lista();
create or replace function public.funnel_lista()
returns table (folio text, id_propuesta text, comprador text, capital numeric, monto_venta numeric, estado text,
               municipios text, tipo text, estatus_venta text, fecha_propuesta date, fecha_venta date, vendedor text,
               estatus_md text, fecha_inicio_md date, fecha_limite_md date, base_completa_venta text,
               estatus_control_doc text, fecha_inicio_admin date, fecha_limite_admin date, estatus_juridico text,
               estatus_final text, base_final text, propuesta_url text, comprobante_pago text,
               fecha_ticket_contrato date, numero_ticket_contrato text, numero_guia text, origen text,
               actualizado timestamptz, actualizado_por text, estatus_propuesta text, es_mia boolean,
               mes text, ligas_desc jsonb, adjuntos jsonb, n_comprobantes bigint, n_documentos bigint,
               correo_comprador text, enviada_en timestamptz, enviada_por text, envios integer,
               comprador_id bigint, comprador_cat text, publicada_en timestamptz, publicada_por text, vistas integer,
               ultima_vista timestamptz, respuesta text, respuesta_en timestamptz, respuesta_por text, respuesta_comentario text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with geo as (
        select d.id_propuesta,
               string_agg(distinct initcap(lower(coalesce(j.estado, g.estado))), ', ') estados,
               string_agg(distinct coalesce(j.municipio, g.municipio), ', ') munis
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta in (select f.id_propuesta from public.funnel_ventas f where f.id_propuesta is not null)
         group by d.id_propuesta
    )
    select f.folio, f.id_propuesta, f.comprador, f.capital, f.monto_venta,
           coalesce(nullif(f.estado, ''), geo.estados), coalesce(nullif(f.municipios, ''), left(geo.munis, 300)),
           f.tipo, f.estatus_venta, f.fecha_propuesta, f.fecha_venta, f.vendedor,
           f.estatus_md, f.fecha_inicio_md, f.fecha_limite_md, f.base_completa_venta,
           f.estatus_control_doc, f.fecha_inicio_admin, f.fecha_limite_admin, f.estatus_juridico,
           f.estatus_final, f.base_final, f.propuesta_url, f.comprobante_pago,
           f.fecha_ticket_contrato, f.numero_ticket_contrato, f.numero_guia, f.origen,
           f.actualizado, f.actualizado_por, p.estatus, coalesce(p.user_id = auth.uid(), false) or public._vendedor_es_yo(f.vendedor),
           f.mes, f.ligas_desc, f.adjuntos,
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprobante_pago'),
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprador'),
           f.correo_comprador, f.enviada_en, f.enviada_por, f.envios,
           f.comprador_id, c.nombre, f.publicada_en, f.publicada_por, f.vistas, f.ultima_vista,
           f.respuesta, f.respuesta_en, f.respuesta_por, f.respuesta_comentario
      from public.funnel_ventas f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join public.compradores c on c.id = f.comprador_id
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;

-- ============================================================
-- PORTAL (sólo el comprador con sesión, sólo SUS datos)
-- ============================================================
create or replace function public._mi_comprador() returns bigint
language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
    select p.comprador_id into v from public.perfiles p join public.compradores c on c.id = p.comprador_id and c.activo
     where p.user_id = auth.uid() and p.activo and p.rol = 'comprador';
    if v is null then raise exception 'Usuario sin acceso al portal de compradores' using errcode = '42501'; end if;
    return v;
end $$;
revoke all on function public._mi_comprador() from public, anon, authenticated;

-- Situación de una propuesta vista por el comprador
create or replace function public._portal_situacion(f public.funnel_ventas, p_est text) returns text
language sql immutable set search_path = public as $$
    select case when f.estatus_venta = 'Vendida' then 'COMPRADA'
                when f.estatus_venta = 'Cancelada' or p_est in ('LIBERADA', 'RECHAZADA') then 'NO DISPONIBLE'
                when f.respuesta is not null then f.respuesta
                else 'PENDIENTE' end
$$;

create or replace function public.portal_inicio()
returns json
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); r json;
begin
    select json_build_object(
        'comprador', c.nombre,
        'vendedor', (select coalesce(v2.nombre, v2.email) from public.perfiles v2 where v2.user_id = c.vendedor_user),
        'vendedor_correo', (select v2.email from public.perfiles v2 where v2.user_id = c.vendedor_user),
        'propuestas_pendientes', (select count(*) from public.funnel_ventas f left join public.propuestas p on p.id_propuesta = f.id_propuesta
                                   where f.comprador_id = v and f.publicada_en is not null and public._portal_situacion(f, p.estatus) = 'PENDIENTE'),
        'propuestas', (select count(*) from public.funnel_ventas f where f.comprador_id = v and f.publicada_en is not null),
        'compras', (select count(*) from public.funnel_ventas f where f.comprador_id = v and f.estatus_venta = 'Vendida'),
        'monto_compras', (select coalesce(sum(f.monto_venta), 0) from public.funnel_ventas f where f.comprador_id = v and f.estatus_venta = 'Vendida'),
        'solicitudes_abiertas', (select count(*) from public.solicitudes_compra s where s.comprador_id = v and s.estatus in ('NUEVA', 'EN PROCESO')))
      into r from public.compradores c where c.id = v;
    return r;
end $$;

create or replace function public.portal_propuestas()
returns table (folio text, publicada_en timestamptz, creditos bigint, capital numeric, precio numeric, tipo text,
               estados text, municipios text, dias_prom numeric, situacion text, respuesta_en timestamptz,
               respuesta_comentario text, vendedor text, vendedor_correo text)
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    return query
    select f.folio, f.publicada_en,
           (select count(*) from public.propuesta_detalle d where d.id_propuesta = f.id_propuesta),
           f.capital,
           case when p.estatus in ('APROBADA', 'EN VENTA') or f.estatus_venta = 'Vendida' then f.monto_venta end,
           f.tipo,
           (select string_agg(distinct initcap(lower(coalesce(j.estado, g.estado))), ', ')
              from public.propuesta_detalle d
              left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
              left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
             where d.id_propuesta = f.id_propuesta),
           left((select string_agg(distinct coalesce(j.municipio, g.municipio), ', ')
              from public.propuesta_detalle d
              left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
              left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
             where d.id_propuesta = f.id_propuesta), 300),
           p.dias_mora,
           public._portal_situacion(f, p.estatus), f.respuesta_en, f.respuesta_comentario,
           p.usuario, (select pe.email from public.perfiles pe where pe.user_id = p.user_id)
      from public.funnel_ventas f join public.propuestas p on p.id_propuesta = f.id_propuesta
     where f.comprador_id = v and f.publicada_en is not null
     order by (public._portal_situacion(f, p.estatus) = 'PENDIENTE') desc, f.publicada_en desc;
end $$;

-- Detalle de créditos (propuesta publicada o compra de la página). Cuenta las vistas.
create or replace function public.portal_detalle(p_folio text)
returns table (vreference text, vgroupid text, dias numeric, capital numeric, colonia text, cp text, municipio text, estado text)
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); v_f public.funnel_ventas; v_est text;
begin
    select * into v_f from public.funnel_ventas f where f.folio = p_folio and f.comprador_id = v;
    if not found or v_f.id_propuesta is null or (v_f.publicada_en is null and v_f.estatus_venta <> 'Vendida') then
        raise exception 'No tienes acceso a %', p_folio using errcode = '42501';
    end if;
    select estatus into v_est from public.propuestas where id_propuesta = v_f.id_propuesta;
    if public._portal_situacion(v_f, v_est) = 'NO DISPONIBLE' then raise exception 'La propuesta % ya no está disponible', p_folio; end if;
    update public.funnel_ventas set vistas = vistas + 1, ultima_vista = now() where folio = p_folio;
    return query
    select d.vreference, d.vgroupid, coalesce(j.dias, g.dias), round(d.npendingk, 2),
           coalesce(nullif(j.colonia, ''), nullif(g.colonia, ''), d.datos->>'Colonia', d.datos->>'vColonia', d.datos->>'COLONIA'),
           coalesce(d.datos->>'CP', d.datos->>'C.P'), coalesce(j.municipio, g.municipio), coalesce(j.estado, g.estado)
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = v_f.id_propuesta
     order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
end $$;

create or replace function public.portal_responder(p_folio text, p_respuesta text, p_comentario text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); v_f public.funnel_ventas; v_est text; v_user uuid; v_quien text; v_comp text;
begin
    if p_respuesta not in ('ACEPTADA', 'RECHAZADA') then raise exception 'Respuesta no válida'; end if;
    if p_respuesta = 'RECHAZADA' and coalesce(trim(p_comentario), '') = '' then
        raise exception 'Cuéntanos por qué la rechazas (nos ayuda a armar una mejor propuesta)';
    end if;
    select * into v_f from public.funnel_ventas f where f.folio = p_folio and f.comprador_id = v and f.publicada_en is not null for update;
    if not found then raise exception 'No tienes acceso a %', p_folio using errcode = '42501'; end if;
    select estatus, user_id into v_est, v_user from public.propuestas where id_propuesta = v_f.id_propuesta;
    if public._portal_situacion(v_f, v_est) <> 'PENDIENTE' then
        raise exception 'La propuesta % ya no espera respuesta (%)', p_folio, public._portal_situacion(v_f, v_est);
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    select nombre into v_comp from public.compradores where id = v;
    update public.funnel_ventas
       set respuesta = p_respuesta, respuesta_en = now(), respuesta_por = v_quien,
           respuesta_comentario = nullif(trim(p_comentario), ''), actualizado = now(), actualizado_por = v_quien
     where folio = p_folio;
    insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
    values (v_f.id_propuesta, v_quien || ' (comprador)', case p_respuesta when 'ACEPTADA' then 'Aceptada por el comprador'
                                                           else 'Rechazada por el comprador' end, nullif(trim(p_comentario), ''));
    perform public._notificar(case p_respuesta when 'ACEPTADA' then array['validador', 'auxiliar'] else array['validador'] end, v_user,
        case p_respuesta when 'ACEPTADA' then '👍 El comprador ACEPTÓ ' else '👎 El comprador rechazó ' end || p_folio,
        v_comp || coalesce(' · «' || nullif(trim(p_comentario), '') || '»', ''), 'funnel');
end $$;

create or replace function public.portal_compras()
returns table (folio text, fecha_venta date, capital numeric, monto_venta numeric, tipo text, estado text, municipios text,
               creditos bigint, estatus_md text, estatus_control_doc text, estatus_juridico text, estatus_final text,
               numero_guia text, documentos bigint, con_detalle boolean)
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    return query
    select f.folio, f.fecha_venta, f.capital, f.monto_venta, f.tipo,
           coalesce(nullif(f.estado, ''), (select string_agg(distinct initcap(lower(coalesce(j.estado, g.estado))), ', ')
              from public.propuesta_detalle d
              left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
              left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
             where d.id_propuesta = f.id_propuesta)), f.municipios,
           (select count(*) from public.propuesta_detalle d where d.id_propuesta = f.id_propuesta),
           f.estatus_md, f.estatus_control_doc, f.estatus_juridico, f.estatus_final, f.numero_guia,
           (select count(*) from public.funnel_documentos d where d.folio = f.folio), f.id_propuesta is not null
      from public.funnel_ventas f
     where f.comprador_id = v and f.estatus_venta = 'Vendida'
     order by f.fecha_venta desc nulls last, f.folio desc;
end $$;

-- ¿Es una compra de este comprador? (para ver documentos)
create or replace function public._portal_folio_mio(p_folio text) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.funnel_ventas f join public.perfiles p on p.comprador_id = f.comprador_id
                    join public.compradores c on c.id = f.comprador_id and c.activo
                   where f.folio = p_folio and f.estatus_venta = 'Vendida'
                     and p.user_id = auth.uid() and p.activo and p.rol = 'comprador')
$$;
revoke all on function public._portal_folio_mio(text) from public, anon;
grant execute on function public._portal_folio_mio(text) to authenticated;

create or replace function public.portal_documentos(p_folio text)
returns table (id bigint, tipo text, nombre text, ruta text, mime text, bytes integer, fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._mi_comprador();
    if not public._portal_folio_mio(p_folio) then raise exception 'No tienes acceso a %', p_folio using errcode = '42501'; end if;
    return query select d.id, d.tipo, d.nombre, d.ruta, d.mime, d.bytes, d.fecha
                   from public.funnel_documentos d where d.folio = p_folio order by d.tipo, d.fecha;
end $$;

-- El comprador sólo puede abrir (liga temporal) archivos de SUS compras
drop policy if exists "documentos_venta_ver_comprador" on storage.objects;
create policy "documentos_venta_ver_comprador" on storage.objects for select to authenticated
    using (bucket_id = 'documentos-venta' and public._portal_folio_mio(split_part(name, '/', 1)));

create or replace function public.portal_solicitar(p_datos jsonb)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); v_id bigint; v_quien text; v_c public.compradores;
        v_min integer := nullif(p_datos->>'dias_min', '')::integer; v_max integer := nullif(p_datos->>'dias_max', '')::integer;
begin
    if (select count(*) from public.solicitudes_compra where comprador_id = v and fecha > now() - interval '1 day') >= 10 then
        raise exception 'Llegaste al máximo de solicitudes por día';
    end if;
    if v_min is not null and v_max is not null and v_min > v_max then raise exception 'Revisa el rango de días de atraso'; end if;
    if coalesce(trim(p_datos->>'estados'), '') = '' and coalesce(trim(p_datos->>'comentarios'), '') = '' then
        raise exception 'Indica al menos un estado o escribe qué cartera buscas';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    select * into v_c from public.compradores where id = v;
    insert into public.solicitudes_compra (comprador_id, user_id, solicitante, tipo_cartera, estados, municipios,
                                           dias_min, dias_max, capital_aprox, comentarios)
    values (v, auth.uid(), v_quien, coalesce(nullif(p_datos->>'tipo_cartera', ''), 'Cualquiera'),
            left(nullif(trim(p_datos->>'estados'), ''), 500), left(nullif(trim(p_datos->>'municipios'), ''), 4000),
            v_min, v_max, nullif(p_datos->>'capital_aprox', '')::numeric, left(nullif(trim(p_datos->>'comentarios'), ''), 2000))
    returning id into v_id;
    perform public._notificar(case when v_c.vendedor_user is null then array['validador', 'vendedor'] else array['validador'] end,
        v_c.vendedor_user, '🛒 Solicitud de compra #' || v_id, v_c.nombre || coalesce(' · ' || nullif(trim(p_datos->>'estados'), ''), '')
        || coalesce(' · capital aprox. ' || to_char(nullif(p_datos->>'capital_aprox', '')::numeric, 'FM$999,999,999'), ''), 'compradores');
    return v_id;
end $$;

create or replace function public.portal_solicitudes()
returns table (id bigint, fecha timestamptz, tipo_cartera text, estados text, municipios text, dias_min integer, dias_max integer,
               capital_aprox numeric, comentarios text, estatus text, folio text, respuesta text, actualizada timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    return query select s.id, s.fecha, s.tipo_cartera, s.estados, s.municipios, s.dias_min, s.dias_max, s.capital_aprox,
                        s.comentarios, s.estatus, s.folio, s.respuesta, s.actualizada
                   from public.solicitudes_compra s where s.comprador_id = v order by s.fecha desc limit 100;
end $$;

create or replace function public.portal_cancelar_solicitud(p_id bigint)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    update public.solicitudes_compra set estatus = 'CANCELADA', actualizada = now(), respuesta = 'Cancelada por el comprador'
     where id = p_id and comprador_id = v and estatus = 'NUEVA';
    if not found then raise exception 'Sólo se pueden cancelar solicitudes NUEVAS'; end if;
end $$;

-- Estados/municipios disponibles para el formulario de solicitud, por tipo de cartera
drop function if exists public.portal_catalogo_geo();
create or replace function public.portal_catalogo_geo()
returns table (tipo text, estado text, municipio text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._mi_comprador();
    return query
    -- agrupa primero por las columnas normalizadas (estado_n / municipio_n) y luego une acentos: ~1 s
    with x as (
        select 'JyP'::text t, j.estado_n en, j.municipio_n mn, max(j.estado) e, max(j.municipio) m
          from public.cartera_jyp j where public.norm(j.estatus_base) = 'DISPONIBLE' and j.estado_n <> '' group by 2, 3
        union all
        select 'Grupal', g.estado_n, g.municipio_n, max(g.estado), max(g.municipio)
          from public.cartera_grupal g where public.norm(g.estatus_base) = 'DISPONIBLE' and g.estado_n <> '' group by 2, 3),
    y as (select x.t, public._clave_nombre(x.e) ke, public._clave_nombre(x.m) km, x.e, x.m from x
           where coalesce(trim(x.e), '') !~ '^[0-9]*$' and coalesce(trim(x.m), '') <> ''),
    -- "Mexico" y "México" son el mismo estado: se muestra la forma con acentos
    e as (select y.ke, initcap(lower(trim(max(y.e)))) nombre from y group by 1),
    m as (select y.ke, y.km, initcap(lower(trim(max(y.m)))) nombre from y group by 1, 2)
    select distinct y.t, e.nombre, m.nombre
      from y join e on e.ke = y.ke join m on m.ke = y.ke and m.km = y.km
     order by 1, 2, 3;
end $$;

-- Lo mismo, una fila por tipo + estado con sus municipios: la API de Supabase regresa máx. 1,000 filas
create or replace function public.portal_catalogo_estados()
returns table (tipo text, estado text, municipios text[])
language plpgsql stable security definer set search_path = public as $$
begin
    return query
    select g.tipo, g.estado, array_agg(g.municipio order by g.municipio)
      from public.portal_catalogo_geo() g group by 1, 2 order by 1, 2;
end $$;
revoke all on function public.portal_catalogo_estados() from public, anon;
grant execute on function public.portal_catalogo_estados() to authenticated;

-- enlaces de avisos: id del módulo sin "#/"
update public.notificaciones set enlace = regexp_replace(enlace, '^#/', '') where enlace like '#/%';

-- ligar lo que ya existe
select public._religar_compradores();

do $$
declare f text;
begin
    foreach f in array array[
        'mis_notificaciones(integer)', 'marcar_notificaciones(bigint[])',
        'admin_crear_usuario(text,text,text,text)', 'admin_editar_usuario(uuid,text,text,text,boolean)', 'admin_usuarios()',
        'compradores_lista()', 'compradores_nombres_funnel()', 'compradores_guardar(bigint,jsonb)',
        'comprador_crear_acceso(bigint,text,text,text)', 'solicitudes_lista()', 'solicitud_atender(bigint,text,text,text)',
        'funnel_publicar(text,bigint)', 'funnel_retirar(text)', 'funnel_aviso_portal(text)', 'funnel_lista()',
        'portal_inicio()', 'portal_propuestas()', 'portal_detalle(text)', 'portal_responder(text,text,text)',
        'portal_compras()', 'portal_documentos(text)', 'portal_solicitar(jsonb)', 'portal_solicitudes()',
        'portal_cancelar_solicitud(bigint)', 'portal_catalogo_geo()'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
revoke all on function public._portal_situacion(public.funnel_ventas, text) from public, anon, authenticated;
