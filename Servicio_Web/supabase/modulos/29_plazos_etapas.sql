-- ============================================================
-- PLAZOS POR ETAPA (Mis compras del portal)
--  Cada etapa posterior a la compra tiene un plazo en días naturales. El comprador ve en qué etapa va,
--  "día X de N", la fecha compromiso y si va retrasada.
--  Etapas (definidas por Daniel, 17-nov-2026), en días naturales:
--    1 Creación de información demográfica final 2 · 2 Petición de expedientes 15 · 3 Firma de endoso 10 ·
--    4 Creación de guía de entrega 5 (aquí el comprador consulta su número de guía).
--  Los cambian validador / admin en 🏢 Compradores › ⏱ Plazos.
-- Requiere 25. Idempotente.
-- ============================================================
create table if not exists public.etapas_plazos (
    etapa   text primary key check (etapa in ('md', 'doc', 'juridico', 'cierre')),
    orden   integer not null,
    nombre  text not null,
    dias    integer not null check (dias between 1 and 365),
    actualizado     timestamptz not null default now(),
    actualizado_por text
);
alter table public.etapas_plazos enable row level security;
revoke all on public.etapas_plazos from anon, authenticated;
insert into public.etapas_plazos (etapa, orden, nombre, dias) values
    ('md', 1, 'Creación de información demográfica final', 2), ('doc', 2, 'Petición de expedientes', 15),
    ('juridico', 3, 'Firma de endoso', 10), ('cierre', 4, 'Creación de guía de entrega', 5)
on conflict (etapa) do update set nombre = excluded.nombre;

-- Lo leen internos y compradores
create or replace function public.plazos_etapas()
returns table (etapa text, orden integer, nombre text, dias integer, actualizado timestamptz, actualizado_por text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_usuario();
    return query select p.etapa, p.orden, p.nombre, p.dias, p.actualizado, p.actualizado_por
                   from public.etapas_plazos p order by p.orden;
end $$;

create or replace function public.plazos_guardar(p_plazos jsonb)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text; r record;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador cambian los plazos' using errcode = '42501'; end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    for r in select key, value from jsonb_each_text(p_plazos) loop
        if r.value !~ '^\d+$' or r.value::integer not between 1 and 365 then
            raise exception 'El plazo de % debe ser de 1 a 365 días', r.key;
        end if;
        update public.etapas_plazos set dias = r.value::integer, actualizado = now(), actualizado_por = v_quien where etapa = r.key;
    end loop;
end $$;

-- Mis compras con las fechas reales de cada etapa
drop function if exists public.portal_compras();
create or replace function public.portal_compras()
returns table (folio text, fecha_venta date, capital numeric, monto_venta numeric, tipo text, estado text, municipios text,
               creditos bigint, estatus_md text, estatus_control_doc text, estatus_juridico text, estatus_final text,
               numero_guia text, documentos bigint, con_detalle boolean,
               fecha_inicio_md date, fecha_limite_md date, fecha_inicio_admin date, fecha_limite_admin date,
               fecha_ticket_contrato date)
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
           (select count(*) from public.funnel_documentos d where d.folio = f.folio), f.id_propuesta is not null,
           f.fecha_inicio_md, f.fecha_limite_md, f.fecha_inicio_admin, f.fecha_limite_admin, f.fecha_ticket_contrato
      from public.funnel_ventas f
     where f.comprador_id = v and f.estatus_venta = 'Vendida'
     order by f.fecha_venta desc nulls last, f.folio desc;
end $$;

do $$
declare f text;
begin
    foreach f in array array['plazos_etapas()', 'plazos_guardar(jsonb)', 'portal_compras()'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
