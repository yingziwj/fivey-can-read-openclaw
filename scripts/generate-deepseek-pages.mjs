import path from "node:path";
import { loadEnvFile } from "./env.mjs";
import {
  DATA_PATH,
  ensureDir,
  normalizeWhitespace,
  readJson,
  stripMarkdown,
  writeJson
} from "./site-lib.mjs";

await loadEnvFile();

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

if (!apiKey) {
  throw new Error("Missing DEEPSEEK_API_KEY. Put it in .env.local or the environment.");
}

const siteData = await readJson(DATA_PATH);
const outputDir = path.resolve("generated", "deepseek-pages");
await ensureDir(outputDir);

const args = process.argv.slice(2);
const allMode = args.includes("--all");
const refreshMode = args.includes("--refresh");
const requestedPaths = args.filter((value) => !value.startsWith("--"));
const handcraftedPathnames = new Set([
  "/tools/index",
  "/channels/index",
  "/channels/telegram"
]);
const concurrency = Number(process.env.DEEPSEEK_CONCURRENCY || 4);

const targetPages = (
  allMode || !requestedPaths.length
    ? siteData.pages.filter((page) => !handcraftedPathnames.has(page.pathname))
    : requestedPaths
        .map((pathname) => siteData.pages.find((page) => page.pathname === pathname))
        .filter(Boolean)
).filter(Boolean);

if (!targetPages.length) {
  throw new Error("No matching pages found for DeepSeek generation.");
}

function compactBlock(block) {
  if (block.type === "paragraph") {
    return { type: "paragraph", text: normalizeWhitespace(block.text) };
  }
  if (block.type === "list") {
    return { type: "list", items: block.items.map((item) => normalizeWhitespace(item)) };
  }
  if (block.type === "code") {
    return {
      type: "code",
      language: block.language,
      code: block.code.split("\n").slice(0, 24).join("\n")
    };
  }
  return block;
}

function pagePrompt(page) {
  const source = {
    title: page.title,
    pathname: page.pathname,
    description: page.description,
    sections: page.sections.map((section) => ({
      title: section.title,
      blocks: section.blocks.slice(0, 8).map(compactBlock)
    }))
  };

  return `
你是一个非常会给5岁小孩讲故事的中文老师，同时你也绝不能把技术事实讲错。

你的任务：
把 OpenClaw 官方英文文档的一页，改写成“5岁小孩也能听懂、成年人也愿意继续看下去”的中文解读版。

要求：
1. 输出必须是中文。
2. 要像在讲故事、讲画面、讲动作。要让人一读就懂，一路想继续往下看。
3. 可以真的把读者当5岁小孩来讲，但事实必须准确，不能瞎编。
4. 不要写成技术摘要，不要写成“本节介绍”“核心机制”“完整指南”“配置逻辑”这种硬邦邦的话。
5. 多用比喻，比如门、钥匙、门牌号、门卫、工具箱、总控台，但比喻要贴合原文。
6. 每句话尽量短一点。少讲抽象话，多讲“这是什么”“它像什么”“它在干什么”。
7. 对代码、命令、配置要用讲故事的方式解释：这行命令像在做什么动作，这段配置像在定什么规则，这个字段像什么按钮。
8. 不要逐句翻译，不要照抄原文，要做真正的中文解读。
9. 不要输出 Markdown，不要输出代码块围栏。
10. 可以在标题或小标签里少量使用 emoji，让内容更像海报导读，但不要每句都塞 emoji。
11. 严格输出 JSON，结构如下：
{
  "heroTitle": "短一点、好懂一点、像海报标题的中文标题",
  "heroSummary": "2-3句总导读，短句，顺口",
  "sections": [
    {
      "title": "短一点、像卡片标题的中文标题",
      "summary": "1到2句，先把这节说成人能马上听懂的话",
      "why": "1句，告诉读者为什么值得看",
      "points": ["3到5条短句，每条都具体、好懂、带画面感"],
      "codeNotes": ["如果这一节有代码/命令，就写2到5条，像在讲这段命令在现场做什么；没有就给空数组"],
      "takeaway": "1句短短的、最好记的话"
    }
  ]
}

额外要求：
- 避免“首先、其次、此外、综上所述”这种写法。
- 避免“该功能、此机制、该配置项”这种写法，尽量换成更自然的话。
- 如果文档里有一长串支持列表，要帮读者分组理解，不要只是重复名单。
- 如果文档里有命令，要解释命令执行后你眼前会发生什么。
- 如果文档里有配置，要解释这个配置是在“放行、拦人、选路、开门、关门”里的哪一种。

下面是这页官方内容的结构化摘录：
${JSON.stringify(source, null, 2)}
`.trim();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDeepSeek(prompt) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是严谨的中文技术编辑，擅长把英文技术文档改写成真正有阅读体验的中文解读。"
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek API returned no content.");
  }

  return JSON.parse(content);
}

async function callDeepSeekWithRetry(prompt, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callDeepSeek(prompt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

async function generatePage(page) {
  const outputPath = path.join(outputDir, `${page.slug.replace(/\//g, "__")}.json`);
  if (!refreshMode) {
    try {
      await readJson(outputPath);
      console.log(`Skipped existing explanation for ${page.pathname}`);
      return;
    } catch {}
  }

  console.log(`Generating DeepSeek explanation for ${page.pathname}`);
  const prompt = pagePrompt(page);
  const result = await callDeepSeekWithRetry(prompt);
  await writeJson(outputPath, {
    generatedAt: new Date().toISOString(),
    pathname: page.pathname,
    title: page.title,
    model,
    result
  });
  console.log(`Generated DeepSeek explanation for ${page.pathname}`);
}

for (let index = 0; index < targetPages.length; index += concurrency) {
  const batch = targetPages.slice(index, index + concurrency);
  await Promise.all(batch.map((page) => generatePage(page)));
}
