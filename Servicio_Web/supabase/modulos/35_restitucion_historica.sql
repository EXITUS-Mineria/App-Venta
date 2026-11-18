-- ============================================================
-- RESTITUCIONES DE VENTAS VIEJAS (antes de la página) CON EL HISTÓRICO
--  La mayoría de los créditos vendidos ya no vienen en las bases del mes, así que Restituciones no los
--  encontraba. Ahora el ORIGINAL se busca primero en las bases y, si no está, en ventas_historico_creditos
--  (vReference JyP o vGroupId Grupal). El reemplazo sigue saliendo de las bases (debe estar Disponible).
--  - _ubicar_original(texto): tipo, clave, en_base.
--  - validar_restitucion: ficha desde el histórico cuando no está en la base (capital del archivo de venta).
--  - aplicar_restitucion(..., p_capital_original): si el archivo de la venta no traía capital se captura.
--    Un crédito de venta histórica cuenta como vendido aunque la base lo marque Disponible.
--  - sugerir_restitucion: no ofrece como reemplazo créditos JyP que ya aparecen en una venta histórica.
-- Requiere 34. Idempotente.
-- ============================================================
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
    en_base := false;
end $$;
revoke all on function public._ubicar_original(text) from public, anon, authenticated;

-- capital del crédito / grupo en su venta histórica más reciente
create or replace function public._capital_historico(p_tipo text, p_clave text)
returns numeric
language sql stable security definer set search_path = public as $$
    select h.npendingk from public.ventas_historico_creditos h
     where (p_tipo = 'JyP' and h.tipo = 'JyP' and h.vreference = p_clave)
        or (p_tipo = 'Grupal' and h.tipo = 'Grupal' and h.vgroupid = p_clave)
     order by h.folio desc limit 1
$$;
revoke all on function public._capital_historico(text, text) from public, anon, authenticated;

create or replace function public.validar_restitucion(p_texto text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare u record; r json; v_llave text; v_venta json;
begin
    perform public._exigir_activo();
    select * into u from public._ubicar_original(p_texto);
    if u.clave is null then
        raise exception 'No encontré «%» en Base JyP, Base Grupal ni en las ventas históricas', trim(p_texto);
    end if;
    v_llave := case when u.tipo = 'JyP' then 'J:' else 'G:' end || u.clave;
    v_venta := public._venta_de_clave(u.tipo, u.clave);

    if not u.en_base then
        return json_build_object(
            'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto), 'en_base', false,
            'integrantes', null, 'capital', public._capital_historico(u.tipo, u.clave), 'dias', null,
            'estados', null, 'municipios', null, 'estado_n', null,
            'estatus_base', 'No está en la base del mes', 'disponible_en_base', false,
            'id_propuesta', null, 'estatus_propuesta', null, 'usuario_propuesta', null,
            'bloqueado', exists (select 1 from public.bloqueados where clave = v_llave),
            'motivo_bloqueo', (select motivo from public.bloqueados where clave = v_llave),
            'restitucion', (select id_restitucion from public.bloqueados where clave = v_llave),
            'vendido', true, 'venta', v_venta);
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
    select json_build_object(
        'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto), 'en_base', true,
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

drop function if exists public.aplicar_restitucion(text, text, text, text);
create or replace function public.aplicar_restitucion(p_original text, p_reemplazo text, p_motivo text,
                                                      p_comentario text default '', p_capital_original numeric default null)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    o record; n record; v_ol text; v_nl text;
    v_cap_o numeric; v_cap_n numeric; v_ok boolean; v_hist text; v_ref_prop text;
    v_prop public.propuestas; v_id_prop text; v_folio text; v_usuario text; v_cap numeric; v_mora numeric;
begin
    perform public._exigir_activo();
    if p_motivo not in ('Defunción', 'Liquidado', 'Venta duplicada', 'Incidencia en el expediente') then
        raise exception 'Motivo no válido: %', p_motivo;
    end if;
    perform pg_advisory_xact_lock(7781203);

    select * into o from public._ubicar_original(p_original);
    if o.clave is null then raise exception 'No encontré «%» en las bases ni en las ventas históricas', p_original; end if;
    select * into n from public._ubicar_cartera(p_reemplazo);
    if n.clave is null then raise exception 'No encontré el reemplazo «%» en las bases', p_reemplazo; end if;
    if o.tipo <> n.tipo then raise exception 'El reemplazo debe ser del mismo tipo (%)', o.tipo; end if;
    if o.clave = n.clave then raise exception 'El reemplazo no puede ser el mismo crédito/grupo'; end if;
    v_ol := case when o.tipo = 'JyP' then 'J:' else 'G:' end || o.clave;
    v_nl := case when n.tipo = 'JyP' then 'J:' else 'G:' end || n.clave;

    if exists (select 1 from public.bloqueados where clave = v_ol) then
        raise exception '% ya fue restituido antes', o.clave;
    end if;
    v_hist := (public._venta_de_clave(o.tipo, o.clave))->>'folio';
    if not coalesce(((public._venta_de_clave(o.tipo, o.clave))->>'historico')::boolean, false) then v_hist := null; end if;

    -- capital del original: base del mes > archivo de la venta histórica > capturado
    if o.en_base then
        if o.tipo = 'JyP' then select npendingk into v_cap_o from public.cartera_jyp where vreference = o.clave;
        else select sum(npendingk) into v_cap_o from public.cartera_grupal where vgroupid = o.clave; end if;
    else
        v_cap_o := public._capital_historico(o.tipo, o.clave);
    end if;
    v_cap_o := coalesce(v_cap_o, p_capital_original);
    if v_cap_o is null or v_cap_o <= 0 then
        raise exception 'No tengo el capital de % en el archivo de la venta %; captúralo para restituir', o.clave, coalesce(v_hist, '');
    end if;

    if n.tipo = 'JyP' then
        select npendingk, disponible into v_cap_n, v_ok from public.cartera_jyp where vreference = n.clave;
    else
        select sum(npendingk), bool_and(disponible) into v_cap_n, v_ok from public.cartera_grupal where vgroupid = n.clave;
    end if;
    if not v_ok or exists (select 1 from public.apartados_activos where clave = v_nl)
       or exists (select 1 from public.bloqueados where clave = v_nl)
       or (n.tipo = 'JyP' and exists (select 1 from public.ventas_historico_creditos h where h.tipo = 'JyP' and h.vreference = n.clave)) then
        raise exception 'El reemplazo % ya no está disponible', n.clave;
    end if;
    if abs(v_cap_n - v_cap_o) > 5000 then
        raise exception 'La diferencia de capital (%) es mayor a ±5,000', round(v_cap_n - v_cap_o, 2);
    end if;

    select coalesce(nombre, email) into v_usuario from public.perfiles where user_id = auth.uid();
    v_folio := 'RST-' || lpad(nextval('public.folio_restitucion')::text, 4, '0');

    select p.* into v_prop from public.apartados_activos a join public.propuestas p using (id_propuesta)
     where a.clave = v_ol;
    if found then
        v_id_prop := v_prop.id_propuesta; v_ref_prop := v_prop.id_propuesta;
        delete from public.propuesta_detalle d where d.id_propuesta = v_id_prop
           and ((o.tipo = 'JyP' and d.tipo_cartera = 'JyP' and d.vreference = o.clave)
             or (o.tipo = 'Grupal' and d.tipo_cartera = 'Grupal' and d.vgroupid = o.clave));
        delete from public.apartados_activos where clave = v_ol;
    else
        if v_hist is null
           and not exists (select 1 from public.cartera_jyp where o.tipo = 'JyP' and vreference = o.clave and not disponible)
           and not exists (select 1 from public.cartera_grupal where o.tipo = 'Grupal' and vgroupid = o.clave and not disponible) then
            raise exception '% está Disponible y no está en ninguna propuesta: no requiere restitución', o.clave;
        end if;
        v_id_prop := v_folio; v_ref_prop := v_hist;
        insert into public.propuestas (id_propuesta, user_id, usuario, tipo_venta, capital_objetivo, capital, centavos,
                                       valor_venta, estatus, capital_original, origen, comentario, revisada_en, revisada_por)
        values (v_folio, auth.uid(), v_usuario, 'Restitución', round(v_cap_o, 2), 0, 0, 0, 'APROBADA',
                round(v_cap_o, 2), 'restitución',
                p_motivo || ': ' || o.clave || ' → ' || n.clave || coalesce(' (venta ' || v_hist || ')', ''), now(), v_usuario);
    end if;

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select v_id_prop, 'JyP', j.vreference, null, j.npendingk, b.datos
      from public.cartera_jyp j
      left join lateral (select to_jsonb(x) datos from public."BASE_JYP" x where x."vReference" = j.vreference limit 1) b on true
     where n.tipo = 'JyP' and j.vreference = n.clave
    union all
    select v_id_prop, 'Grupal', g.vreference, g.vgroupid, g.npendingk, b.datos
      from public.cartera_grupal g
      left join lateral (select to_jsonb(x) datos from public."BASE_GRUPAL" x
                          where x."vGroupId" = g.vgroupid and x."vReference" = g.vreference limit 1) b on true
     where n.tipo = 'Grupal' and g.vgroupid = n.clave;
    insert into public.apartados_activos (clave, id_propuesta) values (v_nl, v_id_prop);
    insert into public.bloqueados (clave, motivo, id_restitucion) values (v_ol, p_motivo, v_folio);

    select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias)) into v_cap, v_mora
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = v_id_prop;
    update public.propuestas
       set capital = round(v_cap, 2), valor_venta = round(v_cap * coalesce(centavos, 0), 2),
           dias_mora = round(v_mora, 1),
           comentario = case when v_id_prop = v_folio then comentario
                             else concat_ws(' | ', nullif(comentario, ''), v_folio || ' ' || p_motivo || ': ' || o.clave || ' → ' || n.clave) end
     where id_propuesta = v_id_prop;

    insert into public.restituciones (id_restitucion, user_id, usuario, motivo, comentario, tipo_cartera,
        clave_original, capital_original, id_propuesta_original, clave_reemplazo, capital_reemplazo,
        id_propuesta_reemplazo, diferencia)
    values (v_folio, auth.uid(), v_usuario, p_motivo, nullif(trim(p_comentario), ''), o.tipo,
        o.clave, round(v_cap_o, 2), v_ref_prop, n.clave, round(v_cap_n, 2), v_id_prop, round(v_cap_n - v_cap_o, 2));

    perform public._notificar(array['validador', 'auxiliar'], null, 'Restitución ' || v_folio || ' · ' || p_motivo,
        v_usuario || ': ' || o.clave || ' → ' || n.clave || ' en ' || v_id_prop
        || coalesce(' (venta histórica ' || v_hist || ')', '')
        || case when v_prop.estatus = 'EN VENTA' then '. Regenerar la sub base.' else '.' end, 'restituciones');

    return json_build_object('id_restitucion', v_folio, 'id_propuesta', v_id_prop, 'original', o.clave,
        'reemplazo', n.clave, 'capital_original', round(v_cap_o, 2), 'capital_reemplazo', round(v_cap_n, 2),
        'diferencia', round(v_cap_n - v_cap_o, 2), 'propuesta_nueva', v_prop.id_propuesta is null, 'venta_historica', v_hist);
end $$;
revoke all on function public.aplicar_restitucion(text, text, text, text, numeric) from public, anon;
grant execute on function public.aplicar_restitucion(text, text, text, text, numeric) to authenticated;

create or replace function public.sugerir_restitucion(p_tipo text, p_capital numeric, p_tolerancia numeric default 5000, p_estado text default null)
returns table (clave text, integrantes bigint, estados text, municipios text, dias numeric, capital numeric, diferencia numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_tol numeric := least(greatest(coalesce(p_tolerancia, 5000), 0), 5000);
begin
    perform public._exigir_activo();
    if p_tipo = 'JyP' then
        return query
        select j.vreference, 1::bigint, j.estado, j.municipio, j.dias, round(j.npendingk, 2),
               round(j.npendingk - p_capital, 2)
          from public.cartera_jyp j
         where j.disponible
           and j.npendingk between p_capital - v_tol and p_capital + v_tol
           and (p_estado is null or p_estado = '' or j.estado_n = upper(p_estado))
           and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
           and not exists (select 1 from public.bloqueados b where b.clave = 'J:' || j.vreference)
           and not exists (select 1 from public.ventas_historico_creditos h where h.tipo = 'JyP' and h.vreference = j.vreference)
         order by abs(j.npendingk - p_capital), j.vreference
         limit 30;
    else
        return query
        select g.vgroupid, count(*), string_agg(distinct nullif(trim(g.estado), ''), ', '),
               string_agg(distinct nullif(trim(g.municipio), ''), ', '), round(avg(g.dias), 1),
               round(sum(g.npendingk), 2), round(sum(g.npendingk) - p_capital, 2)
          from public.cartera_grupal g
         where not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid)
           and not exists (select 1 from public.bloqueados b where b.clave = 'G:' || g.vgroupid)
         group by g.vgroupid
        having bool_and(g.disponible)
           and sum(g.npendingk) between p_capital - v_tol and p_capital + v_tol
           and (p_estado is null or p_estado = '' or bool_or(g.estado_n = upper(p_estado)))
         order by abs(sum(g.npendingk) - p_capital), g.vgroupid
         limit 30;
    end if;
end $$;
