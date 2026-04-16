import { App, TFile, Notice, normalizePath } from "obsidian";
import { LocalLLMClient } from "./api";

const PILLARS = [
  "10_工作與管理",
  "20_學術與電腦科學",
  "30_生活與創作",
  "40_自託管實驗室",
  "99_未分類"
];

const ARTICLE_PROCESSOR_PROMPT = `閱讀使用者提供的文章內容，並嚴格按照以下四個步驟處理，最終改寫為一個完整的 Markdown（標記語言）格式筆記。

## 步驟一：建立標準化 YAML（YAML 資料序列化格式）前文
請根據文章內容，提取中繼資料並生成 YAML 區塊。
- type（類型）: reference（參考資料）
- source（來源）: {SOURCE_URL}
- captured（擷取日期）: {CAPTURED_DATE}
- category（分類）: 必須是以下五大支柱（Five Pillars）的其中一個精確名稱：
  - 10_工作與管理（團隊帶領、會議、專案管理（project management）、人際、職場）
  - 20_學術與電腦科學（電腦科學（Computer Science）、學位、程式開發（programming）、技術）
  - 30_生活與創作（生活飲食、旅遊、個人興趣）
  - 40_自託管實驗室（伺服器、Docker 容器化（containerization）、自託管（self-hosted）、人工智慧（AI）工具）
  - 99_未分類（無法歸類到以上四大類別時放這裡）
- tags（標籤）: [提取 2-3 個與主題相關的標籤，必須包含 #web-clippings（網頁剪輯），並視情況加上 #status/to-process（待處理狀態）或 #status/evergreen（常青筆記狀態）]

## 步驟二：撰寫「一句話總結（One-Sentence Summary）」
在 YAML 區塊下方，請用一句精煉的話（不超過 50 字）總結這篇文章的核心價值或解決的問題，讓未來的讀者（使用者本人）能在一秒內決定是否需要繼續閱讀。

## 步驟三：知識蒸餾與重點提取（Distillation）
不要原文照抄。請過濾掉廢話與冗長的鋪陳，提取文章中最具價值的 3 到 5 個核心觀點或實用技巧，並使用 Markdown 的條列式（Bullet points）或引用區塊（>）呈現。

## 步驟四：原子化概念標記與獨立萃取（Atomization & Extraction）
這是最重要的一步。請主動辨識文章中出現的「獨立重要概念」、「專有名詞」、「框架」或「演算法」（例如：特定的管理工具、系統架構名稱等）。
1. 在重點提取的正文中，將這些詞彙使用雙層中括號 \`[[ ]]\` 包覆起來。
2. 在整份筆記的最末端，請 **務必** 使用以下 \`<atomic-notes>\` 的 XML（延標記語言）結構，為每一個標記 \`[[ ]]\` 的專有名詞產生獨立筆記內容（包含定義、用途及關聯標籤）。

---
# 輸出範本（嚴格遵循此格式輸出，不要輸出任何其他多餘的對話文字）

---
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
      
      const systemPrompt = ARTICLE_PROCESSOR_PROMPT
          .replace(/\{CAPTURED_DATE\}/g, today)
          .replace(/\{SOURCE_URL\}/g, sourceUrl || "[填寫原文網址，若無則留空]");

      new Notice(`正在處理文章「${file.basename}」...這可能需要一些時間。`);

      const rawResponse = await this.apiClient.prompt(
        systemPrompt,
        content,
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
      await this.app.vault.modify(file, originalFmFull + finalBody + imagesSection);

      // Now merge newly discovered properties safely using Obsidian API
      await this.app.fileManager.processFrontMatter(file, (fm) => {
         fm["type"] = "reference";
         fm["captured"] = today;
         if (sourceUrl) fm["source"] = sourceUrl;
         if (finalCategory) fm["category"] = finalCategory;
         
         const tagsMatch = llmFmString.match(/tags:\s*(.+)/i);
         if (tagsMatch) {
            const rawTags = tagsMatch[1]
               .replace(/[\[\]"',]/g, " ")
               .split(/\s+/)
               .filter(t => t.length > 0 && t !== "#web-clippings")
               .map(t => t.replace(/^#/, ""));
            
            const existingTags = Array.isArray(fm["tags"]) ? fm["tags"].map((t: string) => t.replace(/^#/, "")) : [];
            fm["tags"] = Array.from(new Set([...existingTags, ...rawTags, "web-clippings"]));
         }
      });

      if (finalCategory) {
         await this.moveFileToCategory(file, finalCategory);
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
}
