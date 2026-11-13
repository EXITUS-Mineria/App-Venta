// ============================================================
// Configuración del sitio. Es lo ÚNICO que se edita al instalar.
// La "anon key" es pública por diseño: la seguridad la dan el login
// y los permisos (RLS) de Supabase.
// Supabase > Project Settings > API > Project URL / anon public key
// ============================================================
export const CONFIG = {
  SUPABASE_URL: "https://vwlfxkaxiduvolbvdmmg.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3bGZ4a2F4aWR1dm9sYnZkbW1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1Mjk3MTQsImV4cCI6MjExMDEwNTcxNH0.jXmw09W8CfSxPPiQJyirb998cmniNjTZfYVaFF2_u-I",
  EMPRESA: "Exitus Credit",
  SISTEMA: "Venta de Cartera",
};
