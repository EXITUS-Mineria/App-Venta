-- ============================================================
-- BÚSQUEDA POR ESTADO / MUNICIPIO SIN IMPORTAR ACENTOS
--  BASE_JYP escribe sin acentos ("NAUCALPAN DE JUAREZ") y BASE_GRUPAL con acentos ("Naucalpan de Juárez").
--  En ventas DUALES el filtro de municipio sólo encontraba uno de los dos tipos (salían sólo créditos JyP).
--  Las columnas de búsqueda estado_n / municipio_n ahora quitan acentos, así JyP y Grupal coinciden.
-- Requiere 21. Idempotente.
-- ============================================================
do $$
begin
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cartera_jyp'
                  and column_name = 'estado_n' and generation_expression not like '%_sin_acentos%') then
        drop index if exists public.cartera_jyp_geo_n;
        alter table public.cartera_jyp drop column estado_n, drop column municipio_n;
        alter table public.cartera_jyp
            add column estado_n text generated always as (public._sin_acentos(regexp_replace(trim(coalesce(estado, '')), '\s+', ' ', 'g'))) stored,
            add column municipio_n text generated always as (public._sin_acentos(regexp_replace(trim(coalesce(municipio, '')), '\s+', ' ', 'g'))) stored;
        create index cartera_jyp_geo_n on public.cartera_jyp (estado_n, municipio_n);
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cartera_grupal'
                  and column_name = 'estado_n' and generation_expression not like '%_sin_acentos%') then
        drop index if exists public.cartera_grupal_geo_n;
        alter table public.cartera_grupal drop column estado_n, drop column municipio_n;
        alter table public.cartera_grupal
            add column estado_n text generated always as (public._sin_acentos(regexp_replace(trim(coalesce(estado, '')), '\s+', ' ', 'g'))) stored,
            add column municipio_n text generated always as (public._sin_acentos(regexp_replace(trim(coalesce(municipio, '')), '\s+', ' ', 'g'))) stored;
        create index cartera_grupal_geo_n on public.cartera_grupal (estado_n, municipio_n);
    end if;
end $$;
analyze public.cartera_jyp;
analyze public.cartera_grupal;
