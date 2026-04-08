import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH, ensureDir, readJson, writeJson } from "./site-lib.mjs";

const siteData = await readJson(DATA_PATH);
const heroDir = path.resolve("generated", "deepseek-heroes");
await ensureDir(heroDir);

for (const page of siteData.pages) {
  const outputPath = path.join(heroDir, `${page.slug.replace(/\//g, "__")}.json`);
  try {
    await fs.access(outputPath);
  } catch {
    await writeJson(outputPath, {
      generatedAt: new Date().toISOString(),
      pathname: page.pathname,
      title: page.title,
      model: "fallback",
      result: {
        heroTitle: page.title,
        heroSummary: page.description || page.title
      }
    });
  }
}
