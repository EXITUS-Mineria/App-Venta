-- ============================================================
-- MÓDULO VENTA DE CARTERA · cartera, propuestas, apartado y liberación
-- Requiere 00_nucleo.sql. Idempotente.
-- ============================================================

-- ---------- Cargas de bases ----------
create table if not exists public.cargas (
    id        bigserial primary key,
    cartera   text not null check (cartera in ('JyP', 'Grupal')),
    archivo   text,
    filas     integer,
    columnas  text[] not null,          -- orden original de columnas (para el layout Funnel)
    usuario   text,
    cargado   timestamptz not null default now()
);

-- ---------- Cartera (una fila por crédito) ----------
create table if not exists public.cartera_jyp (
    vreference   text primary key,
    estado       text,
    municipio    text,
    colonia      text,
    dias         numeric,
    npendingk    numeric not null default 0,
    estatus_base text,                  -- Estatus como viene en la base
    datos        jsonb not null         -- fila original completa
);
create index if not exists cartera_jyp_geo on public.cartera_jyp (estado, municipio);

create table if not exists public.cartera_grupal (
    id           bigserial primary key,
    vgroupid     text not null,
    vreference   text not null,
    estado       text,
    municipio    text,
    colonia      text,
    dias         numeric,
    npendingk    numeric not null default 0,
    estatus_base text,
    datos        jsonb not null
);
create index if not exists cartera_grupal_grupo on public.cartera_grupal (vgroupid);
create index if not exists cartera_grupal_geo on public.cartera_grupal (estado, municipio);
create index if not exists cartera_grupal_ref on public.cartera_grupal (vreference);

-- ---------- Propuestas ----------
create table if not exists public.propuestas (
    id_propuesta     text primary key,
    fecha            timestamptz not null default now(),
    user_id          uuid,
    usuario          text not null,
    tipo_venta       text,
    capital_objetivo numeric,
    capital          numeric,
    centavos         numeric,
    valor_venta      numeric,
    dias_mora        numeric,
    estatus          text not null default 'EN REVISIÓN',
    conflicto        text,
    origen           text not null default 'web',
    liberada_en      timestamptz,
    liberada_por     text,
    motivo           text
);
create index if not exists propuestas_usuario on public.propuestas (user_id);

-- Flujo: vendedor -> validador -> auxiliar de venta
--   EN REVISIÓN  la armó el vendedor; créditos apartados; se avisa a validadores
--   APROBADA     el validador la revisó (pudo quitar partidas); se avisa a auxiliares
--   EN VENTA     el auxiliar generó la sub base (layout Funnel)
--   RECHAZADA    el validador la rechazó; todo regresa a Disponible
--   LIBERADA     cancelada por el vendedor o un administrador
--   APARTADA / EN CONFLICTO  propuestas migradas de la app de escritorio
alter table public.propuestas alter column estatus set default 'EN REVISIÓN';
alter table public.propuestas drop constraint if exists propuestas_estatus_check;
alter table public.propuestas add constraint propuestas_estatus_check check (estatus in
    ('EN REVISIÓN', 'APROBADA', 'EN VENTA', 'RECHAZADA', 'LIBERADA', 'APARTADA', 'EN CONFLICTO'));
alter table public.propuestas add column if not exists capital_original numeric;
alter table public.propuestas add column if not exists revisada_en      timestamptz;
alter table public.propuestas add column if not exists revisada_por     text;
alter table public.propuestas add column if not exists comentario       text;
alter table public.propuestas add column if not exists partidas_quitadas integer not null default 0;
alter table public.propuestas add column if not exists sub_base_en      timestamptz;
alter table public.propuestas add column if not exists sub_base_por     text;
create index if not exists propuestas_estatus on public.propuestas (estatus);

-- Id de venta: VTA-0300, VTA-0301, ...
create sequence if not exists public.folio_venta start 300 minvalue 300;

create table if not exists public.propuesta_detalle (
    id            bigserial primary key,
    id_propuesta  text not null references public.propuestas on delete cascade,
    tipo_cartera  text not null check (tipo_cartera in ('JyP', 'Grupal')),
    vreference    text not null,
    vgroupid      text,
    npendingk     numeric,
    datos         jsonb                 -- fila de la base al momento de apartar
);
create index if not exists detalle_propuesta on public.propuesta_detalle (id_propuesta);

-- Candado de unicidad: un crédito JyP ('J:ref') o un grupo ('G:grupo')
-- sólo puede estar en UNA propuesta vigente. La llave primaria lo garantiza.
create table if not exists public.apartados_activos (
    clave         text primary key,
    id_propuesta  text not null references public.propuestas on delete cascade
);
create index if not exists activos_propuesta on public.apartados_activos (id_propuesta);

-- ============================================================
-- Seguridad: todo cerrado; se lee con políticas y se escribe sólo por funciones
-- ============================================================
alter table public.cargas            enable row level security;
alter table public.cartera_jyp       enable row level security;
alter table public.cartera_grupal    enable row level security;
alter table public.propuestas        enable row level security;
alter table public.propuesta_detalle enable row level security;
alter table public.apartados_activos enable row level security;

revoke all on public.cargas, public.cartera_jyp, public.cartera_grupal,
              public.propuestas, public.propuesta_detalle, public.apartados_activos from anon;
revoke insert, update, delete on public.cargas, public.cartera_jyp, public.cartera_grupal,
              public.propuestas, public.propuesta_detalle, public.apartados_activos from authenticated;
grant select on public.cargas, public.propuestas, public.propuesta_detalle to authenticated;

drop policy if exists cargas_lectura on public.cargas;
create policy cargas_lectura on public.cargas for select to authenticated using (public.es_activo());

drop policy if exists propuestas_lectura on public.propuestas;
create policy propuestas_lectura on public.propuestas for select to authenticated using (public.es_activo());

drop policy if exists detalle_lectura on public.propuesta_detalle;
create policy detalle_lectura on public.propuesta_detalle for select to authenticated using (public.es_activo());


-- ============================================================
-- Funciones (RPC) del módulo
-- ============================================================

-- Estados y municipios disponibles para los filtros
create or replace function public.catalogo_geo(p_tipo text)
returns table (estado text, municipio text, registros bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select public.norm(x.estado), public.norm(x.municipio), count(*)
    from (
        select j.estado, j.municipio from public.cartera_jyp j where p_tipo in ('JyP', 'Dual')
        union all
        select g.estado, g.municipio from public.cartera_grupal g where p_tipo in ('Grupal', 'Dual')
    ) x
    where public.norm(x.estado) <> ''
    group by 1, 2 order by 1, 2;
end $$;

-- Términos de búsqueda: uno = "contiene", varios = exactos
create or replace function public._coincide(valor text, terminos text[]) returns boolean
language sql immutable as $$
    select case
        when terminos is null or cardinality(terminos) = 0 then true
        when cardinality(terminos) = 1 then upper(valor) like '%' || upper(terminos[1]) || '%'
        else upper(valor) = any (select upper(t) from unnest(terminos) t)
    end
$$;

-- Créditos JyP disponibles
create or replace function public.buscar_jyp(
    p_estados text[] default null, p_municipios text[] default null,
    p_mora_min numeric default null, p_mora_max numeric default null, p_terminos text[] default null)
returns table (vreference text, estado text, municipio text, colonia text, dias numeric,
               npendingk numeric, estatus text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select j.vreference, j.estado, j.municipio, j.colonia, j.dias, j.npendingk, 'Disponible'::text
    from public.cartera_jyp j
    where public.norm(j.estatus_base) = 'DISPONIBLE'
      and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
      and (p_estados is null or cardinality(p_estados) = 0 or public.norm(j.estado) = any (p_estados))
      and (p_municipios is null or cardinality(p_municipios) = 0 or public.norm(j.municipio) = any (p_municipios))
      and (p_mora_min is null or j.dias >= p_mora_min)
      and (p_mora_max is null or j.dias <= p_mora_max)
      and public._coincide(j.vreference, p_terminos)
    order by j.estado, j.municipio, j.vreference;
end $$;

-- Grupos con al menos un integrante en el filtro (todos sus integrantes cuentan)
create or replace function public.buscar_grupos(
    p_estados text[] default null, p_municipios text[] default null,
    p_mora_min numeric default null, p_mora_max numeric default null, p_terminos text[] default null)
returns table (vgroupid text, integrantes bigint, estados text, municipios text, colonias text,
               dias_promedio numeric, capital numeric, disponible boolean)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with ids as (
        select distinct g.vgroupid
        from public.cartera_grupal g
        where (p_estados is null or cardinality(p_estados) = 0 or public.norm(g.estado) = any (p_estados))
          and (p_municipios is null or cardinality(p_municipios) = 0 or public.norm(g.municipio) = any (p_municipios))
          and (p_terminos is null or cardinality(p_terminos) = 0
               or public._coincide(g.vgroupid, p_terminos) or public._coincide(g.vreference, p_terminos))
    ), res as (
        select g.vgroupid,
               count(*) as integrantes,
               string_agg(distinct nullif(trim(g.estado), ''), ', ') as estados,
               string_agg(distinct nullif(trim(g.municipio), ''), ', ') as municipios,
               string_agg(distinct nullif(trim(g.colonia), ''), ', ') as colonias,
               round(avg(g.dias), 1) as dias_promedio,
               round(sum(g.npendingk), 2) as capital,
               bool_and(public.norm(g.estatus_base) = 'DISPONIBLE')
                 and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid)
                 as disponible
        from public.cartera_grupal g join ids using (vgroupid)
        group by g.vgroupid
    )
    select * from res r
    where (p_mora_min is null or r.dias_promedio >= p_mora_min)
      and (p_mora_max is null or r.dias_promedio <= p_mora_max)
    order by r.disponible desc, r.vgroupid;
end $$;

-- Apartar: todo o nada, con candado. Devuelve la propuesta.
create or replace function public.apartar(
    p_tipo_venta text, p_capital_objetivo numeric, p_centavos numeric,
    p_refs text[] default '{}', p_grupos text[] default '{}')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    v_id        text;
    v_usuario   text;
    v_capital   numeric;
    v_mora      numeric;
    v_ocupados  text;
    v_faltan    text;
    v_min       numeric := greatest(0, p_capital_objetivo - 1000);
    v_max       numeric := p_capital_objetivo + 2000;
begin
    perform public._exigir_activo();
    p_refs := coalesce(p_refs, '{}');
    p_grupos := coalesce(p_grupos, '{}');
    if cardinality(p_refs) + cardinality(p_grupos) = 0 then
        raise exception 'Selecciona al menos un crédito o grupo';
    end if;

    -- un apartado a la vez en toda la empresa
    perform pg_advisory_xact_lock(7781203);

    -- existencia y estatus en base
    select string_agg(r, ', ') into v_faltan from unnest(p_refs) r
     where not exists (select 1 from public.cartera_jyp j where j.vreference = r
                        and public.norm(j.estatus_base) = 'DISPONIBLE');
    if v_faltan is not null then
        raise exception 'Créditos JyP que ya no están disponibles: %', left(v_faltan, 300);
    end if;
    select string_agg(g, ', ') into v_faltan from unnest(p_grupos) g
     where not exists (select 1 from public.cartera_grupal c where c.vgroupid = g)
        or exists (select 1 from public.cartera_grupal c where c.vgroupid = g
                    and public.norm(c.estatus_base) <> 'DISPONIBLE');
    if v_faltan is not null then
        raise exception 'Grupos que ya no están completamente disponibles: %', left(v_faltan, 300);
    end if;

    -- ¿otro usuario ya los apartó?
    select string_agg(substr(a.clave, 3) || ' (' || p.usuario || ')', ', ') into v_ocupados
    from public.apartados_activos a join public.propuestas p using (id_propuesta)
    where a.clave = any (array(select 'J:' || x from unnest(p_refs) x)
                         || array(select 'G:' || x from unnest(p_grupos) x));
    if v_ocupados is not null then
        raise exception 'Otro usuario ya apartó parte de la selección: %', left(v_ocupados, 400);
    end if;

    -- capital y rango
    select coalesce(sum(npendingk), 0), avg(dias) into v_capital, v_mora from (
        select npendingk, dias from public.cartera_jyp where vreference = any (p_refs)
        union all
        select npendingk, dias from public.cartera_grupal where vgroupid = any (p_grupos)
    ) s;
    if v_capital < v_min or v_capital > v_max then
        raise exception 'El capital % está fuera del rango % a %', round(v_capital, 2), v_min, v_max;
    end if;

    select coalesce(nombre, email) into v_usuario from public.perfiles where user_id = auth.uid();
    v_id := 'VTA-' || lpad(nextval('public.folio_venta')::text, 4, '0');

    insert into public.propuestas (id_propuesta, user_id, usuario, tipo_venta, capital_objetivo, capital,
                                   centavos, valor_venta, dias_mora, estatus, capital_original)
    values (v_id, auth.uid(), v_usuario, p_tipo_venta, p_capital_objetivo, round(v_capital, 2),
            p_centavos, round(v_capital * p_centavos, 2), round(v_mora, 1), 'EN REVISIÓN', round(v_capital, 2));

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select v_id, 'JyP', j.vreference, null, j.npendingk, j.datos
      from public.cartera_jyp j where j.vreference = any (p_refs)
    union all
    select v_id, 'Grupal', g.vreference, g.vgroupid, g.npendingk, g.datos
      from public.cartera_grupal g where g.vgroupid = any (p_grupos);

    insert into public.apartados_activos (clave, id_propuesta)
    select 'J:' || r, v_id from unnest(p_refs) r
    union all
    select 'G:' || g, v_id from unnest(p_grupos) g;

    perform public._notificar(array['validador'], null, 'Propuesta por revisar: ' || v_id,
        v_usuario || ' · ' || p_tipo_venta || ' · capital ' || to_char(v_capital, 'FM$999,999,990.00')
        || ' · ' || (cardinality(p_refs) + cardinality(p_grupos)) || ' partidas', 'revision');

    return json_build_object('id_propuesta', v_id, 'estatus', 'EN REVISIÓN', 'capital', round(v_capital, 2),
                             'valor_venta', round(v_capital * p_centavos, 2), 'usuario', v_usuario);
end $$;

-- Liberar: el dueño o un administrador
create or replace function public.liberar(p_id text, p_motivo text default '')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas;
begin
    perform public._exigir_activo();
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then
        raise exception 'No existe la propuesta %', p_id;
    end if;
    if v_p.estatus in ('LIBERADA', 'RECHAZADA') then
        raise exception 'La propuesta ya no tiene créditos apartados (%)', v_p.estatus;
    end if;
    if not public.es_admin() and (v_p.user_id is distinct from auth.uid()
                                  or v_p.estatus not in ('EN REVISIÓN', 'APARTADA', 'EN CONFLICTO')) then
        raise exception 'Sólo % (mientras está en revisión) o un administrador pueden liberar esta propuesta', v_p.usuario;
    end if;
    delete from public.apartados_activos where id_propuesta = p_id;
    update public.propuestas
       set estatus = 'LIBERADA', liberada_en = now(),
           liberada_por = (select coalesce(nombre, email) from public.perfiles where user_id = auth.uid()),
           motivo = p_motivo
     where id_propuesta = p_id;
    if v_p.estatus = 'EN REVISIÓN' then
        perform public._notificar(array['validador'], v_p.user_id, 'Propuesta liberada: ' || p_id,
                                  coalesce(nullif(p_motivo, ''), 'Sin motivo'), 'bitacora');
    end if;
    return json_build_object('id_propuesta', p_id, 'estatus', 'LIBERADA');
end $$;

-- Detalle completo para el layout de Funnel
create or replace function public.layout_propuesta(p_id text)
returns table (tipo_cartera text, datos jsonb, columnas text[])
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_rol(array['auxiliar', 'validador'], 'descargar la sub base');
    return query
    select d.tipo_cartera, d.datos,
           (select c.columnas from public.cargas c where c.cartera = d.tipo_cartera order by c.id desc limit 1)
    from public.propuesta_detalle d where d.id_propuesta = p_id order by d.id;
end $$;


-- ============================================================
-- FLUJO DE REVISIÓN
-- ============================================================

-- Validador: quitar partidas (créditos JyP o grupos completos) de una propuesta en revisión.
-- Lo quitado regresa a Disponible y se recalculan capital, venta y mora.
create or replace function public.quitar_partidas(p_id text, p_refs text[] default '{}', p_grupos text[] default '{}')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas; v_n integer; v_cap numeric; v_mora numeric; v_quedan integer;
begin
    perform public._exigir_rol(array['validador'], 'quitar partidas de una propuesta');
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.estatus <> 'EN REVISIÓN' then
        raise exception 'Sólo se pueden quitar partidas de propuestas EN REVISIÓN (está %)', v_p.estatus;
    end if;
    p_refs := coalesce(p_refs, '{}'); p_grupos := coalesce(p_grupos, '{}');

    delete from public.propuesta_detalle d
     where d.id_propuesta = p_id
       and ((d.tipo_cartera = 'JyP' and d.vreference = any (p_refs))
            or (d.tipo_cartera = 'Grupal' and d.vgroupid = any (p_grupos)));
    delete from public.apartados_activos a
     where a.id_propuesta = p_id
       and a.clave = any (array(select 'J:' || x from unnest(p_refs) x) || array(select 'G:' || x from unnest(p_grupos) x));
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'Ninguna de esas partidas pertenece a %', p_id; end if;

    select count(*) into v_quedan from public.apartados_activos where id_propuesta = p_id;
    if v_quedan = 0 then
        raise exception 'No puedes quitar todas las partidas; mejor rechaza la propuesta';
    end if;

    select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias))
      into v_cap, v_mora
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid
                                       and g.vreference = d.vreference
     where d.id_propuesta = p_id;
    update public.propuestas
       set capital = round(v_cap, 2), valor_venta = round(v_cap * centavos, 2),
           dias_mora = coalesce(round(v_mora, 1), dias_mora),
           partidas_quitadas = partidas_quitadas + v_n
     where id_propuesta = p_id;
    return json_build_object('id_propuesta', p_id, 'quitadas', v_n, 'capital', round(v_cap, 2), 'partidas', v_quedan);
end $$;

-- Validador: aprobar o rechazar
create or replace function public.revisar_propuesta(p_id text, p_aprobar boolean, p_comentario text default '')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas; v_quien text; v_estatus text;
begin
    perform public._exigir_rol(array['validador'], 'revisar propuestas');
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.estatus <> 'EN REVISIÓN' then
        raise exception 'La propuesta % ya no está en revisión (está %)', p_id, v_p.estatus;
    end if;
    if not p_aprobar and coalesce(trim(p_comentario), '') = '' then
        raise exception 'Escribe el motivo del rechazo';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    v_estatus := case when p_aprobar then 'APROBADA' else 'RECHAZADA' end;

    if not p_aprobar then
        delete from public.apartados_activos where id_propuesta = p_id;
    end if;
    update public.propuestas
       set estatus = v_estatus, revisada_en = now(), revisada_por = v_quien, comentario = p_comentario
     where id_propuesta = p_id;

    if p_aprobar then
        perform public._notificar(array['auxiliar'], v_p.user_id, 'Propuesta aprobada: ' || p_id,
            'Revisó ' || v_quien || '. Capital ' || to_char(v_p.capital, 'FM$999,999,990.00')
            || '. Lista para generar la sub base.', 'subbases');
    else
        perform public._notificar(null, v_p.user_id, 'Propuesta rechazada: ' || p_id,
            v_quien || ': ' || p_comentario, 'bitacora');
    end if;
    return json_build_object('id_propuesta', p_id, 'estatus', v_estatus);
end $$;

-- Auxiliar de venta: marca la sub base como generada (la descarga se hace con layout_propuesta)
create or replace function public.generar_sub_base(p_id text)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas; v_quien text;
begin
    perform public._exigir_rol(array['auxiliar'], 'generar sub bases');
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.estatus not in ('APROBADA', 'EN VENTA') then
        raise exception 'La propuesta % no está aprobada (está %)', p_id, v_p.estatus;
    end if;
    if v_p.estatus = 'APROBADA' then
        select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
        update public.propuestas set estatus = 'EN VENTA', sub_base_en = now(), sub_base_por = v_quien
         where id_propuesta = p_id;
        perform public._notificar(null, v_p.user_id, 'Sub base generada: ' || p_id,
            v_quien || ' generó la sub base para venta.', 'bitacora');
    end if;
    return json_build_object('id_propuesta', p_id, 'estatus', 'EN VENTA');
end $$;

-- Partidas de una propuesta (un renglón por crédito JyP o por grupo) para revisarla
create or replace function public.partidas_propuesta(p_id text)
returns table (tipo text, clave text, integrantes bigint, estados text, municipios text, colonias text,
               dias numeric, capital numeric)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select d.tipo_cartera,
           coalesce(d.vgroupid, d.vreference),
           count(*),
           string_agg(distinct nullif(trim(coalesce(j.estado, g.estado)), ''), ', '),
           string_agg(distinct nullif(trim(coalesce(j.municipio, g.municipio)), ''), ', '),
           string_agg(distinct nullif(trim(coalesce(j.colonia, g.colonia)), ''), ', '),
           round(avg(coalesce(j.dias, g.dias)), 1),
           round(sum(d.npendingk), 2)
    from public.propuesta_detalle d
    left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
    left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid
                                     and g.vreference = d.vreference
    where d.id_propuesta = p_id
    group by d.tipo_cartera, coalesce(d.vgroupid, d.vreference)
    order by 1, 2;
end $$;

-- Contador por estatus (para KPIs y pendientes)
create or replace function public.resumen_flujo()
returns table (estatus text, propuestas bigint, capital numeric)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select p.estatus, count(*), round(sum(p.capital), 2)
                 from public.propuestas p group by p.estatus;
end $$;


-- Permisos de ejecución: sólo usuarios con sesión
do $$
declare f text;
begin
    foreach f in array array[
        'catalogo_geo(text)',
        'buscar_jyp(text[],text[],numeric,numeric,text[])',
        'buscar_grupos(text[],text[],numeric,numeric,text[])',
        'apartar(text,numeric,numeric,text[],text[])',
        'liberar(text,text)',
        'layout_propuesta(text)',
        'quitar_partidas(text,text[],text[])',
        'revisar_propuesta(text,boolean,text)',
        'generar_sub_base(text)',
        'resumen_flujo()',
        'partidas_propuesta(text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
