-- ============================================================
-- RENDIMIENTO · búsqueda rápida en la cartera (límite de 8 s de Supabase)
--  - La fila original (datos jsonb) se guarda fuera de la tabla principal (TOAST),
--    así recorrer 84 mil créditos lee pocos MB.
--  - Estado, municipio y estatus normalizados como columnas calculadas con índice.
-- Requiere 10_venta.sql. Idempotente. Después de aplicarlo hay que recargar la cartera.
-- ============================================================
alter table public.cartera_jyp    set (toast_tuple_target = 128);
alter table public.cartera_grupal set (toast_tuple_target = 128);

alter table public.cartera_jyp add column if not exists estado_n text
    generated always as (upper(regexp_replace(trim(coalesce(estado, '')), '\s+', ' ', 'g'))) stored;
alter table public.cartera_jyp add column if not exists municipio_n text
    generated always as (upper(regexp_replace(trim(coalesce(municipio, '')), '\s+', ' ', 'g'))) stored;
alter table public.cartera_jyp add column if not exists disponible boolean
    generated always as (upper(trim(coalesce(estatus_base, ''))) = 'DISPONIBLE') stored;
alter table public.cartera_grupal add column if not exists estado_n text
    generated always as (upper(regexp_replace(trim(coalesce(estado, '')), '\s+', ' ', 'g'))) stored;
alter table public.cartera_grupal add column if not exists municipio_n text
    generated always as (upper(regexp_replace(trim(coalesce(municipio, '')), '\s+', ' ', 'g'))) stored;
alter table public.cartera_grupal add column if not exists disponible boolean
    generated always as (upper(trim(coalesce(estatus_base, ''))) = 'DISPONIBLE') stored;

create index if not exists cartera_jyp_geo_n on public.cartera_jyp (estado_n, municipio_n);
create index if not exists cartera_grupal_geo_n on public.cartera_grupal (estado_n, municipio_n);

create or replace function public.catalogo_geo(p_tipo text)
returns table (estado text, municipio text, registros bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select x.estado_n, x.municipio_n, count(*)
    from (
        select j.estado_n, j.municipio_n from public.cartera_jyp j where p_tipo in ('JyP', 'Dual')
        union all
        select g.estado_n, g.municipio_n from public.cartera_grupal g where p_tipo in ('Grupal', 'Dual')
    ) x
    where x.estado_n <> ''
    group by 1, 2 order by 1, 2;
end $$;

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
    where j.disponible
      and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
      and (p_estados is null or cardinality(p_estados) = 0 or j.estado_n = any (p_estados))
      and (p_municipios is null or cardinality(p_municipios) = 0 or j.municipio_n = any (p_municipios))
      and (p_mora_min is null or j.dias >= p_mora_min)
      and (p_mora_max is null or j.dias <= p_mora_max)
      and public._coincide(j.vreference, p_terminos)
    order by j.estado, j.municipio, j.vreference;
end $$;

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
        where (p_estados is null or cardinality(p_estados) = 0 or g.estado_n = any (p_estados))
          and (p_municipios is null or cardinality(p_municipios) = 0 or g.municipio_n = any (p_municipios))
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
               bool_and(g.disponible)
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
