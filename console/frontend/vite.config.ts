import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Dev: `npm run dev` serves on :5173 and proxies /api to the FastAPI backend
// (VITE_API_TARGET, default http://127.0.0.1:8000). Prod: `npm run build` -> dist/,
// served by console/backend/app.py at "/".
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: env.VITE_API_TARGET || "http://127.0.0.1:8000", changeOrigin: false },
      },
    },
    build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});
