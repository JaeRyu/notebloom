import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri(안드로이드/iOS) 개발 시 기기에서 접속할 수 있도록 호스트를 열어 준다.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
