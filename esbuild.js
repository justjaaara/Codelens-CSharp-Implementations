const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Emits the markers the .vscode/tasks.json background problem matcher waits on. */
const watchLogPlugin = {
  name: "watch-log",
  setup(build) {
    build.onStart(() => {
      if (watch) console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const err of result.errors) {
        const loc = err.location;
        if (loc) {
          console.error(`${loc.file}(${loc.line},${loc.column}): error: ${err.text}`);
        } else {
          console.error(`error: ${err.text}`);
        }
      }
      if (watch) console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "silent",
    plugins: [watchLogPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
