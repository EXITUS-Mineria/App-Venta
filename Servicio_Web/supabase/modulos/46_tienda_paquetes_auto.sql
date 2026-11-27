-- ============================================================
-- TIENDA: paquetes automáticos de $10,000 por estado y municipio (JyP y Grupal) + ofertas en estados sin venta
--  · Un paquete = valor de compra fijo (config tienda_monto_paquete, $10,000). El capital que trae depende
--    del precio: capital = monto / centavos. Precio normal tienda_centavos; en estados donde nunca hemos
--    vendido, precio de oferta tienda_centavos_oferta (más capital por el mismo dinero). A ambos se les
--    resta el descuento del nivel de lealtad del comprador. «Sin venta» = sin ventas en los últimos
--    tienda_oferta_dias (90) días.
--  · Paquetes por municipio = capital disponible (Disponible, sin apartar, sin bloquear) / capital por paquete.
--    En Grupal cuenta el grupo completo (todos sus integrantes Disponibles).
--  · El comprador arma un carrito (tipo, estado, municipio, número de paquetes) y se crea su solicitud de
--    compra (una por tipo de cartera). Nada se aparta hasta que el vendedor arma la propuesta.
-- Requiere 42 (config_app), 45. Idempotente.
-- ============================================================
insert into public.config_app (clave, valor, descripcion) values
    ('tienda_paquetes_auto',   'true',  'Mostrar en la Tienda los paquetes automáticos por estado y municipio'),
    ('tienda_monto_paquete',   '10000', 'Valor de compra de cada paquete automático ($)'),
    ('tienda_centavos',        '0.15',  'Precio normal de los paquetes automáticos (centavos por peso de capital, 0.15 = 15 ¢)'),
    ('tienda_centavos_oferta', '0.10',  'Precio de oferta en estados donde aún no tenemos ventas (0.10 = 10 ¢)'),
    ('tienda_oferta_dias',     '90',    'Un estado entra a Ofertas si no tiene ventas en estos días')
on conflict (clave) do nothing;

/** Disponible hoy por tipo, estado y municipio. */
create or replace function public._tienda_disponible()
returns table (tipo text, estado_n text, municipio_n text, creditos bigint, grupos bigint, capital numeric, dias numeric)
language sql stable security definer set search_path = public as $$
    with g as (
        select vgroupid, min(estado_n) e, min(municipio_n) m, sum(npendingk) cap, avg(dias) d, count(*) n
          from public.cartera_grupal group by vgroupid
        having bool_and(disponible)
           and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || vgroupid)
           and not exists (select 1 from public.bloqueados b where b.clave = 'G:' || vgroupid)
    )
    select 'Grupal', e, m, sum(n)::bigint, count(*), round(sum(cap), 2), round(avg(d), 0) from g where length(coalesce(e, '')) > 3 group by e, m
    union all
    select 'JyP', j.estado_n, j.municipio_n, count(*), 0::bigint, round(sum(j.npendingk), 2), round(avg(j.dias), 0)
      from public.cartera_jyp j
     where j.disponible and length(coalesce(j.estado_n, '')) > 3
       and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
       and not exists (select 1 from public.bloqueados b where b.clave = 'J:' || j.vreference)
     group by j.estado_n, j.municipio_n
$$;
revoke all on function public._tienda_disponible() from public, anon, authenticated;

/** Estados con venta RECIENTE (Vendida dentro de tienda_oferta_dias); los demás van a Ofertas. */
create or replace function public._estados_con_venta()
returns text[] language sql stable security definer set search_path = public as $$
    select coalesce(array_agg(distinct z.estado_n) filter (where coalesce(z.estado_n, '') <> ''), '{}')
      from public._compras_zonas() z
     where z.fecha >= (now() at time zone 'America/Mexico_City')::date - public._num_config('tienda_oferta_dias', 90)::int
$$;
revoke all on function public._estados_con_venta() from public, anon, authenticated;

create or replace function public._num_config(p_clave text, p_def numeric)
returns numeric language sql stable security definer set search_path = public as $$
    select coalesce((select nullif(valor #>> '{}', '')::numeric from public.config_app where clave = p_clave), p_def)
$$;
revoke all on function public._num_config(text, numeric) from public, anon, authenticated;

/** Catálogo de paquetes automáticos para el comprador con sesión (precios con su descuento de lealtad). */
create or replace function public.portal_tienda_catalogo()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); monto numeric; c_norm numeric; c_ofer numeric; desc_c numeric; vendidos text[]; r jsonb;
begin
    if not public._config_si('tienda_paquetes_auto') then return jsonb_build_object('activo', false); end if;
    monto := public._num_config('tienda_monto_paquete', 10000);
    desc_c := coalesce(((public._nivel_comprador(v))->>'descuento_centavos')::numeric, 0);
    c_norm := greatest(public._num_config('tienda_centavos', 0.15) - desc_c, 0.01);
    c_ofer := greatest(public._num_config('tienda_centavos_oferta', 0.10) - desc_c, 0.01);
    vendidos := public._estados_con_venta();
    with d as (select * from public._tienda_disponible()),
    m as (
        select d.tipo, d.estado_n, (d.estado_n <> all(vendidos)) oferta, d.municipio_n, d.creditos, d.grupos, d.capital, d.dias,
               floor(d.capital / (monto / case when d.estado_n <> all(vendidos) then c_ofer else c_norm end))::int paquetes
          from d
    ),
    e as (
        select m.tipo, m.estado_n, bool_or(m.oferta) oferta, sum(m.creditos) creditos, sum(m.grupos) grupos, sum(m.capital) capital,
               sum(m.paquetes) paquetes, round(sum(m.dias * m.creditos) / nullif(sum(m.creditos), 0), 0) dias,
               jsonb_agg(jsonb_build_object('municipio', initcap(lower(m.municipio_n)), 'creditos', m.creditos, 'grupos', m.grupos,
                         'capital', m.capital, 'dias', m.dias, 'paquetes', m.paquetes) order by m.capital desc)
                 filter (where m.paquetes >= 1) municipios
          from m group by m.tipo, m.estado_n
    )
    select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'estado', initcap(lower(e.estado_n)), 'oferta', e.oferta,
               'creditos', e.creditos, 'grupos', e.grupos, 'capital', round(e.capital, 2), 'dias', e.dias, 'paquetes', e.paquetes,
               'municipios', coalesce(e.municipios, '[]'::jsonb)) order by e.oferta desc, e.capital desc)
      into r from e where e.paquetes >= 1;
    return jsonb_build_object('activo', true, 'monto_paquete', monto, 'centavos', c_norm, 'centavos_oferta', c_ofer,
        'capital_paquete', round(monto / c_norm, 0), 'capital_paquete_oferta', round(monto / c_ofer, 0),
        'descuento_centavos', desc_c, 'estados', coalesce(r, '[]'::jsonb));
end $$;
revoke all on function public.portal_tienda_catalogo() from public, anon;
grant execute on function public.portal_tienda_catalogo() to authenticated;

/** Carrito: [{tipo, estado, municipio, paquetes}] → una solicitud de compra por tipo de cartera. */
create or replace function public.portal_pedir_carrito(p_lineas jsonb, p_comentario text default '')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); monto numeric; c_norm numeric; c_ofer numeric; desc_c numeric; vendidos text[];
        t text; ids jsonb := '[]'; lineas text; cap numeric; ests text; muns text; n int; disp record; x jsonb;
begin
    if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then raise exception 'Tu carrito está vacío'; end if;
    if jsonb_array_length(p_lineas) > 60 then raise exception 'Máximo 60 renglones por pedido'; end if;
    monto := public._num_config('tienda_monto_paquete', 10000);
    desc_c := coalesce(((public._nivel_comprador(v))->>'descuento_centavos')::numeric, 0);
    c_norm := greatest(public._num_config('tienda_centavos', 0.15) - desc_c, 0.01);
    c_ofer := greatest(public._num_config('tienda_centavos_oferta', 0.10) - desc_c, 0.01);
    vendidos := public._estados_con_venta();
    create temp table if not exists _td (tipo text, estado_n text, municipio_n text, creditos bigint, grupos bigint, capital numeric, dias numeric) on commit drop;
    truncate _td;
    insert into _td select * from public._tienda_disponible();
    -- validar contra lo disponible hoy
    for x in select * from jsonb_array_elements(p_lineas) loop
        if x->>'tipo' not in ('JyP', 'Grupal') then raise exception 'Tipo de cartera inválido'; end if;
        n := coalesce((x->>'paquetes')::int, 0);
        if n < 1 then raise exception 'Indica cuántos paquetes quieres en %', x->>'municipio'; end if;
        select * into disp from _td d
         where d.tipo = x->>'tipo' and d.estado_n = public._sin_acentos(public._estado_oficial(x->>'estado'))
           and d.municipio_n = public._sin_acentos(upper(trim(x->>'municipio')));
        if not found or floor(disp.capital / (monto / case when disp.estado_n <> all(vendidos) then c_ofer else c_norm end)) < n then
            raise exception 'Ya no hay % paquete(s) disponibles en %, %', n, x->>'municipio', x->>'estado';
        end if;
    end loop;
    for t in select distinct e->>'tipo' from jsonb_array_elements(p_lineas) e loop
        select string_agg(format('%s × $%s en %s, %s%s', l->>'paquetes', to_char(monto, 'FM999,999'), l->>'municipio', l->>'estado',
                      case when public._sin_acentos(public._estado_oficial(l->>'estado')) <> all(vendidos) then ' (oferta)' else '' end), '; '),
               sum((l->>'paquetes')::int * monto /
                   case when public._sin_acentos(public._estado_oficial(l->>'estado')) <> all(vendidos) then c_ofer else c_norm end),
               string_agg(distinct l->>'estado', ', '), string_agg(distinct l->>'municipio', ', '),
               sum((l->>'paquetes')::int)
          into lineas, cap, ests, muns, n
          from jsonb_array_elements(p_lineas) l where l->>'tipo' = t;
        ids := ids || to_jsonb(public.portal_solicitar(jsonb_build_object('tipo_cartera', t, 'estados', ests, 'municipios', muns,
            'capital_aprox', round(cap, 0),
            'comentarios', left('🛍️ Tienda: ' || n || ' paquete(s) = ' || to_char(n * monto, 'FM$999,999,999') || ' de compra · ' || lineas ||
                coalesce(' · ' || nullif(trim(p_comentario), ''), ''), 2000))));
    end loop;
    return jsonb_build_object('solicitudes', ids);
end $$;
revoke all on function public.portal_pedir_carrito(jsonb, text) from public, anon;
grant execute on function public.portal_pedir_carrito(jsonb, text) to authenticated;

/** Interno (pestaña Tienda): configuración de paquetes automáticos y estados sin venta reciente con su cartera disponible. */
create or replace function public.tienda_resumen()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare vendidos text[]; monto numeric; c_norm numeric; c_ofer numeric; r jsonb;
begin
    perform public._exigir_activo();
    vendidos := public._estados_con_venta();
    monto := public._num_config('tienda_monto_paquete', 10000);
    c_norm := public._num_config('tienda_centavos', 0.15);
    c_ofer := public._num_config('tienda_centavos_oferta', 0.10);
    with z as (select z.estado_n, count(distinct z.folio) ventas, max(z.fecha) ultima, sum(z.capital) vendido from public._compras_zonas() z group by 1)
    select jsonb_agg(jsonb_build_object('estado', initcap(lower(x.estado_n)), 'con_venta', x.estado_n = any(vendidos),
               'jyp', x.jyp, 'grupal', x.grupal, 'capital', round(x.capital, 2), 'ventas', coalesce(z.ventas, 0), 'ultima', z.ultima,
               'vendido', round(coalesce(z.vendido, 0), 2),
               'paquetes', floor(x.capital / (monto / case when x.estado_n = any(vendidos) then c_norm else c_ofer end)))
               order by (x.estado_n = any(vendidos)), x.capital desc)
      into r
      from (select d.estado_n, sum(d.capital) filter (where d.tipo = 'JyP') jyp, sum(d.capital) filter (where d.tipo = 'Grupal') grupal,
                   sum(d.capital) capital
              from public._tienda_disponible() d group by d.estado_n) x
      left join z on z.estado_n = x.estado_n;
    return jsonb_build_object('activo', public._config_si('tienda_paquetes_auto'), 'monto_paquete', monto, 'centavos', c_norm,
        'centavos_oferta', c_ofer, 'oferta_dias', public._num_config('tienda_oferta_dias', 90), 'estados', coalesce(r, '[]'::jsonb));
end $$;
revoke all on function public.tienda_resumen() from public, anon;
grant execute on function public.tienda_resumen() to authenticated;
