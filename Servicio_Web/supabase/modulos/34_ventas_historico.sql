-- ============================================================
-- HISTÓRICO CRÉDITO → VENTA (ventas anteriores a la página)
--  ventas_historico_creditos: un renglón por partida vendida (JyP = vReference, Grupal = vGroupId), sacado de
--  los archivos del SharePoint "VENTAS DE CARTERA" (Base Final > Base Completa Venta > adjuntos) de las ventas
--  en estatus Vendida. Sólo llaves (folio, tipo, clave, capital, archivo) para ocupar poco espacio.
--  La carga de los datos es única (18-nov-2026, 2,892 partidas de 179 folios) y no está en este archivo.
--  _venta_de_clave() la usa cuando el crédito no está en una propuesta de la página.
-- Requiere 33. Idempotente (la carga de datos va aparte).
-- ============================================================
create table if not exists public.ventas_historico_creditos (
    id bigserial primary key,
    folio text not null,
    tipo text not null check (tipo in ('JyP', 'Grupal')),
    vreference text,
    vgroupid text,
    npendingk numeric,
    fuente text,
    archivo text,
    cargado timestamptz not null default now()
);
create index if not exists ventas_hist_ref on public.ventas_historico_creditos (vreference);
create index if not exists ventas_hist_grp on public.ventas_historico_creditos (vgroupid) where vgroupid is not null;
create index if not exists ventas_hist_folio on public.ventas_historico_creditos (folio);
alter table public.ventas_historico_creditos enable row level security;
revoke all on public.ventas_historico_creditos from anon, authenticated;

create or replace function public._venta_de_clave(p_tipo text, p_clave text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare v_llave text := case when p_tipo = 'JyP' then 'J:' else 'G:' end || p_clave;
        v_prop text; v_folio text; p public.propuestas; f public.funnel_ventas; v_partidas integer; v_ver boolean;
        v_hist boolean := false; v_archivo text; v_otras text[];
begin
    select a.id_propuesta into v_prop from public.apartados_activos a where a.clave = v_llave limit 1;
    if v_prop is null then
        select d.id_propuesta into v_prop from public.propuesta_detalle d
         where (p_tipo = 'JyP' and d.tipo_cartera = 'JyP' and d.vreference = p_clave)
            or (p_tipo = 'Grupal' and d.tipo_cartera = 'Grupal' and d.vgroupid = p_clave)
         order by d.id desc limit 1;
    end if;
    if v_prop is null then
        select r.id_propuesta_reemplazo into v_prop from public.restituciones r
         where r.tipo_cartera = p_tipo and r.clave_reemplazo = p_clave and r.id_propuesta_reemplazo is not null
         order by r.fecha desc limit 1;
    end if;

    if v_prop is not null then
        select * into p from public.propuestas where id_propuesta = v_prop;
        select * into f from public.funnel_ventas where id_propuesta = v_prop order by actualizado desc nulls last limit 1;
        select count(distinct case when tipo_cartera = 'JyP' then 'J:' || vreference else 'G:' || vgroupid end)
          into v_partidas from public.propuesta_detalle where id_propuesta = v_prop;
    else
        -- histórico: la venta más reciente que trae el crédito / grupo en sus archivos
        select array_agg(distinct h.folio order by h.folio desc) into v_otras
          from public.ventas_historico_creditos h
         where (p_tipo = 'JyP' and h.tipo = 'JyP' and h.vreference = p_clave)
            or (p_tipo = 'Grupal' and h.tipo = 'Grupal' and h.vgroupid = p_clave);
        if v_otras is null then return null; end if;
        v_folio := v_otras[1]; v_hist := true;
        select string_agg(distinct h.archivo, '; ') into v_archivo from public.ventas_historico_creditos h where h.folio = v_folio;
        select * into f from public.funnel_ventas where folio = v_folio;
        select count(distinct case when tipo = 'JyP' then 'J:' || vreference else 'G:' || vgroupid end)
          into v_partidas from public.ventas_historico_creditos where folio = v_folio;
    end if;
    v_ver := f.folio is null or public.funnel_puede_ver(f.folio);

    if not v_ver then
        return json_build_object('folio', f.folio, 'id_propuesta', v_prop, 'comprador', coalesce(f.comprador, p.comprador),
                                 'vendedor', coalesce(f.vendedor, p.usuario), 'restringida', true, 'historico', v_hist,
                                 'otras_ventas', to_json(v_otras[2:]));
    end if;
    return json_build_object(
        'folio', coalesce(f.folio, v_folio), 'id_propuesta', v_prop,
        'comprador', coalesce(f.comprador, p.comprador), 'vendedor', coalesce(f.vendedor, p.usuario),
        'tipo', coalesce(f.tipo, p.tipo_venta),
        'estatus_venta', f.estatus_venta, 'estatus_propuesta', p.estatus, 'estatus_final', f.estatus_final,
        'fecha_propuesta', coalesce(f.fecha_propuesta, p.fecha::date), 'fecha_venta', f.fecha_venta,
        'capital', coalesce(p.capital, f.capital), 'monto_venta', coalesce(f.monto_venta, p.valor_venta),
        'centavos', coalesce(p.centavos, case when f.capital > 0 then round(f.monto_venta / f.capital, 4) end),
        'partidas', v_partidas, 'numero_guia', f.numero_guia,
        'estatus_control_doc', f.estatus_control_doc, 'restringida', false,
        'historico', v_hist, 'archivo', v_archivo, 'otras_ventas', to_json(v_otras[2:]));
end $$;
revoke all on function public._venta_de_clave(text, text) from public, anon, authenticated;

-- vendido también cuando el crédito aparece en una venta histórica (JyP vendido sigue "Disponible" en la base)
create or replace function public.validar_restitucion(p_texto text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare u record; r json; v_llave text; v_venta json;
begin
    perform public._exigir_activo();
    select * into u from public._ubicar_cartera(p_texto);
    if u.clave is null then
        raise exception 'No encontré «%» en Base JyP ni en Base Grupal', trim(p_texto);
    end if;
    v_llave := case when u.tipo = 'JyP' then 'J:' else 'G:' end || u.clave;
    v_venta := public._venta_de_clave(u.tipo, u.clave);
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
    select json_build_object(
        'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto),
        'integrantes', b.integrantes, 'capital', b.capital, 'dias', b.dias,
        'estados', b.estados, 'municipios', b.municipios, 'estado_n', b.estado_n,
        'estatus_base', b.estatus_base, 'disponible_en_base', b.disponible,
        'id_propuesta', a.id_propuesta, 'estatus_propuesta', p.estatus, 'usuario_propuesta', p.usuario,
        'bloqueado', (bl.clave is not null), 'motivo_bloqueo', bl.motivo, 'restitucion', bl.id_restitucion,
        'vendido', (a.id_propuesta is not null or not b.disponible or coalesce((v_venta->>'historico')::boolean, false)),
        'venta', v_venta)
      into r
      from base b
      left join public.apartados_activos a on a.clave = v_llave
      left join public.propuestas p on p.id_propuesta = a.id_propuesta
      left join public.bloqueados bl on bl.clave = v_llave;
    return r;
end $$;
revoke all on function public.validar_restitucion(text) from public, anon;
grant execute on function public.validar_restitucion(text) to authenticated;
