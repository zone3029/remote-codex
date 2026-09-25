import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/remote-codex/web-rdp/',
  plugins: [vue()],
});
