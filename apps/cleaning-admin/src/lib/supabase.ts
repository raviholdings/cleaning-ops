import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://rvpajzbdaqcpchzzkyyf.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2cGFqemJkYXFjcGNoenpreXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjI0MDU2MDAsImV4cCI6MjAzNzk4MTYwMH0.fakekey';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
