// ============================================================
// Configuración del sitio. Es lo ÚNICO que se edita al instalar.
// La "anon key" es pública por diseño: la seguridad la dan el login
// y los permisos (RLS) de Supabase.
// Supabase > Project Settings > API > Project URL / anon public key
// ============================================================
export const CONFIG = {
  SUPABASE_URL: "https://vwlfxkaxiduvolbvdmmg.supabase.co",
  SUPABASE_ANON_KEY: "PEGA_AQUI_LA_ANON_KEY",
  EMPRESA: "Exitus Credit",
  SISTEMA: "Venta de Cartera",
};
