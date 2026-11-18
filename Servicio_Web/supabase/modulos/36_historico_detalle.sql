-- ============================================================
-- DETALLE DE LAS VENTAS HISTÓRICAS (saldos, nombre, fechas, mora, ubicación)
--  ventas_historico_detalle: un renglón por crédito (JyP) o integrante (Grupal) tal como venía en el archivo
--  de la venta (Base Final > Base Completa Venta > adjunto), con los datos útiles en `datos` (jsonb):
--  nombre, grupo, capital, saldo_total, saldo_vencido, saldo_grupal, capital_grupal, monto, monto_total,
--  pagado, descuento, plazo, pagos_hechos, dias, apertura, ult_pago, prox_pago, frecuencia, estatus_cred,
--  estado, municipio, colonia, cp, sucursal, ciclo, integrantes, icredid, tipo_cartera.
--  No se guardan teléfonos ni direcciones. Carga única (18-nov-2026, 8,413 renglones de 179 folios).
--  Restituciones muestra este detalle y ya acepta la vReference de un integrante de un grupo vendido.
-- Requiere 35. Idempotente (la carga de datos va aparte).
-- ============================================================
create table if not exists public.ventas_historico_detalle (
    id bigserial primary key,
    folio text not null,
    tipo text not null check (tipo in ('JyP', 'Grupal')),
    vreference text,
    vgroupid text,
    datos jsonb not null default '{}'
);
create index if not exists ventas_hist_det_ref on public.ventas_historico_detalle (vreference);
create index if not exists ventas_hist_det_grp on public.ventas_historico_detalle (vgroupid) where vgroupid is not null;
create index if not exists ventas_hist_det_folio on public.ventas_historico_detalle (folio);
alter table public.ventas_historico_detalle enable row level security;
revoke all on public.ventas_historico_detalle from anon, authenticated;

-- folio histórico más reciente de un crédito / grupo
create or replace function public._folio_historico(p_tipo text, p_clave text)
returns text
language sql stable security definer set search_path = public as $$
    select max(folio) from public.ventas_historico_creditos h
     where (p_tipo = 'JyP' and h.tipo = 'JyP' and h.vreference = p_clave)
        or (p_tipo = 'Grupal' and h.tipo = 'Grupal' and h.vgroupid = p_clave)
$$;
revoke all on function public._folio_historico(text, text) from public, anon, authenticated;

-- créditos (JyP) o integrantes (Grupal) del archivo de la venta, con resumen
create or replace function public._detalle_historico(p_tipo text, p_clave text)
returns json
language sql stable security definer set search_path = public as $$
    with f as (select public._folio_historico(p_tipo, p_clave) folio),
    d as (
        select d.vreference, d.vgroupid, d.datos from public.ventas_historico_detalle d, f
         where d.folio = f.folio
           and ((p_tipo = 'JyP' and d.tipo = 'JyP' and d.vreference = p_clave)
             or (p_tipo = 'Grupal' and d.tipo = 'Grupal' and d.vgroupid = p_clave))
    )
    select case when count(*) = 0 then null else json_build_object(
        'folio', (select folio from f),
        'creditos', count(*),
        'grupo', max(datos->>'grupo'),
        'capital', round(sum((datos->>'capital')::numeric), 2),
        'saldo_total', round(sum((datos->>'saldo_total')::numeric), 2),
        'saldo_vencido', round(sum((datos->>'saldo_vencido')::numeric), 2),
        'saldo_grupal', max((datos->>'saldo_grupal')::numeric),
        'capital_grupal', max((datos->>'capital_grupal')::numeric),
        'monto', round(sum((datos->>'monto')::numeric), 2),
        'dias', round(avg((datos->>'dias')::numeric), 0),
        'estados', string_agg(distinct datos->>'estado', ', '),
        'municipios', string_agg(distinct datos->>'municipio', ', '),
        'filas', json_agg(json_build_object('vreference', vreference) :: jsonb || datos order by vreference))
    end
    from d
$$;
revoke all on function public._detalle_historico(text, text) from public, anon, authenticated;

create or replace function public._capital_historico(p_tipo text, p_clave text)
returns numeric
language sql stable security definer set search_path = public as $$
    select coalesce(
        (select h.npendingk from public.ventas_historico_creditos h
          where (p_tipo = 'JyP' and h.tipo = 'JyP' and h.vreference = p_clave)
             or (p_tipo = 'Grupal' and h.tipo = 'Grupal' and h.vgroupid = p_clave)
          order by h.folio desc limit 1),
        (select nullif((public._detalle_historico(p_tipo, p_clave)->>'capital')::numeric, 0)))
$$;
revoke all on function public._capital_historico(text, text) from public, anon, authenticated;

-- original: bases del mes > histórico (vReference JyP, vGroupId, o vReference de un integrante)
create or replace function public._ubicar_original(p_texto text, out tipo text, out clave text, out en_base boolean)
language plpgsql stable security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_texto, '')));
begin
    if v = '' then return; end if;
    select * into tipo, clave from public._ubicar_cartera(p_texto);
    if clave is not null then en_base := true; return; end if;
    select 'JyP', h.vreference into tipo, clave from public.ventas_historico_creditos h
     where h.tipo = 'JyP' and upper(h.vreference) = v limit 1;
    if clave is null then
        select 'Grupal', h.vgroupid into tipo, clave from public.ventas_historico_creditos h
         where h.tipo = 'Grupal' and upper(h.vgroupid) = v limit 1;
    end if;
    if clave is null then
        select 'Grupal', d.vgroupid into tipo, clave from public.ventas_historico_detalle d
         where d.tipo = 'Grupal' and upper(d.vreference) = v and d.vgroupid is not null limit 1;
    end if;
    en_base := false;
end $$;
revoke all on function public._ubicar_original(text) from public, anon, authenticated;

create or replace function public.validar_restitucion(p_texto text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare u record; r jsonb; v_llave text; v_venta json; v_det json;
begin
    perform public._exigir_activo();
    select * into u from public._ubicar_original(p_texto);
    if u.clave is null then
        raise exception 'No encontré «%» en Base JyP, Base Grupal ni en las ventas históricas', trim(p_texto);
    end if;
    v_llave := case when u.tipo = 'JyP' then 'J:' else 'G:' end || u.clave;
    v_venta := public._venta_de_clave(u.tipo, u.clave);
    v_det := public._detalle_historico(u.tipo, u.clave);

    if not u.en_base then
        return json_build_object(
            'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto), 'en_base', false,
            'integrantes', (v_det->>'creditos')::integer, 'capital', public._capital_historico(u.tipo, u.clave),
            'dias', (v_det->>'dias')::numeric,
            'estados', v_det->>'estados', 'municipios', v_det->>'municipios', 'estado_n', null,
            'estatus_base', 'No está en la base del mes', 'disponible_en_base', false,
            'id_propuesta', null, 'estatus_propuesta', null, 'usuario_propuesta', null,
            'bloqueado', exists (select 1 from public.bloqueados where clave = v_llave),
            'motivo_bloqueo', (select motivo from public.bloqueados where clave = v_llave),
            'restitucion', (select id_restitucion from public.bloqueados where clave = v_llave),
            'vendido', true, 'venta', v_venta, 'detalle_historico', v_det);
    end if;

    with base as (
        select count(*) integrantes, round(sum(npendingk), 2) capital, round(avg(dias), 1) dias,
               string_agg(distinct nullif(trim(estado), ''), ', ') estados,
               string_agg(distinct nullif(trim(municipio), ''), ', ') municipios,
               string_agg(distinct estatus_base, ', ') estatus_base,
               bool_and(disponible) disponible,
               min(estado_n) estado_n
          from (select npendingk, dias, estado, municipio, estatus_base, disponible, estado_n
                  from public.cartera_jyp where u.tipo = 'JyP' and vreference = u.clave
                union all
                select npendingk, dias, estado, municipio, estatus_base, disponible, estado_n
                  from public.cartera_grupal where u.tipo = 'Grupal' and vgroupid = u.clave) x
    )
    select jsonb_build_object(
        'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto), 'en_base', true,
        'integrantes', b.integrantes, 'capital', b.capital, 'dias', b.dias,
        'estados', b.estados, 'municipios', b.municipios, 'estado_n', b.estado_n,
        'estatus_base', b.estatus_base, 'disponible_en_base', b.disponible,
        'id_propuesta', a.id_propuesta, 'estatus_propuesta', p.estatus, 'usuario_propuesta', p.usuario,
        'bloqueado', (bl.clave is not null), 'motivo_bloqueo', bl.motivo, 'restitucion', bl.id_restitucion,
        'vendido', (a.id_propuesta is not null or not b.disponible or coalesce((v_venta->>'historico')::boolean, false)),
        'venta', v_venta,
        'detalle_historico', case when coalesce((v_venta->>'historico')::boolean, false) then v_det end)
      into r
      from base b
      left join public.apartados_activos a on a.clave = v_llave
      left join public.propuestas p on p.id_propuesta = a.id_propuesta
      left join public.bloqueados bl on bl.clave = v_llave;
    return r::json;
end $$;
revoke all on function public.validar_restitucion(text) from public, anon;
grant execute on function public.validar_restitucion(text) to authenticated;
