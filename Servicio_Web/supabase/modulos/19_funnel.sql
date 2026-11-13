-- ============================================================
-- FUNNEL DE VENTAS · réplica de la lista SharePoint "VENTAS DE CARTERA"
-- Una fila por venta (folio VTA-####). Se crea sola al apartar una propuesta en la página
-- y se sincroniza (comprador, capital, monto, tipo; Cancelada si se libera o rechaza).
-- Etapas: Venta → MD → Control Documental → Jurídico → Final (+ ticket y guía).
-- Requiere 10-18. Idempotente.
-- ============================================================
create table if not exists public.funnel_ventas (
    folio                    text primary key,                 -- VTA-0001 …
    id_propuesta             text references public.propuestas on delete set null,
    comprador                text,
    capital                  numeric,
    monto_venta              numeric,
    estado                   text,
    municipios               text,
    tipo                     text check (tipo in ('J&P', 'Grupal', 'Dual')),
    estatus_venta            text not null default 'Propuesta' check (estatus_venta in ('Propuesta', 'Vendida', 'Cancelada')),
    fecha_propuesta          date,
    fecha_venta              date,
    vendedor                 text,
    estatus_md               text check (estatus_md in ('En Proceso', 'Informacion Enviada', 'En Atraso')),
    fecha_inicio_md          date,
    fecha_limite_md          date,
    base_completa_venta      text,
    estatus_control_doc      text check (estatus_control_doc in ('En Proceso', 'Entregados')),
    fecha_inicio_admin       date,
    fecha_limite_admin       date,
    estatus_juridico         text check (estatus_juridico in ('Envío pagarés a jurídico', 'Contrato en proceso', 'Contrato entregado')),
    estatus_final            text check (estatus_final in ('Expedientes enviados a comprador', 'Venta cerrada')),
    base_final               text,
    propuesta_url            text,
    comprobante_pago         text,
    fecha_ticket_contrato    date,
    numero_ticket_contrato   text,
    numero_guia              text,
    origen                   text not null default 'web',      -- web | sharepoint
    actualizado              timestamptz not null default now(),
    actualizado_por          text
);
create index if not exists funnel_id_propuesta on public.funnel_ventas (id_propuesta);
alter table public.funnel_ventas enable row level security;
revoke all on public.funnel_ventas from anon, authenticated;

-- ---------- alta / sincronización automática desde propuestas ----------
create or replace function public.tg_funnel_desde_propuesta() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tipo text := case new.tipo_venta when 'JyP' then 'J&P' when 'Grupal' then 'Grupal' when 'Dual' then 'Dual' end;
begin
    if new.id_propuesta not like 'VTA-%' then return new; end if;   -- PV (escritorio) y RST no son ventas nuevas
    if tg_op = 'INSERT' then
        insert into public.funnel_ventas (folio, id_propuesta, comprador, capital, monto_venta, tipo, estatus_venta,
                                          fecha_propuesta, vendedor, actualizado_por)
        values (new.id_propuesta, new.id_propuesta, new.comprador, new.capital, new.valor_venta, v_tipo, 'Propuesta',
                (new.fecha at time zone 'America/Mexico_City')::date, new.usuario, 'automático')
        on conflict (folio) do nothing;
    else
        update public.funnel_ventas
           set comprador   = coalesce(new.comprador, comprador),
               capital     = new.capital,
               monto_venta = new.valor_venta,
               tipo        = coalesce(v_tipo, tipo),
               estatus_venta = case when new.estatus in ('LIBERADA', 'RECHAZADA') then 'Cancelada'
                                    when estatus_venta = 'Cancelada' then 'Propuesta' else estatus_venta end,
               actualizado = now()
         where folio = new.id_propuesta;
    end if;
    return new;
end $$;
revoke all on function public.tg_funnel_desde_propuesta() from public, anon, authenticated;
drop trigger if exists tr_funnel_desde_propuesta on public.propuestas;
create trigger tr_funnel_desde_propuesta after insert or update on public.propuestas
    for each row execute function public.tg_funnel_desde_propuesta();

-- propuestas web que ya existían
insert into public.funnel_ventas (folio, id_propuesta, comprador, capital, monto_venta, tipo, estatus_venta,
                                  fecha_propuesta, vendedor, actualizado_por)
select p.id_propuesta, p.id_propuesta, p.comprador, p.capital, p.valor_venta,
       case p.tipo_venta when 'JyP' then 'J&P' when 'Grupal' then 'Grupal' when 'Dual' then 'Dual' end,
       case when p.estatus in ('LIBERADA', 'RECHAZADA') then 'Cancelada' else 'Propuesta' end,
       (p.fecha at time zone 'America/Mexico_City')::date, p.usuario, 'automático'
  from public.propuestas p
 where p.id_propuesta like 'VTA-%'
on conflict (folio) do nothing;

-- ---------- lectura (con estado/municipios calculados de la cartera si están vacíos) ----------
create or replace function public.funnel_lista()
returns table (folio text, id_propuesta text, comprador text, capital numeric, monto_venta numeric, estado text,
               municipios text, tipo text, estatus_venta text, fecha_propuesta date, fecha_venta date, vendedor text,
               estatus_md text, fecha_inicio_md date, fecha_limite_md date, base_completa_venta text,
               estatus_control_doc text, fecha_inicio_admin date, fecha_limite_admin date, estatus_juridico text,
               estatus_final text, base_final text, propuesta_url text, comprobante_pago text,
               fecha_ticket_contrato date, numero_ticket_contrato text, numero_guia text, origen text,
               actualizado timestamptz, actualizado_por text, estatus_propuesta text, es_mia boolean)
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
           f.actualizado, f.actualizado_por, p.estatus, (p.user_id = auth.uid())
      from public.funnel_ventas f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;

-- ---------- edición ----------
-- Maestros (validador/admin) y auxiliar de venta: todo. Vendedor dueño: sección Venta y ligas.
create or replace function public.funnel_guardar(p_folio text, p_datos jsonb)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
    v_f public.funnel_ventas; v_quien text; v_dueno boolean; k text;
    v_back   text[] := array['estatus_md','fecha_inicio_md','fecha_limite_md','base_completa_venta','estatus_control_doc',
                             'fecha_inicio_admin','fecha_limite_admin','estatus_juridico','estatus_final','base_final',
                             'fecha_ticket_contrato','numero_ticket_contrato','numero_guia','capital','monto_venta','tipo','estatus_venta'];
    v_venta  text[] := array['comprador','estado','municipios','fecha_venta','propuesta_url','comprobante_pago','fecha_propuesta','vendedor'];
begin
    perform public._exigir_activo();
    select * into v_f from public.funnel_ventas where folio = p_folio for update;
    if not found then raise exception 'No existe la venta %', p_folio; end if;
    v_dueno := exists (select 1 from public.propuestas where id_propuesta = v_f.id_propuesta and user_id = auth.uid());
    for k in select jsonb_object_keys(p_datos) loop
        if not (k = any (v_back) or k = any (v_venta)) then raise exception 'Campo no editable: %', k; end if;
        if not public.tiene_rol(array['auxiliar']) and not (v_dueno and k = any (v_venta)) then
            raise exception 'Tu rol no permite editar «%» de %', k, p_folio using errcode = '42501';
        end if;
    end loop;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();

    update public.funnel_ventas f set
        comprador              = case when p_datos ? 'comprador' then nullif(trim(p_datos->>'comprador'), '') else f.comprador end,
        capital                = case when p_datos ? 'capital' then nullif(p_datos->>'capital', '')::numeric else f.capital end,
        monto_venta            = case when p_datos ? 'monto_venta' then nullif(p_datos->>'monto_venta', '')::numeric else f.monto_venta end,
        estado                 = case when p_datos ? 'estado' then nullif(trim(p_datos->>'estado'), '') else f.estado end,
        municipios             = case when p_datos ? 'municipios' then nullif(trim(p_datos->>'municipios'), '') else f.municipios end,
        tipo                   = case when p_datos ? 'tipo' then nullif(p_datos->>'tipo', '') else f.tipo end,
        estatus_venta          = case when p_datos ? 'estatus_venta' then coalesce(nullif(p_datos->>'estatus_venta', ''), 'Propuesta') else f.estatus_venta end,
        fecha_propuesta        = case when p_datos ? 'fecha_propuesta' then nullif(p_datos->>'fecha_propuesta', '')::date else f.fecha_propuesta end,
        fecha_venta            = case when p_datos ? 'fecha_venta' then nullif(p_datos->>'fecha_venta', '')::date else f.fecha_venta end,
        vendedor               = case when p_datos ? 'vendedor' then nullif(trim(p_datos->>'vendedor'), '') else f.vendedor end,
        estatus_md             = case when p_datos ? 'estatus_md' then nullif(p_datos->>'estatus_md', '') else f.estatus_md end,
        fecha_inicio_md        = case when p_datos ? 'fecha_inicio_md' then nullif(p_datos->>'fecha_inicio_md', '')::date else f.fecha_inicio_md end,
        fecha_limite_md        = case when p_datos ? 'fecha_limite_md' then nullif(p_datos->>'fecha_limite_md', '')::date else f.fecha_limite_md end,
        base_completa_venta    = case when p_datos ? 'base_completa_venta' then nullif(trim(p_datos->>'base_completa_venta'), '') else f.base_completa_venta end,
        estatus_control_doc    = case when p_datos ? 'estatus_control_doc' then nullif(p_datos->>'estatus_control_doc', '') else f.estatus_control_doc end,
        fecha_inicio_admin     = case when p_datos ? 'fecha_inicio_admin' then nullif(p_datos->>'fecha_inicio_admin', '')::date else f.fecha_inicio_admin end,
        fecha_limite_admin     = case when p_datos ? 'fecha_limite_admin' then nullif(p_datos->>'fecha_limite_admin', '')::date else f.fecha_limite_admin end,
        estatus_juridico       = case when p_datos ? 'estatus_juridico' then nullif(p_datos->>'estatus_juridico', '') else f.estatus_juridico end,
        estatus_final          = case when p_datos ? 'estatus_final' then nullif(p_datos->>'estatus_final', '') else f.estatus_final end,
        base_final             = case when p_datos ? 'base_final' then nullif(trim(p_datos->>'base_final'), '') else f.base_final end,
        propuesta_url          = case when p_datos ? 'propuesta_url' then nullif(trim(p_datos->>'propuesta_url'), '') else f.propuesta_url end,
        comprobante_pago       = case when p_datos ? 'comprobante_pago' then nullif(trim(p_datos->>'comprobante_pago'), '') else f.comprobante_pago end,
        fecha_ticket_contrato  = case when p_datos ? 'fecha_ticket_contrato' then nullif(p_datos->>'fecha_ticket_contrato', '')::date else f.fecha_ticket_contrato end,
        numero_ticket_contrato = case when p_datos ? 'numero_ticket_contrato' then nullif(trim(p_datos->>'numero_ticket_contrato'), '') else f.numero_ticket_contrato end,
        numero_guia            = case when p_datos ? 'numero_guia' then nullif(trim(p_datos->>'numero_guia'), '') else f.numero_guia end,
        actualizado = now(), actualizado_por = v_quien
     where f.folio = p_folio;

    if v_f.id_propuesta is not null then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        select v_f.id_propuesta, v_quien, 'Funnel',
               string_agg(initcap(replace(k2, '_', ' ')) || ': ' || coalesce(nullif(p_datos->>k2, ''), '—'), ' · ')
          from jsonb_object_keys(p_datos) k2;
    end if;
end $$;

do $$
declare f text;
begin
    foreach f in array array['funnel_lista()', 'funnel_guardar(text,jsonb)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
