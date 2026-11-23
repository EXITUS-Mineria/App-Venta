-- ============================================================
-- RESTITUIR EN UNA VENTA ELEGIDA
--  aplicar_restitucion(..., p_folio): cuando el crédito / grupo está en varias ventas (Ventas duplicadas)
--  la restitución se registra en la venta elegida. Si es la propuesta donde está apartado, el reemplazo
--  entra a esa propuesta; si es otra venta (histórica o de la página), se crea una propuesta de
--  restitución ligada a esa venta y el apartado de la otra no se toca.
-- Requiere 35. Idempotente.
-- ============================================================
drop function if exists public.aplicar_restitucion(text, text, text, text, numeric);
create or replace function public.aplicar_restitucion(p_original text, p_reemplazo text, p_motivo text,
                                                      p_comentario text default '', p_capital_original numeric default null,
                                                      p_folio text default null)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    o record; n record; v_ol text; v_nl text;
    v_cap_o numeric; v_cap_n numeric; v_ok boolean; v_hist text; v_ref_prop text;
    v_prop public.propuestas; v_id_prop text; v_folio text; v_usuario text; v_cap numeric; v_mora numeric;
    v_apartado boolean := true; v_prop_folio text;
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

    -- Venta elegida (p. ej. desde «Ventas duplicadas»): la restitución se hace en ESA venta
    if nullif(trim(p_folio), '') is not null then
        select a.id_propuesta into v_prop_folio from public.apartados_activos a where a.clave = v_ol;
        if v_prop_folio is not null and (upper(v_prop_folio) = upper(trim(p_folio))
             or exists (select 1 from public.funnel_ventas fv where fv.id_propuesta = v_prop_folio and upper(fv.folio) = upper(trim(p_folio)))) then
            v_apartado := true; v_hist := null;
        elsif exists (select 1 from public.ventas_historico_creditos h where upper(h.folio) = upper(trim(p_folio))
                        and ((o.tipo = 'JyP' and h.tipo = 'JyP' and h.vreference = o.clave)
                          or (o.tipo = 'Grupal' and h.tipo = 'Grupal' and h.vgroupid = o.clave)))
           or exists (select 1 from public.propuesta_detalle d
                       left join public.funnel_ventas fv on fv.id_propuesta = d.id_propuesta
                      where (upper(d.id_propuesta) = upper(trim(p_folio)) or upper(fv.folio) = upper(trim(p_folio)))
                        and ((o.tipo = 'JyP' and d.tipo_cartera = 'JyP' and d.vreference = o.clave)
                          or (o.tipo = 'Grupal' and d.tipo_cartera = 'Grupal' and d.vgroupid = o.clave))) then
            v_apartado := false; v_hist := upper(trim(p_folio));
        else
            raise exception '% no aparece en la venta %', o.clave, p_folio;
        end if;
    end if;

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
     where a.clave = v_ol and v_apartado;
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
revoke all on function public.aplicar_restitucion(text, text, text, text, numeric, text) from public, anon;
grant execute on function public.aplicar_restitucion(text, text, text, text, numeric, text) to authenticated;
