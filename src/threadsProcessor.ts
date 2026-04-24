/**
 * threadsProcessor.ts — Threads Post Processor Engine
 *
 * Batch-processes markdown files in the "Threads" directory with three
 * AI-powered enhancements:
 *   1. Title Generation — reads content and produces a ≤20-char title.
 *   2. Summary Append   — for posts with body text >100 chars, appends
 *                          a concise summary section.
 *   3. Relation Linking  — suggests existing Obsidian vault pages that
 *                          could be linked via [[wikilinks]].
 *
 * Design: lightweight, non-destructive (uses checkpoint system), and
 * follows the same patterns as ArticleProcessorEngine.
 */

import { App, TFile, TFolder, Notice, normalizePath } from "obsidian";
import { LocalLLMClient, parseJsonFromLLM } from "./api";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Single-shot prompt that handles all three tasks at once to minimise
 * LLM round-trips (Threads posts are short, so context fits easily).
 */
const THREADS_PROCESSOR_PROMPT = `你是一位精準的內容分析助手，專門處理社群媒體短文（來自 Threads / Instagram）。

你將收到一篇帖文的「原始檔名」和「內文」，以及使用者 Obsidian 知識庫中「現有頁面清單」。

請嚴格依照以下 JSON 格式回傳，不要輸出任何其他文字：

{
  "title": "（根據內文下一個精準的繁體中文標題，最多 20 個字。若原始檔名中有日期如 2025-06-17，請將日期保留在標題前面，格式為 YYYY-MM-DD 加空格再接標題，日期不計入 20 字上限）",
  "summary": "（若內文超過 100 字，請寫一段 50 字以內的摘要，捕捉核心主題或觀點；若不超過 100 字則回傳空字串 \"\"）",
  "relations": ["頁面名稱A", "頁面名稱B"]
}

## 關於 relations 的規則
- 從「現有頁面清單」中挑選 1 到 3 個與內文主題最相關的頁面。
- 只能從提供的清單中選擇，不可自創頁面名稱。
- 若沒有任何相關頁面，回傳空陣列 []。
- 回傳的是頁面名稱（不含路徑前綴），例如 "旺卡" 而非 "30_Life_&_Creations/旺卡"。

## 關於 title 的規則
- 標題必須是繁體中文。
- 標題應精準概括文章的核心內容或主題。
- 不要使用引號包覆標題文字本身。
- 若檔名中含有日期，標題格式範例："2025-06-17 草屯碳桔燒肉便當初體驗"

## 關於 summary 的規則
- 摘要應當是一段精煉的陳述句，不是條列式。
- 若內文包含食記、影評、書評等，摘要應點出評價或結論。`;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ThreadsProcessorEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  /**
   * Process all markdown files inside the given folder path.
   * Returns the count of successfully processed files.
   */
  public async processBatch(
    folderPath: string,
    onProgress?: (current: number, total: number, name: string) => void,
    shouldCancel?: () => boolean
  ): Promise<number> {
    // ── Collect all markdown files ──
    const files = this.getMarkdownFiles(folderPath);
    if (files.length === 0) {
      new Notice(`在「${folderPath}」中找不到任何 Markdown 檔案。`);
      return 0;
    }

    new Notice(`找到 ${files.length} 篇 Threads 帖文，開始批次處理...`);

    // ── Build the vault page index (basename only) for relation matching ──
    const existingPages = this.collectVaultPageNames(folderPath);

    let processedCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (shouldCancel?.()) {
        new Notice("Threads 批次處理已被使用者取消。");
        break;
      }

      const file = files[i];
      onProgress?.(i + 1, files.length, file.basename);

      try {
        // Skip files that have already been processed by this engine
        const content = await this.app.vault.read(file);
        if (content.includes("threads-processed: true")) {
          console.log(
            `[ThreadsProcessor] Skipping ${file.basename}: already processed.`
          );
          continue;
        }

        await this.processFile(file, content, existingPages);
        processedCount++;
      } catch (err) {
        console.error(
          `[ThreadsProcessor] Failed to process ${file.basename}:`,
          err
        );
      }
    }

    return processedCount;
  }

  // ---- Single-file processing -----------------------------------------------

  private async processFile(
    file: TFile,
    content: string,
    existingPages: string[]
  ): Promise<void> {
    const body = this.stripFrontmatter(content);

    // Skip nearly-empty files
    if (body.trim().length < 10) {
      console.log(
        `[ThreadsProcessor] Skipping ${file.basename}: body too short.`
      );
      return;
    }

    // ── Checkpoint before modification ──
    await this.saveCheckpoint(file, content);

    // ── Build user prompt ──
    // Truncate page list to avoid overwhelming context (send ≤200 page names)
    const pageListStr = existingPages.slice(0, 200).join("\n");

    const userPrompt = [
      `【原始檔名】：${file.basename}`,
      "",
      `【內文】：`,
      body,
      "",
      `【現有頁面清單】（共 ${existingPages.length} 頁，以下列出前 200 個）：`,
      pageListStr,
    ].join("\n");

    // ── Call LLM ──
    const rawResponse = await this.apiClient.prompt(
      THREADS_PROCESSOR_PROMPT,
      userPrompt,
      this.temperature
    );

    const parsed = parseJsonFromLLM<{
      title?: string;
      summary?: string;
      relations?: string[];
    }>(rawResponse);

    if (!parsed) {
      console.warn(
        `[ThreadsProcessor] Failed to parse LLM response for ${file.basename}. Raw:`,
        rawResponse.substring(0, 300)
      );
      return;
    }

    const { title, summary, relations } = parsed;

    // ── Apply changes ──

    // 1. Mark as processed & update frontmatter via Obsidian API
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm["threads-processed"] = true;

      if (title) {
        fm["title"] = title;
      }
    });

    // 2. Append summary & relations section to body
    let appendSection = "";

    if (summary && summary.trim().length > 0) {
      appendSection += `\n\n---\n\n## 摘要\n\n${summary.trim()}\n`;
    }

    if (relations && relations.length > 0) {
      // Filter to only pages that truly exist in the provided list
      const validRelations = relations.filter((r) =>
        existingPages.includes(r)
      );
      if (validRelations.length > 0) {
        appendSection += `\n## 關聯筆記\n\n`;
        for (const rel of validRelations) {
          appendSection += `- [[${rel}]]\n`;
        }
      }
    }

    if (appendSection) {
      const currentContent = await this.app.vault.read(file);
      await this.app.vault.modify(file, currentContent + appendSection);
    }

    // 3. Rename the file if a new title is suggested and different
    if (title) {
      const safeName = title
        .replace(/[\\/:\"*?<>|#^\[\]]/g, "")
        .trim()
        .slice(0, 60);

      if (safeName && safeName !== file.basename) {
        const parentDir = file.parent?.path || "";
        const newPath = normalizePath(`${parentDir}/${safeName}.md`);

        // Avoid overwriting an existing file
        if (!this.app.vault.getAbstractFileByPath(newPath)) {
          await this.app.vault.rename(file, newPath);
          new Notice(`✅ 已處理並重新命名：${safeName}`);
        } else {
          new Notice(`✅ 已處理：${file.basename}（標題重複，未重新命名）`);
        }
      } else {
        new Notice(`✅ 已處理：${file.basename}`);
      }
    } else {
      new Notice(`✅ 已處理：${file.basename}`);
    }
  }

  // ---- Helpers ---------------------------------------------------------------

  /**
   * Collect all markdown file basenames in the vault, excluding the
   * target folder itself, checkpoints, and system folders.
   */
  private collectVaultPageNames(excludeFolder: string): string[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    const excludeNorm = normalizePath(excludeFolder).toLowerCase();

    const names: Set<string> = new Set();
    for (const f of allFiles) {
      const pathLower = f.path.toLowerCase();
      if (
        pathLower.startsWith(excludeNorm) ||
        pathLower.startsWith("_checkpoints") ||
        pathLower.includes(".obsidian")
      ) {
        continue;
      }
      names.add(f.basename);
    }

    return Array.from(names).sort();
  }

  /**
   * Get all markdown files directly inside the given folder (non-recursive).
   * Sorted by modification time (newest first).
   */
  private getMarkdownFiles(folderPath: string): TFile[] {
    const normalised = normalizePath(folderPath);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalised);

    if (!abstractFile || !(abstractFile instanceof TFolder)) {
      return [];
    }

    const folder = abstractFile as TFolder;
    const mdFiles: TFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        mdFiles.push(child);
      }
    }

    // Newest first
    mdFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
    return mdFiles;
  }

  /**
   * Strip YAML frontmatter, returning only the body text.
   */
  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }

  /**
   * Save a checkpoint snapshot before modifying the file.
   */
  private async saveCheckpoint(
    file: TFile,
    content: string
  ): Promise<void> {
    try {
      const checkpointDir = normalizePath(
        `_checkpoints/${file.basename}`
      );
      const existingDir =
        this.app.vault.getAbstractFileByPath(checkpointDir);
      if (!existingDir) {
        await this.app.vault.createFolder(checkpointDir);
      }

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "-");
      const checkpointPath = normalizePath(
        `${checkpointDir}/${file.basename}_${ts}.md`
      );

      const header = [
        "---",
        "type: checkpoint",
        `source: "[[${file.basename}]]"`,
        `checkpoint_created: ${now.toISOString()}`,
        `original_path: "${file.path}"`,
        "---",
        "",
        "> [!warning] 此為自動保存的變更檢查點（Checkpoint）",
        `> 原始檔案：[[${file.basename}]]`,
        `> 快照時間：${now.toISOString()}`,
        "",
        "---",
        "",
      ].join("\n");

      await this.app.vault.create(checkpointPath, header + content);
      console.log(
        `[ThreadsProcessor] Checkpoint saved: ${checkpointPath}`
      );
    } catch (err) {
      console.warn(
        "[ThreadsProcessor] Failed to save checkpoint:",
        err
      );
    }
  }
}
