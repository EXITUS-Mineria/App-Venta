-- ============================================================
-- ENVÍO DE LA PROPUESTA AL COMPRADOR + avisos del funnel Vendedor ↔ Validador
--  - El vendedor dueño (o auxiliar / maestros) manda la propuesta al comprador por correo con un Excel:
--    vReference, vGroupId, Días de atraso, Capital, Colonia, C.P., Municipio, Estado.
--    (Colonia sale vacía mientras BASE_JYP / BASE_GRUPAL no traigan esa columna; el C.P. sí viene.)
--    Se puede enviar aunque la propuesta siga EN REVISIÓN (no si está LIBERADA o RECHAZADA).
--  - El correo lo manda la Edge Function "enviar-propuesta" (Microsoft 365 / Graph). Aquí sólo
--    los datos, el permiso y el registro del envío. El Excel no se guarda: se arma al enviar.
--  - Avisos 🔔: al validador cuando se envía al comprador; al validador y auxiliar cuando se marca Vendida.
-- Requiere 19-23. Idempotente.
-- ============================================================
alter table public.funnel_ventas add column if not exists correo_comprador text;
alter table public.funnel_ventas add column if not exists enviada_en timestamptz;
alter table public.funnel_ventas add column if not exists enviada_por text;
alter table public.funnel_ventas add column if not exists envios integer not null default 0;

-- Datos del Excel para el comprador (mismo permiso que editar la venta)
drop function if exists public.propuesta_para_comprador(text);
create or replace function public.propuesta_para_comprador(p_folio text)
returns table (vreference text, vgroupid text, dias numeric, capital numeric, colonia text, cp text, municipio text, estado text,
               comprador text, vendedor_nombre text, vendedor_correo text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop text; v_est text; v_comp text; v_nom text; v_mail text;
begin
    perform public._exigir_activo();
    select nombre, email into v_nom, v_mail from public.perfiles where user_id = auth.uid();
    select f.id_propuesta, p.estatus, f.comprador into v_prop, v_est, v_comp
      from public.funnel_ventas f left join public.propuestas p on p.id_propuesta = f.id_propuesta where f.folio = p_folio;
    if v_prop is null then raise exception '% no tiene propuesta en la página (venta histórica)', p_folio; end if;
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro pueden enviarla', p_folio using errcode = '42501';
    end if;
    if v_est in ('LIBERADA', 'RECHAZADA') then raise exception 'La propuesta % está %; ya no se puede enviar', v_prop, v_est; end if;
    return query
    select d.vreference, d.vgroupid, coalesce(j.dias, g.dias), round(d.npendingk, 2),
           coalesce(nullif(j.colonia, ''), nullif(g.colonia, ''), d.datos->>'Colonia', d.datos->>'vColonia', d.datos->>'COLONIA'),
           coalesce(d.datos->>'CP', d.datos->>'C.P'), coalesce(j.municipio, g.municipio), coalesce(j.estado, g.estado),
           v_comp, v_nom, v_mail
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = v_prop
     order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
end $$;

-- Registrar el envío (lo llama la Edge Function con la sesión del usuario, después de mandar el correo)
create or replace function public.funnel_registrar_envio(p_folio text, p_correo text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text; v_prop text; v_comp text;
begin
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sin permiso para enviar %', p_folio using errcode = '42501';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.funnel_ventas set correo_comprador = lower(trim(p_correo)), enviada_en = now(), enviada_por = v_quien,
                                    envios = envios + 1, actualizado = now(), actualizado_por = v_quien
     where folio = p_folio returning id_propuesta, comprador into v_prop, v_comp;
    if v_prop is not null then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (v_prop, v_quien, 'Enviada al comprador', lower(trim(p_correo)));
    end if;
    perform public._notificar(array['validador'], null, '📧 Propuesta enviada al comprador',
        p_folio || ' · ' || coalesce(v_comp, '') || ' → ' || lower(trim(p_correo)) || ' (' || v_quien || ')', 'funnel');
end $$;

-- Aviso al marcar Vendida / Cancelada
create or replace function public._funnel_aviso_estatus() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
    if new.estatus_venta is distinct from old.estatus_venta and new.estatus_venta = 'Vendida' then
        select user_id into v_user from public.propuestas where id_propuesta = new.id_propuesta;
        perform public._notificar(array['validador', 'auxiliar'], v_user, '✅ Venta marcada como Vendida',
            new.folio || ' · ' || coalesce(new.comprador, '') || ' · monto ' ||
            coalesce(to_char(new.monto_venta, 'FM$999,999,999.00'), '—') || ' (' || coalesce(new.actualizado_por, '') || ')', 'funnel');
    end if;
    return new;
end $$;
revoke all on function public._funnel_aviso_estatus() from public, anon, authenticated;
drop trigger if exists funnel_aviso_estatus on public.funnel_ventas;
create trigger funnel_aviso_estatus after update of estatus_venta on public.funnel_ventas
    for each row execute function public._funnel_aviso_estatus();

-- funnel_lista con los datos del envío
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
               correo_comprador text, enviada_en timestamptz, enviada_por text, envios integer)
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
           f.correo_comprador, f.enviada_en, f.enviada_por, f.envios
      from public.funnel_ventas f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;

do $$
declare f text;
begin
    foreach f in array array['funnel_lista()', 'propuesta_para_comprador(text)', 'funnel_registrar_envio(text,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
