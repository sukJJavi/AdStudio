import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
    project: "proj_fpqjehmdwrndphoppidu", // el ID que aparece en tu dashboard de Trigger.dev
    dirs: ["./trigger"],
    maxDuration: 300,
    build: {
        // sharp, @resvg/resvg-js y canvas instalan un binario nativo distinto por
        // plataforma (los paquetes @resvg/resvg-js-{os}-{arch}, sharp-{os}-{arch},
        // y el prebuild de node-canvas, vía optionalDependencies/prebuild-install).
        // Si esbuild los empaqueta, el binario resuelto en la máquina de desarrollo
        // (Windows) viaja con el bundle y no carga en el runtime de Trigger.dev
        // (Linux). external los deja fuera del bundle; Trigger.dev genera un
        // package.json aparte para ellos y los instala en su propio entorno de
        // build, donde npm resuelve el binario linux-x64-gnu real.
        // autoDetectExternal (activo por defecto) debería detectarlos solo, pero se
        // declaran explícitos para no depender de esa heurística.
        // https://trigger.dev/docs/config/config-file#external
        external: ["@resvg/resvg-js", "sharp", "canvas"],
    },
});