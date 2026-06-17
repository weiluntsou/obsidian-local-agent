import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient } from "./api";

/**
 * Ontology snapshot: captures the semantic relationships (wikilinks,
 * tags, frontmatter properties) of a note before any LLM rewriting.
 * After processing, any links or tags missing from the LLM output
 * are re-injected to preserve the knowledge graph.
 */
interface OntologySnapshot {
  /** All [[wikilink]] targets found in the original body text. */
  wikilinks: string[];
  /** All #tags found in the original body text (not frontmatter). */
  inlineTags: string[];
  /** Frontmatter tags (array of strings without leading #). */
  frontmatterTags: string[];
  /** Frontmatter key-value pairs to preserve across rewrites. */
  preservedFrontmatter: Record<string, unknown>;
}

const PILLARS = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "99_未分類"
];

const ARTICLE_PROCESSOR_PROMPT = `閱讀使用者提供的文章內容（包含原始檔名），並嚴格按照以下五個步驟處理，最終改寫為一個完整的 Markdown（標記語言）格式筆記。

## 步驟零：評估與修改標題（TITLE）
判斷原始筆記檔名是否能精準概括內文。如果無關或是無意義名稱，請根據內容給出一個 20 字以內的新繁體中文標題。如果原始檔名包含日期資訊（如 2026-04-17），請務必將其保留於新標題中。若原標題已經完美貼切，請沿用。請將最後決定好的標題，放入下一步驟 YAML 區塊的 \`title:\` 欄位。

## 步驟一：建立標準化 YAML（YAML 資料序列化格式）前文
請根據文章內容，提取中繼資料並生成 YAML 區塊。
- title（標題）: {SUGGESTED_TITLE}
- type（類型）: reference（參考資料）
- source（來源）: {SOURCE_URL}
- captured（擷取日期）: {CAPTURED_DATE}
- category（分類）: 必須是以下五大支柱（Five Pillars）的其中一個精確名稱：
  - 10_工作與管理（團隊帶領、會議、專案管理（project management）、人際、職場）
  - 20_學術與電腦科學（電腦科學（Computer Science）、學位、程式開發（programming）、技術）
  - 30_生活與創作（生活飲食、旅遊、個人興趣）
  - 40_自託管實驗室（伺服器、Docker 容器化（containerization）、自託管（self-hosted）、人工智慧（AI）工具）
  - 99_未分類（無法歸類到以上四大類別時放這裡）
- tags（標籤）: [提取 2-3 個與主題相關的標籤，必須包含 #web-clippings（網頁剪輯），並視情況加上 #status/to-process（待處理狀態）或 #status/evergreen（常青筆記狀態）。為了增加知識庫的關聯性，請參考輸入中提供的「知識庫現有標籤」列表，優先選用相關的已存在標籤。若無相關標籤，才自行生成新標籤。]

## 步驟二：撰寫「一句話總結（One-Sentence Summary）」
在 YAML 區塊下方，請用一句精煉的話（不超過 50 字）總結這篇文章的核心價值或解決的問題，讓未來的讀者（使用者本人）能在一秒內決定是否需要繼續閱讀。

## 步驟三：知識蒸餾與重點提取（Distillation）
不要原文照抄。請過濾掉廢話與冗長的鋪陳，提取文章中最具價值的 3 到 5 個核心觀點或實用技巧，並使用 Markdown 的條列式（Bullet points）或引用區塊（>）呈現。

## 步驟四：原子化概念標記與獨立萃取（Atomization & Extraction）
這是最重要的一步。請主動辨識文章中出現的「獨立重要概念」、「專有名詞」、「框架」或「演算法」（例如：特定的管理工具、系統架構名稱等）。
1. 在重點提取的正文中，將這些詞彙使用雙層中括號 \`[[ ]]\` 包覆起來。
2. 在整份筆記的最末端，請 **務必** 使用以下 \`<atomic-notes>\` 的 XML（延標記語言）結構，為每一個標記 \`[[ ]]\` 的專有名詞產生獨立筆記內容（包含定義、用途及關聯標籤，標籤也請優先參考並選用「知識庫現有標籤」列表中的相關標籤）。

---
# 輸出範本（嚴格遵循此格式輸出，不要輸出任何其他多餘的對話文字）

---
title: {SUGGESTED_TITLE}
type: reference
source: {SOURCE_URL}
captured: {CAPTURED_DATE}
category: {Category}
tags: #web-clippings #{Tag1} #{Tag2} #status/to-process
---
[一句話總結放在這裡]

## 重點提取
- [[專有名詞]] 觀點一...
- 觀點二...
> 引用重要技巧...

<atomic-notes>
<note title="專有名詞" tags="#tag1 #tag2" category="20_Academic_CS">
這裡填寫對該專有名詞的詳細解釋、定義以及其用途。注意盡量挑選適當的四大分類，真的不行再選 99_Uncategorized。
</note>
<note title="另一個框架" tags="#tag3" category="10_Work_&_Management">
...
</note>
</atomic-notes>
`;

export class ArticleProcessorEngine {
  constructor(
    private app: App,
    private apiClient: LocalLLMClient,
    private temperature: number
  ) {}

  public async processFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      
      // Try to extract URL if it's already in the file (e.g., from a web clipper)
      const urlMatch = content.match(/URL:\s*(https?:\/\/[^\s]+)/i) || content.match(/Source:\s*(https?:\/\/[^\s]+)/i);
      const sourceUrl = urlMatch ? urlMatch[1] : "";
      
      const today = new Date().toISOString().split("T")[0];
      
      // ── Ontology Preservation: capture relationships before rewrite ──
      const ontology = this.captureOntology(content);

      // Get all existing tags in the vault to help LLM reuse them
      const allVaultTagsMap = (this.app.metadataCache as any).getTags() as Record<string, number>;
      const sortedTags = Object.entries(allVaultTagsMap)
        .sort((a, b) => b[1] - a[1]) // Sort by frequency
        .map(([tag]) => tag); // e.g. "#tagname"

      // Limit to top 150 tags to avoid overloading LLM context
      const tagListLimit = 150;
      const limitedTags = sortedTags.slice(0, tagListLimit);
      const existingTagsContext = limitedTags.length > 0
        ? `\n\n【知識庫現有標籤（供參考，請優先選用相關的標籤以增加關連性，亦可自行發明新標籤）：】\n${limitedTags.join(", ")}`
        : "";

      const systemPrompt = ARTICLE_PROCESSOR_PROMPT
          .replace(/\{CAPTURED_DATE\}/g, today)
          .replace(/\{SOURCE_URL\}/g, sourceUrl || "[填寫原文網址，若無則留空]");

      const userPromptContext = `【原始標題】：${file.basename}\n\n【文章內文】：\n${content}${existingTagsContext}`;

      new Notice(`正在處理文章「${file.basename}」...這可能需要一些時間。`);

      const rawResponse = await this.apiClient.prompt(
        systemPrompt,
        userPromptContext,
        this.temperature
      );

      // Clean up markdown fences if the LLM wraps the response in ```markdown ... ```
      let finalMarkdown = rawResponse.trim();
      
      // Broad cleanup
      finalMarkdown = finalMarkdown.replace(/^```markdown\n/i, "");
      finalMarkdown = finalMarkdown.replace(/\n```$/, "");
      finalMarkdown = finalMarkdown.replace(/^```yaml\n/i, "");
      finalMarkdown = finalMarkdown.replace(/---\n```\n/g, "---\n");
      finalMarkdown = finalMarkdown.replace(/^```\n/i, "");
      finalMarkdown = finalMarkdown.trim();

      // Fallback: If for some reason frontmatter is missing the dashes at the very top:
      if (!finalMarkdown.startsWith("---")) {
         const match = finalMarkdown.match(/---\n[\s\S]*?\n---/);
         if (match) {
             finalMarkdown = finalMarkdown.substring(match.index!);
         }
      }

      // Auto-Migration Setup
      let finalCategory = "99_未分類";
      const catMatch = finalMarkdown.match(/category:\s*(.+)/i);
      if (catMatch) {
         finalCategory = catMatch[1].trim().replace(/^["'\[\]]+|["'\[\]]+$/g, ""); // strip brackets/quotes
         if (!PILLARS.includes(finalCategory)) {
             finalCategory = "99_未分類"; // strict fallback
         }
      }

      // Extract atomic notes block BEFORE saving final markdown
      const atomicRegex = /<atomic-notes>([\s\S]*?)<\/atomic-notes>/i;
      const atomicMatch = finalMarkdown.match(atomicRegex);
      if (atomicMatch) {
         finalMarkdown = finalMarkdown.replace(atomicRegex, "").trim();
         
         const noteBlock = atomicMatch[1];
         const noteRegex = /<note\s+title="([^"]+)"(?:[^>]*)?>([\s\S]*?)<\/note>/gi;
         const tagsRegex = /tags="([^"]+)"/i;
         const catAttrRegex = /category="([^"]+)"/i;

         let nMatch;
         while ((nMatch = noteRegex.exec(noteBlock)) !== null) {
            const fullTagStr = nMatch[0];
            const title = nMatch[1].trim();
            const tagsAttrMatch = fullTagStr.match(tagsRegex);
            const tagsStr = tagsAttrMatch ? tagsAttrMatch[1].trim() : "";
            
            const catAttrMatch = fullTagStr.match(catAttrRegex);
            let noteCategory = catAttrMatch ? catAttrMatch[1].trim() : finalCategory;
            if (!PILLARS.includes(noteCategory)) {
               noteCategory = "99_未分類"; // strict fallback
            }

            const content = nMatch[2].trim();
            const tagsArr = tagsStr.split(/\s+/).filter(Boolean);
            
            try {
              await this.createAtomicNote(title, content, tagsArr, noteCategory, file.basename);
            } catch (err) {
              console.error("[ArticleProcessorEngine] Failed atomic note:", title, err);
            }
         }
      }

      // Extract the body from the LLM response (strip its frontmatter)
      const llmFmMatch = finalMarkdown.match(/^---\n([\s\S]*?)\n---/);
      const llmFmString = llmFmMatch ? llmFmMatch[1] : "";
      const finalBody = finalMarkdown.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

      // ── Ontology Re-injection: restore any missing wikilinks & tags ──
      const ontologyRestoredBody = this.restoreOntology(finalBody, ontology);

      // Get original frontmatter
      const originalFmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const originalFmFull = originalFmMatch ? originalFmMatch[0] + "\n" : "";

      // Salvage original images
      const imageRegex = /<img\s+[^>]*src="[^"]+"[^>]*>|!\[.*?\]\(.*?\)|\!\[\[.*?\]\]/gi;
      const imagesMatch = content.match(imageRegex);
      const uniqueImages = imagesMatch ? Array.from(new Set(imagesMatch)) : [];
      
      let imagesSection = "";
      if (uniqueImages.length > 0) {
          imagesSection = "\n\n## 原始附圖（保留的圖像）\n" + uniqueImages.join("\n\n") + "\n";
      }

      // Overwrite file with Original Frontmatter + LLM Body + Saved Images
      await this.app.vault.modify(file, originalFmFull + ontologyRestoredBody + imagesSection);

      // Now merge newly discovered properties safely using Obsidian API
      let suggestedTitle = file.basename;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
         // Preserve all original frontmatter keys that the LLM doesn't manage
         for (const [key, value] of Object.entries(ontology.preservedFrontmatter)) {
           if (!(key in fm)) {
             fm[key] = value;
           }
         }

         const titleMatch = llmFmString.match(/title:\s*(.+)/i);
         if (titleMatch) {
            suggestedTitle = titleMatch[1].replace(/["']/g, "").trim();
            fm["title"] = suggestedTitle;
         }

         fm["type"] = "reference";
         fm["captured"] = today;
         if (sourceUrl) fm["source"] = sourceUrl;
         if (finalCategory) fm["category"] = finalCategory;
         
         const tagsMatch = llmFmString.match(/tags:\s*(.+)/i);
         let rawTags: string[] = [];
         if (tagsMatch) {
            rawTags = tagsMatch[1]
               .replace(/[\[\]"',]/g, " ")
               .split(/\s+/)
               .filter(t => t.length > 0 && t !== "#web-clippings")
               .map(t => t.replace(/^#/, ""));
         }
         const existingTags = Array.isArray(fm["tags"]) ? fm["tags"].map((t: string) => t.replace(/^#/, "")) : [];
         fm["tags"] = Array.from(new Set([...existingTags, ...rawTags, ...ontology.frontmatterTags, "web-clippings"]));
      });

      if (finalCategory) {
         await this.moveFileToCategory(file, finalCategory);
      }

      // Smart Renaming
      const newBaseName = suggestedTitle.replace(/[\\/:"*?<>|#^\[\]]/g, "").trim().slice(0, 50);
      if (newBaseName && newBaseName !== file.basename) {
         const parentDirPath = file.parent?.path || "";
         const newPath = normalizePath(`${parentDirPath}/${newBaseName}.md`);
         if (!this.app.vault.getAbstractFileByPath(newPath)) {
            await this.app.vault.rename(file, newPath);
         }
      }

    } catch (err) {
      console.error("[ArticleProcessorEngine] Error processing file:", err);
      throw err;
    }
  }

  private async createAtomicNote(title: string, content: string, tags: string[], category: string, sourceName: string): Promise<void> {
    let safeTitle = title.replace(/[\\/:"*?<>|#^\[\]]/g, "").trim() || "Atomic Note";
    const destFolder = normalizePath(category);
    const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
    if (!abstractFolder) {
      await this.app.vault.createFolder(destFolder);
    }

    let attempt = 0;
    let finalPath = normalizePath(`${category}/${safeTitle}.md`);
    while (this.app.vault.getAbstractFileByPath(finalPath)) {
      attempt++;
      finalPath = normalizePath(`${category}/${safeTitle} ${attempt}.md`);
    }

    const today = new Date().toISOString().split("T")[0];
    const tagsStr = tags.length > 0 
      ? `tags:\n  - ${tags.map(t => t.replace(/^#/, "")).join("\n  - ")}`
      : "tags: []";

    const fullContent = `---
type: atomic-note
category: ${category}
${tagsStr}
created: ${today}
---
來源筆記：[[${sourceName}]]

# ${safeTitle}

${content}
`;
    await this.app.vault.create(finalPath, fullContent);
  }

  private async moveFileToCategory(file: TFile, category: string): Promise<void> {
    const destFolder = normalizePath(category);
    const abstractFolder = this.app.vault.getAbstractFileByPath(destFolder);
    
    // Check if the destination folder exists; if not, create it
    if (!abstractFolder) {
      await this.app.vault.createFolder(destFolder);
    }
    
    // Define the new location
    const newPath = normalizePath(`${category}/${file.name}`);
    await this.app.vault.rename(file, newPath);
  }

  // ========================================================================
  // Ontology Preservation
  // ========================================================================

  private stripFrontmatter(content: string): string {
    const fmRegex = /^---\s*\n[\s\S]*?\n---\s*\n?/;
    return content.replace(fmRegex, "").trim();
  }

  /**
   * Capture the semantic ontology of a note before LLM rewriting.
   * This includes wikilinks, inline tags, and frontmatter properties.
   */
  private captureOntology(content: string): OntologySnapshot {
    // Extract wikilinks: [[Target]] or [[Target|Alias]]
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const wikilinks: string[] = [];
    let m;
    while ((m = wikilinkRegex.exec(content)) !== null) {
      wikilinks.push(m[1].trim());
    }

    // Extract inline #tags from body (not frontmatter)
    const body = this.stripFrontmatter(content);
    const tagRegex = /(?:^|\s)#([\w\-\/]+)/g;
    const inlineTags: string[] = [];
    while ((m = tagRegex.exec(body)) !== null) {
      inlineTags.push(m[1]);
    }

    // Extract frontmatter tags and all preserved properties
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const frontmatterTags: string[] = [];
    const preservedFrontmatter: Record<string, unknown> = {};

    if (fmMatch) {
      const fmBlock = fmMatch[1];
      // Simple YAML key extraction for preservation
      const lines = fmBlock.split("\n");
      let currentKey = "";
      for (const line of lines) {
        const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
        if (keyMatch) {
          currentKey = keyMatch[1];
          const value = keyMatch[2].trim();
          if (value && !value.startsWith("[") && value !== "") {
            preservedFrontmatter[currentKey] = value;
          }
        }
      }

      // Extract frontmatter tags array
      const tagsMatch = fmBlock.match(/tags:\s*\n((?:\s+-\s+.+\n?)*)/i);
      if (tagsMatch) {
        const tagLines = tagsMatch[1].split("\n");
        for (const tl of tagLines) {
          const t = tl.replace(/^\s*-\s*/, "").replace(/^#/, "").trim();
          if (t) frontmatterTags.push(t);
        }
      } else {
        // Inline tags format: tags: [tag1, tag2]
        const inlineTagsMatch = fmBlock.match(/tags:\s*\[([^\]]*)\]/i);
        if (inlineTagsMatch) {
          const parts = inlineTagsMatch[1].split(",");
          for (const p of parts) {
            const t = p.replace(/["'#]/g, "").trim();
            if (t) frontmatterTags.push(t);
          }
        }
      }
    }

    return {
      wikilinks: Array.from(new Set(wikilinks)),
      inlineTags: Array.from(new Set(inlineTags)),
      frontmatterTags: Array.from(new Set(frontmatterTags)),
      preservedFrontmatter,
    };
  }

  /**
   * Re-inject any wikilinks and inline tags that existed in the original
   * note but are absent from the LLM-rewritten body.
   */
  private restoreOntology(refinedBody: string, ontology: OntologySnapshot): string {
    // Find which original wikilinks are missing from the new content
    const missingLinks: string[] = [];
    for (const link of ontology.wikilinks) {
      if (!refinedBody.includes(`[[${link}`)) {
        missingLinks.push(link);
      }
    }

    // Find which original inline tags are missing
    const missingTags: string[] = [];
    for (const tag of ontology.inlineTags) {
      if (!refinedBody.includes(`#${tag}`)) {
        missingTags.push(tag);
      }
    }

    // If nothing is missing, return as-is
    if (missingLinks.length === 0 && missingTags.length === 0) {
      return refinedBody;
    }

    // Build an "Ontology Preserved" section
    const parts: string[] = [refinedBody];
    parts.push("");
    parts.push("## 本體論保留區（Preserved Ontology）");
    parts.push("> 以下連結與標籤來自原始筆記，由系統自動保留以維護知識圖譜完整性。");
    parts.push("");

    if (missingLinks.length > 0) {
      parts.push("**保留的雙向連結（Preserved Wikilinks）：**");
      for (const link of missingLinks) {
        parts.push(`- [[${link}]]`);
      }
      parts.push("");
    }

    if (missingTags.length > 0) {
      parts.push("**保留的標籤（Preserved Tags）：**");
      parts.push(missingTags.map(t => `#${t}`).join(" "));
      parts.push("");
    }

    return parts.join("\n");
  }


}
