import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // The Twilio Voice SDK is most of the bundle and changes rarely; keep it in its own cacheable file.
      output: { manualChunks: { twilio: ['@twilio/voice-sdk'], vendor: ['react', 'react-dom', 'react-router-dom', '@supabase/supabase-js'] } },
    },
  },
});
