-- ============================================================
-- JURÍDICO · funnel de juicios (réplica de la lista SharePoint «LEGAL 1» del Área Legal)
--  - Un renglón por juicio ligado al crédito por vReference.
--  - 4 etapas: 1 Presentación de demanda · 2 Emplazamiento · 3 Probatoria · 4 Sentencia y resolución.
--    Cada etapa: opción + fecha del acto + observaciones (se AGREGAN, no se borran).
--  - Roles nuevos: abogado (abogados y pasantes: editan SUS juicios) y coord_juridico (edita todos, asigna).
--    Los maestros (validador / admin) también ven y editan todo. Los usuarios jurídicos NO ven Venta de Cartera.
--  - Historial de cada cambio (reemplaza «Historial de versiones» de SharePoint).
--  - Documentos en Storage privado «documentos-juridico» (PDF, fotos, Word, máx. 10 MB).
-- Requiere 00, 22 y 25 (_sin_acentos, _vendedor_es_yo) y 25 (_crear_usuario_auth, _exigir_usuario). Idempotente.
-- ============================================================

-- ---------- roles ----------
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador', 'abogado', 'coord_juridico'));

-- Usuario INTERNO de Venta de Cartera (compradores y jurídico no cuentan: sólo usan sus funciones)
create or replace function public.es_activo() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and rol not in ('comprador', 'abogado', 'coord_juridico'))
$$;

create or replace function public.es_juridico() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and rol in ('abogado', 'coord_juridico', 'admin', 'validador'))
$$;
create or replace function public.es_coord_juridico() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and rol in ('coord_juridico', 'admin', 'validador'))
$$;
create or replace function public._exigir_juridico() returns void
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.es_juridico() then raise exception 'Usuario sin acceso a Jurídico' using errcode = '42501'; end if;
end $$;

create or replace function public.admin_crear_usuario(p_email text, p_nombre text, p_rol text, p_clave text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden dar de alta usuarios'; end if;
    if p_rol = 'comprador' then raise exception 'Los accesos de comprador se dan de alta en el módulo Compradores'; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'abogado', 'coord_juridico') then
        raise exception 'Rol no válido: %', p_rol;
    end if;
    return public._crear_usuario_auth(p_email, p_nombre, p_rol, p_clave, null);
end $$;

create or replace function public.admin_editar_usuario(p_user uuid, p_email text, p_nombre text, p_rol text, p_activo boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_comp bigint;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden editar usuarios'; end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador', 'abogado', 'coord_juridico') then
        raise exception 'Rol no válido: %', p_rol;
    end if;
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

drop view if exists public.usuarios_app;
create view public.usuarios_app
with (security_invoker = true) as
select u.email::text                    as correo,
       p.nombre,
       case p.rol when 'validador' then 'Validador (maestro)' when 'auxiliar' then 'Auxiliar de venta'
                  when 'control_doc' then 'Control documental' when 'admin' then 'Administrador'
                  when 'comprador' then 'Comprador' when 'abogado' then 'Abogado / pasante'
                  when 'coord_juridico' then 'Coordinador jurídico' else 'Vendedor' end as rol,
       p.activo,
       u.email_confirmed_at is not null as confirmado,
       u.last_sign_in_at                as ultimo_ingreso,
       p.creado                         as alta,
       p.user_id
  from public.perfiles p
  join auth.users u on u.id = p.user_id;
revoke all on public.usuarios_app from anon, authenticated;


-- ---------- juicios ----------
create sequence if not exists public.folio_juicio start 1;

create table if not exists public.juicios (
    id                 bigserial primary key,
    folio              text not null unique,                 -- JUR-0001…
    sp_id              integer unique,                       -- Id en la lista LEGAL 1 (migrados)
    vreference         text,
    nombre             text,                                 -- vName
    abogado            text,
    abogado_email      text,
    pasante            text,
    expediente         text,
    juzgado            text,
    medio_preparatorio boolean not null default false,
    etapa1 text check (etapa1 in ('Admision de Demanda', 'Prevención', 'Desechamiento')),
    fecha_etapa1 date, obs_e1 text,
    etapa2 text check (etapa2 in ('Cedula', 'Nueva Fecha de Diligencia', 'Diligencia Exitosa', 'Diligencia No Exitosa', 'Ilocalizable')),
    fecha_etapa2 date, obs_e2 text,
    etapa3 text check (etapa3 in ('Apertura Prueba', 'Confesional', 'Pericial')),
    fecha_etapa3 date, obs_e3 text,
    etapa4 text check (etapa4 in ('Sentencia Favorable', 'Sentencia No Favorable', 'Apelacion', 'Amparo', 'Ejecucion', 'Convenio')),
    fecha_etapa4 date, obs_e4 text,
    adjuntos           jsonb not null default '[]',          -- ligas a los adjuntos de SharePoint (migrados)
    origen             text not null default 'pagina',       -- pagina | sharepoint
    activo             boolean not null default true,        -- false = dado de baja (no se borra)
    creado             timestamptz not null default now(),
    creado_por         text,
    actualizado        timestamptz not null default now(),
    actualizado_por    text
);
create index if not exists juicios_vref on public.juicios (vreference);
create index if not exists juicios_abogado on public.juicios (lower(abogado_email));
alter table public.juicios enable row level security;
revoke all on public.juicios from anon, authenticated;

create table if not exists public.juicios_historial (
    id        bigserial primary key,
    juicio_id bigint not null references public.juicios (id) on delete cascade,
    campo     text not null,
    antes     text,
    despues   text,
    user_id   uuid,
    quien     text,
    fecha     timestamptz not null default now()
);
create index if not exists juicios_historial_juicio on public.juicios_historial (juicio_id, fecha desc);
alter table public.juicios_historial enable row level security;
revoke all on public.juicios_historial from anon, authenticated;

create table if not exists public.juicios_documentos (
    id         bigserial primary key,
    juicio_id  bigint not null references public.juicios (id) on delete cascade,
    nombre     text not null,
    ruta       text not null unique,
    mime       text,
    bytes      integer,
    user_id    uuid,
    subido_por text,
    fecha      timestamptz not null default now()
);
create index if not exists juicios_documentos_juicio on public.juicios_documentos (juicio_id);
alter table public.juicios_documentos enable row level security;
revoke all on public.juicios_documentos from anon, authenticated;

-- Catálogo de pasantes (nombres exactos del manual operativo)
create table if not exists public.juridico_pasantes (
    nombre text primary key,
    activo boolean not null default true
);
alter table public.juridico_pasantes enable row level security;
revoke all on public.juridico_pasantes from anon, authenticated;
insert into public.juridico_pasantes (nombre) values
    ('Avila Vazquez Jose Pablo'), ('De La Cruz Sanchez Leslie Guadalupe'), ('Gutierrez Ruiz Litzy Carina'),
    ('Rojas Contreras Ramses'), ('Ruiz Huerta Luis Angel'), ('Vargas Ramos Abigail'), ('Villavicencio Gonzalez Galilea')
on conflict do nothing;

-- "Ruiz huerta Luis Ángel." / "LUIS ANGEL RUIZ HUERTA" → "Ruiz Huerta Luis Angel" (mismas palabras, cualquier orden)
create or replace function public._pasante_canonico(t text) returns text
language sql stable security definer set search_path = public as $$
    select coalesce((
        select p.nombre from public.juridico_pasantes p
         where (select array_agg(w order by w) from regexp_split_to_table(trim(regexp_replace(public._sin_acentos(p.nombre), '[^A-Z ]', ' ', 'g')), '\s+') w where w <> '')
             = (select array_agg(w order by w) from regexp_split_to_table(trim(regexp_replace(public._sin_acentos(t), '[^A-Z ]', ' ', 'g')), '\s+') w where w <> '')
         limit 1),
        -- errores de dedo: misma persona si comparten al menos 2 palabras completas
        (select p.nombre from public.juridico_pasantes p
          where (select count(*) from regexp_split_to_table(public._sin_acentos(p.nombre), '\s+') w
                  where length(w) >= 3 and position(w in regexp_replace(public._sin_acentos(t), '[^A-Z ]', ' ', 'g')) > 0) >= 2
          limit 1),
        nullif(trim(regexp_replace(t, '[.\s]+$', '')), ''))
$$;

-- ¿El juicio es mío? (abogado asignado por correo o nombre, o pasante por nombre)
create or replace function public._juicio_es_mio(j public.juicios) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles p where p.user_id = auth.uid() and p.activo
                   and lower(p.email) = lower(coalesce(j.abogado_email, '')))
        or public._vendedor_es_yo(j.abogado) or public._vendedor_es_yo(j.pasante)
$$;

create or replace function public._juicio_puede_editar(p_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
    select public.es_coord_juridico()
        or (public.es_juridico() and exists (select 1 from public.juicios j where j.id = p_id and public._juicio_es_mio(j)))
$$;
revoke all on function public._juicio_puede_editar(bigint) from public, anon;
grant execute on function public._juicio_puede_editar(bigint) to authenticated;

-- etapa actual: la más avanzada con opción
create or replace function public._juicio_etapa(j public.juicios) returns integer
language sql immutable as $$
    select case when j.etapa4 is not null then 4 when j.etapa3 is not null then 3
                when j.etapa2 is not null then 2 when j.etapa1 is not null then 1 else 0 end
$$;


-- ---------- lectura ----------
drop function if exists public.juridico_lista();
create or replace function public.juridico_lista()
returns table (id bigint, folio text, sp_id integer, vreference text, nombre text, abogado text, abogado_email text,
               pasante text, expediente text, juzgado text, medio_preparatorio boolean,
               etapa1 text, fecha_etapa1 date, obs_e1 text, etapa2 text, fecha_etapa2 date, obs_e2 text,
               etapa3 text, fecha_etapa3 date, obs_e3 text, etapa4 text, fecha_etapa4 date, obs_e4 text,
               adjuntos jsonb, origen text, creado timestamptz, creado_por text, actualizado timestamptz, actualizado_por text,
               es_mio boolean, puede_editar boolean, n_documentos bigint, vref_repetida boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_coord boolean := public.es_coord_juridico();
begin
    perform public._exigir_juridico();
    return query
    select j.id, j.folio, j.sp_id, j.vreference, j.nombre, j.abogado, j.abogado_email, j.pasante, j.expediente, j.juzgado,
           j.medio_preparatorio, j.etapa1, j.fecha_etapa1, j.obs_e1, j.etapa2, j.fecha_etapa2, j.obs_e2,
           j.etapa3, j.fecha_etapa3, j.obs_e3, j.etapa4, j.fecha_etapa4, j.obs_e4, j.adjuntos, j.origen,
           j.creado, j.creado_por, j.actualizado, j.actualizado_por,
           public._juicio_es_mio(j), v_coord or public._juicio_es_mio(j),
           (select count(*) from public.juicios_documentos d where d.juicio_id = j.id),
           coalesce(j.vreference, '') <> '' and exists (select 1 from public.juicios x where x.activo and x.id <> j.id
                                                         and x.vreference = j.vreference)
      from public.juicios j where j.activo
     order by j.actualizado desc;
end $$;

-- abogados para asignar: usuarios con rol abogado/coord + los que ya aparecen en los juicios
create or replace function public.juridico_abogados()
returns table (nombre text, email text, tiene_usuario boolean)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_juridico();
    return query
    with x as (
        select coalesce(nullif(trim(p.nombre), ''), p.email) n, lower(p.email) e, true u
          from public.perfiles p where p.activo and p.rol in ('abogado', 'coord_juridico')
        union all
        select j.abogado, lower(j.abogado_email), false from public.juicios j where j.activo and j.abogado is not null)
    select distinct on (x.e) x.n, x.e, bool_or(x.u) over (partition by x.e)
      from x where x.e is not null order by x.e, x.u desc;
end $$;

create or replace function public.juridico_pasantes_lista()
returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_juridico();
    return query select nombre from public.juridico_pasantes where activo order by nombre;
end $$;

create or replace function public.juridico_historial(p_id bigint)
returns table (campo text, antes text, despues text, quien text, fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_juridico();
    return query select h.campo, h.antes, h.despues, h.quien, h.fecha
                   from public.juicios_historial h where h.juicio_id = p_id order by h.fecha desc, h.id desc limit 300;
end $$;


-- ---------- escritura ----------
-- p_id nulo = alta. p_datos: claves de la tabla (sin obs_*: las observaciones se AGREGAN con juridico_agregar_nota).
create or replace function public.juridico_guardar(p_id bigint, p_datos jsonb)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare
    v_id bigint := p_id; v_quien text; v_j public.juicios; v_nuevo public.juicios; k text; v_old text; v_new text;
    v_coord boolean := public.es_coord_juridico();
    v_permitidos text[] := array['vreference', 'nombre', 'abogado', 'abogado_email', 'pasante', 'expediente', 'juzgado',
        'medio_preparatorio', 'etapa1', 'fecha_etapa1', 'etapa2', 'fecha_etapa2', 'etapa3', 'fecha_etapa3', 'etapa4', 'fecha_etapa4'];
    v_dest uuid;
begin
    perform public._exigir_juridico();
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    for k in select jsonb_object_keys(p_datos) loop
        if not k = any (v_permitidos) then raise exception 'Campo no editable: %', k; end if;
    end loop;

    if v_id is null then
        insert into public.juicios (folio, creado_por, actualizado_por, abogado, abogado_email)
        select 'JUR-' || lpad(nextval('public.folio_juicio')::text, 4, '0'), v_quien, v_quien,
               case when v_coord then null else coalesce(nullif(trim(p.nombre), ''), p.email) end,
               case when v_coord then null else lower(p.email) end
          from public.perfiles p where p.user_id = auth.uid()
        returning id into v_id;
        insert into public.juicios_historial (juicio_id, campo, despues, user_id, quien) values (v_id, 'alta', 'Juicio dado de alta', auth.uid(), v_quien);
    elsif not public._juicio_puede_editar(v_id) then
        raise exception 'Sólo el abogado o pasante asignado, o la coordinación jurídica, pueden editar este juicio' using errcode = '42501';
    end if;
    if not v_coord and (p_datos ? 'abogado' or p_datos ? 'abogado_email') and p_id is not null then
        raise exception 'Sólo la coordinación jurídica reasigna abogados';
    end if;

    select * into v_j from public.juicios where id = v_id for update;
    update public.juicios j set
        vreference         = case when p_datos ? 'vreference' then nullif(upper(trim(p_datos->>'vreference')), '') else j.vreference end,
        nombre             = case when p_datos ? 'nombre' then nullif(upper(trim(p_datos->>'nombre')), '') else j.nombre end,
        abogado            = case when p_datos ? 'abogado' then nullif(trim(p_datos->>'abogado'), '') else j.abogado end,
        abogado_email      = case when p_datos ? 'abogado_email' then nullif(lower(trim(p_datos->>'abogado_email')), '') else j.abogado_email end,
        pasante            = case when p_datos ? 'pasante' then public._pasante_canonico(p_datos->>'pasante') else j.pasante end,
        expediente         = case when p_datos ? 'expediente' then nullif(regexp_replace(trim(p_datos->>'expediente'), '\s*/\s*', '/'), '') else j.expediente end,
        juzgado            = case when p_datos ? 'juzgado' then nullif(upper(regexp_replace(trim(p_datos->>'juzgado'), '\s+', ' ', 'g')), '') else j.juzgado end,
        medio_preparatorio = case when p_datos ? 'medio_preparatorio' then coalesce((p_datos->>'medio_preparatorio')::boolean, false) else j.medio_preparatorio end,
        etapa1       = case when p_datos ? 'etapa1' then nullif(p_datos->>'etapa1', '') else j.etapa1 end,
        fecha_etapa1 = case when p_datos ? 'fecha_etapa1' then nullif(p_datos->>'fecha_etapa1', '')::date else j.fecha_etapa1 end,
        etapa2       = case when p_datos ? 'etapa2' then nullif(p_datos->>'etapa2', '') else j.etapa2 end,
        fecha_etapa2 = case when p_datos ? 'fecha_etapa2' then nullif(p_datos->>'fecha_etapa2', '')::date else j.fecha_etapa2 end,
        etapa3       = case when p_datos ? 'etapa3' then nullif(p_datos->>'etapa3', '') else j.etapa3 end,
        fecha_etapa3 = case when p_datos ? 'fecha_etapa3' then nullif(p_datos->>'fecha_etapa3', '')::date else j.fecha_etapa3 end,
        etapa4       = case when p_datos ? 'etapa4' then nullif(p_datos->>'etapa4', '') else j.etapa4 end,
        fecha_etapa4 = case when p_datos ? 'fecha_etapa4' then nullif(p_datos->>'fecha_etapa4', '')::date else j.fecha_etapa4 end,
        actualizado = now(), actualizado_por = v_quien
     where j.id = v_id returning * into v_nuevo;

    -- reglas del manual operativo
    if coalesce(v_nuevo.vreference, '') !~ '^[0-9]+-[0-9]$' and coalesce(v_nuevo.vreference, '') !~ '^GI[0-9]+$' then
        raise exception 'vReference «%» no válida: va tal cual del sistema, con guion y dígito (ej. 1000974336-9)', coalesce(v_nuevo.vreference, '');
    end if;
    if v_nuevo.abogado_email is null then raise exception 'Todo juicio tiene abogado asignado'; end if;
    if (v_nuevo.etapa1 is not null and v_nuevo.fecha_etapa1 is null) or (v_nuevo.etapa2 is not null and v_nuevo.fecha_etapa2 is null)
       or (v_nuevo.etapa3 is not null and v_nuevo.fecha_etapa3 is null) or (v_nuevo.etapa4 is not null and v_nuevo.fecha_etapa4 is null) then
        raise exception 'Cada etapa con opción lleva la fecha del acto procesal';
    end if;
    if greatest(v_nuevo.fecha_etapa1, v_nuevo.fecha_etapa2, v_nuevo.fecha_etapa3, v_nuevo.fecha_etapa4) > (now() at time zone 'America/Mexico_City')::date + 1 then
        raise exception 'La fecha de etapa no puede ser futura: es la del acuerdo o diligencia';
    end if;

    -- historial
    foreach k in array v_permitidos loop
        execute format('select ($1).%I::text, ($2).%I::text', k, k) into v_old, v_new using v_j, v_nuevo;
        if p_id is not null and v_old is distinct from v_new or p_id is null and v_new is not null then
            insert into public.juicios_historial (juicio_id, campo, antes, despues, user_id, quien)
            values (v_id, k, v_old, v_new, auth.uid(), v_quien);
        end if;
    end loop;

    -- aviso al abogado cuando se le asigna un juicio
    if v_nuevo.abogado_email is distinct from v_j.abogado_email and v_nuevo.abogado_email is not null then
        select user_id into v_dest from public.perfiles where lower(email) = v_nuevo.abogado_email and activo;
        if v_dest is not null then
            perform public._notificar(null, v_dest, 'Juicio asignado: ' || v_nuevo.folio,
                coalesce(v_nuevo.vreference, '') || ' · ' || coalesce(v_nuevo.nombre, '') || ' · exp. ' || coalesce(v_nuevo.expediente, 's/n'), 'juridico');
        end if;
    end if;
    -- aviso a coordinación cuando hay resolución
    if v_nuevo.etapa4 is distinct from v_j.etapa4 and v_nuevo.etapa4 is not null then
        perform public._notificar(array['coord_juridico'], null, v_nuevo.folio || ': ' || v_nuevo.etapa4,
            coalesce(v_nuevo.nombre, '') || ' · ' || coalesce(v_nuevo.abogado, ''), 'juridico');
    end if;
    return v_id;
end $$;

-- Agrega una línea «dd/mm/aaaa – texto» al final de las observaciones de la etapa (no se borra lo anterior)
create or replace function public.juridico_agregar_nota(p_id bigint, p_etapa integer, p_fecha date, p_texto text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text; v_linea text; v_col text := 'obs_e' || p_etapa;
begin
    if not public._juicio_puede_editar(p_id) then
        raise exception 'Sólo el abogado o pasante asignado, o la coordinación jurídica, pueden editar este juicio' using errcode = '42501';
    end if;
    if p_etapa not between 1 and 4 then raise exception 'Etapa no válida'; end if;
    if length(trim(coalesce(p_texto, ''))) < 3 then raise exception 'Escribe el detalle del movimiento'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    v_linea := to_char(coalesce(p_fecha, (now() at time zone 'America/Mexico_City')::date), 'DD/MM/YYYY') || ' – ' || trim(p_texto);
    execute format('update public.juicios set %1$I = case when coalesce(trim(%1$I), '''') = '''' then $1 else rtrim(%1$I, E'' \n'') || E''\n'' || $1 end,
                    actualizado = now(), actualizado_por = $2 where id = $3', v_col) using v_linea, v_quien, p_id;
    insert into public.juicios_historial (juicio_id, campo, despues, user_id, quien) values (p_id, v_col, v_linea, auth.uid(), v_quien);
end $$;

-- Baja (no se borra): sólo coordinación / maestros
create or replace function public.juridico_baja(p_id bigint, p_motivo text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text;
begin
    if not public.es_coord_juridico() then raise exception 'Sólo la coordinación jurídica da de baja juicios'; end if;
    if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escribe el motivo de la baja'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.juicios set activo = false, actualizado = now(), actualizado_por = v_quien where id = p_id;
    insert into public.juicios_historial (juicio_id, campo, antes, despues, user_id, quien) values (p_id, 'baja', 'activo', p_motivo, auth.uid(), v_quien);
end $$;


-- ---------- documentos (Storage privado) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos-juridico', 'documentos-juridico', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- Ruta: <id del juicio>/<marca>_<nombre>
drop policy if exists "documentos_juridico_ver" on storage.objects;
create policy "documentos_juridico_ver" on storage.objects for select to authenticated
    using (bucket_id = 'documentos-juridico' and public.es_juridico());
drop policy if exists "documentos_juridico_subir" on storage.objects;
create policy "documentos_juridico_subir" on storage.objects for insert to authenticated
    with check (bucket_id = 'documentos-juridico' and split_part(name, '/', 1) ~ '^[0-9]+$'
                and public._juicio_puede_editar(split_part(name, '/', 1)::bigint));
drop policy if exists "documentos_juridico_borrar" on storage.objects;
create policy "documentos_juridico_borrar" on storage.objects for delete to authenticated
    using (bucket_id = 'documentos-juridico' and split_part(name, '/', 1) ~ '^[0-9]+$'
           and public._juicio_puede_editar(split_part(name, '/', 1)::bigint));

create or replace function public.juridico_documentos(p_id bigint)
returns table (id bigint, nombre text, ruta text, mime text, bytes integer, subido_por text, fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_juridico();
    return query select d.id, d.nombre, d.ruta, d.mime, d.bytes, d.subido_por, d.fecha
                   from public.juicios_documentos d where d.juicio_id = p_id order by d.fecha desc;
end $$;

create or replace function public.juridico_registrar_documento(p_id bigint, p_nombre text, p_ruta text, p_mime text, p_bytes integer)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint; v_quien text;
begin
    if not public._juicio_puede_editar(p_id) then raise exception 'Sin permiso para subir documentos a este juicio' using errcode = '42501'; end if;
    if split_part(p_ruta, '/', 1) <> p_id::text then raise exception 'Ruta de archivo no válida'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.juicios_documentos (juicio_id, nombre, ruta, mime, bytes, user_id, subido_por)
    values (p_id, left(p_nombre, 200), p_ruta, p_mime, p_bytes, auth.uid(), v_quien) returning id into v_id;
    update public.juicios set actualizado = now(), actualizado_por = v_quien where id = p_id;
    insert into public.juicios_historial (juicio_id, campo, despues, user_id, quien) values (p_id, 'documento', p_nombre, auth.uid(), v_quien);
    return v_id;
end $$;

create or replace function public.juridico_borrar_documento(p_doc bigint)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_ruta text; v_juicio bigint; v_nombre text; v_quien text;
begin
    select ruta, juicio_id, nombre into v_ruta, v_juicio, v_nombre from public.juicios_documentos where id = p_doc;
    if v_ruta is null then raise exception 'No existe el documento'; end if;
    if not public._juicio_puede_editar(v_juicio) then raise exception 'Sin permiso para borrar documentos de este juicio' using errcode = '42501'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    delete from public.juicios_documentos where id = p_doc;
    insert into public.juicios_historial (juicio_id, campo, antes, user_id, quien) values (v_juicio, 'documento borrado', v_nombre, auth.uid(), v_quien);
    return v_ruta;
end $$;


-- ---------- migración desde SharePoint LEGAL 1 (sólo maestros; también sirve para re-sincronizar) ----------
-- p_filas: arreglo de objetos con las claves de la tabla + sp_id, adjuntos, creado, actualizado, creado_por, actualizado_por.
-- Upsert por sp_id; NO toca juicios ya editados en la página después de la migración.
create or replace function public.juridico_importar(p_filas jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare r jsonb; n integer := 0; v_id bigint;
begin
    if auth.uid() is not null and not public.es_admin() then raise exception 'Sólo maestros importan'; end if;
    for r in select * from jsonb_array_elements(p_filas) loop
        select id into v_id from public.juicios where sp_id = (r->>'sp_id')::int;
        if v_id is not null and exists (select 1 from public.juicios_historial h where h.juicio_id = v_id and h.user_id is not null) then
            continue;   -- ya se trabaja en la página: no se pisa
        end if;
        insert into public.juicios as j (folio, sp_id, vreference, nombre, abogado, abogado_email, pasante, expediente, juzgado,
            medio_preparatorio, etapa1, fecha_etapa1, obs_e1, etapa2, fecha_etapa2, obs_e2, etapa3, fecha_etapa3, obs_e3,
            etapa4, fecha_etapa4, obs_e4, adjuntos, origen, creado, creado_por, actualizado, actualizado_por)
        values ('JUR-' || lpad(nextval('public.folio_juicio')::text, 4, '0'), (r->>'sp_id')::int,
            nullif(upper(trim(r->>'vreference')), ''), nullif(upper(trim(r->>'nombre')), ''),
            nullif(trim(r->>'abogado'), ''), nullif(lower(trim(r->>'abogado_email')), ''),
            public._pasante_canonico(r->>'pasante'), nullif(regexp_replace(trim(r->>'expediente'), '\s*/\s*', '/'), ''),
            nullif(upper(regexp_replace(trim(r->>'juzgado'), '\s+', ' ', 'g')), ''),
            coalesce((r->>'medio_preparatorio')::boolean, false),
            nullif(r->>'etapa1', ''), (r->>'fecha_etapa1')::date, nullif(rtrim(r->>'obs_e1', E' \n'), ''),
            nullif(r->>'etapa2', ''), (r->>'fecha_etapa2')::date, nullif(rtrim(r->>'obs_e2', E' \n'), ''),
            nullif(r->>'etapa3', ''), (r->>'fecha_etapa3')::date, nullif(rtrim(r->>'obs_e3', E' \n'), ''),
            nullif(r->>'etapa4', ''), (r->>'fecha_etapa4')::date, nullif(rtrim(r->>'obs_e4', E' \n'), ''),
            coalesce(r->'adjuntos', '[]'), 'sharepoint',
            coalesce((r->>'creado')::timestamptz, now()), r->>'creado_por',
            coalesce((r->>'actualizado')::timestamptz, now()), r->>'actualizado_por')
        on conflict (sp_id) do update set
            vreference = excluded.vreference, nombre = excluded.nombre, abogado = excluded.abogado,
            abogado_email = excluded.abogado_email, pasante = excluded.pasante, expediente = excluded.expediente,
            juzgado = excluded.juzgado, medio_preparatorio = excluded.medio_preparatorio,
            etapa1 = excluded.etapa1, fecha_etapa1 = excluded.fecha_etapa1, obs_e1 = excluded.obs_e1,
            etapa2 = excluded.etapa2, fecha_etapa2 = excluded.fecha_etapa2, obs_e2 = excluded.obs_e2,
            etapa3 = excluded.etapa3, fecha_etapa3 = excluded.fecha_etapa3, obs_e3 = excluded.obs_e3,
            etapa4 = excluded.etapa4, fecha_etapa4 = excluded.fecha_etapa4, obs_e4 = excluded.obs_e4,
            adjuntos = excluded.adjuntos, actualizado = excluded.actualizado, actualizado_por = excluded.actualizado_por,
            folio = j.folio;
        n := n + 1;
    end loop;
    return n;
end $$;


-- ---------- permisos ----------
do $$
declare f text;
begin
    foreach f in array array[
        'es_juridico()', 'es_coord_juridico()', 'juridico_lista()', 'juridico_abogados()', 'juridico_pasantes_lista()',
        'juridico_historial(bigint)', 'juridico_guardar(bigint,jsonb)', 'juridico_agregar_nota(bigint,integer,date,text)',
        'juridico_baja(bigint,text)', 'juridico_documentos(bigint)',
        'juridico_registrar_documento(bigint,text,text,text,integer)', 'juridico_borrar_documento(bigint)',
        'juridico_importar(jsonb)', 'admin_crear_usuario(text,text,text,text)',
        'admin_editar_usuario(uuid,text,text,text,boolean)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
revoke all on function public._exigir_juridico() from public, anon, authenticated;
revoke all on function public._pasante_canonico(text) from public, anon, authenticated;
revoke all on function public._juicio_es_mio(public.juicios) from public, anon, authenticated;
