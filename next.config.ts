import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // lib/ is server-only and reads SERVICE_ROLE / GOOGLE_API_KEY at module load.
  // Listing the packages here keeps Next from trying to bundle them for the
  // client, which would both break and leak.
  serverExternalPackages: ['@supabase/supabase-js', '@google/genai'],
};

export default nextConfig;
